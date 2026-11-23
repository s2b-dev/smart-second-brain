/**
 * What an OpenAI-compatible endpoint reports about its own models (context windows, LiteLLM's
 * capability flags), and how hydration reads it (#479).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { hydrateChatModel, hydrateEmbeddingModel } from "../../src/lib/modelMetadataNormalizer";
import { createOpenAICompatibleProvider, MODEL_INFO_TIMEOUT_MS } from "../../src/providers/openai-compatible";
import {
	extractCompatibleModelInfo,
	getCompatibleModelInfo,
	setCompatibleModelInfo,
} from "../../src/providers/openaiCompatibleModels";

const windowOf = (providerId: string, modelId: string) => getCompatibleModelInfo(providerId, modelId)?.contextWindow;
const windows = (info: Map<string, { contextWindow?: number }>) =>
	Object.fromEntries([...info].map(([id, model]) => [id, model.contextWindow]));

describe("extractCompatibleModelInfo", () => {
	it("reads each server's limit field from /v1/models", () => {
		const info = extractCompatibleModelInfo([
			{ id: "sglang-model", max_model_len: 262144 },
			{ id: "together-model", context_length: 131072 },
			{ id: "groq-model", context_window: "32768" },
			{ id: "mistral-model", max_context_length: 65536 },
			{ id: "no-limit" },
			{ id: "bad-limit", max_model_len: 0 },
		]);
		expect(windows(info)).toEqual({
			"sglang-model": 262144,
			"together-model": 131072,
			"groq-model": 32768,
			"mistral-model": 65536,
		});
	});

	it("takes LiteLLM's configured max_input_tokens, the smallest across deployments", () => {
		const info = extractCompatibleModelInfo(
			[{ id: "my-alias", max_model_len: 1_000_000 }, { id: "other" }],
			[
				{ model_name: "my-alias", model_info: { max_input_tokens: 200000 } },
				{ model_name: "my-alias", model_info: { max_input_tokens: 160000 } },
				{ model_name: "other", model_info: null },
			],
		);
		expect(windows(info)).toEqual({ "my-alias": 160000 });
	});

	// Shaped like a live LiteLLM proxy (2026-11-23): `supports_vision` is left out for models
	// that do take images, and no deployment carries `supports_reasoning`.
	it("reads LiteLLM's capability flags, treating a missing or null flag as unknown", () => {
		const info = extractCompatibleModelInfo(
			[],
			[
				{
					model_name: "claude-haiku-4-5",
					model_info: { max_input_tokens: 200000, supports_vision: true, supports_function_calling: true },
				},
				{ model_name: "gpt-4.1", model_info: { max_input_tokens: 128000, supports_function_calling: true } },
				{
					model_name: "reasoner",
					model_info: { supports_reasoning: true, supports_response_schema: false, supports_vision: null },
				},
				{ model_name: "text-embedding-3-large", model_info: { max_input_tokens: 8192 } },
			],
		);
		expect(info.get("claude-haiku-4-5")).toEqual({ contextWindow: 200000, vision: true, toolCalls: true });
		expect(info.get("gpt-4.1")).toEqual({ contextWindow: 128000, toolCalls: true });
		expect(info.get("reasoner")).toEqual({ reasoning: true, structuredOutput: false });
		expect(info.get("text-embedding-3-large")).toEqual({ contextWindow: 8192 });
	});

	it("gives a model a capability only when every deployment that reports it has it", () => {
		const info = extractCompatibleModelInfo(
			[],
			[
				{ model_name: "routed", model_info: { supports_vision: true, supports_function_calling: false } },
				{ model_name: "routed", model_info: { supports_vision: false, supports_function_calling: true } },
				{ model_name: "routed", model_info: {} },
			],
		);
		expect(info.get("routed")).toEqual({ vision: false, toolCalls: false });
	});
});

describe("hydrateChatModel for openai-compatible", () => {
	beforeEach(() => setCompatibleModelInfo("litellm", new Map()));

	it("takes the window and capabilities the endpoint reports", () => {
		setCompatibleModelInfo(
			"litellm",
			new Map([["my-alias", { contextWindow: 200000, vision: true, toolCalls: true }]]),
		);
		const model = hydrateChatModel("litellm", "my-alias", { templateId: "openai-compatible" });
		expect(model.contextWindow).toBe(200000);
		expect(model.capabilities).toMatchObject({ vision: true, toolCalls: true });
		expect(model.capabilities.reasoning).toBeUndefined();
	});

	it("leaves the window unknown when the endpoint reports nothing", () => {
		const model = hydrateChatModel("litellm", "my-alias", { templateId: "openai-compatible" });
		expect(model.contextWindow).toBeUndefined();
		expect(model.capabilities.vision).toBeUndefined();
	});

	it("ignores the cache for other templates", () => {
		setCompatibleModelInfo("litellm", new Map([["my-alias", { contextWindow: 200000 }]]));
		expect(hydrateChatModel("litellm", "my-alias", { templateId: "openai" }).contextWindow).toBeUndefined();
	});

	it("sizes an embedding model's input budget from the endpoint", () => {
		setCompatibleModelInfo("litellm", new Map([["my-embedder", { contextWindow: 2048 }]]));
		expect(
			hydrateEmbeddingModel("litellm", "my-embedder", { templateId: "openai-compatible" }).maxInputTokens,
		).toBe(2048);
		expect(
			hydrateEmbeddingModel("litellm", "other-embedder", { templateId: "openai-compatible" }).maxInputTokens,
		).toBe(8191);
	});
});

describe("openai-compatible discoverModels", () => {
	const auth = { baseUrl: "http://localhost:4000", apiKey: "sk-test" };

	it("caches what /v1/models and LiteLLM's /v1/model/info report", async () => {
		vi.mocked(requestUrl).mockImplementation((async (req: { url: string }) => {
			if (req.url.endsWith("/v1/models")) {
				return { status: 200, json: { data: [{ id: "my-alias" }, { id: "local", max_model_len: 8192 }] } };
			}
			return {
				status: 200,
				json: {
					data: [{ model_name: "my-alias", model_info: { max_input_tokens: 200000, supports_vision: true } }],
				},
			};
		}) as never);
		const provider = createOpenAICompatibleProvider({ id: "litellm-a", displayName: "LiteLLM" });
		expect(await provider.discoverModels?.(auth)).toEqual(["my-alias", "local"]);
		expect(getCompatibleModelInfo("litellm-a", "my-alias")).toEqual({ contextWindow: 200000, vision: true });
		expect(windowOf("litellm-a", "local")).toBe(8192);
	});

	it("treats a missing /v1/model/info as no info, not a discovery failure", async () => {
		vi.mocked(requestUrl).mockImplementation((async (req: { url: string }) => {
			if (req.url.endsWith("/v1/models")) {
				return { status: 200, json: { data: [{ id: "plain" }] } };
			}
			return { status: 404, text: "Not Found", json: null };
		}) as never);
		const provider = createOpenAICompatibleProvider({ id: "plain-server", displayName: "Plain" });
		expect(await provider.discoverModels?.(auth)).toEqual(["plain"]);
		expect(windowOf("plain-server", "plain")).toBeUndefined();
	});

	it("lists models without /v1/model/info when that request never answers", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(requestUrl).mockImplementation(((req: { url: string }) =>
				req.url.endsWith("/v1/models")
					? Promise.resolve({ status: 200, json: { data: [{ id: "slow", max_model_len: 4096 }] } })
					: new Promise(() => {})) as never);
			const provider = createOpenAICompatibleProvider({ id: "slow-server", displayName: "Slow" });
			const discovery = provider.discoverModels?.(auth);
			await vi.advanceTimersByTimeAsync(MODEL_INFO_TIMEOUT_MS);
			expect(await discovery).toEqual(["slow"]);
			expect(windowOf("slow-server", "slow")).toBe(4096);
		} finally {
			vi.useRealTimers();
		}
	});
});
