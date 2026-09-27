/**
 * Whether a line is a Markdown list item — bullet (`-`, `*`, `+`), ordered
 * (`1.`, `1)`), task (`- [ ]`), optionally indented or inside a blockquote.
 * These are the lines on which Obsidian's own Enter continues the list.
 */
export function isMarkdownListLine(line: string): boolean {
	return /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])(?:\s|$)/.test(line);
}
