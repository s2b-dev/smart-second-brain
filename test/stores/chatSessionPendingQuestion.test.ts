import { AIMessage, type BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckpointHistoryItem } from "../../src/agent/Agent";
import type { ToolInterrupt } from "../../src/agent/toolInterrupts";
import type SecondBrainPlugin from "../../src/main";
import { ChatSession } from "../../src/stores/chatStore.svelte";
import { buildCheckpointGraph, pendingToolInterrupts } from "../../src/stores/chatTimeline";
import { setPlugin } from "../../src/stores/state.svelte";
import { parseAskQuestionResult } from "../../src/utils/askQuestion";

/* --------------------------------------------------------------------------
 * ChatSession — a turn paused on `ask_question`.
 *
 * The open question is read from the checkpoint graph (so it survives reloads and
 * branch switches), answering continues the asking turn instead of starting a new one,
 * and a message typed while it is open is delivered as the answer: appended as a new
 * turn it would leave the question's tool call without a result.
 * ------------------------------------------------------------------------*/

const THREAD_ID = "Chats/Question.chat";

const INTERRUPT: ToolInterrupt = {
	id: "int-1",
	toolCallId: "call_ask",
	toolName: "ask_question",
	args: { questions: [{ question: "Which folder?", options: [{ label: "A" }, { label: "B" }] }] },
};

const HUMAN = new HumanMessage({ content: "file it", id: "h1" });
const ASKING = new AIMessage({
	content: "One detail first.",
	id: "ai1",
	tool_calls: [{ id: "call_ask", name: "ask_question", args: INTERRUPT.args, type: "tool_call" }],
});

function checkpoint(
	checkpointId: string,
	step: number,
	messages: BaseMessage[],
	parentCheckpointId?: string,
	interrupts?: ToolInterrupt[],
): CheckpointHistoryItem {
	return {
		checkpointId,
		step,
		messages,
		parentCheckpointId,
		ts: new Date(2026, 0, 1, 0, step + 2).toISOString(),
		interrupts,
	};
}

/** A thread whose only turn stopped on the question, at checkpoint `b`. */
function pausedHistory(): CheckpointHistoryItem[] {
	return [
		checkpoint("r", -1, []),
		checkpoint("a", 0, [HUMAN], "r"),
		checkpoint("b", 1, [HUMAN, ASKING], "a", [INTERRUPT]),
	];
}

function pausedGraph(extra: CheckpointHistoryItem[] = [], active = "b") {
	const graph = buildCheckpointGraph([...pausedHistory(), ...extra]);
	graph.activeCheckpointId = active;
	return graph;
}

describe("pendingToolInterrupts", () => {
	it("reports the interrupt of a paused branch tip", () => {
		expect(pendingToolInterrupts(pausedGraph())).toEqual([INTERRUPT]);
	});

	it("reports nothing once the run continued below the paused checkpoint", () => {
		const answered = new ToolMessage({ content: "B", tool_call_id: "call_ask" });
		const graph = pausedGraph([checkpoint("c", 2, [HUMAN, ASKING, answered], "b")], "c");
		expect(pendingToolInterrupts(graph)).toEqual([]);
		// Not even when the stale checkpoint is the active one: it is no longer a tip.
		graph.activeCheckpointId = "b";
		expect(pendingToolInterrupts(graph)).toEqual([]);
	});

	it("reports nothing on a branch that never asked", () => {
		const other = new AIMessage({ content: "done", id: "ai2" });
		const graph = pausedGraph([checkpoint("d", 1, [HUMAN, other], "a")], "d");
		expect(pendingToolInterrupts(graph)).toEqual([]);
	});
});

describe("ChatSession — answering an open question", () => {
	const resumeFromInterrupt = vi.fn();
	const streamQuery = vi.fn();
	const getCheckpointHistory = vi.fn();

	type Internals = {
		runStream: (
			pairId: string,
			getStream: (signal: AbortSignal) => AsyncIterable<unknown>,
			options: { parentCheckpointId?: string; elapsedBeforeMs?: number },
		) => Promise<void>;
	};

	function makeSession() {
		const session = new ChatSession(THREAD_ID, {
			graphState: pausedGraph(),
			errorCount: 0,
			selectedAgentId: "agent-1",
		});
		const internals = session as unknown as Internals;
		// The stream itself is covered by the Agent tests; here only what the session
		// asks for matters, so run the stream factory and stop.
		const runStream = vi.fn(async (_pairId: string, getStream: (signal: AbortSignal) => AsyncIterable<unknown>) => {
			getStream(new AbortController().signal);
		});
		internals.runStream = runStream;
		return { session, runStream };
	}

	beforeEach(() => {
		resumeFromInterrupt.mockReset();
		streamQuery.mockReset();
		getCheckpointHistory.mockReset();
		// By default the stubbed run saves nothing.
		getCheckpointHistory.mockResolvedValue(pausedHistory());
		setPlugin({
			agentManager: { resumeFromInterrupt, streamQuery, getCheckpointHistory },
		} as unknown as SecondBrainPlugin);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exposes the open question from the checkpoint graph", () => {
		const { session } = makeSession();
		expect(session.pendingInterrupts).toEqual([INTERRUPT]);
		expect(session.messages).toHaveLength(1);
	});

	it("continues the asking turn from the paused checkpoint with the answer", async () => {
		const { session, runStream } = makeSession();
		const askingPairId = session.messages[0].id;

		await session.answerInterrupts(() => "the answer");

		expect(runStream).toHaveBeenCalledOnce();
		expect(runStream.mock.calls[0][0]).toBe(askingPairId);
		expect(resumeFromInterrupt).toHaveBeenCalledWith(
			THREAD_ID,
			"agent-1",
			"b",
			[{ interrupt: INTERRUPT, message: "the answer" }],
			expect.any(AbortSignal),
		);
		expect(session.messages).toHaveLength(1);
	});

	it("reopens the paused tool card so the answer can close it", async () => {
		const { session } = makeSession();
		const assistant = session.messages[0].assistantMessage;
		expect(assistant.toolCalls?.[0].status).toBe("completed");

		await session.answerInterrupts(() => "the answer");

		expect(assistant.toolCalls?.[0].status).toBe("running");
		expect(assistant.assistantTimeline?.some((e) => e.type === "tool_end" && e.toolCallId === "call_ask")).toBe(
			false,
		);
	});

	it("keeps the question open when the run made no progress", async () => {
		const { session } = makeSession();
		await session.answerInterrupts(() => "the answer");
		// The stubbed run wrote no checkpoint, so the thread is still paused where it was.
		expect(session.pendingInterrupts).toEqual([INTERRUPT]);
	});

	it("does not reopen a question whose answer was saved before the run failed", async () => {
		const { session } = makeSession();
		// The run wrote the answer, then died on the next model call: runStream never
		// synced the graph, but the thread has moved past the paused checkpoint.
		const answered = new ToolMessage({ content: "the answer", tool_call_id: "call_ask" });
		getCheckpointHistory.mockResolvedValue([
			...pausedHistory(),
			checkpoint("c", 2, [HUMAN, ASKING, answered], "b"),
		]);

		await session.answerInterrupts(() => "the answer");

		expect(session.pendingInterrupts).toEqual([]);
		expect(session.getActiveCheckpointId()).toBe("c");
	});

	it("holds a message sent while a stopped answer is still being reconciled", async () => {
		const { session } = makeSession();
		let releaseHistory: (items: CheckpointHistoryItem[]) => void = () => {};
		getCheckpointHistory.mockReturnValue(
			new Promise<CheckpointHistoryItem[]>((resolve) => {
				releaseHistory = resolve;
			}),
		);

		const answering = session.answerInterrupts(() => "the answer");
		await vi.waitFor(() => expect(getCheckpointHistory).toHaveBeenCalled());
		// The run is over and the chat reads idle, but whether the question is still
		// open is not known yet. A send now must wait rather than start a plain turn.
		const sending = session.sendMessage("actually, use Archive");
		await Promise.resolve();
		expect(resumeFromInterrupt).toHaveBeenCalledTimes(1);
		expect(streamQuery).not.toHaveBeenCalled();

		// Nothing was saved: the question is still open, so the message answers it.
		getCheckpointHistory.mockResolvedValue(pausedHistory());
		releaseHistory(pausedHistory());
		await answering;
		await sending;

		expect(streamQuery).not.toHaveBeenCalled();
		expect(resumeFromInterrupt).toHaveBeenCalledTimes(2);
	});

	it("carries the composer's context with a typed answer, apart from the reply", async () => {
		const { session } = makeSession();

		await session.sendMessage("use these notes", undefined, undefined, undefined, [
			{ path: "Notes/Plan.md", basename: "Plan" },
		]);

		const [, , , responses] = resumeFromInterrupt.mock.calls[0];
		const sent = JSON.parse(responses[0].message) as { reply: string; context?: string };
		expect(sent.reply).toBe("use these notes");
		expect(sent.context).toContain("[[Notes/Plan]]");
	});

	it("refuses attachments on a typed answer instead of dropping them", async () => {
		const { session } = makeSession();
		await expect(session.sendMessage("see file", [{ path: "a.png" } as never])).rejects.toThrow(/question/);
		expect(resumeFromInterrupt).not.toHaveBeenCalled();
		expect(session.pendingInterrupts).toEqual([INTERRUPT]);
	});

	it("delivers a message typed while the question is open as its answer", async () => {
		const { session } = makeSession();

		const pairId = await session.sendMessage("neither, use Archive");

		expect(streamQuery).not.toHaveBeenCalled();
		expect(pairId).toBe(session.messages[0].id);
		expect(session.messages).toHaveLength(1);
		const [, , , responses] = resumeFromInterrupt.mock.calls[0];
		expect(parseAskQuestionResult(responses[0].message)).toEqual({
			status: "replied",
			reply: "neither, use Archive",
		});
	});

	it("refuses to summarize while a question is open", async () => {
		const { session } = makeSession();
		await expect(session.summarizeHistoryNow()).rejects.toThrow(/question/);
	});
});
