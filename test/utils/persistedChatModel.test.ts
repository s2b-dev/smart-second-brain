import { describe, expect, it, vi } from "vitest";
import type { HydratedChatModelMetadata } from "../../src/types/modelMetadata";

const mockHydratedChatModelsByKey = new Map<string, Partial<HydratedChatModelMetadata>>();
let mockOverrides: Record<string, number> = {};

vi.mock("../../src/hooks/useAvailableModels.svelte", () => ({
	useAvailableModels: () => ({
		hydratedChatModelsByKey: mockHydratedChatModelsByKey,
	}),
}));

vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => ({
		getModelContextOverride: (key: string) => mockOverrides[key],
	}),
}));

import { buildPersistedChatModel } from "../../src/utils/persistedChatModel";

describe("buildPersistedChatModel", () => {
	it("preserves custom contextWindow if existing model matches", () => {
		mockHydratedChatModelsByKey.set("custom:qwen3.8", {
			contextWindow: 128000,
			capabilities: { vision: false },
		});

		const existing = {
			provider: "custom",
			model: "qwen3.8",
			modelConfig: {
				contextWindow: 41000,
				supportsVision: false,
			},
		};

		const result = buildPersistedChatModel("custom", "qwen3.8", existing);
		expect(result.modelConfig.contextWindow).toBe(41000);
	});

	it("uses hydrated contextWindow when switching to a different model", () => {
		mockHydratedChatModelsByKey.set("custom:other-model", {
			contextWindow: 64000,
			capabilities: { vision: true },
		});

		const existing = {
			provider: "custom",
			model: "qwen3.8",
			modelConfig: {
				contextWindow: 41000,
				supportsVision: false,
			},
		};

		const result = buildPersistedChatModel("custom", "other-model", existing);
		expect(result.modelConfig.contextWindow).toBe(64000);
		expect(result.modelConfig.supportsVision).toBe(true);
	});

	it("defaults to 128000 when no existing config or hydrated metadata exists", () => {
		mockHydratedChatModelsByKey.clear();

		const result = buildPersistedChatModel("custom", "unknown-model", null);
		expect(result.modelConfig.contextWindow).toBe(128000);
	});

	it("prioritizes modelContextOverrides over hydrated and existing contextWindow", () => {
		mockOverrides["custom:override-model"] = 991808;
		mockHydratedChatModelsByKey.set("custom:override-model", {
			contextWindow: 64000,
		});

		const existing = {
			provider: "custom",
			model: "override-model",
			modelConfig: {
				contextWindow: 32000,
			},
		};

		const result = buildPersistedChatModel("custom", "override-model", existing);
		expect(result.modelConfig.contextWindow).toBe(991808);
	});
});
