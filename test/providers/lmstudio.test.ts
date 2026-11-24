/**
 * LM Studio: model discovery through the native REST API (v1, then v0, then `/v1/models`),
 * the metadata it records for hydration, and the message shown when the server isn't running.
 */

import { requestUrl } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateChatModel, hydrateEmbeddingModel } from "../../src/lib/modelMetadataNormalizer";
import { createLmStudioProvider } from "../../src/providers/lmstudio";
import {
	classifyOpenAIModelIds,
	getLmStudioModel,
	parseV0Models,
	parseV1Models,
} from "../../src/providers/lmstudioModels";

/** Trimmed from the example in LM Studio's `/api/v1/models` docs. */
const V1_RESPONSE = {
	models: [
		{
			type: "llm",
			key: "google/gemma-4-26b-a4b",
			display_name: "Gemma 4 26B A4B",
			quantization: { name: "Q4_K_M", bits_per_weight: 4 },
			params_string: "26B-A4B",
			loaded_instances: [{ id: "google/gemma-4-26b-a4b", config: { context_length: 4096 } }],
			max_context_length: 262144,
			capabilities: { vision: true, trained_for_tool_use: true },
		},
		{
			type: "llm",
			key: "deepseek-r1",
			display_name: "DeepSeek R1",
			loaded_instances: [],
			max_context_length: 131072,
			capabilities: { vision: false, trained_for_tool_use: true },
		},
		{
			type: "embedding",
			key: "text-embedding-nomic-embed-text-v1.5-embedding",
			display_name: "Nomic Embed Text v1.5",
			loaded_instances: [],
			max_context_length: 2048,
		},
		{ type: "decision", key: "some-classifier", loaded_instances: [], max_context_length: null },
	],
};

/** Trimmed from the example in LM Studio's `/api/v0/models` docs. */
const V0_RESPONSE = {
	object: "list",
	data: [
		{
			id: "qwen2-vl-7b-instruct",
			type: "vlm",
			quantization: "4bit",
			state: "not-loaded",
			max_context_length: 32768,
		},
		{
			id: "meta-llama-3.1-8b-instruct",
			type: "llm",
			state: "loaded",
			max_context_length: 131072,
			loaded_context_length: 8192,
			capabilities: ["tool_use"],
		},
		{ id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings", max_context_length: 2048 },
	],
};

type FakeResponse = { status: number; json?: unknown; text?: string };

/** Routes requestUrl by path suffix; anything unrouted answers like an older LM Studio does. */
function serve(routes: Record<string, FakeResponse | Error>): void {
	vi.mocked(requestUrl).mockImplementation((async (req: { url: string }) => {
		const path = new URL(req.url).pathname;
		const route = routes[path];
		if (route instanceof Error) throw route;
		return route ?? { status: 200, json: { error: `Unexpected endpoint or method. (GET ${path})` }, text: "" };
	}) as never);
}

const auth = { baseUrl: "http://localhost:1234" };

describe("parseV1Models", () => {
	it("splits chat from embedding models and drops decision models", () => {
		const models = parseV1Models(V1_RESPONSE);
		expect(models.map((m) => [m.id, m.kind])).toEqual([
			["google/gemma-4-26b-a4b", "chat"],
			["deepseek-r1", "chat"],
			["text-embedding-nomic-embed-text-v1.5-embedding", "embedding"],
		]);
	});

	it("uses the loaded context length when loaded, the maximum otherwise", () => {
		const [gemma, deepseek, nomic] = parseV1Models(V1_RESPONSE);
		expect(gemma.contextLength).toBe(4096);
		expect(deepseek.contextLength).toBe(131072);
		expect(nomic.contextLength).toBe(2048);
	});

	it("takes the smallest window across several loaded instances", () => {
		const [model] = parseV1Models({
			models: [
				{
					type: "llm",
					key: "m",
					loaded_instances: [{ config: { context_length: 16384 } }, { config: { context_length: 8192 } }],
					max_context_length: 32768,
				},
			],
		});
		expect(model.contextLength).toBe(8192);
	});

	it("reads vision and tool capabilities", () => {
		const [gemma, deepseek, nomic] = parseV1Models(V1_RESPONSE);
		expect([gemma.supportsVision, gemma.supportsTools]).toEqual([true, true]);
		expect(deepseek.supportsVision).toBe(false);
		expect(nomic.supportsVision).toBeUndefined();
	});
});

describe("parseV0Models", () => {
	it("treats vlm as a vision chat model and embeddings as embedding", () => {
		const models = parseV0Models(V0_RESPONSE);
		expect(models.map((m) => [m.id, m.kind, m.supportsVision])).toEqual([
			["qwen2-vl-7b-instruct", "chat", true],
			["meta-llama-3.1-8b-instruct", "chat", false],
			["text-embedding-nomic-embed-text-v1.5", "embedding", undefined],
		]);
	});

	it("uses loaded_context_length for a loaded model", () => {
		const [qwen, llama] = parseV0Models(V0_RESPONSE);
		expect(qwen.contextLength).toBe(32768);
		expect(llama.contextLength).toBe(8192);
		expect(llama.supportsTools).toBe(true);
	});
});

describe("classifyOpenAIModelIds", () => {
	it("classifies embedding models by name", () => {
		expect(classifyOpenAIModelIds(["qwen3-8b", "text-embedding-qwen3-embedding-0.6b", " "])).toEqual([
			{ id: "qwen3-8b", kind: "chat", loaded: false },
			{ id: "text-embedding-qwen3-embedding-0.6b", kind: "embedding", loaded: false },
		]);
	});
});

describe("LM Studio discovery", () => {
	beforeEach(() => {
		vi.mocked(requestUrl).mockReset();
	});

	it("prefers /api/v1/models and records metadata for hydration", async () => {
		serve({ "/api/v1/models": { status: 200, json: V1_RESPONSE } });
		const provider = createLmStudioProvider("lm-studio", "LM Studio");

		expect(await provider.discoverModels(auth)).toEqual(["google/gemma-4-26b-a4b", "deepseek-r1"]);
		expect(await provider.discoverEmbeddingModels?.(auth)).toEqual([
			"text-embedding-nomic-embed-text-v1.5-embedding",
		]);

		const chat = hydrateChatModel("lm-studio", "google/gemma-4-26b-a4b", { templateId: "lmstudio" });
		expect(chat.displayName).toBe("Gemma 4 26B A4B");
		expect(chat.contextWindow).toBe(4096);
		expect(chat.capabilities.vision).toBe(true);
		expect(chat.quantization).toBe("Q4_K_M");

		const embed = hydrateEmbeddingModel("lm-studio", "text-embedding-nomic-embed-text-v1.5-embedding");
		expect(embed.maxInputTokens).toBe(2048);
	});

	it("falls back to /api/v0/models on LM Studio 0.3.x", async () => {
		serve({
			"/api/v1/models": { status: 404, text: "Not Found" },
			"/api/v0/models": { status: 200, json: V0_RESPONSE },
		});
		const provider = createLmStudioProvider("lm-studio-v0", "LM Studio");

		expect(await provider.discoverModels(auth)).toEqual(["qwen2-vl-7b-instruct", "meta-llama-3.1-8b-instruct"]);
		expect(getLmStudioModel("lm-studio-v0", "qwen2-vl-7b-instruct")?.supportsVision).toBe(true);
	});

	it("falls back to /v1/models when the native API answers with an error body", async () => {
		serve({
			"/v1/models": { status: 200, json: { data: [{ id: "qwen3-8b" }, { id: "text-embedding-bge-m3" }] } },
		});
		const provider = createLmStudioProvider("lm-studio-old", "LM Studio");

		expect(await provider.discoverModels(auth)).toEqual(["qwen3-8b"]);
		expect(await provider.discoverEmbeddingModels?.(auth)).toEqual(["text-embedding-bge-m3"]);
	});

	it("accepts a server URL pasted with /v1 and sends the API token", async () => {
		serve({ "/api/v1/models": { status: 200, json: V1_RESPONSE } });
		const provider = createLmStudioProvider("lm-studio-token", "LM Studio");

		await provider.discoverModels({ baseUrl: "http://localhost:1234/v1/", apiKey: "lms-token" });
		const [request] = vi.mocked(requestUrl).mock.calls[0] as unknown as [
			{ url: string; headers: Record<string, string> },
		];
		expect(request.url).toBe("http://localhost:1234/api/v1/models");
		expect(request.headers.Authorization).toBe("Bearer lms-token");
	});

	it("says where to turn the server on when nothing is listening", async () => {
		serve({ "/api/v1/models": new Error("net::ERR_CONNECTION_REFUSED") });
		const provider = createLmStudioProvider("lm-studio-off", "LM Studio");

		await expect(provider.discoverModels(auth)).rejects.toThrow(/localhost:1234.*Developer/);
	});
});

describe("LM Studio validateAuth", () => {
	beforeEach(() => {
		vi.mocked(requestUrl).mockReset();
	});

	it("is valid when /v1/models answers", async () => {
		serve({ "/v1/models": { status: 200, json: { data: [] } } });
		const provider = createLmStudioProvider("lm-studio", "LM Studio");
		expect(await provider.validateAuth(auth)).toEqual({ valid: true });
	});

	it("reports a stopped server with the setup hint, not a raw fetch error", async () => {
		serve({ "/v1/models": new Error("net::ERR_CONNECTION_REFUSED") });
		const provider = createLmStudioProvider("lm-studio", "LM Studio");
		const result = await provider.validateAuth(auth);
		expect(result.valid).toBe(false);
		expect(!result.valid && result.error).toMatch(/Developer/);
		expect(!result.valid && result.error).not.toMatch(/ERR_CONNECTION_REFUSED/);
	});

	it("reports a rejected API token", async () => {
		serve({ "/v1/models": { status: 401, json: { error: "Invalid API token" } } });
		const provider = createLmStudioProvider("lm-studio", "LM Studio");
		expect(await provider.validateAuth(auth)).toEqual({ valid: false, error: "Invalid API token" });
	});
});
