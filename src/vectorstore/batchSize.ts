export const MIN_EMBEDDING_BATCH_SIZE = 1;
export const MAX_EMBEDDING_BATCH_SIZE = 2048;

/**
 * Upper bound on the text sent in one embedding request, in characters.
 *
 * The batch size counts *chunks*, and a chunk may be as long as the model's
 * whole input window (`maxInputTokens × 3` chars, ~24k for an 8191-token
 * model). A full batch of long chunks therefore reached a million characters
 * and more in one request — beyond OpenAI's per-request token cap, and far
 * beyond what a shared, slower endpoint answers inside the 60 s request
 * timeout (observed: every batch timing out against an academic OpenAI-
 * compatible host that embeds a short batch in about a second). ~120k chars
 * (~30–40k tokens) keeps a request well inside both while still letting
 * batches of short chunks run at the full batch size.
 */
export const MAX_EMBEDDING_BATCH_CHARS = 120_000;

/**
 * Take the next batch off the front of `pending`: at most `batchSize` entries
 * and at most `maxChars` characters of text, but always at least one entry, so
 * a single oversized chunk still goes out (alone) instead of stalling the run.
 */
export function takeEmbeddingBatch<T>(
	pending: T[],
	batchSize: number,
	textOf: (entry: T) => string,
	maxChars: number = MAX_EMBEDDING_BATCH_CHARS,
): T[] {
	let count = 0;
	let chars = 0;
	while (count < pending.length && count < batchSize) {
		const length = textOf(pending[count]).length;
		if (count > 0 && chars + length > maxChars) break;
		chars += length;
		count++;
	}
	return pending.splice(0, count);
}

/** True when `pending` holds a full batch by either measure. */
export function hasFullEmbeddingBatch<T>(
	pending: T[],
	batchSize: number,
	textOf: (entry: T) => string,
	maxChars: number = MAX_EMBEDDING_BATCH_CHARS,
): boolean {
	if (pending.length >= batchSize) return true;
	let chars = 0;
	for (const entry of pending) {
		chars += textOf(entry).length;
		if (chars >= maxChars) return true;
	}
	return false;
}

export function getDefaultEmbeddingBatchSize(providerId: string): number {
	switch (providerId) {
		case "openai":
		case "openrouter":
			return 100;
		case "omlx":
		case "ollama":
			return 10;
		default:
			return 50;
	}
}

export function normalizeEmbeddingBatchSize(value: number | null | undefined, providerId: string): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed)) {
		return getDefaultEmbeddingBatchSize(providerId);
	}

	return Math.min(MAX_EMBEDDING_BATCH_SIZE, Math.max(MIN_EMBEDDING_BATCH_SIZE, Math.trunc(parsed)));
}
