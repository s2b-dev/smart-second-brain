import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => ({
		getSelectedAgent: () => ({ id: "agent-1", name: "Agent", chatModel: undefined }),
		getAgent: () => undefined,
		showToolIODetails: false,
	}),
}));

import { ChatSession, type TurnProgress } from "../../src/stores/chatStore.svelte";
import { AssistantState, type AssistantMessage } from "../../src/stores/chatTimeline";

/* --------------------------------------------------------------------------
 * Turn progress: the preamble must reach listeners exactly once per step, at
 * whichever chunk first carries it. Providers that stream tool-call deltas
 * announce a tool twice (tool_pending, then tool_start) with the same preamble;
 * the pending branch consumes it for the chat, and a listener hooked only into
 * tool_start would never hear it. That was voice mode's silent-narration bug.
 * ------------------------------------------------------------------------*/

type Internals = {
	consumeStream: (assistantMessage: AssistantMessage, stream: AsyncIterable<unknown>) => Promise<void>;
};

function makeSession(): { session: ChatSession; internals: Internals } {
	const session = new ChatSession("Chats/Progress.chat", {
		graphState: { nodes: new Map() },
		errorCount: 0,
		selectedAgentId: "",
	});
	return { session, internals: session as unknown as Internals };
}

function assistantMessage(): AssistantMessage {
	return { state: AssistantState.streaming, content: "", assistantTimeline: [] } as unknown as AssistantMessage;
}

async function* chunks(items: unknown[]) {
	for (const item of items) yield item;
}

const common = { runId: "r", threadId: "t" };

describe("ChatSession turn progress", () => {
	it("reports a preamble once when tool_pending precedes tool_start", async () => {
		const { session, internals } = makeSession();
		const seen: TurnProgress[] = [];
		session.subscribeTurnProgress((p) => seen.push(p));

		await internals.consumeStream(
			assistantMessage(),
			chunks([
				{
					type: "tool_pending",
					toolCallId: "c1",
					toolName: "search_notes",
					preamble: "Let me look.",
					...common,
				},
				{
					type: "tool_start",
					toolCallId: "c1",
					toolName: "search_notes",
					input: { query: "x" },
					preamble: "Let me look.",
					...common,
				},
				{ type: "tool_end", toolCallId: "c1", toolName: "search_notes", output: "ok", ...common },
				{ type: "result", result: { messages: [] }, ...common },
			]),
		);

		expect(seen).toEqual([{ toolName: "search_notes", preamble: "Let me look." }]);
	});

	it("still reports a preamble that only tool_start carries", async () => {
		const { session, internals } = makeSession();
		const seen: TurnProgress[] = [];
		session.subscribeTurnProgress((p) => seen.push(p));

		await internals.consumeStream(
			assistantMessage(),
			chunks([
				{
					type: "tool_start",
					toolCallId: "c1",
					toolName: "read_content",
					input: { path: "a.md" },
					preamble: "Reading it.",
					...common,
				},
				{ type: "tool_end", toolCallId: "c1", toolName: "read_content", output: "ok", ...common },
				{ type: "result", result: { messages: [] }, ...common },
			]),
		);

		expect(seen).toHaveLength(1);
		expect(seen[0].preamble).toBe("Reading it.");
	});

	it("stays quiet for tool calls without a preamble and for a repeated one", async () => {
		const { session, internals } = makeSession();
		const seen: TurnProgress[] = [];
		session.subscribeTurnProgress((p) => seen.push(p));

		await internals.consumeStream(
			assistantMessage(),
			chunks([
				{ type: "tool_pending", toolCallId: "c1", toolName: "search_notes", preamble: "Same.", ...common },
				{ type: "tool_pending", toolCallId: "c2", toolName: "grep_notes", preamble: "Same.", ...common },
				{
					type: "tool_start",
					toolCallId: "c1",
					toolName: "search_notes",
					input: {},
					preamble: "Same.",
					...common,
				},
				{
					type: "tool_start",
					toolCallId: "c2",
					toolName: "grep_notes",
					input: {},
					preamble: "Same.",
					...common,
				},
				{ type: "tool_end", toolCallId: "c1", toolName: "search_notes", output: "ok", ...common },
				{ type: "tool_end", toolCallId: "c2", toolName: "grep_notes", output: "ok", ...common },
				{ type: "tool_start", toolCallId: "c3", toolName: "read_content", input: {}, ...common },
				{ type: "tool_end", toolCallId: "c3", toolName: "read_content", output: "ok", ...common },
				{ type: "result", result: { messages: [] }, ...common },
			]),
		);

		expect(seen.map((p) => p.preamble)).toEqual(["Same."]);
	});
});
