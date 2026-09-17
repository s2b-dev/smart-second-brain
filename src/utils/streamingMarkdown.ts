/**
 * Streaming markdown is rendered in two parts: a *sealed* prefix whose DOM is never
 * touched again, and a live *tail* that is re-rendered as tokens arrive. Re-parsing
 * the whole accumulated reply on every frame costs O(length) per frame, so a long
 * reply stalls the main thread for its entire duration (#482); sealing keeps the
 * per-frame cost proportional to the current block only.
 *
 * `findSealableEnd` decides how much of `remainder` (the text after the current
 * sealed prefix) can be sealed. It returns an offset into `remainder`; 0 means
 * nothing new can be sealed yet. The sealed text always ends at a line start.
 *
 * A cut point is a blank line that is
 * - outside a fenced code block and outside a `$$` math block,
 * - followed by a *complete* line (terminated by "\n"), so a partial "-" is never
 *   misread as a list item or a rule, and
 * - not continuing the block above it: an indented line, a list item after a list
 *   item (a loose list would otherwise be split into two lists, restarting the
 *   numbering), or a blockquote after a blockquote.
 *
 * Splitting a document at such a point renders the same as the whole document
 * for everything except link-reference and footnote definitions, which are
 * resolved by the full render that happens once the reply settles.
 */

const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/;
const LEADING_WHITESPACE = /^\s+\S/;
const INDENTED_CODE = /^(?: {4}|\t)/;
const BLOCKQUOTE = /^\s{0,3}>/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
/** A `$$` block opens at a line start; anything else (`` `$$` ``, `costs $$5`) is inline. */
const MATH_OPEN = /^\s{0,3}\$\$/;
const MATH_CLOSE = /\$\$\s*$/;

interface Fence {
	char: string;
	length: number;
}

function startsNewBlock(line: string, previous: string | null): boolean {
	if (INDENTED_CODE.test(line)) return false;
	if (previous === null) return true;
	const previousIsListContext = LIST_ITEM.test(previous) || LEADING_WHITESPACE.test(previous);
	if (previousIsListContext && (LIST_ITEM.test(line) || LEADING_WHITESPACE.test(line))) return false;
	if (BLOCKQUOTE.test(previous) && BLOCKQUOTE.test(line)) return false;
	return true;
}

/** CommonMark: a closing fence uses the opening marker's character, at least as long, with no info string. */
function closesFence(line: string, fence: Fence): boolean {
	const match = CLOSING_FENCE.exec(line);
	return match !== null && match[1][0] === fence.char && match[1].length >= fence.length;
}

export function findSealableEnd(remainder: string): number {
	let fence: Fence | null = null;
	let inMath = false;
	let lineStart = 0;
	let previousNonBlank: string | null = null;
	let blankSincePrevious = false;
	let sealable = 0;

	while (lineStart < remainder.length) {
		const newline = remainder.indexOf("\n", lineStart);
		// The last, unterminated line is still being streamed: never classify it.
		if (newline === -1) break;
		const line = remainder.slice(lineStart, newline);
		const blank = line.trim() === "";

		if (blank) {
			if (fence === null && !inMath) blankSincePrevious = true;
		} else {
			if (fence !== null) {
				if (closesFence(line, fence)) fence = null;
			} else if (inMath) {
				if (MATH_CLOSE.test(line)) inMath = false;
			} else {
				if (blankSincePrevious && startsNewBlock(line, previousNonBlank)) sealable = lineStart;
				const opening = FENCE.exec(line);
				// CommonMark: a backtick fence's info string may not contain a backtick.
				if (opening && !(opening[1][0] === "`" && line.slice(opening[0].length).includes("`"))) {
					fence = { char: opening[1][0], length: opening[1].length };
				} else if (MATH_OPEN.test(line)) {
					// `$$x$$` on one line is already closed; a bare `$$` (or `$$x`) opens a block.
					const body = line.trim().slice(2);
					inMath = !(body.length > 0 && MATH_CLOSE.test(body));
				}
			}
			blankSincePrevious = false;
			previousNonBlank = line;
		}
		lineStart = newline + 1;
	}
	return sealable;
}
