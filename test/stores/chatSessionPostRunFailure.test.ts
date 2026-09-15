import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ChatSession } from "../../src/stores/chatStore.svelte";
import { AssistantState, buildCheckpointGraph, type CheckpointGraphState } from "../../src/stores/chatTimeline";
import type { CheckpointHistoryItem } from "../../src/agent/Agent";

/* --------------------------------------------------------------------------
 * ChatSession — a post-success failure must not retract the turn.
 *
 * `runStream` wraps the stream AND the bookkeeping that follows it (auto-title
 * rename, checkpoint-graph sync, thinking-duration persistence, reloadAfter) in
 * one try/catch. Once `consumeStream` resolves, the answer has streamed and the
 * checkpointer has persisted it — so a throw from that trailing bookkeeping is
 * a view-freshness problem, not a failed reply. The original catch marked the
 * pair `error` regardless, which is how a rename-invalidated `onNeedReload`
 * turned a perfectly good answer into a red error bubble offering to "retry"
 * work that had already succeeded.
 *
 * These tests pin the boundary: failures BEFORE the stream completes still
 * surface as errors; failures AFTER it leave the turn successful.
 * ------------------------------------------------------------------------*/

const THREAD_ID = "Chats/Post Run.chat";

function checkpoint(
	checkpointId: string,
	step: number,
	messages: (HumanMessage | AIMessage)[],
	parentCheckpointId?: string,
): CheckpointHistoryItem {
	return { checkpointId, step, messages, parentCheckpointId, ts: new Date(2026, 0, 1, 0, step + 2).toISOString() };
}

/** One completed turn, so the session has a pair to stream into. */
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

type RunStreamInternals = {
	runStream(
		pairId: string,
		getStream: (signal: AbortSignal) => AsyncIterable<unknown>,
		options: { beforeCheckpointIds: Set<string>; reloadAfter?: boolean; parentCheckpointId?: string },
	): Promise<void>;
	consumeStream: (...args: unknown[]) => Promise<void>;
	syncGraphAfterRun: (...args: unknown[]) => Promise<void>;
};

function makeSession(): { session: ChatSession; internals: RunStreamInternals } {
	const session = new ChatSession(THREAD_ID, {
		graphState: buildGraph(),
		errorCount: 0,
		selectedAgentId: "",
	});
	const internals = session as unknown as RunStreamInternals;
	// Default happy path for the two boundaries these tests toggle.
	internals.consumeStream = vi.fn().mockResolvedValue(undefined);
	internals.syncGraphAfterRun = vi.fn().mockResolvedValue(undefined);
	return { session, internals };
}

async function run(session: ChatSession, internals: RunStreamInternals, reloadAfter = false): Promise<string> {
	const pair = session.messages.at(-1);
	if (!pair) throw new Error("expected a message pair");
	await internals.runStream.call(session, pair.id, () => (async function* () {})(), {
		beforeCheckpointIds: new Set(["r", "a", "b"]),
		reloadAfter,
	});
	return pair.id;
}

describe("ChatSession — post-success bookkeeping failures preserve the turn", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the turn successful when onNeedReload throws after the stream completed", async () => {
		const { session, internals } = makeSession();
		// Exactly the failure the rename bug produced.
		(session as unknown as { onNeedReload: () => Promise<void> }).onNeedReload = () => {
			throw new Error("No session to reload");
		};

		const pairId = await run(session, internals, true);

		const pair = session.messages.find((p) => p.id === pairId);
		expect(pair?.assistantMessage.state).toBe(AssistantState.success);
		expect(pair?.assistantMessage.errorCode).toBeUndefined();
	});

	it("keeps the turn successful when the checkpoint-graph sync throws", async () => {
		const { session, internals } = makeSession();
		internals.syncGraphAfterRun = vi.fn().mockRejectedValue(new Error("checkpoint read failed"));

		const pairId = await run(session, internals);

		const pair = session.messages.find((p) => p.id === pairId);
		expect(pair?.assistantMessage.state).toBe(AssistantState.success);
		expect(pair?.assistantMessage.errorCode).toBeUndefined();
	});

	it("still reports an error when the stream itself fails", async () => {
		const { session, internals } = makeSession();
		internals.consumeStream = vi.fn().mockRejectedValue(new Error("model refused"));

		const pairId = await run(session, internals);

		const pair = session.messages.find((p) => p.id === pairId);
		expect(pair?.assistantMessage.state).toBe(AssistantState.error);
		expect(pair?.assistantMessage.errorCode).toBeTruthy();
	});

	it("still reports cancellation when the user stops mid-stream", async () => {
		const { session, internals } = makeSession();
		internals.consumeStream = vi.fn().mockImplementation(async () => {
			(session as unknown as { cancelled: boolean }).cancelled = true;
			throw new Error("aborted");
		});

		const pairId = await run(session, internals);

		const pair = session.messages.find((p) => p.id === pairId);
		expect(pair?.assistantMessage.state).toBe(AssistantState.cancelled);
	});

	it("leaves the session idle and re-runnable after a post-success failure", async () => {
		const { session, internals } = makeSession();
		internals.syncGraphAfterRun = vi.fn().mockRejectedValue(new Error("checkpoint read failed"));

		await run(session, internals);

		// The finally block must still clear the run slot; a leaked abortController
		// would make the next send throw "already in progress".
		expect(session.isRunning).toBe(false);
	});
});
