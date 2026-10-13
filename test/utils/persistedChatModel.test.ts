import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HydratedChatModelMetadata } from "../../src/types/modelMetadata";

const hydratedChatModelsByKey = new Map<string, HydratedChatModelMetadata>();

vi.mock("../../src/hooks/useAvailableModels.svelte", () => ({
	useAvailableModels: () => ({ hydratedChatModelsByKey }),
}));

import { buildPersistedChatModel } from "../../src/utils/persistedChatModel";

function hydrated(provider: string, variantKey: string, contextWindow: number, vision?: boolean) {
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

	it("falls back to the previous value, then 128000, when the catalogue has no entry", () => {
		const existing = { provider: "ollama", model: "qwen3:8b", modelConfig: { contextWindow: 16384 } };

		expect(buildPersistedChatModel("ollama", "llama3.2:3b", existing).modelConfig.contextWindow).toBe(16384);
		expect(buildPersistedChatModel("ollama", "llama3.2:3b", null).modelConfig.contextWindow).toBe(128000);
	});

	it("follows the catalogue for vision and keeps the stored temperature", () => {
		hydrated("ollama", "qwen3:8b", 40960, true);
		const existing = {
			provider: "ollama",
			model: "qwen3:8b",
			modelConfig: { contextWindow: 16384, supportsVision: false, temperature: 0.2 },
		};

		const result = buildPersistedChatModel("ollama", "qwen3:8b", existing);

		expect(result.modelConfig).toEqual({ contextWindow: 16384, supportsVision: true, temperature: 0.2 });
	});
});
