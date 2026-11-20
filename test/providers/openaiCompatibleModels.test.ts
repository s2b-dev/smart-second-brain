/**
 * Context windows an OpenAI-compatible endpoint reports for its own models, and their
 * precedence over models.dev when a model is hydrated (#479).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { hydrateChatModel } from "../../src/lib/modelMetadataNormalizer";
import type { ModelsDevApiResponse } from "../../src/providers/modelsDevApi";
import { createOpenAICompatibleProvider, MODEL_INFO_TIMEOUT_MS } from "../../src/providers/openai-compatible";
import {
	extractContextWindows,
	getCompatibleContextWindow,
	setCompatibleContextWindows,
} from "../../src/providers/openaiCompatibleModels";

describe("extractContextWindows", () => {
	it("reads each server's limit field from /v1/models", () => {
		const windows = extractContextWindows([
			{ id: "sglang-model", max_model_len: 262144 },
			{ id: "together-model", context_length: 131072 },
			{ id: "groq-model", context_window: "32768" },
			{ id: "mistral-model", max_context_length: 65536 },
			{ id: "no-limit" },
			{ id: "bad-limit", max_model_len: 0 },
		]);
		expect(Object.fromEntries(windows)).toEqual({
			"sglang-model": 262144,
			"together-model": 131072,
			"groq-model": 32768,
			"mistral-model": 65536,
		});
	});

	it("takes LiteLLM's configured max_input_tokens, the smallest across deployments", () => {
		const windows = extractContextWindows(
			[{ id: "my-alias", max_model_len: 1_000_000 }, { id: "other" }],
			[
				{ model_name: "my-alias", model_info: { max_input_tokens: 200000 } },
				{ model_name: "my-alias", model_info: { max_input_tokens: 160000 } },
				{ model_name: "other", model_info: null },
			],
		);
		expect(Object.fromEntries(windows)).toEqual({ "my-alias": 160000 });
	});
});

/** models.dev "knows" the alias, under a much smaller window: the #479 symptom. */
const MODELS_DEV = {
	someprovider: { models: { "my-alias": { id: "my-alias", name: "My Alias", limit: { context: 32768 } } } },
} as unknown as ModelsDevApiResponse;

describe("hydrateChatModel for openai-compatible", () => {
	beforeEach(() => setCompatibleContextWindows("litellm", new Map()));

	it("prefers the endpoint's window over models.dev", () => {
		setCompatibleContextWindows("litellm", new Map([["my-alias", 200000]]));
		const model = hydrateChatModel("litellm", "my-alias", {
			modelsDevData: MODELS_DEV,
			templateId: "openai-compatible",
		});
		expect(model.contextWindow).toBe(200000);
	});

	it("falls back to models.dev when the endpoint reports nothing", () => {
		const model = hydrateChatModel("litellm", "my-alias", {
			modelsDevData: MODELS_DEV,
			templateId: "openai-compatible",
		});
		expect(model.contextWindow).toBe(32768);
	});

	it("ignores the cache for other templates", () => {
		setCompatibleContextWindows("litellm", new Map([["my-alias", 200000]]));
		const model = hydrateChatModel("litellm", "my-alias", { modelsDevData: MODELS_DEV, templateId: "openai" });
		expect(model.contextWindow).toBe(32768);
	});
});

describe("openai-compatible discoverModels", () => {
	const auth = { baseUrl: "http://localhost:4000", apiKey: "sk-test" };

	it("caches windows from /v1/models and LiteLLM's /v1/model/info", async () => {
		vi.mocked(requestUrl).mockImplementation((async (req: { url: string }) => {
			if (req.url.endsWith("/v1/models")) {
				return { status: 200, json: { data: [{ id: "my-alias" }, { id: "local", max_model_len: 8192 }] } };
			}
			return {
				status: 200,
				json: { data: [{ model_name: "my-alias", model_info: { max_input_tokens: 200000 } }] },
			};
		}) as never);
		const provider = createOpenAICompatibleProvider({ id: "litellm-a", displayName: "LiteLLM" });
		expect(await provider.discoverModels?.(auth)).toEqual(["my-alias", "local"]);
		expect(getCompatibleContextWindow("litellm-a", "my-alias")).toBe(200000);
		expect(getCompatibleContextWindow("litellm-a", "local")).toBe(8192);
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
		expect(getCompatibleContextWindow("plain-server", "plain")).toBeUndefined();
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
			expect(getCompatibleContextWindow("slow-server", "slow")).toBe(4096);
		} finally {
			vi.useRealTimers();
		}
	});
});
