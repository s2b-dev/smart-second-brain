/**
 * Locate `s2b-view` fences in a note's markdown, so a note can be opened as a view
 * (`views/gen-view/GenView.ts`) and a rendered block can find its own index.
 *
 * Fence-aware in the CommonMark sense: a fence opened inside another fence (the views
 * skill's own ````markdown examples) is content, not a view. Opening markers may be
 * indented up to three spaces; the closing marker uses the same character, at least
 * the same length, and carries no info string.
 */

import { parseViewSpec, VIEW_BLOCK_LANGUAGE, type ViewSpec } from "./viewSpec";

export interface ViewFence {
	/** Position among the note's view fences, top to bottom. */
	index: number;
	/** Zero-based line of the opening marker (what `getSectionInfo` reports for the block). */
	lineStart: number;
	/** Zero-based line of the closing marker. */
	lineEnd: number;
	/** The fence body, verbatim. */
	source: string;
	spec: ViewSpec;
}

const OPENING = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

function closes(line: string, char: string, length: number): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
	return match !== null && match[1][0] === char && match[1].length >= length;
}

/** Every top-level `s2b-view` fence in `markdown`, in document order. */
export function findViewFences(markdown: string): ViewFence[] {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const fences: ViewFence[] = [];
	let open: { char: string; length: number; lang: string; lineStart: number } | null = null;
	let body: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (open) {
			if (closes(line, open.char, open.length)) {
				if (open.lang === VIEW_BLOCK_LANGUAGE) {
					const source = body.join("\n");
					fences.push({
						index: fences.length,
						lineStart: open.lineStart,
						lineEnd: i,
						source,
						spec: parseViewSpec(source),
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

/** The view fence whose opening marker is on `line`, or null. */
export function viewFenceAtLine(markdown: string, line: number): ViewFence | null {
	return findViewFences(markdown).find((fence) => fence.lineStart === line) ?? null;
}
