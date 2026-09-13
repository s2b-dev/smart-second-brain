import { describe, expect, it } from "vitest";
import {
	lookupModelInfoSync,
	type ModelsDevApiResponse,
	type ModelsDevModelInfo,
} from "../../src/providers/modelsDevApi";

function model(id: string, name: string): ModelsDevModelInfo {
	return { id, name };
}

function catalogue(providerId: string, models: Record<string, ModelsDevModelInfo>): ModelsDevApiResponse {
	return {
		[providerId]: {
			id: providerId,
			name: providerId,
			models,
		},
	};
}

/** Insertion order matters: it is the order `Object.values` will iterate. */
function multiProviderCatalogue(
	...entries: [providerId: string, models: Record<string, ModelsDevModelInfo>][]
): ModelsDevApiResponse {
	const out: ModelsDevApiResponse = {};
	for (const [providerId, models] of entries) {
		out[providerId] = { id: providerId, name: providerId, models };
	}
	return out;
}

describe("lookupModelInfoSync", () => {
	it("returns exact key matches", () => {
		const data = catalogue("anthropic", {
			"claude-sonnet-4-5": model("claude-sonnet-4-5", "Claude Sonnet 4.5"),
		});
		expect(lookupModelInfoSync(data, "anthropic", "claude-sonnet-4-5")?.name).toBe("Claude Sonnet 4.5");
	});

	it("matches punctuation variants of the same version via normalization", () => {
		const data = catalogue("anthropic", {
			"claude-3.5-sonnet": model("claude-3.5-sonnet", "Claude 3.5 Sonnet"),
		});
		expect(lookupModelInfoSync(data, "anthropic", "claude-3-5-sonnet")?.name).toBe("Claude 3.5 Sonnet");
	});

	it("does not fuzzy-match a sibling with a different version", () => {
		const data = catalogue("anthropic", {
			"claude-sonnet-4-5": model("claude-sonnet-4-5", "Claude Sonnet 4.5"),
		});
		expect(lookupModelInfoSync(data, "anthropic", "claude-sonnet-4")).toBeNull();
	});

	it("does not fuzzy-match across version letters and digits", () => {
		const data = catalogue("openai", {
			"gpt-4o": model("gpt-4o", "GPT-4o"),
		});
		expect(lookupModelInfoSync(data, "openai", "gpt-4.1")).toBeNull();
	});

	it("does not fuzzy-match a different model number", () => {
		const data = catalogue("openai", {
			o3: model("o3", "o3"),
		});
		expect(lookupModelInfoSync(data, "openai", "o1")).toBeNull();
	});

	it("does not fuzzy-match a typo, even with identical digits", () => {
		const data = catalogue("anthropic", {
			"claude-sonnet-4-5": model("claude-sonnet-4-5", "Claude Sonnet 4.5"),
		});
		expect(lookupModelInfoSync(data, "anthropic", "claude-sonet-4-5")).toBeNull();
	});

	it("matches the same id written with different separators", () => {
		const data = catalogue("qwen", {
			"qwen3-8b": model("qwen3-8b", "Qwen3 8B"),
		});
		expect(lookupModelInfoSync(data, "custom-instance-1", "qwen3:8b")?.name).toBe("Qwen3 8B");
		expect(lookupModelInfoSync(data, "custom-instance-1", "Qwen3-8B")?.name).toBe("Qwen3 8B");
	});

	it("does not match an id that is one edit away from a catalogue entry (#480)", () => {
		const data = catalogue("qwen", {
			"qwen3-8b": model("qwen3-8b", "Qwen3 8B"),
		});
		// "qwen3.8" normalizes to "qwen38", one character short of "qwen38b". The size suffix
		// is meaning, not a typo; the model must keep its own name and metadata.
		expect(lookupModelInfoSync(data, "custom-instance-1", "qwen3.8")).toBeNull();
	});

	describe("cross-provider fallback precedence", () => {
		// An unmapped provider id (a user-created openai-compatible instance, e.g. SAP HAI)
		// goes straight to the cross-provider scan.
		const UNMAPPED = "custom-instance-1";

		it("prefers an exact id in a later provider over a fuzzy hit in an earlier one", () => {
			const data = multiProviderCatalogue(
				[
					"digitalocean",
					{ "anthropic-claude-4.1-opus": model("anthropic-claude-4.1-opus", "Anthropic Claude 4.1 Opus") },
				],
				[
					"sap-ai-core",
					{ "anthropic--claude-4.6-opus": model("anthropic--claude-4.6-opus", "anthropic--claude-4.6-opus") },
				],
			);
			expect(lookupModelInfoSync(data, UNMAPPED, "anthropic--claude-4.6-opus")?.name).toBe(
				"anthropic--claude-4.6-opus",
			);
		});

		it("prefers an exact id in a later provider over a normalized hit in an earlier one", () => {
			const data = multiProviderCatalogue(
				[
					"digitalocean",
					{
						"anthropic-claude-4.5-sonnet": model(
							"anthropic-claude-4.5-sonnet",
							"Anthropic Claude 4.5 Sonnet",
						),
					},
				],
				[
					"sap-ai-core",
					{
						"anthropic--claude-4.5-sonnet": model(
							"anthropic--claude-4.5-sonnet",
							"anthropic--claude-4.5-sonnet",
						),
					},
				],
			);
			expect(lookupModelInfoSync(data, UNMAPPED, "anthropic--claude-4.5-sonnet")?.name).toBe(
				"anthropic--claude-4.5-sonnet",
			);
		});

		it("falls back to a normalized match when no provider holds the exact id", () => {
			const data = multiProviderCatalogue([
				"digitalocean",
				{ "anthropic-claude-4.5-opus": model("anthropic-claude-4.5-opus", "Anthropic Claude 4.5 Opus") },
			]);
			expect(lookupModelInfoSync(data, UNMAPPED, "anthropic--claude-4.5-opus")?.name).toBe(
				"Anthropic Claude 4.5 Opus",
			);
		});
	});
});
