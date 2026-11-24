import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HydratedChatModelMetadata } from "../../src/types/modelMetadata";

const hydratedChatModelsByKey = new Map<string, HydratedChatModelMetadata>();

vi.mock("../../src/hooks/useAvailableModels.svelte", () => ({
	useAvailableModels: () => ({ hydratedChatModelsByKey }),
}));

import { buildPersistedChatModel } from "../../src/utils/persistedChatModel";

function hydrated(provider: string, variantKey: string, contextWindow: number | undefined, vision?: boolean) {
	hydratedChatModelsByKey.set(`${provider}:${variantKey}`, {
		kind: "chat",
		provider,
		variantKey,
		displayName: variantKey,
		contextWindow,
		capabilities: { vision },
	});
}

describe("buildPersistedChatModel", () => {
	beforeEach(() => {
		hydratedChatModelsByKey.clear();
	});

	it("keeps a stored context window when the same model is re-picked (#542)", () => {
		hydrated("ollama", "qwen3:8b", 128000);
		const existing = { provider: "ollama", model: "qwen3:8b", modelConfig: { contextWindow: 16384 } };

		const result = buildPersistedChatModel("ollama", "qwen3:8b", existing);

		expect(result.modelConfig.contextWindow).toBe(16384);
	});

	it("takes the catalogue context window when a different model is picked", () => {
		hydrated("ollama", "llama3.2:3b", 131072);
		const existing = { provider: "ollama", model: "qwen3:8b", modelConfig: { contextWindow: 16384 } };

		const result = buildPersistedChatModel("ollama", "llama3.2:3b", existing);

		expect(result.modelConfig.contextWindow).toBe(131072);
	});

	it("treats the same model name on another provider as a different model", () => {
		hydrated("openrouter", "qwen3:8b", 40960);
		const existing = { provider: "ollama", model: "qwen3:8b", modelConfig: { contextWindow: 16384 } };

		const result = buildPersistedChatModel("openrouter", "qwen3:8b", existing);

		expect(result.modelConfig.contextWindow).toBe(40960);
	});

	it("uses the catalogue value when the same model has no stored context window", () => {
		hydrated("ollama", "qwen3:8b", 40960);
		const existing = { provider: "ollama", model: "qwen3:8b", modelConfig: {} };

		const result = buildPersistedChatModel("ollama", "qwen3:8b", existing);

		expect(result.modelConfig.contextWindow).toBe(40960);
	});

	it("stores 128000 when the provider reports no window, never another model's value", () => {
		hydrated("openai", "gpt-5.4", undefined);
		const existing = { provider: "ollama", model: "qwen3:8b", modelConfig: { contextWindow: 16384 } };

		expect(buildPersistedChatModel("openai", "gpt-5.4", existing).modelConfig.contextWindow).toBe(128000);
		expect(buildPersistedChatModel("ollama", "llama3.2:3b", null).modelConfig.contextWindow).toBe(128000);
	});

	it("keeps the stored image-input setting and temperature when the same model is re-picked", () => {
		hydrated("ollama", "qwen3:8b", 40960, true);
		const existing = {
			provider: "ollama",
			model: "qwen3:8b",
			modelConfig: { contextWindow: 16384, supportsVision: false, temperature: 0.2 },
		};

		const result = buildPersistedChatModel("ollama", "qwen3:8b", existing);

		expect(result.modelConfig).toEqual({ contextWindow: 16384, supportsVision: false, temperature: 0.2 });
	});

	it("takes image input from the provider for a different model, and leaves it unknown when unreported", () => {
		hydrated("ollama", "llava:7b", 4096, true);
		hydrated("openai", "gpt-5.4", undefined);
		const existing = {
			provider: "ollama",
			model: "qwen3:8b",
			modelConfig: { contextWindow: 16384, supportsVision: true },
		};

		expect(buildPersistedChatModel("ollama", "llava:7b", existing).modelConfig.supportsVision).toBe(true);
		expect(buildPersistedChatModel("openai", "gpt-5.4", existing).modelConfig.supportsVision).toBeUndefined();
	});

	it("keeps the reasoning effort on a re-pick and drops it for a different model", () => {
		const existing = {
			provider: "anthropic",
			model: "claude-opus-5-5",
			modelConfig: { contextWindow: 1000000, reasoningEffort: "high" as const },
		};

		expect(buildPersistedChatModel("anthropic", "claude-opus-5-5", existing).modelConfig.reasoningEffort).toBe(
			"high",
		);
		expect(
			buildPersistedChatModel("anthropic", "claude-haiku-4-5", existing).modelConfig.reasoningEffort,
		).toBeUndefined();
	});
});
