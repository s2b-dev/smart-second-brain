import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { describe, expect, it } from "vitest";
import { createPromptCachingMiddleware } from "../../src/agent/promptCaching";
import { createTransportedChatAnthropic } from "../../src/providers/chatProviders";

/** Captures every request body and answers with a minimal Anthropic Messages reply. */
function anthropicFetch(bodies: Record<string, unknown>[]) {
	return (async (_url: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		return new Response(
			JSON.stringify({
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "claude-test",
				content: [{ type: "text", text: "ok" }],
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 1 },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof fetch;
}

const history = [new HumanMessage("first"), new AIMessage("reply"), new HumanMessage("second")];

describe("createPromptCachingMiddleware", () => {
	it("sends top-level cache_control through our transported ChatAnthropic", async () => {
		const bodies: Record<string, unknown>[] = [];
		const model = createTransportedChatAnthropic("anthropic", {
			model: "claude-test",
			apiKey: "test-key",
			streaming: false,
			clientOptions: { fetch: anthropicFetch(bodies) },
		});
		const agent = createAgent({
			model,
			tools: [],
			systemPrompt: "You are a test agent.",
			middleware: [createPromptCachingMiddleware()],
		});

		await agent.invoke({ messages: history });

		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
	});

	it("is a silent no-op for non-Anthropic models", async () => {
		const bodies: Record<string, unknown>[] = [];
		const model = new ChatOpenAI({
			model: "gpt-test",
			apiKey: "test-key",
			configuration: {
				fetch: (async (_url: unknown, init?: RequestInit) => {
					bodies.push(JSON.parse(String(init?.body)));
					return new Response(
						JSON.stringify({
							id: "c1",
							object: "chat.completion",
							created: 0,
							model: "gpt-test",
							choices: [
								{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
							],
							usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}) as typeof fetch,
			},
		});
		const agent = createAgent({
			model,
			tools: [],
			systemPrompt: "You are a test agent.",
			middleware: [createPromptCachingMiddleware()],
		});

		await agent.invoke({ messages: history });

		expect(bodies).toHaveLength(1);
		expect(bodies[0]).not.toHaveProperty("cache_control");
	});
});
