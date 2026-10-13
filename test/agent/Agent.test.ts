import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

const { createAgentMock, summarizationMiddlewareMock } = vi.hoisted(() => ({
	createAgentMock: vi.fn(() => ({ invoke: vi.fn(), streamEvents: vi.fn() })),
	summarizationMiddlewareMock: vi.fn((config: unknown) => ({ kind: "summary", config })),
}));

vi.mock("langchain", () => ({
	createAgent: createAgentMock,
	summarizationMiddleware: summarizationMiddlewareMock,
}));

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Agent, sanitizeRunnableName } from "../../src/agent/Agent";
import { getTrimTokensToSummarize } from "../../src/agent/summarization";
import { countMessageTokens, estimateSystemPromptTokens } from "../../src/utils/tokenEstimator";

function makeRegistry() {
	return {
		createChatInstance: vi.fn((provider: string, model: string) => ({
			provider,
			model,
			invoke: vi.fn(),
		})) as unknown as (provider: string, model: string) => BaseChatModel,
	};
}

const BASE_RESOLVE_PARAMS = {
	cacheKey: "test-key",
	systemPrompt: "You are a helpful assistant.",
	tools: [] as const,
	subAgents: [] as const,
} as const;

// The middleware counts messages only, so its trigger is the meter's trigger
// minus the system prompt the meter adds on top.
const SYSTEM_PROMPT_TOKENS = estimateSystemPromptTokens(BASE_RESOLVE_PARAMS.systemPrompt);

describe("Agent summarization middleware", () => {
	beforeEach(() => {
		createAgentMock.mockClear();
		summarizationMiddlewareMock.mockClear();
	});

	it("uses the configured summarization model when provided", async () => {
		const registry = makeRegistry();
		const agent = new Agent({ registry: registry as never });

		await agent.resolveRun({
			...BASE_RESOLVE_PARAMS,
			provider: "openai",
			chatModel: "gpt-4o",
			options: { contextWindow: 100_000 },
			summarizationModel: {
				provider: "openai",
				chatModel: "gpt-4o-mini",
				options: { contextWindow: 100_000 },
			},
		});

		expect(summarizationMiddlewareMock).toHaveBeenCalledTimes(1);
		expect((summarizationMiddlewareMock.mock.calls[0] ?? [])[0]).toMatchObject({
			trigger: { tokens: 80_000 - SYSTEM_PROMPT_TOKENS, messages: 14 },
			keep: { messages: 12 },
			tokenCounter: countMessageTokens,
			trimTokensToSummarize: getTrimTokensToSummarize(100_000, 80_000),
		});
		expect(registry.createChatInstance).toHaveBeenCalledWith("openai", "gpt-4o-mini", { contextWindow: 100_000 });
		expect(createAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				middleware: [expect.objectContaining({ kind: "summary" })],
			}),
		);
	});

	it("falls back to the active chat model for summarization when no explicit summarization model is set", async () => {
		const registry = makeRegistry();
		const agent = new Agent({ registry: registry as never });

		await agent.resolveRun({
			...BASE_RESOLVE_PARAMS,
			cacheKey: "test-key-2",
			provider: "anthropic",
			chatModel: "claude-sonnet",
			options: { contextWindow: 50_000 },
		});

		expect(summarizationMiddlewareMock).toHaveBeenCalledTimes(1);
		expect(registry.createChatInstance).toHaveBeenCalledTimes(1);
		expect((summarizationMiddlewareMock.mock.calls[0] ?? [])[0]).toMatchObject({
			trigger: { tokens: 40_000 - SYSTEM_PROMPT_TOKENS, messages: 14 },
			keep: { messages: 12 },
			tokenCounter: countMessageTokens,
			// The chat model summarizes, so its own window bounds what it reads.
			trimTokensToSummarize: getTrimTokensToSummarize(50_000, 40_000),
		});
	});

	it("bounds the summarizer's input by the dedicated summary model's own window", async () => {
		const registry = makeRegistry();
		const agent = new Agent({ registry: registry as never });

		await agent.resolveRun({
			...BASE_RESOLVE_PARAMS,
			cacheKey: "test-key-4",
			provider: "openai",
			chatModel: "gpt-4o",
			options: { contextWindow: 200_000 },
			summarizationModel: { provider: "openai", chatModel: "small", options: { contextWindow: 32_000 } },
		});

		const config = (summarizationMiddlewareMock.mock.calls[0] ?? [])[0] as { trimTokensToSummarize: number };
		expect(config.trimTokensToSummarize).toBe(getTrimTokensToSummarize(32_000, 160_000));
		expect(config.trimTokensToSummarize).toBeLessThan(32_000);
	});

	it("skips summarization middleware when the context window is unknown", async () => {
		const registry = makeRegistry();
		const agent = new Agent({ registry: registry as never });

		await agent.resolveRun({
			...BASE_RESOLVE_PARAMS,
			cacheKey: "test-key-3",
			provider: "openai",
			chatModel: "gpt-4o",
			options: {},
		});

		expect(summarizationMiddlewareMock).not.toHaveBeenCalled();
		expect(createAgentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				middleware: [],
			}),
		);
	});
});

describe("Agent stream tool output normalization", () => {
	it("unwraps tool-message-like output wrappers", () => {
		const agent = new Agent({ registry: makeRegistry() as never });

		const output = (
			agent as unknown as {
				normalizeStreamToolOutput: (rawOutput: unknown) => unknown;
			}
		).normalizeStreamToolOutput({
			content: [{ type: "text", text: "Found 3 results" }],
			artifact: { totalResults: 3 },
			status: "success",
		});

		expect(output).toEqual([{ type: "text", text: "Found 3 results" }]);
	});

	it("preserves missing tool output as undefined", () => {
		const agent = new Agent({ registry: makeRegistry() as never });

		const output = (
			agent as unknown as {
				normalizeStreamToolOutput: (rawOutput: unknown) => unknown;
			}
		).normalizeStreamToolOutput(undefined);

		expect(output).toBeUndefined();
	});
});

describe("sanitizeRunnableName", () => {
	// OpenAI/Azure/OpenAI-compatible endpoints enforce `^[^\s<|\\/>]+$` on
	// `messages[N].name`; a subagent runnable name leaks into AIMessage.name and
	// would 400 the subagent's second turn if it contains disallowed characters.
	const disallowed = /[\s<|\\/>]/;

	it("replaces spaces and parentheses with underscores", () => {
		expect(sanitizeRunnableName("Default Agent (isolated)")).toBe("Default_Agent_isolated");
	});

	it("leaves an already-safe name untouched", () => {
		expect(sanitizeRunnableName("research-agent")).toBe("research-agent");
	});

	it("collapses runs of disallowed characters into a single underscore", () => {
		expect(sanitizeRunnableName("a   /  b")).toBe("a_b");
	});

	it("trims leading and trailing underscores", () => {
		expect(sanitizeRunnableName("  spaced  ")).toBe("spaced");
	});

	it("falls back to 'subagent' for an all-disallowed name", () => {
		expect(sanitizeRunnableName("  <|>  ")).toBe("subagent");
	});

	it("produces a name matching the provider pattern for tricky inputs", () => {
		for (const input of ["Default Agent (isolated)", "My/Weird\\Name", "a|b<c>d", "  "]) {
			expect(sanitizeRunnableName(input)).not.toMatch(disallowed);
		}
	});
});

describe("Agent streamTokens subagent-content suppression", () => {
	// Regression coverage for the leak fix: tokens authored by a subagent carry
	// `lc_agent_name` in the messages-mode stream metadata and must NOT surface as
	// parent-content `token` chunks (the subagent answer is delivered via the
	// `task` ToolMessage instead). Parent tokens (no `lc_agent_name`) must survive.
	type StreamTuple = ["messages" | "tools" | "values", unknown];

	function aiMessage(id: string, content: string) {
		return {
			id,
			content,
			type: "ai",
			getType: () => "ai",
		};
	}

	/** Builds a resolved run whose runnable streams the given tuples. */
	function makeResolvedRun(tuples: StreamTuple[]) {
		return {
			runnable: {
				stream: async () =>
					(async function* () {
						for (const t of tuples) yield t;
					})(),
			},
			selectedModel: { provider: "openai", name: "gpt-4o", instance: {} },
			supportsVision: false,
			currentProvider: "openai",
		} as never;
	}

	async function collectTokens(tuples: StreamTuple[]): Promise<string[]> {
		const agent = new Agent({ registry: makeRegistry() as never });
		const tokens: string[] = [];
		// Append a terminal `values` payload so streamTokens resolves a final output
		// (otherwise it throws "completed without producing a final output").
		const withFinal: StreamTuple[] = [...tuples, ["values", { messages: [aiMessage("final", "done")] }]];
		for await (const chunk of agent.streamTokens({
			query: "hi",
			threadId: "t1",
			resolved: makeResolvedRun(withFinal),
		} as never)) {
			if ((chunk as { type: string }).type === "token") {
				tokens.push((chunk as { token: string }).token);
			}
		}
		return tokens;
	}

	it("suppresses subagent tokens and preserves parent tokens", async () => {
		const tokens = await collectTokens([
			["messages", [aiMessage("p1", "Parent before. "), { langgraph_node: "model_request" }]],
			["messages", [aiMessage("s1", "Subagent answer."), { lc_agent_name: "Default Agent (isolated)" }]],
			["messages", [aiMessage("p1", "Parent after."), { langgraph_node: "model_request" }]],
		]);

		expect(tokens).toEqual(["Parent before. ", "Parent after."]);
		expect(tokens.join("")).not.toContain("Subagent answer.");
	});

	it("emits parent tokens normally when no subagent is involved", async () => {
		const tokens = await collectTokens([
			["messages", [aiMessage("p1", "Hello "), { langgraph_node: "model_request" }]],
			["messages", [aiMessage("p1", "world"), {}]],
		]);

		expect(tokens).toEqual(["Hello ", "world"]);
	});
});
