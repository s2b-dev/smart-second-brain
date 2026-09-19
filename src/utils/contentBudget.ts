/**
 * Dynamic content budgeting.
 *
 * Several tools inject free-form text into the model's context — a note read by
 * `read_content`, a passage the user selected in the editor. Left unbounded, a
 * single huge note or selection can blow past the model's context window (or
 * dominate it, crowding out the conversation). Rather than hard-code a fixed
 * character cap, we derive one from the active model's context window so a
 * large-context model gets a generous budget and a small one stays safe.
 *
 * Pure module: no Obsidian / DOM deps so it is trivially unit-testable.
 */

/** Approximate chars per token — mirrors the vectorstore's own estimate. */
export const CHARS_PER_TOKEN = 4;

/** Fallback context window (tokens) when the model reports none. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Fraction of the context window a single injected content blob may occupy.
 * The remainder is headroom for the system prompt, conversation history, other
 * context blocks, and the model's response. A read note is a large payload, so
 * it gets a bigger slice than a transient selection.
 */
export const READ_CONTENT_BUDGET_FRACTION = 0.5;
export const SELECTION_BUDGET_FRACTION = 0.25;

/**
 * A directory listing is orientation, not content: it should never dominate the window the
 * way a read note may. The fraction keeps small models safe; the absolute ceiling stops a
 * million-token model from being handed a fifty-thousand-token folder tree it will never use.
 */
export const LIST_DIRECTORY_BUDGET_FRACTION = 0.05;
export const LIST_DIRECTORY_MAX_CHARS = 40_000;

/** Never derive a cap below this many chars, even for a tiny context window. */
const MIN_CHAR_BUDGET = 4_000;

/**
 * Convert a model context window (in tokens) into a character budget for a
 * single injected content blob.
 *
 * @param contextWindow Model context window in tokens (undefined/0 → default).
 * @param fraction Share of the window this blob may occupy (0–1).
 * @returns A positive character cap, floored at `MIN_CHAR_BUDGET`.
 */
export function contextWindowToCharBudget(contextWindow: number | undefined, fraction: number): number {
	const tokens = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
	const budget = Math.floor(tokens * fraction * CHARS_PER_TOKEN);
	return Math.max(MIN_CHAR_BUDGET, budget);
}

/**
 * Truncate `text` to `maxChars`, appending a visible marker when cut.
 * Returns the text unchanged when it already fits (or `maxChars <= 0`).
 */
export function truncateToBudget(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
	const marker = `\n\n... [truncated at ${maxChars} characters]`;
	const keep = Math.max(0, maxChars - marker.length);
	return { text: `${text.slice(0, keep)}${marker}`, truncated: true };
}
