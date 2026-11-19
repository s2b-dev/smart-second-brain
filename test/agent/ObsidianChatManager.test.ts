import { describe, it, expect, vi, beforeEach } from "vitest";
import { gzipSync, gunzipSync } from "node:zlib";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

// Mock dataStore.svelte for getChatFolder / targetFolder
vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: vi.fn(() => ({
		targetFolder: "Chats",
	})),
}));

import { ObsidianChatManager } from "../../src/agent/ObsidianChatManager";
import { THREAD_DATA_VERSION } from "../../src/agent/threadDataCodec";
import type { BaseMessage } from "@langchain/core/messages";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------*/

function createMockPlugin() {
	return {
		manifest: { id: "smart-second-brain", dir: "smart-second-brain" },
		registerEvent: vi.fn(),
		app: {
			vault: {
				on: vi.fn(),
				adapter: {
					exists: vi.fn().mockResolvedValue(false),
					read: vi.fn().mockResolvedValue(""),
					readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
					write: vi.fn().mockResolvedValue(undefined),
					writeBinary: vi.fn().mockResolvedValue(undefined),
					mkdir: vi.fn().mockResolvedValue(undefined),
					remove: vi.fn().mockResolvedValue(undefined),
					rmdir: vi.fn().mockResolvedValue(undefined),
					list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
					stat: vi.fn().mockResolvedValue({ ctime: 1000, mtime: 2000, size: 100 }),
				},
				configDir: ".obsidian",
			},
		},
	};
}

function makeCheckpoint(id: string, ts: string): Checkpoint {
	// `pending_sends` is a legacy LangGraph field: it still turns up in checkpoints written
	// by older versions, so the fixture keeps it, but it is no longer on the Checkpoint type
	// (and nothing in src/ reads it). The cast records that this is on-disk shape, wider
	// than the current type, rather than a field we expect to be checked.
	return {
		v: 1,
		id,
		ts,
		channel_values: { messages: [] },
		channel_versions: {},
		versions_seen: {},
		pending_sends: [],
	} as Checkpoint & { pending_sends: unknown[] };
}

function makeMetadata(step: number, parentCheckpointId?: string): CheckpointMetadata {
	// Same as makeCheckpoint: LangGraph writes `writes` into checkpoint metadata at runtime
	// (the codec dedups through it — see threadDataCodec), but it is not declared on
	// CheckpointMetadata. Cast rather than drop it, since its presence is the point.
	return {
		source: "loop",
		step,
		writes: {},
		parents: parentCheckpointId ? { "": parentCheckpointId } : {},
	} as CheckpointMetadata & { writes: Record<string, unknown> };
}

/* --------------------------------------------------------------------------
 * ObsidianChatManager – ThreadStore operations
 * ------------------------------------------------------------------------*/

describe("ObsidianChatManager", () => {
	let manager: ObsidianChatManager;
	let plugin: ReturnType<typeof createMockPlugin>;

	beforeEach(() => {
		plugin = createMockPlugin();
		manager = new ObsidianChatManager(plugin as never);
	});

	describe("ThreadStore operations", () => {
		it("should create and read a thread snapshot", async () => {
			const threadStore = manager.asThreadStore();

			await threadStore.write({
				threadId: "Chats/thread-1.chat",
				title: "Test Thread",
				createdAt: 1000,
				updatedAt: 2000,
			});

			const result = await threadStore.read("Chats/thread-1.chat");
			expect(result).toBeDefined();
			expect(result!.threadId).toBe("Chats/thread-1.chat");
			expect(result!.title).toBe("Test Thread");
			expect(result!.createdAt).toBe(1000);
		});

		it("should list threads sorted by updatedAt descending", async () => {
			const threadStore = manager.asThreadStore();
			// Mark index as loaded to avoid rebuild
			(manager as unknown as { indexLoaded: boolean }).indexLoaded = true;

			// Populate threadIndex directly (write() defers index updates via debounce)
			const threadIndex = (
				manager as unknown as {
					threadIndex: Map<string, { threadId: string; title: string; createdAt: number; updatedAt: number }>;
				}
			).threadIndex;
			threadIndex.set("Chats/old.chat", {
				threadId: "Chats/old.chat",
				title: "Old Thread",
				createdAt: 1000,
				updatedAt: 1000,
			});
			threadIndex.set("Chats/new.chat", {
				threadId: "Chats/new.chat",
				title: "New Thread",
				createdAt: 2000,
				updatedAt: 3000,
			});
			threadIndex.set("Chats/mid.chat", {
				threadId: "Chats/mid.chat",
				title: "Mid Thread",
				createdAt: 1500,
				updatedAt: 2000,
			});

			const threads = await threadStore.list();
			expect(threads).toHaveLength(3);
			expect(threads[0].threadId).toBe("Chats/new.chat");
			expect(threads[1].threadId).toBe("Chats/mid.chat");
			expect(threads[2].threadId).toBe("Chats/old.chat");
		});

		it("should delete a thread", async () => {
			const threadStore = manager.asThreadStore();
			(manager as unknown as { indexLoaded: boolean }).indexLoaded = true;

			await threadStore.write({
				threadId: "Chats/to-delete.chat",
				title: "Delete Me",
				createdAt: 1000,
				updatedAt: 1000,
			});

			await threadStore.delete("Chats/to-delete.chat");

			const result = await threadStore.read("Chats/to-delete.chat");
			expect(result).toBeUndefined();

			const threads = await threadStore.list();
			expect(threads.find((t) => t.threadId === "Chats/to-delete.chat")).toBeUndefined();
		});

		it("should clear all threads", async () => {
			const threadStore = manager.asThreadStore();
			(manager as unknown as { indexLoaded: boolean }).indexLoaded = true;

			await threadStore.write({
				threadId: "Chats/t1.chat",
				title: "Thread 1",
				createdAt: 1000,
				updatedAt: 1000,
			});
			await threadStore.write({
				threadId: "Chats/t2.chat",
				title: "Thread 2",
				createdAt: 2000,
				updatedAt: 2000,
			});

			await threadStore.clear();

			const threads = await threadStore.list();
			expect(threads).toHaveLength(0);
		});

		it("should update an existing thread's metadata", async () => {
			const threadStore = manager.asThreadStore();

			await threadStore.write({
				threadId: "Chats/thread-update.chat",
				title: "Original",
				createdAt: 1000,
				updatedAt: 1000,
			});

			await threadStore.write({
				threadId: "Chats/thread-update.chat",
				title: "Updated Title",
				createdAt: 1000,
				updatedAt: 2000,
			});

			const result = await threadStore.read("Chats/thread-update.chat");
			expect(result!.title).toBe("Updated Title");
			expect(result!.updatedAt).toBe(2000);
		});

		it("should flush a pending thread snapshot write to disk immediately", async () => {
			const threadStore = manager.asThreadStore();

			await threadStore.write({
				threadId: "Chats/thread-flush.chat",
				title: "Flush Me",
				createdAt: 1000,
				updatedAt: 2000,
			});

			expect(plugin.app.vault.adapter.writeBinary).not.toHaveBeenCalled();

			await threadStore.flush?.("Chats/thread-flush.chat");

			expect(plugin.app.vault.adapter.writeBinary).toHaveBeenCalled();
			const [path, buf] = (plugin.app.vault.adapter.writeBinary as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(path).toBe("Chats/thread-flush.chat");
			const json = gunzipSync(Buffer.from(buf)).toString("utf8");
			expect(json).toContain('"threadId":"Chats/thread-flush.chat"');
		});
	});

	/* --------------------------------------------------------------------------
	 * CheckpointSaver operations
	 * ------------------------------------------------------------------------*/

	describe("CheckpointSaver operations", () => {
		it("should store and retrieve a checkpoint via put/getTuple", async () => {
			const checkpoint = makeCheckpoint("cp-1", "2024-01-01T00:00:00Z");
			const metadata = makeMetadata(0);
			const config = {
				configurable: { thread_id: "Chats/thread-1.chat", checkpoint_id: "cp-1" },
			};

			const savedConfig = await manager.put(config, checkpoint, metadata, {});

			expect(savedConfig.configurable!.checkpoint_id).toBe("cp-1");

			const tuple = await manager.getTuple({
				configurable: { thread_id: "Chats/thread-1.chat", checkpoint_id: "cp-1" },
			});

			expect(tuple).toBeDefined();
			expect(tuple!.checkpoint.id).toBe("cp-1");
			expect(tuple!.metadata?.step).toBe(0);
		});

		it("should return the latest checkpoint when no checkpoint_id specified", async () => {
			const config = { configurable: { thread_id: "Chats/thread-2.chat" } };

			await manager.put(config, makeCheckpoint("cp-old", "2024-01-01T00:00:00Z"), makeMetadata(0), {});
			await manager.put(
				{ ...config, configurable: { ...config.configurable, checkpoint_id: "cp-old" } },
				makeCheckpoint("cp-new", "2024-01-01T00:01:00Z"),
				makeMetadata(1, "cp-old"),
				{},
			);

			const tuple = await manager.getTuple(config);
			expect(tuple).toBeDefined();
			expect(tuple!.checkpoint.id).toBe("cp-new");
		});

		it("should return undefined for non-existent thread", async () => {
			const tuple = await manager.getTuple({
				configurable: { thread_id: "Chats/nonexistent.chat" },
			});
			expect(tuple).toBeUndefined();
		});

		it("should return undefined when thread_id is missing", async () => {
			const tuple = await manager.getTuple({ configurable: {} });
			expect(tuple).toBeUndefined();
		});

		it("should store and retrieve writes via putWrites", async () => {
			const config = { configurable: { thread_id: "Chats/thread-3.chat", checkpoint_id: "cp-1" } };

			await manager.put(config, makeCheckpoint("cp-1", "2024-01-01T00:00:00Z"), makeMetadata(0), {});

			const writes: [string, unknown][] = [["channel-1", { value: "test-write" }]];
			await manager.putWrites(config, writes, "task-1");

			const tuple = await manager.getTuple(config);
			expect(tuple).toBeDefined();
			expect(tuple!.pendingWrites).toBeDefined();
			expect(tuple!.pendingWrites!.length).toBeGreaterThanOrEqual(1);
		});

		it("should flush pending checkpoint persistence to disk", async () => {
			await manager.put(
				{ configurable: { thread_id: "Chats/thread-persist.chat", checkpoint_id: "cp-1" } },
				makeCheckpoint("cp-1", "2024-01-01T00:00:00Z"),
				makeMetadata(0),
				{},
			);

			expect(plugin.app.vault.adapter.writeBinary).not.toHaveBeenCalled();

			await manager.flush("Chats/thread-persist.chat");

			expect(plugin.app.vault.adapter.writeBinary).toHaveBeenCalled();
			const [path, buf] = (plugin.app.vault.adapter.writeBinary as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(path).toBe("Chats/thread-persist.chat");
			const json = gunzipSync(Buffer.from(buf)).toString("utf8");
			expect(json).toContain('"cp-1"');
		});

		it("should list checkpoints in order", async () => {
			const config = { configurable: { thread_id: "Chats/thread-4.chat" } };

			await manager.put(config, makeCheckpoint("cp-1", "2024-01-01T00:00:00Z"), makeMetadata(0), {});
			await manager.put(
				{ ...config, configurable: { ...config.configurable, checkpoint_id: "cp-1" } },
				makeCheckpoint("cp-2", "2024-01-01T00:01:00Z"),
				makeMetadata(1, "cp-1"),
				{},
			);
			await manager.put(
				{ ...config, configurable: { ...config.configurable, checkpoint_id: "cp-2" } },
				makeCheckpoint("cp-3", "2024-01-01T00:02:00Z"),
				makeMetadata(2, "cp-2"),
				{},
			);

			const tuples = [];
			for await (const tuple of manager.list(config)) {
				tuples.push(tuple);
			}

			expect(tuples).toHaveLength(3);
			// Should be sorted by timestamp descending
			expect(tuples[0].checkpoint.id).toBe("cp-3");
			expect(tuples[1].checkpoint.id).toBe("cp-2");
			expect(tuples[2].checkpoint.id).toBe("cp-1");
		});

		it("should respect limit option in list", async () => {
			const config = { configurable: { thread_id: "Chats/thread-5.chat" } };

			await manager.put(config, makeCheckpoint("cp-a", "2024-01-01T00:00:00Z"), makeMetadata(0), {});
			await manager.put(
				{ configurable: { thread_id: "Chats/thread-5.chat", checkpoint_id: "cp-a" } },
				makeCheckpoint("cp-b", "2024-01-01T00:01:00Z"),
				makeMetadata(1, "cp-a"),
				{},
			);

			const tuples = [];
			for await (const tuple of manager.list(config, { limit: 1 })) {
				tuples.push(tuple);
			}

			expect(tuples).toHaveLength(1);
			expect(tuples[0].checkpoint.id).toBe("cp-b");
		});
	});

	/* --------------------------------------------------------------------------
	 * Deduplicated persistence (v2 format, issue #431)
	 * ------------------------------------------------------------------------*/

	describe("deduplicated persistence", () => {
		function makeMessage(role: "human" | "ai", content: string) {
			return {
				lc: 1,
				type: "constructor",
				id: ["langchain_core", "messages", role === "human" ? "HumanMessage" : "AIMessage"],
				kwargs: { content, additional_kwargs: {} },
			};
		}

		const longAnswer = "The answer, in detail: ".repeat(40);

		/** Simulate LangGraph's full-history-per-checkpoint puts for two turns. */
		async function putTwoTurns(threadId: string) {
			const history = [makeMessage("human", "First question?"), makeMessage("ai", longAnswer)];
			const cp1 = makeCheckpoint("cp-1", "2024-01-01T00:00:00Z");
			(cp1.channel_values as Record<string, unknown>).messages = JSON.parse(JSON.stringify(history));
			await manager.put({ configurable: { thread_id: threadId } }, cp1, makeMetadata(0), {});

			history.push(makeMessage("human", "Second question?"), makeMessage("ai", "Short answer."));
			const cp2 = makeCheckpoint("cp-2", "2024-01-01T00:01:00Z");
			(cp2.channel_values as Record<string, unknown>).messages = JSON.parse(JSON.stringify(history));
			await manager.put(
				{ configurable: { thread_id: threadId, checkpoint_id: "cp-1" } },
				cp2,
				makeMetadata(1, "cp-1"),
				{},
			);
		}

		it("writes each message once even when checkpoints repeat the history", async () => {
			await putTwoTurns("Chats/dedup.chat");
			await manager.flush("Chats/dedup.chat");

			const [, buf] = (plugin.app.vault.adapter.writeBinary as ReturnType<typeof vi.fn>).mock.calls[0];
			const json = gunzipSync(Buffer.from(buf)).toString("utf8");

			expect(json).toContain(`"version":${THREAD_DATA_VERSION}`);
			expect(json).toContain('"messageTable"');
			// The long first answer is part of both checkpoints' histories but
			// must be serialized exactly once.
			expect(json.split(longAnswer).length - 1).toBe(1);
		});

		it("restores full checkpoint messages after a save/reload cycle", async () => {
			await putTwoTurns("Chats/reload.chat");
			await manager.flush("Chats/reload.chat");
			const [, buf] = (plugin.app.vault.adapter.writeBinary as ReturnType<typeof vi.fn>).mock.calls[0];

			// Fresh manager backed by the file we just wrote.
			const plugin2 = createMockPlugin();
			(plugin2.app.vault.adapter.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
			(plugin2.app.vault.adapter.readBinary as ReturnType<typeof vi.fn>).mockResolvedValue(buf);
			const manager2 = new ObsidianChatManager(plugin2 as never);

			const tuple = await manager2.getTuple({
				configurable: { thread_id: "Chats/reload.chat", checkpoint_id: "cp-2" },
			});
			// getTuple hands LangGraph revived messages, as it would have stored them.
			const messages = (tuple!.checkpoint.channel_values as Record<string, BaseMessage[]>).messages;
			expect(messages).toHaveLength(4);
			expect(messages[1].content).toBe(longAnswer);
			expect(messages[3].content).toBe("Short answer.");

			// The older checkpoint kept its own (shorter) history.
			const tuple1 = await manager2.getTuple({
				configurable: { thread_id: "Chats/reload.chat", checkpoint_id: "cp-1" },
			});
			expect((tuple1!.checkpoint.channel_values as Record<string, unknown[]>).messages).toHaveLength(2);
		});

		it("shares unchanged history messages with the parent checkpoint in memory", async () => {
			await putTwoTurns("Chats/shared.chat");

			const storage = (
				manager as unknown as {
					storage: Map<
						string,
						{ checkpoints: Record<string, { checkpoint: { channel_values: { messages: unknown[] } } }> }
					>;
				}
			).storage;
			const checkpoints = storage.get("Chats/shared.chat")!.checkpoints;
			const messages1 = checkpoints["cp-1"].checkpoint.channel_values.messages;
			const messages2 = checkpoints["cp-2"].checkpoint.channel_values.messages;
			expect(messages2[0]).toBe(messages1[0]);
			expect(messages2[1]).toBe(messages1[1]);
		});

		it("migrates a legacy v1 file to the deduplicated format on load", async () => {
			const message = makeMessage("ai", longAnswer);
			const legacy = {
				version: 1,
				threadId: "Chats/legacy.chat",
				createdAt: 1,
				updatedAt: 2,
				checkpoints: {
					"cp-1": {
						checkpoint: {
							v: 1,
							id: "cp-1",
							ts: "2024-01-01T00:00:00Z",
							channel_values: { messages: [message] },
							channel_versions: {},
							versions_seen: {},
							pending_sends: [],
						},
						metadata: { source: "loop", step: 0, writes: {}, parents: {} },
					},
					"cp-2": {
						checkpoint: {
							v: 1,
							id: "cp-2",
							ts: "2024-01-01T00:01:00Z",
							channel_values: { messages: [message, makeMessage("human", "next")] },
							channel_versions: {},
							versions_seen: {},
							pending_sends: [],
						},
						metadata: { source: "loop", step: 1, writes: {}, parents: {} },
					},
				},
				writes: {},
			};
			const legacyBuf = gzipSync(Buffer.from(JSON.stringify(legacy)));
			(plugin.app.vault.adapter.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
			(plugin.app.vault.adapter.readBinary as ReturnType<typeof vi.fn>).mockResolvedValue(
				legacyBuf.buffer.slice(legacyBuf.byteOffset, legacyBuf.byteOffset + legacyBuf.byteLength),
			);

			const tuple = await manager.getTuple({
				configurable: { thread_id: "Chats/legacy.chat", checkpoint_id: "cp-2" },
			});
			expect((tuple!.checkpoint.channel_values as Record<string, unknown[]>).messages).toHaveLength(2);

			// Loading a pre-dedup file marks the thread dirty so the debounced
			// save rewrites it in the new format.
			const dirtyVersions = (manager as unknown as { dirtyThreadVersions: Map<string, number> })
				.dirtyThreadVersions;
			expect(dirtyVersions.get("Chats/legacy.chat")).toBeGreaterThanOrEqual(1);

			await manager.flush("Chats/legacy.chat");
			expect(plugin.app.vault.adapter.writeBinary).toHaveBeenCalled();
			const [, buf] = (plugin.app.vault.adapter.writeBinary as ReturnType<typeof vi.fn>).mock.calls[0];
			const json = gunzipSync(Buffer.from(buf)).toString("utf8");
			expect(json).toContain(`"version":${THREAD_DATA_VERSION}`);
			expect(json.split(longAnswer).length - 1).toBe(1);
		});
	});

	/* --------------------------------------------------------------------------
	 * Index rebuild from .chat files
	 * ------------------------------------------------------------------------*/

	describe("index rebuild", () => {
		it("should rebuild index from .chat files on disk", async () => {
			(plugin.app.vault.adapter.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
			(plugin.app.vault.adapter.list as ReturnType<typeof vi.fn>).mockResolvedValue({
				files: ["Chats/rebuilt-thread.chat"],
				folders: [],
			});
			(plugin.app.vault.adapter.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
				ctime: 1000,
				mtime: 2000,
				size: 100,
			});

			await manager.rebuildIndex();

			const threads = await manager.asThreadStore().list();
			expect(threads).toHaveLength(1);
			expect(threads[0].threadId).toBe("Chats/rebuilt-thread.chat");
			expect(threads[0].title).toBe("rebuilt-thread");
			expect(threads[0].createdAt).toBe(1000);
			expect(threads[0].updatedAt).toBe(2000);
		});
	});

	describe("thinking duration annotation", () => {
		async function annotateAndRead(cpId: string, messages: unknown[]) {
			const threadId = `Chats/thread-${cpId}.chat`;
			const checkpoint = makeCheckpoint(cpId, "2024-01-01T00:00:00Z");
			(checkpoint.channel_values as Record<string, unknown>).messages = messages;
			await manager.put({ configurable: { thread_id: threadId } }, checkpoint, makeMetadata(0), {});
			await manager.annotateThinkingDuration(threadId, cpId, 42_000);

			const tuple = await manager.getTuple({ configurable: { thread_id: threadId, checkpoint_id: cpId } });
			const stored = (tuple!.checkpoint.channel_values as Record<string, BaseMessage[]>).messages;
			return stored.map(
				(m) =>
					(m.response_metadata as Record<string, unknown> | undefined)?.thinking_duration_ms as
						| number
						| undefined,
			);
		}

		const human = { type: "human", kwargs: { content: "Hello" } };

		it("stamps the final answer when it is the last AI message", async () => {
			const durations = await annotateAndRead("cp-dur-plain", [
				human,
				{ type: "ai", kwargs: { content: "The answer" } },
			]);
			expect(durations[1]).toBe(42_000);
		});

		it("skips a trailing tool-calling turn with no prose, stamping the answer instead", async () => {
			// The reader ignores empty-content AI messages, so stamping the trailing
			// one lost the duration on reload ("Thought for 1s").
			const durations = await annotateAndRead("cp-dur-empty", [
				human,
				{ type: "ai", kwargs: { content: "The answer" } },
				{ type: "ai", kwargs: { content: "", tool_calls: [{ id: "c-1", name: "manage_notes", args: {} }] } },
			]);
			expect(durations[1]).toBe(42_000);
			expect(durations[2]).toBeUndefined();
		});

		it("skips a trailing subagent turn, stamping the parent answer instead", async () => {
			const durations = await annotateAndRead("cp-dur-sub", [
				human,
				{ type: "ai", kwargs: { content: "The answer" } },
				{
					type: "ai",
					kwargs: {
						content: "subagent reasoning",
						tool_calls: [{ id: "c-9", name: "search_notes", args: {} }],
					},
				},
			]);
			expect(durations[1]).toBe(42_000);
			expect(durations[2]).toBeUndefined();
		});

		it("skips a trailing tool_use block turn (Anthropic block content)", async () => {
			const durations = await annotateAndRead("cp-dur-blocks", [
				human,
				{ type: "ai", kwargs: { content: "The answer" } },
				{
					type: "ai",
					kwargs: {
						content: [
							{ type: "text", text: "Let me check" },
							{ type: "tool_use", id: "c-2" },
						],
					},
				},
			]);
			expect(durations[1]).toBe(42_000);
			expect(durations[2]).toBeUndefined();
		});

		it("stamps nothing when no AI message qualifies as the answer", async () => {
			const durations = await annotateAndRead("cp-dur-none", [
				human,
				{ type: "ai", kwargs: { content: "", tool_calls: [{ id: "c-1", name: "manage_notes", args: {} }] } },
			]);
			expect(durations.every((d) => d === undefined)).toBe(true);
		});
	});
});
