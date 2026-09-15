import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

/**
 * Fake runnable whose `stream` yields a minimal values-mode payload so every
 * streaming method reaches its run-completion tail (where thread metadata is
 * persisted). `createAgent` is memoized by cacheKey, so one instance serves all.
 */
const { createAgentMock, summarizationMiddlewareMock } = vi.hoisted(() => ({
	createAgentMock: vi.fn(() => ({
		invoke: vi.fn(),
		streamEvents: vi.fn(),
		stream: vi.fn(async () => {
			async function* gen() {
				yield ["values", { messages: [{ type: "ai", getType: () => "ai", text: "done", content: "done" }] }];
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
import { Agent, type ResolvedRun } from "../../src/agent/Agent";
import type { ThreadStore } from "../../src/agent/memory/ThreadStore";

const THREAD_ID = "Chats/thread.chat";

function makeRegistry() {
	return {
		createChatInstance: vi.fn((provider: string, model: string) => ({ provider, model, invoke: vi.fn() })),
	} as unknown as { createChatInstance: (p: string, m: string, o?: unknown) => BaseChatModel };
}

/**
 * Stand-in for ObsidianChatManager.asThreadStore(). `write` is debounced there —
 * it only marks the thread dirty — so `flush` is what actually gets the run's
 * metadata onto disk. Recording both lets us assert the pairing.
 */
function makeThreadStore() {
	const writes: string[] = [];
	const flushes: (string | undefined)[] = [];
	const store: ThreadStore = {
		read: vi.fn(async () => undefined),
		write: vi.fn(async (snapshot) => {
			writes.push(snapshot.threadId);
		}),
		delete: vi.fn(async () => {}),
		list: vi.fn(async () => []),
		clear: vi.fn(async () => {}),
		flush: vi.fn(async (threadId?: string) => {
			flushes.push(threadId);
		}),
	};
	return { store, writes, flushes };
}

async function drain(stream: AsyncGenerator<unknown>): Promise<void> {
	for await (const _ of stream) {
		// exhaust
	}
}

async function makeResolved(agent: Agent): Promise<ResolvedRun> {
	return agent.resolveRun({
		provider: "openai",
		chatModel: "gpt-4o",
		options: { contextWindow: 128_000 },
		cacheKey: "flush-test-key",
		systemPrompt: "You are helpful.",
		tools: [] as const,
		subAgents: [] as const,
	});
}

describe("run-completion thread persistence", () => {
	beforeEach(() => {
		createAgentMock.mockClear();
		summarizationMiddlewareMock.mockClear();
	});

	it("streamTokens flushes thread metadata", async () => {
		const { store, writes, flushes } = makeThreadStore();
		const agent = new Agent({ registry: makeRegistry() as never, threadStore: store });

		await drain(agent.streamTokens({ query: "hi", resolved: await makeResolved(agent), threadId: THREAD_ID }));

		expect(writes).toContain(THREAD_ID);
		expect(flushes).toContain(THREAD_ID);
	});

	it("editFromCheckpoint flushes thread metadata", async () => {
		const { store, writes, flushes } = makeThreadStore();
		const agent = new Agent({ registry: makeRegistry() as never, threadStore: store });

		await drain(
			agent.editFromCheckpoint({
				query: "hi",
				resolved: await makeResolved(agent),
				threadId: THREAD_ID,
				checkpointId: "cp-1",
			}),
		);

		expect(writes).toContain(THREAD_ID);
		expect(flushes).toContain(THREAD_ID);
	});

	/**
	 * Regression: this path called `persistThreadMetadata` but not
	 * `flushThreadPersistence`, unlike the other three run-completion paths. Since
	 * the real store's `write` is a 2s-debounced save, a quit inside that window
	 * lost the regenerated run's metadata.
	 */
	it("regenerateFromCheckpoint flushes thread metadata", async () => {
		const { store, writes, flushes } = makeThreadStore();
		const agent = new Agent({ registry: makeRegistry() as never, threadStore: store });

		await drain(
			agent.regenerateFromCheckpoint({
				resolved: await makeResolved(agent),
				threadId: THREAD_ID,
				checkpointId: "cp-1",
			}),
		);

		expect(writes).toContain(THREAD_ID);
		expect(flushes).toContain(THREAD_ID);
	});

	it("run() flushes thread metadata", async () => {
		const { store, writes, flushes } = makeThreadStore();
		const agent = new Agent({ registry: makeRegistry() as never, threadStore: store });
		const resolved = await makeResolved(agent);
		(resolved.runnable as unknown as { invoke: ReturnType<typeof vi.fn> }).invoke = vi.fn(async () => ({
			messages: [{ type: "ai", getType: () => "ai", text: "done", content: "done" }],
		}));

		await agent.run({ query: "hi", resolved, threadId: THREAD_ID });

		expect(writes).toContain(THREAD_ID);
		expect(flushes).toContain(THREAD_ID);
	});

	it("tolerates a thread store with no flush implementation", async () => {
		const { store } = makeThreadStore();
		const noFlush: ThreadStore = { ...store, flush: undefined };
		const agent = new Agent({ registry: makeRegistry() as never, threadStore: noFlush });

		await expect(
			drain(
				agent.regenerateFromCheckpoint({
					resolved: await makeResolved(agent),
					threadId: THREAD_ID,
					checkpointId: "cp-1",
				}),
			),
		).resolves.toBeUndefined();
	});
});
