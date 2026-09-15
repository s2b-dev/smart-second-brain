import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

/*
 * `streamTokens`, `editFromCheckpoint` and `regenerateFromCheckpoint` used to each
 * carry a verbatim copy of the same ~200-line stream loop. They now share one
 * implementation (`runStream`). These tests pin the observable behaviour that
 * copy provided — token emission, tool start/end correlation, preamble capture,
 * subagent token suppression, and abort handling — so the shared loop can't
 * regress any single caller.
 */

const STREAM_CHUNKS: unknown[] = [];

const { createAgentMock, summarizationMiddlewareMock } = vi.hoisted(() => ({
	createAgentMock: vi.fn(() => ({
		invoke: vi.fn(),
		streamEvents: vi.fn(),
		stream: vi.fn(async () => {
			async function* gen() {
				for (const c of STREAM_CHUNKS) yield c;
			}
			return gen();
		}),
	})),
	summarizationMiddlewareMock: vi.fn(() => ({ kind: "summary" })),
}));

vi.mock("langchain", () => ({
	createAgent: createAgentMock,
	summarizationMiddleware: summarizationMiddlewareMock,
}));

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Agent, type AgentStreamChunk, type ResolvedRun } from "../../src/agent/Agent";

const THREAD_ID = "Chats/thread.chat";

function makeAgent() {
	const registry = {
		createChatInstance: vi.fn((provider: string, model: string) => ({ provider, model, invoke: vi.fn() })),
	} as unknown as { createChatInstance: (p: string, m: string, o?: unknown) => BaseChatModel };
	return new Agent({ registry: registry as never });
}

async function makeResolved(agent: Agent): Promise<ResolvedRun> {
	return agent.resolveRun({
		provider: "openai",
		chatModel: "gpt-4o",
		options: { contextWindow: 128_000 },
		cacheKey: `parity-${Math.random()}`,
		systemPrompt: "You are helpful.",
		tools: [] as const,
		subAgents: [] as const,
	});
}

/** An AI message delta as the `messages` stream mode delivers it. */
function aiDelta(id: string, content: string, toolCalls?: { id: string }[]) {
	return [
		"messages",
		[{ type: "ai", getType: () => "ai", id, content, tool_calls: toolCalls }, {} as Record<string, unknown>],
	];
}

const FINAL_VALUES = ["values", { messages: [{ type: "ai", getType: () => "ai", text: "final", content: "final" }] }];

async function collect(stream: AsyncGenerator<AgentStreamChunk>): Promise<AgentStreamChunk[]> {
	const out: AgentStreamChunk[] = [];
	for await (const c of stream) out.push(c);
	return out;
}

/** Drive each of the three public streaming methods over the same fake stream. */
async function runAllThree(): Promise<Record<string, AgentStreamChunk[]>> {
	const results: Record<string, AgentStreamChunk[]> = {};

	const a = makeAgent();
	results.streamTokens = await collect(
		a.streamTokens({ query: "hi", resolved: await makeResolved(a), threadId: THREAD_ID }),
	);

	const b = makeAgent();
	results.editFromCheckpoint = await collect(
		b.editFromCheckpoint({
			query: "hi",
			resolved: await makeResolved(b),
			threadId: THREAD_ID,
			checkpointId: "cp-1",
		}),
	);

	const c = makeAgent();
	results.regenerateFromCheckpoint = await collect(
		c.regenerateFromCheckpoint({
			resolved: await makeResolved(c),
			threadId: THREAD_ID,
			checkpointId: "cp-1",
		}),
	);

	return results;
}

beforeEach(() => {
	createAgentMock.mockClear();
	STREAM_CHUNKS.length = 0;
});

describe("stream loop parity across the three entry points", () => {
	it("emits the same token sequence", async () => {
		STREAM_CHUNKS.push(aiDelta("m1", "Hello "), aiDelta("m1", "world"), FINAL_VALUES);

		for (const [name, chunks] of Object.entries(await runAllThree())) {
			const tokens = chunks.filter((c) => c.type === "token").map((c) => (c as { token: string }).token);
			expect(tokens, name).toEqual(["Hello ", "world"]);
		}
	});

	it("correlates tool start/end and carries the preamble", async () => {
		STREAM_CHUNKS.push(
			// Text first, then a delta carrying the tool call — the preamble is the
			// accumulated text stamped onto that call id.
			aiDelta("m1", "Let me look. "),
			aiDelta("m1", "", [{ id: "tc-1" }]),
			["tools", { event: "on_tool_start", toolCallId: "tc-1", name: "search_notes", input: { query: "x" } }],
			["tools", { event: "on_tool_end", toolCallId: "tc-1", name: "search_notes", output: "result" }],
			FINAL_VALUES,
		);

		for (const [name, chunks] of Object.entries(await runAllThree())) {
			const start = chunks.find((c) => c.type === "tool_start") as
				| { toolName: string; toolCallId: string; preamble?: string; input: unknown }
				| undefined;
			const end = chunks.find((c) => c.type === "tool_end") as
				| { toolName: string; toolCallId: string; output: unknown }
				| undefined;

			expect(start, name).toBeDefined();
			expect(start?.toolName, name).toBe("search_notes");
			expect(start?.preamble, name).toBe("Let me look. ");
			expect(start?.input, name).toEqual({ query: "x" });
			// tool_end resolves its name from the pending map, not the raw event.
			expect(end?.toolName, name).toBe("search_notes");
			expect(end?.toolCallId, name).toBe("tc-1");
			expect(end?.output, name).toBe("result");
		}
	});

	it("suppresses subagent tokens from the parent's content", async () => {
		STREAM_CHUNKS.push(
			aiDelta("m1", "parent "),
			// A subagent token is tagged with lc_agent_name and must not append to the
			// parent message — otherwise the subagent's answer leaks into it twice.
			[
				"messages",
				[{ type: "ai", getType: () => "ai", id: "m2", content: "SUBAGENT" }, { lc_agent_name: "worker" }],
			],
			aiDelta("m1", "tail"),
			FINAL_VALUES,
		);

		for (const [name, chunks] of Object.entries(await runAllThree())) {
			const tokens = chunks.filter((c) => c.type === "token").map((c) => (c as { token: string }).token);
			expect(tokens, name).toEqual(["parent ", "tail"]);
		}
	});

	it("yields a result chunk carrying the final messages", async () => {
		STREAM_CHUNKS.push(aiDelta("m1", "done"), FINAL_VALUES);

		for (const [name, chunks] of Object.entries(await runAllThree())) {
			const result = chunks.find((c) => c.type === "result");
			expect(result, name).toBeDefined();
			expect((result as { result: { threadId: string } }).result.threadId, name).toBe(THREAD_ID);
		}
	});

	it("stops early and yields no result when the signal is already aborted", async () => {
		STREAM_CHUNKS.push(aiDelta("m1", "ignored"), FINAL_VALUES);
		const controller = new AbortController();
		controller.abort();

		const agent = makeAgent();
		const chunks = await collect(
			agent.streamTokens({
				query: "hi",
				resolved: await makeResolved(agent),
				threadId: THREAD_ID,
				signal: controller.signal,
			}),
		);

		expect(chunks.find((c) => c.type === "result")).toBeUndefined();
	});

	it("throws a method-specific error when the stream produces no final output", async () => {
		// No values-mode payload at all.
		STREAM_CHUNKS.push(aiDelta("m1", "text only"));

		const a = makeAgent();
		await expect(
			collect(a.streamTokens({ query: "hi", resolved: await makeResolved(a), threadId: THREAD_ID })),
		).rejects.toThrow(/streaming completed without producing a final output/i);

		const c = makeAgent();
		await expect(
			collect(
				c.regenerateFromCheckpoint({
					resolved: await makeResolved(c),
					threadId: THREAD_ID,
					checkpointId: "cp-1",
				}),
			),
		).rejects.toThrow(/regeneration completed without producing a final output/i);
	});
});

describe("stream input shape per entry point", () => {
	it("passes a human message for query/edit and null for regenerate", async () => {
		STREAM_CHUNKS.push(FINAL_VALUES);

		const a = makeAgent();
		const resolvedA = await makeResolved(a);
		await collect(a.streamTokens({ query: "hi", resolved: resolvedA, threadId: THREAD_ID }));
		const streamA = (resolvedA.runnable as unknown as { stream: ReturnType<typeof vi.fn> }).stream;
		expect((streamA.mock.calls[0][0] as { messages: unknown[] }).messages).toHaveLength(1);

		const c = makeAgent();
		const resolvedC = await makeResolved(c);
		await collect(c.regenerateFromCheckpoint({ resolved: resolvedC, threadId: THREAD_ID, checkpointId: "cp-1" }));
		const streamC = (resolvedC.runnable as unknown as { stream: ReturnType<typeof vi.fn> }).stream;
		// Regenerate continues from the checkpoint without adding a message.
		expect(streamC.mock.calls[0][0]).toBeNull();
		expect(
			(streamC.mock.calls[0][1] as { configurable: { checkpoint_id: string } }).configurable.checkpoint_id,
		).toBe("cp-1");
	});
});
