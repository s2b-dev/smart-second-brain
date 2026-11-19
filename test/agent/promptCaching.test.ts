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
	it("marks the system prompt and the newest message as cache breakpoints", async () => {
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

		const result = await agent.invoke({ messages: history });

		expect(bodies).toHaveLength(1);
		const body = bodies[0] as {
			cache_control?: unknown;
			system: { text: string; cache_control?: unknown }[];
			messages: { role: string; content: string | { type: string; text?: string; cache_control?: unknown }[] }[];
		};
		// Block-level, not the top-level field Bedrock-backed gateways ignore.
		expect(body.cache_control).toBeUndefined();
		expect(body.system).toEqual([
			{ type: "text", text: "You are a test agent.", cache_control: { type: "ephemeral" } },
		]);
		const last = body.messages.at(-1);
		expect(last?.content).toEqual([{ type: "text", text: "second", cache_control: { type: "ephemeral" } }]);
		// Only the newest message carries a breakpoint.
		expect(JSON.stringify(body.messages.slice(0, -1))).not.toContain("cache_control");
		// The stored history is untouched.
		expect(result.messages.map((m) => m.content)).toEqual(["first", "reply", "second", "ok"]);
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
		expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
	});
});

describe("withCacheBreakpoint", () => {
	it("marks the last cacheable block and never the input array", async () => {
		const { withCacheBreakpoint } = await import("../../src/agent/promptCaching");
		const content = [
			{ type: "text", text: "a" },
			{ type: "thinking", thinking: "hmm" },
		];
		expect(withCacheBreakpoint(content)).toEqual([
			{ type: "text", text: "a", cache_control: { type: "ephemeral" } },
			{ type: "thinking", thinking: "hmm" },
		]);
		expect(content[0]).not.toHaveProperty("cache_control");
		expect(withCacheBreakpoint("")).toBeNull();
		expect(withCacheBreakpoint([{ type: "thinking", thinking: "x" }])).toBeNull();
	});
});
