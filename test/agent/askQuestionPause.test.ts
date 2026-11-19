import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { Agent, type AgentStreamChunk, type ResolvedRun } from "../../src/agent/Agent";
import { PAUSES_FOR_USER } from "../../src/agent/toolInterrupts";
import { buildCheckpointGraph, pendingToolInterrupts } from "../../src/stores/chatTimeline";

/*
 * `ask_question` end to end against the real LangChain stack: the human-in-the-loop
 * middleware pauses the call, the pause is read back from checkpoint history (not from
 * anything held in memory), and the user's answer becomes the tool result.
 */

const THREAD_ID = "Chats/thread.chat";

/** Asks a question alongside a search on the first turn, then reports what it saw. */
class AskingModel extends BaseChatModel {
	_llmType() {
		return "asking-fake";
	}

	bindTools() {
		return this as never;
	}

	async _generate(messages: BaseMessage[]) {
		const last = messages[messages.length - 1];
		const message =
			last.type === "human"
				? new AIMessage({
						content: "Let me check.",
						tool_calls: [
							{
								id: "call_ask",
								name: "ask_question",
								args: {
									questions: [
										{ question: "Which folder?", options: [{ label: "A" }, { label: "B" }] },
									],
								},
								type: "tool_call",
							},
							{ id: "call_search", name: "search", args: { q: "plan" }, type: "tool_call" },
						],
					})
				: new AIMessage("All done.");
		return { generations: [{ message, text: String(message.content) }] };
	}
}

function makeHarness() {
	const askBody = vi.fn(async () => "must never run");
	const searchBody = vi.fn(async ({ q }: { q: string }) => `results for ${q}`);
	const tools = [
		tool(askBody, {
			name: "ask_question",
			description: "Ask the user.",
			schema: z.object({ questions: z.array(z.unknown()) }),
			metadata: { [PAUSES_FOR_USER]: true },
		}),
		tool(searchBody, { name: "search", description: "Search.", schema: z.object({ q: z.string() }) }),
	];
	const registry = { createChatInstance: () => new AskingModel({}) };
	const agent = new Agent({ registry: registry as never });
	const resolve = (): Promise<ResolvedRun> =>
		agent.resolveRun({
			provider: "fake",
			chatModel: "fake-model",
			options: { contextWindow: 128_000 },
			cacheKey: "ask-question",
			systemPrompt: "You are helpful.",
			tools,
			subAgents: [],
		});
	return { agent, resolve, askBody, searchBody };
}

async function collect(stream: AsyncGenerator<AgentStreamChunk>): Promise<AgentStreamChunk[]> {
	const out: AgentStreamChunk[] = [];
	for await (const chunk of stream) out.push(chunk);
	return out;
}

/** The checkpoint graph as the chat store sees it after a run, on the latest checkpoint. */
async function graphAtLatest(agent: Agent) {
	const graph = buildCheckpointGraph(await agent.getCheckpointHistory(THREAD_ID));
	graph.activeCheckpointId = await agent.getLatestCheckpointId(THREAD_ID);
	return graph;
}

describe("ask_question pause and resume", () => {
	it("pauses the call, keeps it in the checkpoint, and resumes with the user's answer", async () => {
		const { agent, resolve, askBody, searchBody } = makeHarness();

		const paused = await collect(
			agent.streamTokens({ query: "file it", resolved: await resolve(), threadId: THREAD_ID }),
		);

		// The paused call is announced with its arguments but never ends; the other call
		// of the same step ran to completion.
		expect(paused.find((c) => c.type === "tool_start" && c.toolCallId === "call_ask")).toMatchObject({
			toolName: "ask_question",
			input: { questions: [{ question: "Which folder?", options: [{ label: "A" }, { label: "B" }] }] },
		});
		expect(paused.some((c) => c.type === "tool_end" && c.toolCallId === "call_ask")).toBe(false);
		expect(paused.some((c) => c.type === "tool_end" && c.toolCallId === "call_search")).toBe(true);
		// A pause settles the turn like any other: the store rebuilds from the checkpoint.
		expect(paused.some((c) => c.type === "result")).toBe(true);
		expect(askBody).not.toHaveBeenCalled();
		expect(searchBody).toHaveBeenCalledTimes(1);

		// The open question is read from checkpoint history alone.
		const pausedGraph = await graphAtLatest(agent);
		const pending = pendingToolInterrupts(pausedGraph);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ toolCallId: "call_ask", toolName: "ask_question" });

		const resumed = await collect(
			agent.resumeFromInterrupt({
				resolved: await resolve(),
				threadId: THREAD_ID,
				checkpointId: pausedGraph.activeCheckpointId as string,
				responses: [{ interrupt: pending[0], message: "the user picked B" }],
			}),
		);

		expect(resumed[0]).toMatchObject({ type: "tool_end", toolCallId: "call_ask", output: "the user picked B" });
		expect(resumed.some((c) => c.type === "token" && c.token.includes("All done."))).toBe(true);
		// Answering in place does not re-run the paused step's other calls.
		expect(askBody).not.toHaveBeenCalled();
		expect(searchBody).toHaveBeenCalledTimes(1);

		const settledGraph = await graphAtLatest(agent);
		expect(pendingToolInterrupts(settledGraph)).toEqual([]);
		const messages = settledGraph.nodes.get(settledGraph.activeCheckpointId as string)?.messages ?? [];
		const answer = messages.find((m) => ToolMessage.isInstance(m) && m.tool_call_id === "call_ask");
		expect(answer?.content).toBe("the user picked B");
		expect(messages.at(-1)?.content).toBe("All done.");
	});

	it("keeps an abandoned question answerable when its branch is selected again", async () => {
		const { agent, resolve } = makeHarness();

		await collect(agent.streamTokens({ query: "file it", resolved: await resolve(), threadId: THREAD_ID }));
		const pausedGraph = await graphAtLatest(agent);
		const pausedCheckpointId = pausedGraph.activeCheckpointId as string;
		const [interrupt] = pendingToolInterrupts(pausedGraph);

		// The user edits the first message instead of answering: a new branch from the root.
		const root = [...pausedGraph.nodes.values()].find((node) => node.messages.length === 0);
		await collect(
			agent.editFromCheckpoint({
				query: "file it somewhere else",
				resolved: await resolve(),
				threadId: THREAD_ID,
				checkpointId: root?.checkpointId as string,
			}),
		);

		// Back on the first branch, the question is still open, and answering it works
		// even though its checkpoint is no longer the thread's latest.
		const history = buildCheckpointGraph(await agent.getCheckpointHistory(THREAD_ID));
		history.activeCheckpointId = pausedCheckpointId;
		expect(pendingToolInterrupts(history).map((i) => i.id)).toEqual([interrupt.id]);

		const resumed = await collect(
			agent.resumeFromInterrupt({
				resolved: await resolve(),
				threadId: THREAD_ID,
				checkpointId: pausedCheckpointId,
				responses: [{ interrupt, message: "late answer" }],
			}),
		);
		expect(resumed[0]).toMatchObject({ type: "tool_end", toolCallId: "call_ask", output: "late answer" });
		expect(resumed.some((c) => c.type === "result")).toBe(true);

		const after = buildCheckpointGraph(await agent.getCheckpointHistory(THREAD_ID));
		after.activeCheckpointId = pausedCheckpointId;
		// The paused checkpoint now has the continuation below it: no longer a tip.
		expect(pendingToolInterrupts(after)).toEqual([]);
	});
});
