const LIST_LINE = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])(?:\s|$)/;
const QUOTED = /^\s{0,3}>/;
const FENCE = /^\s{0,3}(?:>\s*)*(`{3,}|~{3,})/;

/**
 * Whether the line containing `pos` in `text` is a Markdown list item —
 * bullet (`-`, `*`, `+`), ordered (`1.`, `1)`), task (`- [ ]`), optionally
 * indented or inside a blockquote — and not inside a fenced code block. These
 * are the lines on which Obsidian's own Enter continues the list.
 */
export function isMarkdownListLineAt(text: string, pos: number): boolean {
	const lines = text.slice(0, pos).split("\n");
	const current = lines.pop() + text.slice(pos).split("\n", 1)[0];
	// Replay fences above the cursor: an opener's closer uses the same
	// character and is at least as long (CommonMark). A fence opened inside a
	// blockquote also ends with the blockquote, i.e. at the first unquoted line.
	let open: string | null = null;
	let openQuoted = false;
	for (const line of lines) {
		if (open !== null && openQuoted && !QUOTED.test(line)) open = null;
		const fence = FENCE.exec(line)?.[1];
		if (!fence) continue;
		if (open === null) {
			open = fence;
			openQuoted = QUOTED.test(line);
		} else if (fence[0] === open[0] && fence.length >= open.length) {
			open = null;
		}
	}
	if (open !== null && openQuoted && !QUOTED.test(current)) open = null;
	return open === null && LIST_LINE.test(current);
}
