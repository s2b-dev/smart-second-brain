import { describe, expect, it } from "vitest";
import { anthropicProvider } from "../../src/providers/anthropic";
import { createOpenAICompatibleProvider } from "../../src/providers/openai-compatible";
import { openaiProvider } from "../../src/providers/openai";
import { openrouterProvider } from "../../src/providers/openrouter";
import type { ChatModelConfig } from "../../src/types/provider";

// Reads the request body fields a built chat model would send. Every LangChain chat
// model exposes them through `invocationParams()`; the transport wrappers delegate it.
function paramsOf(model: unknown): Record<string, unknown> {
	return (model as { invocationParams: (options?: unknown) => Record<string, unknown> }).invocationParams({});
}

const high: Partial<ChatModelConfig> = { contextWindow: 128000, reasoningEffort: "high" };
const unset: Partial<ChatModelConfig> = { contextWindow: 128000 };

describe("reasoning effort reaches the request", () => {
	it("OpenAI sends reasoning_effort for reasoning models only", () => {
		const auth = { apiKey: "sk-test" };
		expect(paramsOf(openaiProvider.createChatInstance(auth, "o3", high)).reasoning_effort).toBe("high");
		expect(paramsOf(openaiProvider.createChatInstance(auth, "o3", unset)).reasoning_effort).toBeUndefined();
		// A non-reasoning model would 400 on the field; LangChain drops it.
		expect(paramsOf(openaiProvider.createChatInstance(auth, "gpt-4o", high)).reasoning_effort).toBeUndefined();
	});

	it("Anthropic sends output_config.effort with adaptive thinking", () => {
		const params = paramsOf(
			anthropicProvider.createChatInstance({ apiKey: "sk-ant-test" }, "claude-opus-4-8", high),
		);
		expect(params.output_config).toMatchObject({ effort: "high" });
		expect(params.thinking).toMatchObject({ type: "adaptive" });

		const plain = paramsOf(
			anthropicProvider.createChatInstance({ apiKey: "sk-ant-test" }, "claude-opus-4-8", unset),
		);
		expect((plain.output_config as { effort?: string } | undefined)?.effort).toBeUndefined();
	});

	it("OpenRouter sends its unified reasoning object for any model id", () => {
		const auth = { apiKey: "sk-or-test" };
		expect(paramsOf(openrouterProvider.createChatInstance(auth, "deepseek/deepseek-r1", high)).reasoning).toEqual({
			effort: "high",
		});
		expect(
			paramsOf(openrouterProvider.createChatInstance(auth, "deepseek/deepseek-r1", unset)).reasoning,
		).toBeUndefined();
	});

	it("OpenAI-compatible endpoints send reasoning_effort for any model id", () => {
		const provider = createOpenAICompatibleProvider({ id: "litellm", displayName: "LiteLLM" });
		const auth = { apiKey: "sk-test", baseUrl: "http://localhost:4000" };
		expect(paramsOf(provider.createChatInstance(auth, "qwen3-32b", high)).reasoning_effort).toBe("high");
		expect(paramsOf(provider.createChatInstance(auth, "qwen3-32b", unset)).reasoning_effort).toBeUndefined();
	});
});
