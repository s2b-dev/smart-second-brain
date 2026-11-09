import { describe, expect, it } from "vitest";
import { MAX_EMBEDDING_BATCH_CHARS, hasFullEmbeddingBatch, takeEmbeddingBatch } from "../../src/vectorstore/batchSize";

const text = (s: string) => s;

describe("takeEmbeddingBatch", () => {
	it("takes up to batchSize short chunks", () => {
		const pending = Array.from({ length: 30 }, (_, i) => `chunk ${i}`);
		expect(takeEmbeddingBatch(pending, 20, text)).toHaveLength(20);
		expect(pending).toHaveLength(10);
	});

	it("caps a batch of long chunks by characters, not count", () => {
		const long = "x".repeat(24_000);
		const pending = Array.from({ length: 50 }, () => long);
		const batch = takeEmbeddingBatch(pending, 50, text);
		expect(batch.length).toBe(Math.floor(MAX_EMBEDDING_BATCH_CHARS / long.length));
		expect(batch.join("").length).toBeLessThanOrEqual(MAX_EMBEDDING_BATCH_CHARS);
	});

	it("always sends an oversized chunk alone instead of stalling", () => {
		const pending = ["y".repeat(MAX_EMBEDDING_BATCH_CHARS * 2), "small"];
		expect(takeEmbeddingBatch(pending, 50, text)).toHaveLength(1);
		expect(pending).toEqual(["small"]);
	});

	it("keeps order", () => {
		const pending = ["a", "b", "c"];
		expect(takeEmbeddingBatch(pending, 2, text)).toEqual(["a", "b"]);
	});
});

describe("hasFullEmbeddingBatch", () => {
	it("is full by count or by characters", () => {
		expect(hasFullEmbeddingBatch(["a", "b"], 2, text)).toBe(true);
		expect(hasFullEmbeddingBatch(["a"], 2, text)).toBe(false);
		expect(hasFullEmbeddingBatch(["z".repeat(MAX_EMBEDDING_BATCH_CHARS)], 50, text)).toBe(true);
	});
});
