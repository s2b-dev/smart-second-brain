/**
 * What Anthropic's `/v1/models` reports per model, and how the model picker reads it.
 */

import { describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { hydrateChatModel } from "../../src/lib/modelMetadataNormalizer";
import { discoverAnthropicModels } from "../../src/providers/anthropic";
import { getAnthropicModelInfo, populateAnthropicCache } from "../../src/providers/anthropicModels";

/** Entries shaped like the Models API: a full capability tree with `supported` at each leaf. */
const OPUS = {
	id: "claude-opus-4-8",
	display_name: "Claude Opus 4.8",
	max_input_tokens: 1_000_000,
	max_tokens: 128_000,
	capabilities: {
		image_input: { supported: true },
		structured_outputs: { supported: true },
		thinking: { supported: true, types: { enabled: { supported: false }, adaptive: { supported: true } } },
		effort: {
			supported: true,
			low: { supported: true },
			medium: { supported: true },
			high: { supported: true },
			xhigh: { supported: true },
			max: { supported: true },
		},
	},
};

/** Thinks, but takes no effort parameter: the case models.dev's `reasoning` flag got wrong (#582). */
const HAIKU = {
	id: "claude-haiku-4-5",
	display_name: "Claude Haiku 4.5",
	max_input_tokens: 200_000,
	max_tokens: 64_000,
	capabilities: {
		image_input: { supported: true },
		structured_outputs: { supported: true },
		thinking: { supported: true, types: { enabled: { supported: true }, adaptive: { supported: false } } },
		effort: { supported: false, low: { supported: false }, high: { supported: false } },
	},
};

/** What a proxy in front of the API may answer with (the SAP HAI proxy, 2026-11-23). */
const PROXIED = { id: "claude-sonnet-4-6", display_name: "Sonnet 4.6 (latest)", type: "model" };

describe("populateAnthropicCache", () => {
	it("reads the limits and capability tree of each model", () => {
		populateAnthropicCache("anthropic-a", [OPUS, HAIKU]);
		expect(getAnthropicModelInfo("anthropic-a", "claude-opus-4-8")).toEqual({
			id: "claude-opus-4-8",
			displayName: "Claude Opus 4.8",
			maxInputTokens: 1_000_000,
			maxOutputTokens: 128_000,
			vision: true,
			thinking: true,
			structuredOutput: true,
			effortLevels: ["low", "medium", "high", "xhigh", "max"],
		});
		expect(getAnthropicModelInfo("anthropic-a", "claude-haiku-4-5")?.effortLevels).toEqual([]);
	});

	it("leaves out what a proxy doesn't report", () => {
		populateAnthropicCache("proxy", [PROXIED]);
		expect(getAnthropicModelInfo("proxy", "claude-sonnet-4-6")).toEqual({
			id: "claude-sonnet-4-6",
			displayName: "Sonnet 4.6 (latest)",
			maxInputTokens: undefined,
			maxOutputTokens: undefined,
			vision: undefined,
			thinking: undefined,
			structuredOutput: undefined,
			effortLevels: undefined,
		});
	});

	it("keeps each provider instance's models apart", () => {
		populateAnthropicCache("direct", [OPUS]);
		populateAnthropicCache("proxy", [PROXIED]);
		expect(getAnthropicModelInfo("proxy", "claude-opus-4-8")).toBeUndefined();
	});
});

describe("hydrateChatModel for an Anthropic instance", () => {
	it("shows the reported name, window and capabilities", () => {
		populateAnthropicCache("work", [OPUS, HAIKU]);
		const opus = hydrateChatModel("work", "claude-opus-4-8", { templateId: "anthropic" });
		expect(opus.displayName).toBe("Claude Opus 4.8");
		expect(opus.contextWindow).toBe(1_000_000);
		expect(opus.capabilities).toEqual({
			toolCalls: undefined,
			vision: true,
			reasoning: true,
			structuredOutput: true,
			effortLevels: ["low", "medium", "high", "xhigh", "max"],
		});
		const haiku = hydrateChatModel("work", "claude-haiku-4-5", { templateId: "anthropic" });
		expect(haiku.capabilities.reasoning).toBe(true);
		expect(haiku.capabilities.effortLevels).toEqual([]);
	});

	it("reports nothing it wasn't told", () => {
		populateAnthropicCache("proxy", [PROXIED]);
		const model = hydrateChatModel("proxy", "claude-sonnet-4-6", { templateId: "anthropic" });
		expect(model.displayName).toBe("Sonnet 4.6 (latest)");
		expect(model.contextWindow).toBeUndefined();
		expect(model.capabilities.vision).toBeUndefined();
		expect(model.capabilities.reasoning).toBeUndefined();
	});
});

describe("discoverAnthropicModels", () => {
	it("follows has_more pages and caches every model", async () => {
		const urls: string[] = [];
		vi.mocked(requestUrl).mockImplementation((async (req: { url: string }) => {
			urls.push(req.url);
			return req.url.includes("after_id=")
				? { status: 200, json: { data: [HAIKU], has_more: false } }
				: { status: 200, json: { data: [OPUS], has_more: true, last_id: OPUS.id } };
		}) as never);
		expect(await discoverAnthropicModels({ apiKey: "sk-ant-test" }, "paged")).toEqual([
			"claude-opus-4-8",
			"claude-haiku-4-5",
		]);
		expect(urls).toEqual([
			"https://api.anthropic.com/v1/models?limit=1000",
			"https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-4-8",
		]);
		expect(getAnthropicModelInfo("paged", "claude-haiku-4-5")?.maxInputTokens).toBe(200_000);
	});

	it("fails discovery on an error status", async () => {
		vi.mocked(requestUrl).mockResolvedValue({ status: 401, text: "invalid x-api-key", json: null } as never);
		await expect(discoverAnthropicModels({ apiKey: "bad" }, "x")).rejects.toThrow("invalid x-api-key");
	});
});
