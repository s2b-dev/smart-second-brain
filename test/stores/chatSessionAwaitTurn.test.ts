import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => ({
		getSelectedAgent: () => ({ id: "agent-1", name: "Agent", chatModel: undefined }),
	}),
}));

import { ChatSession } from "../../src/stores/chatStore.svelte";
import { AssistantState, buildCheckpointGraph, type CheckpointGraphState } from "../../src/stores/chatTimeline";
import type { CheckpointHistoryItem } from "../../src/agent/Agent";

/* --------------------------------------------------------------------------
 * ChatSession.sendMessageAndAwait — the completion hook voice mode's supervisor
 * bridge relies on. `sendMessage` fires and forgets; this variant resolves once
 * the run has settled with the terminal state and the final text, and never
 * rejects, so the caller always has an outcome to relay.
 * ------------------------------------------------------------------------*/

const THREAD_ID = "Chats/Await Turn.chat";

function checkpoint(
	checkpointId: string,
	step: number,
	messages: (HumanMessage | AIMessage)[],
	parentCheckpointId?: string,
): CheckpointHistoryItem {
	return { checkpointId, step, messages, parentCheckpointId, ts: new Date(2026, 0, 1, 0, step + 2).toISOString() };
}

function buildGraph(): CheckpointGraphState {
	const h1 = new HumanMessage({ content: "hello", id: "h1" });
	const ai1 = new AIMessage({ content: "hi", id: "ai1" });
	const graph = buildCheckpointGraph([
		checkpoint("r", -1, []),
		checkpoint("a", 0, [h1], "r"),
		checkpoint("b", 1, [h1, ai1], "a"),
	]);
	graph.activeCheckpointId = "b";
	return graph;
}

type Internals = {
	runStream(
		pairId: string,
		getStream: (signal: AbortSignal) => AsyncIterable<unknown>,
		options: { beforeCheckpointIds: Set<string> },
	): Promise<void>;
	processAssistantReply: (pairId: string, ...rest: unknown[]) => Promise<void>;
	consumeStream: (assistantMessage: { content: string }, stream: unknown) => Promise<void>;
	syncGraphAfterRun: (...args: unknown[]) => Promise<void>;
	abortController: AbortController | null;
	cancelled: boolean;
};

function makeSession(): { session: ChatSession; internals: Internals } {
	const session = new ChatSession(THREAD_ID, {
		graphState: buildGraph(),
		errorCount: 0,
		selectedAgentId: "",
	});
	const internals = session as unknown as Internals;
	internals.syncGraphAfterRun = vi.fn().mockResolvedValue(undefined);
	internals.consumeStream = vi.fn().mockImplementation(async (assistantMessage: { content: string }) => {
		assistantMessage.content = "the answer";
	});
	// Route the real send path into runStream with an empty stream, exactly as the
	// production method does minus the query augmentation.
	internals.processAssistantReply = (pairId: string) =>
		internals.runStream.call(session, pairId, () => (async function* () {})(), {
			beforeCheckpointIds: new Set(["r", "a", "b"]),
		});
	return { session, internals };
}

describe("ChatSession.sendMessageAndAwait", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves with the final text once the run succeeds", async () => {
		const { session } = makeSession();

		const outcome = await session.sendMessageAndAwait("what did I write?");

		expect(outcome).toEqual({ state: AssistantState.success, content: "the answer", errorCode: undefined });
		expect(session.isRunning).toBe(false);
	});

	it("reports cancellation with whatever had streamed", async () => {
		const { session, internals } = makeSession();
		internals.consumeStream = vi.fn().mockImplementation(async (assistantMessage: { content: string }) => {
			assistantMessage.content = "partial";
			internals.cancelled = true;
			throw new Error("aborted");
		});

		const outcome = await session.sendMessageAndAwait("stop me");

		expect(outcome.state).toBe(AssistantState.cancelled);
		expect(outcome.content).toBe("partial");
	});

	it("reports a stream failure as an error outcome with its message", async () => {
		const { session, internals } = makeSession();
		internals.consumeStream = vi.fn().mockRejectedValue(new Error("model refused"));

		const outcome = await session.sendMessageAndAwait("break");

		expect(outcome.state).toBe(AssistantState.error);
		expect(outcome.errorCode).toContain("model refused");
	});

	it("turns the synchronous 'already in progress' refusal into an error outcome instead of rejecting", async () => {
		const { session, internals } = makeSession();
		internals.abortController = new AbortController();

		const outcome = await session.sendMessageAndAwait("second send");

		expect(outcome.state).toBe(AssistantState.error);
		expect(outcome.errorCode).toContain("already in progress");
	});

	it("keeps plain sendMessage fire-and-forget and still records the outcome", async () => {
		const { session } = makeSession();

		const pairId = await session.sendMessage("typed");
		expect(typeof pairId).toBe("string");
		// Let the run settle.
		await vi.waitFor(() => expect(session.isRunning).toBe(false));

		const pair = session.messages.at(-1);
		expect(pair?.assistantMessage.state).toBe(AssistantState.success);
	});
});
