import { describe, expect, it } from "vitest";

import {
	canReuseCachedEmbeddings,
	formatEta,
	summarizeValidationProgressCounts,
} from "../../src/vectorstore/VectorStoreService";
import { getDefaultEmbeddingBatchSize, normalizeEmbeddingBatchSize } from "../../src/vectorstore/batchSize";

describe("embedding batch size helpers", () => {
	it("returns provider-specific defaults", () => {
		expect(getDefaultEmbeddingBatchSize("ollama")).toBe(10);
		expect(getDefaultEmbeddingBatchSize("omlx")).toBe(10);
		expect(getDefaultEmbeddingBatchSize("openai")).toBe(100);
		expect(getDefaultEmbeddingBatchSize("custom-provider")).toBe(50);
	});

	it("normalizes invalid custom values", () => {
		expect(normalizeEmbeddingBatchSize(undefined, "openai")).toBe(100);
		expect(normalizeEmbeddingBatchSize(0, "openai")).toBe(1);
		expect(normalizeEmbeddingBatchSize(99999, "openai")).toBe(2048);
	});
});

describe("summarizeValidationProgressCounts", () => {
	it("preserves already indexed files when resuming validation indexing", () => {
		expect(
			summarizeValidationProgressCounts({
				eligibleFileCount: 3000,
				pendingFileCount: 1000,
				validPendingFileCount: 1000,
			}),
		).toEqual({
			startingIndexedCount: 2000,
			totalCount: 3000,
		});
	});

	it("reduces the final total when some pending files are later skipped", () => {
		expect(
			summarizeValidationProgressCounts({
				eligibleFileCount: 3000,
				pendingFileCount: 1000,
				validPendingFileCount: 900,
			}),
		).toEqual({
			startingIndexedCount: 2000,
			totalCount: 2900,
		});
	});
});

describe("formatEta", () => {
	it("formats sub-minute durations in seconds", () => {
		expect(formatEta(5_000)).toBe("5s");
		expect(formatEta(59_000)).toBe("59s");
	});

	it("rounds up so in-flight work never reads as 0s", () => {
		expect(formatEta(200)).toBe("1s");
		expect(formatEta(0)).toBe("1s");
	});

	it("formats minutes and hours", () => {
		expect(formatEta(90_000)).toBe("2m");
		expect(formatEta(60 * 60_000)).toBe("1h");
		expect(formatEta(72 * 60_000)).toBe("1h 12m");
	});
});

/*
 * The embeddings instance is cached per index for the whole plugin session, and
 * it bakes in the credentials it was built with. Reuse therefore has to consider
 * the registry's credential generation, not just provider/model ids — otherwise a
 * rotated API key or an edited baseUrl keeps being used until Obsidian restarts,
 * failing silently (an embed call just 401s).
 *
 * This is the same defect the `authGen` term fixed in the agent's runnable cache.
 * `getEmbeddingsForInstance` is private and only reachable through index init, so
 * the rule is extracted here to be directly assertable — without a seam the guard
 * could be deleted without failing anything.
 */
describe("canReuseCachedEmbeddings", () => {
	const cached = { providerId: "openai", modelId: "text-embedding-3-small", authGeneration: 7 };
	const want = { provider: "openai", model: "text-embedding-3-small" };

	it("reuses when provider, model and credentials are all unchanged", () => {
		expect(canReuseCachedEmbeddings(cached, want, 7)).toBe(true);
	});

	it("rebuilds after a credential change, even with identical ids", () => {
		// The rotation case: same provider, same model, new key.
		expect(canReuseCachedEmbeddings(cached, want, 8)).toBe(false);
	});

	it("rebuilds when the provider changes", () => {
		expect(canReuseCachedEmbeddings(cached, { provider: "ollama", model: want.model }, 7)).toBe(false);
	});

	it("rebuilds when the model changes", () => {
		expect(canReuseCachedEmbeddings(cached, { provider: want.provider, model: "other" }, 7)).toBe(false);
	});

	it("never reuses a never-populated cache slot", () => {
		// A fresh IndexInstance starts with all three null.
		expect(canReuseCachedEmbeddings({ providerId: null, modelId: null, authGeneration: null }, want, 0)).toBe(
			false,
		);
	});

	it("does not treat a null generation as matching generation 0", () => {
		// Guards the sentinel: `null` means "never built", which must not collide with
		// the registry's initial generation of 0.
		expect(canReuseCachedEmbeddings({ ...cached, authGeneration: null }, want, 0)).toBe(false);
	});
});
