import { describe, expect, it } from "vitest";
import { populateOpenRouterCache } from "../../src/providers/openrouterModels";
import {
	anthropicReasoningEffortSupport,
	getReasoningEffortSupport,
	liteLLMReasoningEffortSupport,
} from "../../src/providers/reasoningSupport";
import type { OpenRouterModelInfo } from "../../src/providers/openrouterModels";

const adaptive = (supported: boolean) => ({ types: { adaptive: { supported } } });

describe("anthropicReasoningEffortSupport", () => {
	it("needs both adaptive thinking and effort, and leaves models without capabilities unknown", () => {
		const result = anthropicReasoningEffortSupport([
			{ id: "claude-sonnet-4-6", capabilities: { thinking: adaptive(true), effort: { supported: true } } },
			{ id: "claude-haiku-4-5", capabilities: { thinking: adaptive(false), effort: { supported: false } } },
			{ id: "claude-opus-4-5", capabilities: { thinking: adaptive(false), effort: { supported: true } } },
			// A proxy that strips the capability tree.
			{ id: "claude-opus-4-6" },
		]);
		expect(Object.fromEntries(result)).toEqual({
			"claude-sonnet-4-6": true,
			"claude-haiku-4-5": false,
			"claude-opus-4-5": false,
		});
	});
});

describe("liteLLMReasoningEffortSupport", () => {
	it("reads supports_reasoning, requires every deployment of a name, and skips unreported ones", () => {
		const result = liteLLMReasoningEffortSupport([
			{ model_name: "gpt-5", model_info: { supports_reasoning: true } },
			{ model_name: "gpt-4.1-mini", model_info: { supports_reasoning: false } },
			{ model_name: "mixed", model_info: { supports_reasoning: true } },
			{ model_name: "mixed", model_info: { supports_reasoning: false } },
			// HAI's model info has no supports_reasoning at all.
			{ model_name: "gemini-2.5-flash", model_info: { max_input_tokens: 1048576 } },
		]);
		expect(Object.fromEntries(result)).toEqual({ "gpt-5": true, "gpt-4.1-mini": false, mixed: false });
	});
});

describe("OpenRouter support", () => {
	it("is recorded from supported_parameters; include_reasoning alone doesn't count", () => {
		const model = (id: string, supported_parameters?: string[]) =>
			({ id, supported_parameters }) as OpenRouterModelInfo;
		populateOpenRouterCache([
			model("deepseek/deepseek-r1", ["tools", "reasoning", "include_reasoning"]),
			model("openai/gpt-4o", ["tools"]),
			model("some/model", ["include_reasoning"]),
			model("unknown/model"),
		]);
		expect(getReasoningEffortSupport("openrouter", "deepseek/deepseek-r1")).toBe(true);
		expect(getReasoningEffortSupport("openrouter", "openai/gpt-4o")).toBe(false);
		expect(getReasoningEffortSupport("openrouter", "some/model")).toBe(false);
		expect(getReasoningEffortSupport("openrouter", "unknown/model")).toBeUndefined();
	});
});
