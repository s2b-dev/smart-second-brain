/**
 * The model catalogue ChatGPT sign-in serves (`/backend-api/codex/models`), and how the model
 * picker reads it.
 */

import { describe, expect, it } from "vitest";
import { hydrateChatModel } from "../../src/lib/modelMetadataNormalizer";
import { getCodexModelInfo, populateCodexCache } from "../../src/providers/codexModels";

/** Entries trimmed from a real Codex CLI `models_cache.json` (client_version 0.118.0). */
const CATALOG = [
	{
		slug: "gpt-5.4",
		display_name: "gpt-5.4",
		context_window: 272000,
		input_modalities: ["text", "image"],
		supported_reasoning_levels: [
			{ effort: "low", description: "Fast responses with lighter reasoning" },
			{ effort: "medium" },
			{ effort: "high" },
			{ effort: "xhigh" },
		],
		visibility: "list",
		supported_in_api: true,
	},
	{
		slug: "gpt-5.4-mini",
		display_name: "GPT-5.4-Mini",
		context_window: 272000,
		input_modalities: ["text", "image"],
		supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
		visibility: "list",
		supported_in_api: true,
	},
	{
		slug: "gpt-oss-20b",
		display_name: "gpt-oss-20b",
		context_window: 128000,
		input_modalities: ["text"],
		visibility: "hide",
		supported_in_api: true,
	},
	{ slug: "internal-only", visibility: "list", supported_in_api: false },
	{ display_name: "no slug" },
];

describe("populateCodexCache", () => {
	it("offers the models the server lists for the picker", () => {
		expect(populateCodexCache("chatgpt", CATALOG)).toEqual(["gpt-5.4", "gpt-5.4-mini"]);
	});

	it("keeps what each model reports, hidden ones included", () => {
		populateCodexCache("chatgpt", CATALOG);
		expect(getCodexModelInfo("chatgpt", "gpt-5.4")).toEqual({
			id: "gpt-5.4",
			displayName: "gpt-5.4",
			contextWindow: 272000,
			vision: true,
			effortLevels: ["low", "medium", "high", "xhigh"],
		});
		expect(getCodexModelInfo("chatgpt", "gpt-oss-20b")).toMatchObject({ vision: false, effortLevels: undefined });
	});
});

describe("hydrateChatModel for a ChatGPT-signed-in OpenAI instance", () => {
	it("shows the catalogue's name, window, image input and effort levels", () => {
		populateCodexCache("openai", CATALOG);
		const model = hydrateChatModel("openai", "gpt-5.4-mini", { templateId: "openai" });
		expect(model.displayName).toBe("GPT-5.4-Mini");
		expect(model.contextWindow).toBe(272000);
		expect(model.capabilities).toMatchObject({ vision: true, reasoning: true, effortLevels: ["low", "medium"] });
	});

	it("leaves an API-key instance's models unknown", () => {
		const model = hydrateChatModel("openai-key", "gpt-5.4", { templateId: "openai" });
		expect(model.displayName).toBe("gpt-5.4");
		expect(model.contextWindow).toBeUndefined();
		expect(model.capabilities.vision).toBeUndefined();
	});
});
