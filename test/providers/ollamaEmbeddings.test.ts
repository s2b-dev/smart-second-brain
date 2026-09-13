/**
 * Ollama embedding transport: retry policy and request shape.
 *
 * Regression coverage for #485 — a permanent HTTP 400 ("the input length
 * exceeds the context length") was retried six times with exponential backoff
 * because the Ollama client reports the status as `status_code`, which
 * LangChain's default retry handler does not read.
 */

import { describe, expect, it, vi } from "vitest";
import { createTransportedOllamaEmbeddings, ollamaEmbedFailedAttempt } from "../../src/providers/chatProviders";
import { ollamaProvider } from "../../src/providers/ollama";
import { OLLAMA_EMBED_NUM_CTX } from "../../src/providers/ollamaModels";

function ollamaError(status_code: number, message = "the input length exceeds the context length") {
	const error = new Error(message);
	error.name = "ResponseError";
	return Object.assign(error, { error: message, status_code });
}

describe("ollamaEmbedFailedAttempt", () => {
	it("stops retrying on a 4xx Ollama ResponseError", () => {
		const error = ollamaError(400);
		expect(() => ollamaEmbedFailedAttempt(error)).toThrow(error);
		expect(() => ollamaEmbedFailedAttempt(ollamaError(404, "model not found"))).toThrow();
	});

	it("keeps retrying on 5xx and transport failures", () => {
		expect(() => ollamaEmbedFailedAttempt(ollamaError(500, "model runner has unexpectedly stopped"))).not.toThrow();
		expect(() => ollamaEmbedFailedAttempt(new TypeError("fetch failed"))).not.toThrow();
		expect(() => ollamaEmbedFailedAttempt(undefined)).not.toThrow();
	});

	it("never retries a cancellation", () => {
		expect(() => ollamaEmbedFailedAttempt(new DOMException("Indexing cancelled", "AbortError"))).toThrow();
		expect(() => ollamaEmbedFailedAttempt(new Error("Cancel: aborted"))).toThrow();
	});
});

describe("createTransportedOllamaEmbeddings", () => {
	it("issues exactly one request when the server rejects the input with 400", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "the input length exceeds the context length" }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		);
		const embeddings = createTransportedOllamaEmbeddings({
			model: "qwen3-embedding:4b",
			baseUrl: "http://localhost:11434",
			fetch: fetchMock as unknown as typeof fetch,
		});

		await expect(embeddings.embedDocuments(["a very long chunk"])).rejects.toThrow(/exceeds the context length/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("ollamaProvider.createEmbeddingInstance", () => {
	it("pins num_ctx to the chunk budget and truncates as a backstop", () => {
		const embeddings = ollamaProvider.createEmbeddingInstance({ baseUrl: "http://localhost:11434/" }, "m");
		expect(embeddings).toMatchObject({
			truncate: true,
			requestOptions: { num_ctx: OLLAMA_EMBED_NUM_CTX },
		});
	});
});
