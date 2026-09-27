const LIST_LINE = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])(?:\s|$)/;
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
	// character and is at least as long (CommonMark).
	let open: string | null = null;
	for (const line of lines) {
		const fence = FENCE.exec(line)?.[1];
		if (!fence) continue;
		if (open === null) open = fence;
		else if (fence[0] === open[0] && fence.length >= open.length) open = null;
	}
	return open === null && LIST_LINE.test(current);
}
