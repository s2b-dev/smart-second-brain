/**
 * Embedding transport: retry policy and request shape.
 *
 * Regression coverage for #485 — a permanent HTTP 400 ("the input length
 * exceeds the context length") was retried six times with exponential backoff
 * because the Ollama client reports the status as `status_code`, which
 * LangChain's default retry handler does not read — and for the unreachable
 * case: a stopped local server was retried through the whole backoff budget
 * (a minute or two per call) before the indexer learned of it.
 */

import { describe, expect, it, vi } from "vitest";
import {
	createTransportedOllamaEmbeddings,
	createTransportedOpenAIEmbeddings,
	embedFailedAttempt,
} from "../../src/providers/chatProviders";
import { ollamaProvider } from "../../src/providers/ollama";
import { OLLAMA_EMBED_NUM_CTX } from "../../src/providers/ollamaModels";

function ollamaError(status_code: number, message = "the input length exceeds the context length") {
	const error = new Error(message);
	error.name = "ResponseError";
	return Object.assign(error, { error: message, status_code });
}

describe("embedFailedAttempt", () => {
	it("stops retrying on a 4xx Ollama ResponseError", () => {
		const error = ollamaError(400);
		expect(() => embedFailedAttempt(error)).toThrow(error);
		expect(() => embedFailedAttempt(ollamaError(404, "model not found"))).toThrow();
	});

	it("stops retrying when nothing is listening, or the request already timed out", () => {
		expect(() => embedFailedAttempt(new Error("net::ERR_CONNECTION_REFUSED"))).toThrow();
		const cause = Object.assign(new Error("connect ECONNREFUSED ::1:11434"), { code: "ECONNREFUSED" });
		expect(() => embedFailedAttempt(new TypeError("fetch failed", { cause }))).toThrow();
		expect(() => embedFailedAttempt(new DOMException("Request timed out after 60000ms", "TimeoutError"))).toThrow();
		const sdkTimeout = new Error("Request timed out.");
		sdkTimeout.name = "APIConnectionTimeoutError";
		expect(() => embedFailedAttempt(sdkTimeout)).toThrow();
	});

	it("keeps the default backoff for blips: 5xx, resets, a generic network failure", () => {
		expect(() => embedFailedAttempt(ollamaError(500, "model runner has unexpectedly stopped"))).not.toThrow();
		expect(() => embedFailedAttempt(Object.assign(new Error("Bad gateway"), { status: 502 }))).not.toThrow();
		expect(() => embedFailedAttempt(new Error("socket hang up"))).not.toThrow();
		expect(() => embedFailedAttempt(new TypeError("fetch failed"))).not.toThrow();
		expect(() => embedFailedAttempt(undefined)).not.toThrow();
	});

	it("delegates the rest to LangChain's default rules: a 4xx the OpenAI client reports is not retried", () => {
		expect(() => embedFailedAttempt(Object.assign(new Error("Bad request"), { status: 400 }))).toThrow();
	});

	it("never retries a cancellation", () => {
		expect(() => embedFailedAttempt(new DOMException("Indexing cancelled", "AbortError"))).toThrow();
		expect(() => embedFailedAttempt(new Error("Cancel: aborted"))).toThrow();
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

describe("createTransportedOpenAIEmbeddings", () => {
	it("issues exactly one request when the connection is refused", async () => {
		// What Electron's network stack throws through Obsidian's `requestUrl`
		// for a server that is not running; the OpenAI client wraps it.
		const fetchMock = vi.fn(async () => {
			throw new Error("net::ERR_CONNECTION_REFUSED");
		});
		const embeddings = createTransportedOpenAIEmbeddings({
			model: "harrier-oss-v1-0.6b-MLX-8bit",
			apiKey: "not-required",
			configuration: { baseURL: "http://localhost:1/v1", fetch: fetchMock as unknown as typeof fetch },
		});

		await expect(embeddings.embedDocuments(["a chunk"])).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("createTransportedOpenAIEmbeddings — timeout", () => {
	it("issues exactly one request when the fetch times out", async () => {
		// `obsidianFetch` rejects with a `TimeoutError` DOMException; the OpenAI
		// client turns it into its own `APIConnectionTimeoutError` (the original
		// on `cause`) before LangChain's retry sees it. A named `Error` stands in
		// for the DOMException here: jsdom's is not an `Error` subclass, which the
		// SDK's `castToError` flattens to an empty `Error("{}")` — an artefact
		// Electron and WebKit, where DOMException extends Error, do not have.
		const fetchMock = vi.fn(async () => {
			throw Object.assign(new Error("Request timed out after 60000ms"), { name: "TimeoutError" });
		});
		const embeddings = createTransportedOpenAIEmbeddings({
			model: "text-embedding-3-small",
			apiKey: "not-required",
			configuration: { baseURL: "http://localhost:1/v1", fetch: fetchMock as unknown as typeof fetch },
		});

		await expect(embeddings.embedDocuments(["a chunk"])).rejects.toThrow(/timed out/i);
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
