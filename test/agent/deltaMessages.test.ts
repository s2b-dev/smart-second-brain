import { describe, it, expect, vi } from "vitest";
import { gunzipSync } from "node:zlib";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));
vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: vi.fn(() => ({ targetFolder: "Chats" })),
}));

import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, HumanMessage, RemoveMessage, ToolMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { z } from "zod";
import { ObsidianChatManager } from "../../src/agent/ObsidianChatManager";
import { createDeltaMessagesStateSchema } from "../../src/agent/threadReplay";
import { installContentIndexingSource, readIndexableContent } from "../../src/utils/fileFiltering";

/**
 * End-to-end check of `messages` stored as a LangGraph DeltaChannel (#540): the
 * same scripted conversation runs once with the default full-copy channel and
 * once with deltas, against the real vault saver. Everything the plugin reads
 * back — per-checkpoint history (timeline, branches), LangGraph's own state for
 * every checkpoint, a save/reload, and the search extraction — must match.
 */

const THREAD = "Chats/delta.chat";

/** A model that replays a fixed script of replies, each with a unique id. */
class ScriptedModel extends BaseChatModel {
	private next = 0;
	constructor(private readonly script: () => AIMessage[]) {
		super({});
	}
	private replies: AIMessage[] = [];
	_llmType() {
		return "scripted";
	}
	bindTools() {
		return this as never;
	}
	async _generate(): Promise<ChatResult> {
		if (this.next === 0) this.replies = this.script();
		const message = this.replies[this.next++];
		if (!message) throw new Error("script exhausted");
		return { generations: [{ message, text: String(message.content) }] };
	}
}

const lookup = tool(async ({ query }: { query: string }) => `result for ${query}`, {
	name: "lookup",
	description: "Look something up",
	schema: z.object({ query: z.string() }),
});

const TURNS = 8;

/** One reply per model call: turn 1 calls a tool first, the rest answer directly. */
function script(): AIMessage[] {
	const replies = [
		new AIMessage({
			id: "ai-tool",
			content: "",
			tool_calls: [{ id: "call-1", name: "lookup", args: { query: "q1" }, type: "tool_call" }],
		}),
		new AIMessage({ id: "ai-1", content: "answer 1" }),
	];
	for (let turn = 2; turn <= TURNS; turn++)
		replies.push(new AIMessage({ id: `ai-${turn}`, content: `answer ${turn}` }));
	replies.push(new AIMessage({ id: "ai-regen", content: "regenerated answer" }));
	replies.push(new AIMessage({ id: "ai-edit", content: "answer to the edit" }));
	replies.push(new AIMessage({ id: "ai-after-summary", content: "answer after summary" }));
	return replies;
}

function createMockPlugin() {
	return {
		manifest: { id: "smart-second-brain", dir: "smart-second-brain" },
		registerEvent: vi.fn(),
		app: {
			vault: {
				on: vi.fn(),
				getAbstractFileByPath: vi.fn(() => null),
				adapter: {
					exists: vi.fn().mockResolvedValue(false),
					readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
					writeBinary: vi.fn().mockResolvedValue(undefined),
					mkdir: vi.fn().mockResolvedValue(undefined),
					remove: vi.fn().mockResolvedValue(undefined),
					list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
					stat: vi.fn().mockResolvedValue({ ctime: 1000, mtime: 2000, size: 100 }),
				},
				configDir: ".obsidian",
			},
		},
	};
}

/**
 * A message reduced to what the UI shows. Ids are kept since branching keys on
 * them, except a tool result's, which LangGraph generates at random per run; it
 * is keyed by the call it answers instead.
 */
function signature(messages: BaseMessage[]): string {
	return JSON.stringify(
		messages.map((m) => [
			m.getType(),
			ToolMessage.isInstance(m) ? `tool:${m.tool_call_id}` : m.id,
			typeof m.content === "string" ? m.content : m.content,
			(m as AIMessage).tool_calls?.map((call) => call.name) ?? [],
		]),
	);
}

async function runConversation(useDeltas: boolean) {
	const plugin = createMockPlugin();
	const manager = new ObsidianChatManager(plugin as never);
	const agent = createAgent({
		model: new ScriptedModel(script),
		tools: [lookup],
		checkpointer: manager,
		...(useDeltas ? { stateSchema: createDeltaMessagesStateSchema(3) } : {}),
	});
	const config = (checkpointId?: string) => ({
		configurable: { thread_id: THREAD, ...(checkpointId ? { checkpoint_id: checkpointId } : {}) },
	});

	for (let turn = 1; turn <= TURNS; turn++) {
		await agent.invoke(
			{ messages: [new HumanMessage({ id: `human-${turn}`, content: `question ${turn}` })] },
			config(),
		);
	}

	// Regenerate the last answer: rerun from the checkpoint whose last message is the last question.
	const history = await manager.readCheckpointHistory(THREAD);
	const lastQuestion = history.find((item) => {
		const last = item.messages.at(-1);
		return last?.id === `human-${TURNS}` && item.messages.length === TURNS * 2 + 1;
	});
	expect(lastQuestion).toBeDefined();
	await agent.invoke(null, config(lastQuestion?.checkpointId));

	// Edit turn 2's question: rerun from the end of turn 1 with a new question.
	const endOfTurnOne = history.find((item) => item.messages.at(-1)?.id === "ai-1" && item.messages.length === 4);
	expect(endOfTurnOne).toBeDefined();
	await agent.invoke(
		{ messages: [new HumanMessage({ id: "human-edit", content: "edited question 2" })] },
		config(endOfTurnOne?.checkpointId),
	);

	// Summarization-style rewrite on the edit branch: drop everything, keep a summary.
	// Every step from here addresses its checkpoint by id: "latest" breaks
	// same-millisecond timestamp ties by step, which a fast run can hit.
	const editTip = await tipOf(manager, "ai-edit");
	const summarized = await agent.updateState(config(editTip), {
		messages: [
			new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
			new HumanMessage({ id: "summary", content: "summary of the chat" }),
		],
	});
	await agent.invoke(
		{ messages: [new HumanMessage({ id: "human-after", content: "next question" })] },
		config((summarized as { configurable?: { checkpoint_id?: string } }).configurable?.checkpoint_id),
	);

	await manager.flush(THREAD);
	const writes = (plugin.app.vault.adapter.writeBinary as ReturnType<typeof vi.fn>).mock.calls;
	const file = writes[writes.length - 1][1] as ArrayBuffer;
	return { agent, manager, file, tipId: await tipOf(manager, "ai-after-summary") };
}

/** The checkpoint whose newest message is `messageId`. */
async function tipOf(manager: ObsidianChatManager, messageId: string): Promise<string> {
	const history = await manager.readCheckpointHistory(THREAD);
	const tip = history.find((item) => item.messages.at(-1)?.id === messageId);
	expect(tip).toBeDefined();
	return tip?.checkpointId as string;
}

/** Per-checkpoint histories as a sorted multiset (checkpoint ids differ between runs). */
async function historySignatures(manager: ObsidianChatManager) {
	const history = await manager.readCheckpointHistory(THREAD);
	return history.map((item) => `${item.step}:${signature(item.messages)}`).sort();
}

async function reload(file: ArrayBuffer) {
	const plugin = createMockPlugin();
	plugin.app.vault.adapter.exists.mockResolvedValue(true);
	plugin.app.vault.adapter.readBinary.mockResolvedValue(file);
	return new ObsidianChatManager(plugin as never);
}

describe("messages stored as deltas", () => {
	it("reads back exactly what full copies read back, and stores far less", async () => {
		const full = await runConversation(false);
		const delta = await runConversation(true);

		// Timeline / branch history: identical per-checkpoint message lists.
		const fullHistory = await historySignatures(full.manager);
		expect(await historySignatures(delta.manager)).toEqual(fullHistory);

		// LangGraph's own reconstruction agrees with the plugin's replay at every checkpoint.
		for (const item of await delta.manager.readCheckpointHistory(THREAD)) {
			const state = await delta.agent.graph.getState({
				configurable: { thread_id: THREAD, checkpoint_id: item.checkpointId },
			});
			expect(signature((state.values as { messages: BaseMessage[] }).messages)).toBe(signature(item.messages));
		}

		// The summarized branch ends after the summary rewrite.
		const tip = await delta.agent.graph.getState({
			configurable: { thread_id: THREAD, checkpoint_id: delta.tipId },
		});
		expect((tip.values as { messages: BaseMessage[] }).messages.map((m) => m.id)).toEqual([
			"summary",
			"human-after",
			"ai-after-summary",
		]);

		// A save/reload cycle changes nothing.
		expect(await historySignatures(await reload(delta.file))).toEqual(fullHistory);

		// Search indexes the same conversation.
		installContentIndexingSource(() => ({ pdfs: false, chats: true, data: false }));
		const index = async (file: ArrayBuffer) =>
			readIndexableContent(
				{ adapter: { readBinary: vi.fn().mockResolvedValue(file) } } as never,
				{ path: THREAD, extension: "chat", basename: "delta" } as never,
			);
		expect(await index(delta.file)).toBe(await index(full.file));
		expect(await index(delta.file)).toContain("answer after summary");
		installContentIndexingSource(null);

		// Full copies repeat the history in every checkpoint; deltas don't.
		const size = (file: ArrayBuffer) => gunzipSync(Buffer.from(file)).length;
		expect(size(delta.file)).toBeLessThan(size(full.file));
	});

	it("keeps reading a thread saved before deltas, and continues it with deltas", async () => {
		const legacy = await runConversation(false);
		const plugin = createMockPlugin();
		plugin.app.vault.adapter.exists.mockResolvedValue(true);
		plugin.app.vault.adapter.readBinary.mockResolvedValue(legacy.file);
		const manager = new ObsidianChatManager(plugin as never);
		const agent = createAgent({
			model: new ScriptedModel(() => [new AIMessage({ id: "ai-continued", content: "continued" })]),
			tools: [lookup],
			checkpointer: manager,
			stateSchema: createDeltaMessagesStateSchema(3),
		});

		await agent.invoke(
			{ messages: [new HumanMessage({ id: "human-continued", content: "one more" })] },
			{ configurable: { thread_id: THREAD, checkpoint_id: legacy.tipId } },
		);

		const tip = await agent.graph.getState({
			configurable: { thread_id: THREAD, checkpoint_id: await tipOf(manager, "ai-continued") },
		});
		expect((tip.values as { messages: BaseMessage[] }).messages.map((m) => m.id)).toEqual([
			"summary",
			"human-after",
			"ai-after-summary",
			"human-continued",
			"ai-continued",
		]);
		const history = await manager.readCheckpointHistory(THREAD);
		const newest = history.find((item) => item.messages.at(-1)?.id === "ai-continued");
		expect(newest?.messages.map((m) => m.id)).toEqual(
			(tip.values as { messages: BaseMessage[] }).messages.map((m) => m.id),
		);
	});
});
