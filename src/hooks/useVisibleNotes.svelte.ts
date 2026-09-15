import type { EventRef, TFile, Workspace, WorkspaceLeaf } from "obsidian";
import { getPlugin } from "../stores/state.svelte";

export interface VisibleNote {
	file: TFile;
	viewType: string;
	/** e.g. "p. 1 / 2" for PDFs. (Markdown notes carry no context — the user selects the exact text to reference.) */
	context?: string;
	icon: string;
}

/** Serializable version of VisibleNote (no TFile). Persisted in HumanMessage additional_kwargs. */
export interface VisibleNoteRef {
	path: string;
	basename: string;
	viewType: string;
	context?: string;
	icon: string;
}

export function toVisibleNoteRefs(notes: VisibleNote[]): VisibleNoteRef[] {
	return notes.map((n) => ({
		path: n.file.path,
		basename: n.file.basename,
		viewType: n.viewType,
		context: n.context,
		icon: n.icon,
	}));
}

const VIEW_TYPES = ["markdown", "pdf", "canvas", "image"] as const;

const VIEW_ICONS: Record<string, string> = {
	markdown: "file-text",
	pdf: "file-type",
	canvas: "layout-dashboard",
	image: "image",
};

const VISIBLE_NOTES_POLL_MS = 1500;

function isRootVisibleLeaf(workspace: Workspace, leaf: WorkspaceLeaf): boolean {
	if (leaf.getRoot() !== workspace.rootSplit) return false;
	// `containerEl` is real but undeclared on WorkspaceLeaf in the public API types, so
	// name the one property being read instead of widening the whole leaf to `any`.
	return (leaf as WorkspaceLeaf & { containerEl?: HTMLElement }).containerEl?.style.display !== "none";
}

function shouldPollVisibleNotesContext(workspace: Workspace): boolean {
	// Only PDFs have scroll-dependent context (page number) worth polling for.
	for (const leaf of workspace.getLeavesOfType("pdf")) {
		if (isRootVisibleLeaf(workspace, leaf)) return true;
	}

	return false;
}

/** The pdf.js viewer nested inside Obsidian's PDF view (internal, untyped API). */
interface PdfJsViewerInternal {
	_currentPageNumber?: number;
	currentPageNumber?: number;
	_pages?: unknown[];
	pagesCount?: number;
	_pageLabels?: string[] | null;
}

function getPdfContext(view: unknown): string | undefined {
	try {
		const inner = (view as { viewer?: { child?: { pdfViewer?: { pdfViewer?: PdfJsViewerInternal } } } } | null)
			?.viewer?.child?.pdfViewer?.pdfViewer;
		if (!inner) return undefined;
		const page = inner._currentPageNumber ?? inner.currentPageNumber;
		const total = inner._pages?.length ?? inner.pagesCount;
		if (typeof page !== "number" || page <= 0 || typeof total !== "number" || total <= 0) {
			return undefined;
		}
		// PDFs can define custom page labels (e.g. 0-indexed, Roman numerals).
		// When present, show the label instead of the raw page number.
		const labels = inner._pageLabels;
		const label = labels?.[page - 1];
		if (label != null && label !== "" && label !== String(page)) {
			return `p. ${label} / ${total}`;
		}
		return `p. ${page} / ${total}`;
	} catch {
		/* internal API may change */
	}
	return undefined;
}

function getContext(type: string, leaf: WorkspaceLeaf): string | undefined {
	switch (type) {
		case "pdf":
			return getPdfContext(leaf.view);
		default:
			return undefined;
	}
}

/**
 * Snapshot of the notes currently *visible* to the user in the main workspace
 * area: the front (on-screen) tab of each pane, for every supported view type.
 * Notes stacked behind another tab are excluded (their leaf is `display:none`),
 * and the chat view is excluded because it is not a supported note type.
 *
 * Multiple visible panes (e.g. a side-by-side split) yield multiple notes.
 * To reference a non-visible note the user types a [[wikilink]].
 */
function getVisibleNotes(workspace: Workspace): VisibleNote[] {
	const visible: VisibleNote[] = [];
	const seen = new Set<string>();

	for (const type of VIEW_TYPES) {
		for (const leaf of workspace.getLeavesOfType(type)) {
			if (leaf.getRoot() !== workspace.rootSplit) continue;
			// Front-tab test: background tabs in a stack are hidden with display:none.
			if ((leaf as { containerEl?: HTMLElement }).containerEl?.style.display === "none") continue;
			const file = (leaf.view as { file?: TFile }).file;
			if (!file || seen.has(file.path)) continue;
			seen.add(file.path);

			visible.push({
				file,
				viewType: type,
				context: getContext(type, leaf),
				icon: VIEW_ICONS[type] ?? "file",
			});
		}
	}

	return visible;
}

/** Formats visible notes into a context string for the agent. */
export function formatVisibleNotesContext(notes: VisibleNoteRef[]): string {
	if (notes.length === 0) return "";
	const lines = notes.map((n) => {
		const ctx = n.context ? ` (${n.context})` : "";
		return `- ${n.path}${ctx}`;
	});
	return `[Currently visible notes]\n${lines.join("\n")}`;
}

/**
 * Reactive tracker for the notes currently visible in the main workspace area
 * (front tab of each pane, chat view excluded). Provides context metadata
 * (current PDF page, active heading, etc.). Updates on leaf/layout changes and
 * polls only when a preview/PDF view is visible (scroll changes context).
 */
export class VisibleNotesTracker {
	readonly #workspace = getPlugin().app.workspace;
	#notes: VisibleNote[] = $state([]);
	#refs: EventRef[] = [];
	#interval: number | undefined;

	/** The currently visible notes (front tab of each pane, chat excluded). */
	get notes(): VisibleNote[] {
		return this.#notes;
	}

	constructor() {
		this.#sync();
		this.#refs = [
			this.#workspace.on("active-leaf-change", () => this.#sync()),
			this.#workspace.on("layout-change", () => this.#sync()),
		];
		this.#updatePolling();
	}

	#sync() {
		this.#refresh();
		this.#updatePolling();
	}

	#refresh() {
		const next = getVisibleNotes(this.#workspace);
		// Only update state when the visible set actually changed to avoid
		// unnecessary Svelte re-renders from the polling interval.
		if (!this.#notesEqual(this.#notes, next)) {
			this.#notes = next;
		}
	}

	#updatePolling() {
		const needsPolling = shouldPollVisibleNotesContext(this.#workspace);
		if (needsPolling) {
			if (!this.#interval) {
				// Poll only for preview / PDF views where scroll position changes context.
				this.#interval = window.setInterval(() => this.#refresh(), VISIBLE_NOTES_POLL_MS);
			}
			return;
		}

		if (this.#interval) {
			window.clearInterval(this.#interval);
			this.#interval = undefined;
		}
	}

	#notesEqual(a: VisibleNote[], b: VisibleNote[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i].file.path !== b[i].file.path || a[i].context !== b[i].context) return false;
		}
		return true;
	}

	destroy() {
		for (const ref of this.#refs) {
			this.#workspace.offref(ref);
		}
		this.#refs = [];
		window.clearInterval(this.#interval);
		this.#interval = undefined;
	}
}
