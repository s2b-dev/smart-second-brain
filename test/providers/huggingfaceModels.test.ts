/**
 * Hugging Face router catalog: which models are listed, and the metadata the model
 * picker shows for them (name, context window, capabilities).
 */

import { describe, expect, it } from "vitest";
import { hydrateChatModel } from "../../src/lib/modelMetadataNormalizer";
import { huggingFaceDisplayName, populateHuggingFaceCache } from "../../src/providers/huggingfaceModels";

const CATALOG = [
	{
		id: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8",
		architecture: { input_modalities: ["text"] },
		providers: [{ status: "live", context_length: 262144, supports_tools: true }],
	},
	{
		id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
		architecture: { input_modalities: ["text"] },
		providers: [
			{ status: "live", context_length: 262144, supports_tools: true, supports_structured_output: true },
			// No tool support: never serves a request with tools, so its window doesn't count.
			{ status: "live", context_length: 8192, supports_tools: null },
		],
	},
	{
		id: "google/gemma-4-31B-it",
		architecture: { input_modalities: ["text", "image"] },
		providers: [
			{ status: "live", context_length: 131072, supports_tools: true },
			{ status: "live", context_length: 65536, supports_tools: true },
		],
	},
	{
		id: "acme/no-tools",
		providers: [{ status: "live", context_length: 4096, supports_tools: false }],
	},
	{
		id: "acme/offline",
		providers: [{ status: "error", context_length: 4096, supports_tools: true }],
	},
];

describe("populateHuggingFaceCache", () => {
	it("lists only models a live provider serves with tool calling", () => {
		expect(populateHuggingFaceCache(CATALOG)).toEqual([
			"google/gemma-4-31B-it",
			"nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
			"nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8",
		]);
	});
});

describe("hydrateChatModel for a Hugging Face instance", () => {
	populateHuggingFaceCache(CATALOG);
	const hydrate = (id: string, provider = "hf-work") => hydrateChatModel(provider, id, { templateId: "huggingface" });

	it("never shows the owner prefix", () => {
		expect(hydrate("nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8").displayName).toBe(
			"NVIDIA Nemotron 3 Super 120B A12B FP8",
		);
	});

	it("takes the context window from the router", () => {
		expect(hydrate("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16").contextWindow).toBe(262144);
	});

	it("uses the smallest window among the tool-capable providers", () => {
		expect(hydrate("google/gemma-4-31B-it").contextWindow).toBe(65536);
	});

	it("reports capabilities from the router, and reasoning as unknown", () => {
		expect(hydrate("google/gemma-4-31B-it").capabilities).toMatchObject({ toolCalls: true, vision: true });
		expect(hydrate("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16").capabilities).toMatchObject({
			toolCalls: true,
			vision: false,
			structuredOutput: true,
		});
		expect(hydrate("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16").capabilities.reasoning).toBeUndefined();
	});

	it("leaves other providers' models alone", () => {
		const custom = hydrateChatModel("together", "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8", {
			templateId: "openai-compatible",
		});
		expect(custom.displayName).toBe("nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8");
		expect(custom.contextWindow).toBeUndefined();
	});
});

describe("huggingFaceDisplayName", () => {
	it("drops the owner and spaces out the repo name", () => {
		expect(huggingFaceDisplayName("meta-llama/Llama-3.1-8B-Instruct")).toBe("Llama 3.1 8B Instruct");
		expect(huggingFaceDisplayName("no-owner_model")).toBe("no owner model");
	});
});
