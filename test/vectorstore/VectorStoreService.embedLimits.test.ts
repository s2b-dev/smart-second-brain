import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Chunk sizing for an OpenAI-compatible embedder waits for that endpoint's model discovery
 * (its limits arrive with it), but only for a bounded time: `/v1/models` can stall while
 * `/v1/embeddings` works, and indexing must not stall with it.
 */

let limitsKnown = false;
let templateId = "openai-compatible";
let discover: () => Promise<string[]> = async () => [];
const discoverModels = vi.fn((_providerId: string) => discover());

vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => ({
		vaultSlug: "vault-1",
		getProviderTemplateId: () => templateId,
		getResolvedProviderAuth: () => null,
	}),
}));
vi.mock("../../src/providers/registrySync", () => ({ ensureProviderRegistered: () => true }));
vi.mock("../../src/providers/registry", () => ({
	getRegistry: () => ({ discoverModels: (id: string) => discoverModels(id) }),
}));
vi.mock("../../src/providers/openaiCompatibleModels", () => ({ hasCompatibleModelInfo: () => limitsKnown }));
vi.mock("../../src/providers/googleModels", () => ({ hasGeminiModelInfo: () => limitsKnown }));
vi.mock("../../src/lib/modelMetadataNormalizer", () => ({
	hydrateEmbeddingModel: () => ({ maxInputTokens: limitsKnown ? 512 : 8191 }),
}));

import { VectorStoreService } from "../../src/vectorstore/VectorStoreService";

interface Internals {
	getEmbeddingMaxInputTokens(inst: { maxInputTokensCache: unknown }, model: unknown): Promise<number>;
	isEmbedLimitProvisional(providerId: string): boolean;
}

const MODEL = { provider: "gateway", model: "embed" };

function makeService(): Internals {
	const Ctor = VectorStoreService as unknown as new (plugin: unknown) => Internals;
	return new Ctor({ app: {} });
}

beforeEach(() => {
	vi.useFakeTimers();
	limitsKnown = false;
	templateId = "openai-compatible";
	discoverModels.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("embedding limits from OpenAI-compatible discovery", () => {
	it("uses the reported limit once discovery answers in time", async () => {
		discover = async () => {
			limitsKnown = true;
			return ["embed"];
		};
		const inst = { maxInputTokensCache: null };
		expect(await makeService().getEmbeddingMaxInputTokens(inst, MODEL)).toBe(512);
		expect(inst.maxInputTokensCache).toMatchObject({ maxInputTokens: 512 });
	});

	it("stops waiting on a stalled discovery and applies the limit once it lands", async () => {
		let finish: () => void = () => {};
		discover = () =>
			new Promise((resolve) => {
				finish = () => {
					limitsKnown = true;
					resolve(["embed"]);
				};
			});
		const service = makeService();
		const inst = { maxInputTokensCache: null };

		const first = service.getEmbeddingMaxInputTokens(inst, MODEL);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await first).toBe(8191);
		// The fallback is provisional: not memoized, and later batches don't wait again.
		expect(inst.maxInputTokensCache).toBeNull();
		expect(await service.getEmbeddingMaxInputTokens(inst, MODEL)).toBe(8191);
		expect(discoverModels).toHaveBeenCalledTimes(1);
		// Rejections of notes chunked now are not remembered as the note's fault.
		expect(service.isEmbedLimitProvisional("gateway")).toBe(true);

		finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(await service.getEmbeddingMaxInputTokens(inst, MODEL)).toBe(512);
		expect(discoverModels).toHaveBeenCalledTimes(1);
		expect(service.isEmbedLimitProvisional("gateway")).toBe(false);
	});

	it("memoizes the fallback after a failed discovery instead of retrying every batch", async () => {
		discover = async () => {
			throw new Error("offline");
		};
		const service = makeService();
		const inst = { maxInputTokensCache: null };
		expect(await service.getEmbeddingMaxInputTokens(inst, MODEL)).toBe(8191);
		expect(inst.maxInputTokensCache).toMatchObject({ maxInputTokens: 8191 });
		expect(discoverModels).toHaveBeenCalledTimes(1);
	});
});

describe("embedding limits from Gemini discovery", () => {
	it("waits for the catalog, whose embedding limit is far below the fallback", async () => {
		templateId = "google";
		discover = async () => {
			limitsKnown = true;
			return ["gemini-2.5-flash"];
		};
		const inst = { maxInputTokensCache: null };
		expect(await makeService().getEmbeddingMaxInputTokens(inst, MODEL)).toBe(512);
		expect(discoverModels).toHaveBeenCalledTimes(1);
	});

	it("doesn't wait for providers whose limits need no discovery", async () => {
		templateId = "ollama";
		const inst = { maxInputTokensCache: null };
		expect(await makeService().getEmbeddingMaxInputTokens(inst, MODEL)).toBe(8191);
		expect(discoverModels).not.toHaveBeenCalled();
	});
});
