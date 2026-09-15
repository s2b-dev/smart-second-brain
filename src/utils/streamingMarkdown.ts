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
const FENCE = /^\s{0,3}(?:```|~~~)/;
const MATH_DELIMITER = /\$\$/g;

function startsNewBlock(line: string, previous: string | null): boolean {
	if (INDENTED_CODE.test(line)) return false;
	if (previous === null) return true;
	const previousIsListContext = LIST_ITEM.test(previous) || LEADING_WHITESPACE.test(previous);
	if (previousIsListContext && (LIST_ITEM.test(line) || LEADING_WHITESPACE.test(line))) return false;
	if (BLOCKQUOTE.test(previous) && BLOCKQUOTE.test(line)) return false;
	return true;
}

export function findSealableEnd(remainder: string): number {
	let inFence = false;
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
			if (!inFence && !inMath) blankSincePrevious = true;
		} else {
			if (blankSincePrevious && !inFence && !inMath && startsNewBlock(line, previousNonBlank)) {
				sealable = lineStart;
			}
			blankSincePrevious = false;
			if (FENCE.test(line)) {
				inFence = !inFence;
			} else if (!inFence) {
				const delimiters = line.match(MATH_DELIMITER)?.length ?? 0;
				if (delimiters % 2 === 1) inMath = !inMath;
			}
			previousNonBlank = line;
		}
		lineStart = newline + 1;
	}
	return sealable;
}
