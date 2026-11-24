import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * LM Studio's embedding limit is the length the model is loaded with, which changes when the
 * user reloads it. Chunk sizing must follow it: not memoized, and the listing re-read in the
 * background at most once a minute.
 */

let loadedLimit = 2048;
const discoverModels = vi.fn(async (_providerId: string) => ["embed"]);

vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => ({
		vaultSlug: "vault-1",
		getProviderTemplateId: () => "lmstudio",
		getResolvedProviderAuth: () => null,
	}),
}));
vi.mock("../../src/providers/registrySync", () => ({ ensureProviderRegistered: () => true }));
vi.mock("../../src/providers/registry", () => ({
	getRegistry: () => ({ discoverModels: (id: string) => discoverModels(id) }),
}));
vi.mock("../../src/providers/lmstudioModels", () => ({ hasLmStudioModels: () => true }));
vi.mock("../../src/lib/modelMetadataNormalizer", () => ({
	hydrateEmbeddingModel: () => ({ maxInputTokens: loadedLimit }),
}));

import { VectorStoreService } from "../../src/vectorstore/VectorStoreService";

interface Internals {
	getEmbeddingMaxInputTokens(inst: { maxInputTokensCache: unknown }, model: unknown): Promise<number>;
}

const MODEL = { provider: "lm-studio", model: "embed" };

function makeService(): Internals {
	const Ctor = VectorStoreService as unknown as new (plugin: unknown) => Internals;
	return new Ctor({ app: {} });
}

beforeEach(() => {
	vi.useFakeTimers();
	loadedLimit = 2048;
	discoverModels.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("embedding limits from LM Studio", () => {
	it("follows a reloaded model's limit instead of memoizing the first one", async () => {
		const service = makeService();
		const inst = { maxInputTokensCache: null };
		expect(await service.getEmbeddingMaxInputTokens(inst, MODEL)).toBe(2048);
		expect(inst.maxInputTokensCache).toBeNull();

		loadedLimit = 512;
		expect(await service.getEmbeddingMaxInputTokens(inst, MODEL)).toBe(512);
	});

	it("re-reads the listing at most once a minute", async () => {
		const service = makeService();
		const inst = { maxInputTokensCache: null };
		await service.getEmbeddingMaxInputTokens(inst, MODEL);
		await service.getEmbeddingMaxInputTokens(inst, MODEL);
		expect(discoverModels).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60_000);
		await service.getEmbeddingMaxInputTokens(inst, MODEL);
		expect(discoverModels).toHaveBeenCalledTimes(2);
	});
});
