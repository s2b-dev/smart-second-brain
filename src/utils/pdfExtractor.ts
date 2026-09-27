import { loadPdfJs } from "obsidian";
import { PDFDocument } from "pdf-lib";

/**
 * pdfjs `VerbosityLevel.ERRORS`. Suppresses per-page `WARNING`-level noise from
 * the worker (e.g. "TT: undefined function: 32" — unimplemented TrueType font
 * hinting opcodes) while still surfacing real errors. Font hinting barely
 * matters here: we mostly pull text via `getTextContent()`, and only render
 * tiny first-page thumbnails.
 */
const PDFJS_VERBOSITY_ERRORS = 0;

/**
 * Resolves the URLs pdfjs needs for standard font data and CMaps.
 *
 * Without `standardFontDataUrl`, pdfjs can't load the 14 standard fonts and
 * throws `UnknownErrorException` per non-embedded font, falling into expensive
 * glyph recovery ("Required `glyf` table is not found -- trying to recover").
 * Repeated across every page of every PDF in a full index, that font-recovery
 * work is heavy enough to OOM the shared worker and crash the renderer.
 *
 * Obsidian ships these assets alongside the pdfjs worker and points
 * `GlobalWorkerOptions.workerSrc` at it (e.g. "/lib/pdfjs/pdf.worker.min.mjs").
 * We derive the sibling `standard_fonts/` and `cmaps/` dirs from that path
 * rather than hardcoding, so the fix survives a change to Obsidian's layout.
 * If `workerSrc` is unset, return nothing and let pdfjs use its own defaults.
 */
function pdfAssetUrls(pdfjsLib: {
	GlobalWorkerOptions?: { workerSrc?: string };
}): { standardFontDataUrl?: string; cMapUrl?: string } {
	const workerSrc = pdfjsLib?.GlobalWorkerOptions?.workerSrc;
	if (!workerSrc) return {};
	const base = workerSrc.replace(/[^/]*$/, ""); // strip the worker filename → ".../lib/pdfjs/"
	return { standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/` };
}

export interface PdfExtractResult {
	text: string;
	totalPages: number;
}

/** A pdfjs text item. `hasEOL` marks the last item on a visual line. */
interface PdfTextItem {
	str: string;
	hasEOL?: boolean;
}

/**
 * Joins pdfjs text items into a line-structured string.
 *
 * pdfjs emits one item per styled run, so items must be separated or words fuse
 * across run boundaries ("Scene" + "Leonard" -> "SceneLeonard"). Items ending a
 * visual line are followed by a newline; the rest are separated by a space
 * unless one side already supplies the whitespace.
 */
export function joinPdfTextItems(items: PdfTextItem[]): string {
	let text = "";
	for (const item of items) {
		if (item.hasEOL) {
			text += `${item.str}\n`;
			continue;
		}
		if (item.str.length === 0) continue;
		const needsSpace = text.length > 0 && !/\s$/.test(text) && !/^\s/.test(item.str);
		text += needsSpace ? ` ${item.str}` : item.str;
	}
	return text.replace(/[ \t]+$/gm, "").trim();
}

/**
 * Extracts all text content from a PDF file using Obsidian's built-in pdfjs.
 *
 * Pages are separated by a blank line so downstream chunking has a paragraph
 * boundary to split on — PDFs have no headings for the chunker to use.
 *
 * @param data - PDF file content as Uint8Array
 * @returns Extracted text and total page count
 */
export async function extractTextFromPdf(data: Uint8Array): Promise<PdfExtractResult> {
	const pdfjsLib = await loadPdfJs();
	const pdf = await pdfjsLib.getDocument({
		data,
		verbosity: PDFJS_VERBOSITY_ERRORS,
		...pdfAssetUrls(pdfjsLib),
		cMapPacked: true,
	}).promise;
	try {
		const totalPages = pdf.numPages;
		const textParts: string[] = [];
		for (let i = 1; i <= totalPages; i++) {
			const page = await pdf.getPage(i);
			const content = await page.getTextContent();
			textParts.push(joinPdfTextItems(content.items));
		}
		return { text: textParts.filter((part) => part.length > 0).join("\n\n"), totalPages };
	} finally {
		// Release worker-side memory (font caches, page objects) before the next
		// PDF. Without this, a full-vault index accumulates every document until GC
		// and OOMs the shared worker.
		await pdf.destroy();
	}
}

/**
 * Renders page 1 of a PDF to a PNG `width` pixels wide — the composer's
 * attachment thumbnail, which crops to the top of the page.
 *
 * @param data - PDF file content as Uint8Array (pdfjs may transfer it; pass a copy)
 * @param width - Width of the output image, in device pixels
 */
export async function renderPdfThumbnail(data: Uint8Array, width: number): Promise<Blob> {
	const pdfjsLib = await loadPdfJs();
	const pdf = await pdfjsLib.getDocument({
		data,
		verbosity: PDFJS_VERBOSITY_ERRORS,
		...pdfAssetUrls(pdfjsLib),
		cMapPacked: true,
	}).promise;
	try {
		const page = await pdf.getPage(1);
		const natural = page.getViewport({ scale: 1 });
		const viewport = page.getViewport({ scale: width / natural.width });
		const canvas = document.createElement("canvas");
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		const canvasContext = canvas.getContext("2d");
		if (!canvasContext) throw new Error("Canvas 2D context unavailable");
		await page.render({ canvasContext, viewport }).promise;
		return await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(blob) => (blob ? resolve(blob) : reject(new Error("PDF thumbnail encode failed"))),
				"image/png",
			),
		);
	} finally {
		await pdf.destroy();
	}
}

export interface PdfPageExtractResult {
	text: string;
	totalPages: number;
}

/**
 * Extracts text from specific pages of a PDF file.
 *
 * @param data - PDF file content as Uint8Array
 * @param pages - Array of 1-indexed page numbers to extract
 * @returns Extracted text from the specified pages and total page count
 */
export async function extractTextFromPdfPages(data: Uint8Array, pages: number[]): Promise<PdfPageExtractResult> {
	const pdfjsLib = await loadPdfJs();
	const pdf = await pdfjsLib.getDocument({
		data,
		verbosity: PDFJS_VERBOSITY_ERRORS,
		...pdfAssetUrls(pdfjsLib),
		cMapPacked: true,
	}).promise;
	try {
		const totalPages = pdf.numPages;
		const textParts: string[] = [];
		for (const pageNum of pages) {
			if (pageNum < 1 || pageNum > totalPages) continue;
			const page = await pdf.getPage(pageNum);
			const content = await page.getTextContent();
			textParts.push(joinPdfTextItems(content.items));
		}
		return { text: textParts.filter((part) => part.length > 0).join("\n\n"), totalPages };
	} finally {
		await pdf.destroy();
	}
}

/**
 * Extracts specific pages from a PDF into a new standalone PDF binary using pdf-lib.
 *
 * @param data - PDF file content as Uint8Array
 * @param pages - Array of 1-indexed page numbers to extract
 * @returns New PDF as Uint8Array containing only the requested pages, total page count,
 *          and which pages were actually included (out-of-range pages are skipped)
 */
export async function extractPdfPages(
	data: Uint8Array,
	pages: number[],
): Promise<{ pdf: Uint8Array; totalPages: number; includedPages: number[] }> {
	const srcDoc = await PDFDocument.load(data);
	const totalPages = srcDoc.getPageCount();

	const validPages = pages.filter((p) => p >= 1 && p <= totalPages);
	if (validPages.length === 0) {
		return { pdf: new Uint8Array(0), totalPages, includedPages: [] };
	}

	const newDoc = await PDFDocument.create();
	// pdf-lib uses 0-indexed page numbers
	const copiedPages = await newDoc.copyPages(
		srcDoc,
		validPages.map((p) => p - 1),
	);
	for (const page of copiedPages) {
		newDoc.addPage(page);
	}

	const pdfBytes = await newDoc.save();
	return { pdf: new Uint8Array(pdfBytes), totalPages, includedPages: validPages };
}
