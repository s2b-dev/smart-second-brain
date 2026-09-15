import { describe, expect, it } from "vitest";
import { hydrateEmbeddingModel } from "../../src/lib/modelMetadataNormalizer";
import { OLLAMA_EMBED_NUM_CTX, type OllamaModelInfo } from "../../src/providers/ollamaModels";

function ollamaData(name: string, contextLength: number | undefined): Map<string, OllamaModelInfo> {
	return new Map([[name, { name, contextLength, capabilities: [], supportsVision: false, supportsTools: false }]]);
}

describe("hydrateEmbeddingModel — Ollama input budget", () => {
	it("caps the advertised architecture context to the num_ctx the client sends", () => {
		// qwen3-embedding reports 40960 via /api/show; the server enforces num_ctx (#485).
		const model = hydrateEmbeddingModel("ollama", "qwen3-embedding:4b", {
			ollamaData: ollamaData("qwen3-embedding:4b", 40960),
		});
		expect(model.maxInputTokens).toBe(OLLAMA_EMBED_NUM_CTX);
	});

	it("keeps a smaller model context as-is", () => {
		const model = hydrateEmbeddingModel("ollama", "nomic-embed-text", {
			ollamaData: ollamaData("nomic-embed-text", 2048),
		});
		expect(model.maxInputTokens).toBe(2048);
	});

	it("caps the provider default too when /api/show has no context length", () => {
		const model = hydrateEmbeddingModel("ollama", "unknown-embed", {
			ollamaData: ollamaData("unknown-embed", undefined),
		});
		expect(model.maxInputTokens).toBeLessThanOrEqual(OLLAMA_EMBED_NUM_CTX);
	});

	it("leaves other providers uncapped", () => {
		const model = hydrateEmbeddingModel("openrouter", "some/embed", {
			openRouterData: new Map([
				["some/embed", { id: "some/embed", name: "Embed", context_length: 32768 } as never],
			]),
		});
		expect(model.maxInputTokens).toBe(32768);
	});
});
