/**
 * Google Gemini provider: model discovery (chat vs embedding split), key validation,
 * the embeddings client (task types, batching, failures), and the metadata the model
 * picker shows for Gemini models.
 */

import * as obsidian from "obsidian";
import type { RequestUrlParam, requestUrl } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateChatModel, hydrateEmbeddingModel } from "../../src/lib/modelMetadataNormalizer";
import { createGoogleProvider, GeminiEmbeddings } from "../../src/providers/google";
import { getCachedGeminiModels, populateGeminiCache } from "../../src/providers/googleModels";
import { isDocumentRejectionError } from "../../src/lib/transportErrors";

const AUTH = { apiKey: "test-key" };
/** Instances are named after their display name, so the id says nothing about the vendor. */
const PROVIDER_ID = "google-gemini";
const googleProvider = createGoogleProvider(PROVIDER_ID, "Google Gemini");

const CATALOG = [
	{
		name: "models/gemini-2.5-flash",
		displayName: "Gemini 2.5 Flash",
		inputTokenLimit: 1048576,
		supportedGenerationMethods: ["generateContent", "countTokens", "createCachedContent", "batchGenerateContent"],
	},
	{
		name: "models/gemini-flash-latest",
		displayName: "Gemini Flash Latest",
		inputTokenLimit: 1048576,
		supportedGenerationMethods: ["generateContent", "countTokens"],
	},
	{
		name: "models/gemini-2.5-flash-preview-tts",
		displayName: "Gemini 2.5 Flash Preview TTS",
		supportedGenerationMethods: ["countTokens", "generateContent"],
	},
	{
		name: "models/gemini-2.5-flash-image",
		displayName: "Nano Banana",
		supportedGenerationMethods: ["generateContent", "countTokens"],
	},
	{
		name: "models/gemini-embedding-001",
		displayName: "Gemini Embedding 001",
		inputTokenLimit: 2048,
		supportedGenerationMethods: ["embedContent", "countTextTokens", "countTokens", "asyncBatchEmbedContent"],
	},
	{
		name: "models/imagen-4.0-generate-001",
		displayName: "Imagen 4",
		supportedGenerationMethods: ["predict"],
	},
];

let requestUrlMock: ReturnType<typeof vi.mocked<typeof requestUrl>>;
let requests: RequestUrlParam[];

/** Queue the responses requestUrl returns, in call order, recording each request. */
function queueResponses(...responses: Array<{ status: number; json: unknown }>) {
	for (const response of responses) {
		requestUrlMock.mockImplementationOnce(((param: RequestUrlParam) => {
			requests.push(param);
			return Promise.resolve({ ...response, text: JSON.stringify(response.json) });
		}) as unknown as typeof requestUrl);
	}
}

beforeEach(() => {
	requestUrlMock = vi.mocked(obsidian.requestUrl);
	requestUrlMock.mockReset();
	requests = [];
	populateGeminiCache(PROVIDER_ID, []);
});

describe("model discovery", () => {
	it("lists text chat models and embedding models separately", async () => {
		queueResponses({ status: 200, json: { models: CATALOG } }, { status: 200, json: { models: CATALOG } });

		expect(await googleProvider.discoverModels(AUTH)).toEqual(["gemini-2.5-flash", "gemini-flash-latest"]);
		expect(await googleProvider.discoverEmbeddingModels?.(AUTH)).toEqual(["gemini-embedding-001"]);
	});

	it("follows page tokens and sends the key as a header, never in the URL", async () => {
		queueResponses(
			{ status: 200, json: { models: CATALOG.slice(0, 1), nextPageToken: "page-2" } },
			{ status: 200, json: { models: CATALOG.slice(4, 5) } },
		);

		await googleProvider.discoverModels(AUTH);

		expect(requests).toHaveLength(2);
		expect(requests[1].url).toContain("pageToken=page-2");
		for (const request of requests) {
			expect(request.url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?")).toBe(true);
			expect(request.url).not.toContain("test-key");
			expect(request.headers?.["x-goog-api-key"]).toBe("test-key");
		}
		expect([...getCachedGeminiModels(PROVIDER_ID).keys()]).toEqual(["gemini-2.5-flash", "gemini-embedding-001"]);
	});

	it("uses a custom base URL", async () => {
		queueResponses({ status: 200, json: { models: [] } });
		await googleProvider.discoverModels({ ...AUTH, baseUrl: "http://localhost:6655/gemini/" });
		expect(requests[0].url.startsWith("http://localhost:6655/gemini/v1beta/models?")).toBe(true);
	});

	it("surfaces the API's error message", async () => {
		queueResponses({ status: 403, json: { error: { message: "Permission denied" } } });
		await expect(googleProvider.discoverModels(AUTH)).rejects.toThrow("Permission denied");
	});
});

describe("validateAuth", () => {
	it("requires a key", async () => {
		expect((await googleProvider.validateAuth({})).valid).toBe(false);
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("accepts a key the models list answers", async () => {
		queueResponses({ status: 200, json: { models: [] } });
		expect(await googleProvider.validateAuth(AUTH)).toEqual({ valid: true });
	});

	it("reports an invalid key, which Gemini answers with 400", async () => {
		queueResponses({
			status: 400,
			json: { error: { message: "API key not valid. Please pass a valid API key." } },
		});
		expect(await googleProvider.validateAuth(AUTH)).toEqual({
			valid: false,
			error: "API key not valid. Please pass a valid API key.",
		});
	});
});

describe("GeminiEmbeddings", () => {
	function fakeFetch(handler: (body: { requests: Array<{ taskType: string }> }) => Response) {
		const calls: Array<{ url: string; body: { requests: Array<{ taskType: string; model: string }> } }> = [];
		const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			calls.push({ url: String(input), body });
			return handler(body);
		}) as unknown as typeof fetch;
		return { fetchFn, calls };
	}

	function vectorsFor(body: { requests: unknown[] }) {
		return new Response(JSON.stringify({ embeddings: body.requests.map((_, i) => ({ values: [i, 1] })) }), {
			status: 200,
		});
	}

	it("tags documents and queries with their own task types", async () => {
		const { fetchFn, calls } = fakeFetch(vectorsFor);
		const embeddings = new GeminiEmbeddings(AUTH, "models/gemini-embedding-001", { fetch: fetchFn });

		expect(await embeddings.embedDocuments(["a", "b"])).toEqual([
			[0, 1],
			[1, 1],
		]);
		expect(await embeddings.embedQuery("q")).toEqual([0, 1]);

		expect(calls[0].url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
		);
		expect(calls[0].body.requests.map((r) => r.taskType)).toEqual(["RETRIEVAL_DOCUMENT", "RETRIEVAL_DOCUMENT"]);
		expect(calls[0].body.requests[0].model).toBe("models/gemini-embedding-001");
		expect(calls[1].body.requests.map((r) => r.taskType)).toEqual(["RETRIEVAL_QUERY"]);
	});

	it("splits documents into batches of 100", async () => {
		const { fetchFn, calls } = fakeFetch(vectorsFor);
		const embeddings = new GeminiEmbeddings(AUTH, "gemini-embedding-001", { fetch: fetchFn });

		const vectors = await embeddings.embedDocuments(Array.from({ length: 250 }, (_, i) => `doc ${i}`));

		expect(vectors).toHaveLength(250);
		expect(calls.map((c) => c.body.requests.length)).toEqual([100, 100, 50]);
	});

	it("throws on a failed batch instead of returning empty vectors, without retrying a 4xx", async () => {
		const { fetchFn, calls } = fakeFetch(
			() =>
				new Response(JSON.stringify({ error: { message: "Request payload size exceeds the limit" } }), {
					status: 400,
				}),
		);
		const embeddings = new GeminiEmbeddings(AUTH, "gemini-embedding-001", { fetch: fetchFn });

		const error = await embeddings.embedDocuments(["a"]).catch((e: unknown) => e);
		expect(String(error)).toContain("Request payload size exceeds the limit");
		expect(isDocumentRejectionError(error)).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it("reports an invalid key as an auth failure, not a rejected document", async () => {
		const { fetchFn, calls } = fakeFetch(
			() =>
				new Response(
					JSON.stringify({
						error: {
							code: 400,
							message: "API key not valid. Please pass a valid API key.",
							status: "INVALID_ARGUMENT",
							details: [
								{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
							],
						},
					}),
					{ status: 400 },
				),
		);
		const embeddings = new GeminiEmbeddings(AUTH, "gemini-embedding-001", { fetch: fetchFn });

		const error = await embeddings.embedDocuments(["a"]).catch((e: unknown) => e);
		expect((error as { status?: number }).status).toBe(401);
		// The indexer keeps a note retryable unless the error rejects the document itself.
		expect(isDocumentRejectionError(error)).toBe(false);
		expect(calls).toHaveLength(1);
	});

	it("throws when the reply is missing vectors", async () => {
		const { fetchFn } = fakeFetch(
			() => new Response(JSON.stringify({ embeddings: [{ values: [] }] }), { status: 200 }),
		);
		const embeddings = new GeminiEmbeddings(AUTH, "gemini-embedding-001", { fetch: fetchFn, maxRetries: 0 });

		await expect(embeddings.embedDocuments(["a"])).rejects.toThrow("empty vector");
	});
});

describe("chat instance", () => {
	it("accepts images for any model id, leaving the call to the plugin's per-model capability", () => {
		const chat = googleProvider.createChatInstance(AUTH, "models/gemini-flash-latest", { temperature: 0.3 });
		const model = chat as unknown as { model: string; temperature: number; _isMultimodalModel: boolean };
		expect(model.model).toBe("gemini-flash-latest");
		expect(model.temperature).toBe(0.3);
		expect(model._isMultimodalModel).toBe(true);
	});
});

describe("model metadata", () => {
	it("takes names, limits and thinking from the Gemini catalog, and leaves vision unknown", () => {
		populateGeminiCache(PROVIDER_ID, [{ ...CATALOG[0], thinking: true }, CATALOG[4]]);
		const chat = hydrateChatModel(PROVIDER_ID, "gemini-2.5-flash", { templateId: "google" });
		expect(chat.displayName).toBe("Gemini 2.5 Flash");
		expect(chat.contextWindow).toBe(1048576);
		expect(chat.capabilities.reasoning).toBe(true);
		// The catalog doesn't report image input; the Agent editor's toggle covers it.
		expect(chat.capabilities.vision).toBeUndefined();

		const embedding = hydrateEmbeddingModel(PROVIDER_ID, "gemini-embedding-001", { templateId: "google" });
		expect(embedding.displayName).toBe("Gemini Embedding 001");
		expect(embedding.maxInputTokens).toBe(2048);
	});

	it("keeps each instance's catalog apart", () => {
		populateGeminiCache(PROVIDER_ID, CATALOG);
		populateGeminiCache("gemini-gateway", [{ ...CATALOG[0], inputTokenLimit: 32768 }]);
		const own = hydrateChatModel(PROVIDER_ID, "gemini-2.5-flash", { templateId: "google" });
		const gateway = hydrateChatModel("gemini-gateway", "gemini-2.5-flash", { templateId: "google" });
		expect(own.contextWindow).toBe(1048576);
		expect(gateway.contextWindow).toBe(32768);
	});

	it("reports nothing it wasn't told before discovery has run", () => {
		const chat = hydrateChatModel(PROVIDER_ID, "gemini-2.5-flash", { templateId: "google" });
		expect(chat.contextWindow).toBeUndefined();
		expect(chat.displayName).toBe("gemini-2.5-flash");
	});
});
