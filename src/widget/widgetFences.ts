/**
 * Locate `s2b-widget` fences in a note's markdown. Used to keep widget code out of the
 * search indexes: a fence's HTML and JavaScript are noise to retrieval, so
 * {@link stripWidgetFences} replaces each with a one-line marker carrying its title.
 *
 * Fence-aware in the CommonMark sense: a fence opened inside another fence (the widgets
 * skill's own ````markdown examples) is content, not a widget. Opening markers may be
 * indented up to three spaces; the closing marker uses the same character, at least
 * the same length, and carries no info string.
 */

import { parseWidgetSpec, WIDGET_BLOCK_LANGUAGE, type WidgetSpec } from "./widgetSpec";

export interface WidgetFence {
	/** Position among the note's widget fences, top to bottom. */
	index: number;
	/** Zero-based line of the opening marker. */
	lineStart: number;
	/** Zero-based line of the closing marker. */
	lineEnd: number;
	/** The fence body, verbatim. */
	source: string;
	spec: WidgetSpec;
}

const OPENING = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

function closes(line: string, char: string, length: number): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
	return match !== null && match[1][0] === char && match[1].length >= length;
}

/** Every top-level `s2b-widget` fence in `markdown`, in document order. */
export function findWidgetFences(markdown: string): WidgetFence[] {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const fences: WidgetFence[] = [];
	let open: { char: string; length: number; lang: string; lineStart: number } | null = null;
	let body: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (open) {
			if (closes(line, open.char, open.length)) {
				if (open.lang === WIDGET_BLOCK_LANGUAGE) {
					const source = body.join("\n");
					fences.push({
						index: fences.length,
						lineStart: open.lineStart,
						lineEnd: i,
						source,
						spec: parseWidgetSpec(source),
					});
				}
				open = null;
				body = [];
			} else {
				body.push(line);
			}
			continue;
		}
		const match = OPENING.exec(line);
		if (match) open = { char: match[1][0], length: match[1].length, lang: match[2], lineStart: i };
	}
	return fences;
}

/**
 * `markdown` with every widget fence replaced by `(widget: <title>)` — or `(widget)` when it
 * has none — so a note that holds a dashboard is still findable by its name while its
 * code stays out of the index. Returns the input untouched when there is nothing to strip.
 */
export function stripWidgetFences(markdown: string): string {
	const fences = findWidgetFences(markdown);
	if (fences.length === 0) return markdown;
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let cursor = 0;
	for (const fence of fences) {
		out.push(...lines.slice(cursor, fence.lineStart));
		out.push(fence.spec.title ? `(widget: ${fence.spec.title})` : "(widget)");
		cursor = fence.lineEnd + 1;
	}
	out.push(...lines.slice(cursor));
	return out.join("\n");
}
