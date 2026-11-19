import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ChatSession } from "../../src/stores/chatStore.svelte";
import { setPlugin } from "../../src/stores/state.svelte";
import { AssistantState, buildCheckpointGraph, type CheckpointGraphState } from "../../src/stores/chatTimeline";
import type { CheckpointHistoryItem } from "../../src/agent/Agent";
import type SecondBrainPlugin from "../../src/main";
import { isDefaultChatTitle, needsChatTitle } from "../../src/utils/chatTitle";

/* --------------------------------------------------------------------------
 * ChatSession — auto-title after the first SUCCESSFUL turn.
 *
 * Titling used to hang off the first submit only. When that first turn errored
 * the rename never ran, and neither the retry, a regenerate nor an edit titled
 * the chat afterwards. The file kept its "New Chat" name while no longer being
 * empty, so every later new chat was deduped to "New Chat (2)", "(3)", ...
 *
 * The rule now: any turn that succeeds while the thread still carries the
 * placeholder name titles it from the conversation's opening message.
 * ------------------------------------------------------------------------*/

function checkpoint(
	checkpointId: string,
	step: number,
	messages: (HumanMessage | AIMessage)[],
	parentCheckpointId?: string,
): CheckpointHistoryItem {
	return { checkpointId, step, messages, parentCheckpointId, ts: new Date(2026, 0, 1, 0, step + 2).toISOString() };
}

/** One turn; `summarized` prepends the hidden summary a compacted history leads with. */
function buildGraph({ summarized = false } = {}): CheckpointGraphState {
	const lead = summarized
		? [
				new HumanMessage({
					content: "Summary of the earlier conversation",
					id: "sum",
					additional_kwargs: { lc_source: "summarization" },
				}),
			]
		: [];
	const h1 = new HumanMessage({ content: "how do I water ferns", id: "h1" });
	const ai1 = new AIMessage({ content: "sparingly", id: "ai1" });
	const graph = buildCheckpointGraph([
		checkpoint("r", -1, []),
		checkpoint("a", 0, [...lead, h1], "r"),
		checkpoint("b", 1, [...lead, h1, ai1], "a"),
	]);
	graph.activeCheckpointId = "b";
	return graph;
}

type RunStreamInternals = {
	runStream(
		pairId: string,
		getStream: (signal: AbortSignal) => AsyncIterable<unknown>,
		options: { beforeCheckpointIds: Set<string> },
	): Promise<void>;
	consumeStream: (...args: unknown[]) => Promise<void>;
	syncGraphAfterRun: (...args: unknown[]) => Promise<void>;
	shouldPredictSummarization: (...args: unknown[]) => Promise<boolean>;
	withdrawAbandonedPendingChanges: (...args: unknown[]) => void;
};

const generateTitle = vi.fn();
const markThreadFailed = vi.fn();

function makeSession(
	threadId: string,
	{
		onThreadIdChange,
		summarized,
	}: { onThreadIdChange?: (oldPath: string, newPath: string) => void; summarized?: boolean } = {},
): { session: ChatSession; internals: RunStreamInternals } {
	const session = new ChatSession(threadId, {
		graphState: buildGraph({ summarized }),
		errorCount: 0,
		selectedAgentId: "",
		onThreadIdChange,
	});
	const internals = session as unknown as RunStreamInternals;
	internals.consumeStream = vi.fn().mockResolvedValue(undefined);
	internals.syncGraphAfterRun = vi.fn().mockResolvedValue(undefined);
	// Only reached on the retry path; neither is under test here.
	internals.shouldPredictSummarization = vi.fn().mockResolvedValue(false);
	internals.withdrawAbandonedPendingChanges = vi.fn();
	return { session, internals };
}

async function run(session: ChatSession, internals: RunStreamInternals): Promise<void> {
	const pair = session.messages.at(-1);
	if (!pair) throw new Error("expected a message pair");
	await internals.runStream.call(session, pair.id, () => (async function* () {})(), {
		beforeCheckpointIds: new Set(["r", "a", "b"]),
	});
}

describe("ChatSession — auto-title after the first successful turn", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		generateTitle.mockResolvedValue("Chats/Watering Ferns.chat");
		markThreadFailed.mockResolvedValue("Chats/New Chat (failed).chat");
		setPlugin({
			agentManager: {
				generateThreadTitleFromUserMessage: generateTitle,
				markThreadFailed,
				regenerateFromCheckpoint: vi.fn(),
				annotateThinkingDuration: vi.fn().mockResolvedValue(undefined),
			},
		} as unknown as SecondBrainPlugin);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("titles a still-placeholder chat from its opening message", async () => {
		const onThreadIdChange = vi.fn();
		const { session, internals } = makeSession("Chats/New Chat.chat", { onThreadIdChange });

		await run(session, internals);

		expect(generateTitle).toHaveBeenCalledWith("Chats/New Chat.chat", "", "how do I water ferns");
		expect(String(session.id)).toBe("Chats/Watering Ferns.chat");
		expect(onThreadIdChange).toHaveBeenCalledWith("Chats/New Chat.chat", "Chats/Watering Ferns.chat");
	});

	it("titles the chat when a retry succeeds after the first turn failed", async () => {
		const { session, internals } = makeSession("Chats/New Chat.chat");
		internals.consumeStream = vi.fn().mockRejectedValueOnce(new Error("model refused"));

		await run(session, internals);
		expect(generateTitle).not.toHaveBeenCalled();
		const failed = session.messages.at(-1)!;
		expect(failed.assistantMessage.state).toBe(AssistantState.error);

		expect(String(session.id)).toBe("Chats/New Chat (failed).chat");

		// The retry goes through the regenerate path, which never passed a title before.
		await session.retryLastError(failed.id);

		expect(generateTitle).toHaveBeenCalledWith("Chats/New Chat (failed).chat", "", "how do I water ferns");
		expect(String(session.id)).toBe("Chats/Watering Ferns.chat");
	});

	it("titles from the first real message when a summary marker leads the history", async () => {
		const { session, internals } = makeSession("Chats/New Chat.chat", { summarized: true });
		expect(session.messages[0]?.userMessage.content).toBe("");

		await run(session, internals);

		expect(generateTitle).toHaveBeenCalledWith("Chats/New Chat.chat", "", "how do I water ferns");
	});

	it("titles an auto-deduped placeholder like 'New Chat (3)'", async () => {
		const { session, internals } = makeSession("Chats/New Chat (3).chat");

		await run(session, internals);

		expect(generateTitle).toHaveBeenCalledOnce();
	});

	it("leaves an already-titled chat alone", async () => {
		const { session, internals } = makeSession("Chats/Watering Ferns.chat");

		await run(session, internals);

		expect(generateTitle).not.toHaveBeenCalled();
	});

	it("moves a placeholder chat to 'New Chat (failed)' when its turn fails, freeing the name", async () => {
		const onThreadIdChange = vi.fn();
		const { session, internals } = makeSession("Chats/New Chat.chat", { onThreadIdChange });
		internals.consumeStream = vi.fn().mockRejectedValue(new Error("model refused"));

		await run(session, internals);

		expect(generateTitle).not.toHaveBeenCalled();
		expect(markThreadFailed).toHaveBeenCalledWith("Chats/New Chat.chat");
		expect(String(session.id)).toBe("Chats/New Chat (failed).chat");
		expect(onThreadIdChange).toHaveBeenCalledWith("Chats/New Chat.chat", "Chats/New Chat (failed).chat");
		expect(session.messages.at(-1)?.assistantMessage.state).toBe(AssistantState.error);
	});

	it("does not re-mark an already failed chat, nor mark a titled one", async () => {
		for (const threadId of ["Chats/New Chat (failed).chat", "Chats/Watering Ferns.chat"]) {
			const { session, internals } = makeSession(threadId);
			internals.consumeStream = vi.fn().mockRejectedValue(new Error("model refused"));

			await run(session, internals);

			expect(String(session.id)).toBe(threadId);
		}
		expect(markThreadFailed).not.toHaveBeenCalled();
	});

	it("does not mark a chat failed when the user stopped the turn", async () => {
		const { session, internals } = makeSession("Chats/New Chat.chat");
		internals.consumeStream = vi.fn().mockImplementation(async () => {
			(session as unknown as { cancelled: boolean }).cancelled = true;
			throw new Error("aborted");
		});

		await run(session, internals);

		expect(markThreadFailed).not.toHaveBeenCalled();
	});

	it("keeps the error visible when the failed-marker rename itself throws", async () => {
		markThreadFailed.mockRejectedValue(new Error("rename failed"));
		const { session, internals } = makeSession("Chats/New Chat.chat");
		internals.consumeStream = vi.fn().mockRejectedValue(new Error("model refused"));

		await run(session, internals);

		expect(String(session.id)).toBe("Chats/New Chat.chat");
		expect(session.messages.at(-1)?.assistantMessage.errorCode).toContain("model refused");
		expect(session.isRunning).toBe(false);
	});
});

describe("placeholder title matchers", () => {
	it.each([
		// path, isDefaultChatTitle (reusable placeholder), needsChatTitle
		["Chats/New Chat.chat", true, true],
		["Chats/New Chat (2).chat", true, true],
		["New Chat", true, true],
		["Chats/New Chat (failed).chat", false, true],
		["Chats/New Chat (failed) (2).chat", false, true],
		["Chats/New Chat about ferns.chat", false, false],
		["Chats/New Chat (x).chat", false, false],
		["Chats/Watering Ferns.chat", false, false],
	])("%s → default %s, needs title %s", (path, isDefault, needsTitle) => {
		expect(isDefaultChatTitle(path)).toBe(isDefault);
		expect(needsChatTitle(path)).toBe(needsTitle);
	});
});
