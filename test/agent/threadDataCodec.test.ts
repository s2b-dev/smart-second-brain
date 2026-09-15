import { describe, expect, it } from "vitest";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import {
	THREAD_DATA_VERSION,
	type ThreadData,
	adoptEqualMessages,
	deflateThreadData,
	inflateThreadData,
	sniffThreadDataVersion,
} from "../../src/agent/threadDataCodec";

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------*/

function makeMessage(role: "human" | "ai", content: string): Record<string, unknown> {
	return {
		lc: 1,
		type: "constructor",
		id: ["langchain_core", "messages", role === "human" ? "HumanMessage" : "AIMessage"],
		kwargs: { content, additional_kwargs: {} },
	};
}

function makeCheckpoint(id: string, ts: string, messages: unknown[]): Checkpoint {
	return {
		v: 1,
		id,
		ts,
		channel_values: { messages },
		channel_versions: {},
		versions_seen: {},
		pending_sends: [],
	} as unknown as Checkpoint;
}

/**
 * A thread shaped the way LangGraph produces it: each checkpoint repeats the
 * full message history (deep copies), and metadata.writes repeats the step's
 * new messages once more.
 */
function makeQuadraticThread(): ThreadData {
	const q1 = makeMessage("human", "What is the capital of France? ".repeat(50));
	const a1 = makeMessage("ai", "Paris. ".repeat(100));
	const q2 = makeMessage("human", "And of Germany?");
	const a2 = makeMessage("ai", "Berlin.");

	const copy = (msg: unknown) => JSON.parse(JSON.stringify(msg));

	return {
		threadId: "Chats/t.chat",
		title: "Capitals",
		createdAt: 1,
		updatedAt: 2,
		checkpoints: {
			"cp-1": {
				checkpoint: makeCheckpoint("cp-1", "2024-01-01T00:00:00Z", [copy(q1), copy(a1)]),
				metadata: {
					source: "loop",
					step: 0,
					writes: { agent: { messages: [copy(a1)] } },
					parents: {},
				} as CheckpointMetadata,
			},
			"cp-2": {
				checkpoint: makeCheckpoint("cp-2", "2024-01-01T00:01:00Z", [copy(q1), copy(a1), copy(q2), copy(a2)]),
				metadata: {
					source: "loop",
					step: 1,
					writes: { agent: { messages: [copy(a2)] } },
					parents: {},
				} as CheckpointMetadata,
				parentConfig: { configurable: { thread_id: "Chats/t.chat", checkpoint_id: "cp-1" } },
			},
		},
		writes: {
			"cp-1": [["messages", [copy(a1)]] as never],
		},
	};
}

/* --------------------------------------------------------------------------
 * deflate / inflate round-trip
 * ------------------------------------------------------------------------*/

describe("threadDataCodec", () => {
	it("round-trips a thread through deflate → JSON → inflate unchanged", () => {
		const original = makeQuadraticThread();
		const pristine = JSON.parse(JSON.stringify(original));

		const deflated = deflateThreadData(original);
		const inflated = inflateThreadData(JSON.parse(JSON.stringify(deflated)) as ThreadData);

		expect(JSON.parse(JSON.stringify(inflated))).toEqual({ ...pristine, version: THREAD_DATA_VERSION });
		// Deflating must not mutate the in-memory thread.
		expect(JSON.parse(JSON.stringify(original))).toEqual(pristine);
	});

	it("stores each duplicated message only once in the serialized output", () => {
		const data = makeQuadraticThread();
		const deflated = deflateThreadData(data);
		const json = JSON.stringify(deflated);

		// q1/a1 appear in both checkpoints, in metadata.writes and in pending
		// writes of the raw thread — the deflated file must carry each once.
		expect(countOccurrences(json, "What is the capital of France? ".repeat(50))).toBe(1);
		expect(countOccurrences(json, "Paris. ".repeat(100))).toBe(1);
		expect(countOccurrences(json, "Berlin.")).toBe(1);

		const rawSize = JSON.stringify(data).length;
		expect(json.length).toBeLessThan(rawSize / 2);
	});

	it("shares one object per unique message after inflation", () => {
		const deflated = deflateThreadData(makeQuadraticThread());
		const inflated = inflateThreadData(JSON.parse(JSON.stringify(deflated)) as ThreadData);

		const msgs1 = getMessages(inflated, "cp-1");
		const msgs2 = getMessages(inflated, "cp-2");
		expect(msgs2[0]).toBe(msgs1[0]);
		expect(msgs2[1]).toBe(msgs1[1]);

		// metadata.writes and pending writes share the same objects too.
		// `writes` is present at runtime but absent from CheckpointMetadata, so this goes
		// through unknown — the codec reads it structurally (isRecord), not by type.
		const metadataWrites = (
			inflated.checkpoints["cp-1"].metadata as unknown as { writes: { agent: { messages: unknown[] } } }
		).writes;
		expect(metadataWrites.agent.messages[0]).toBe(msgs1[1]);
		const pendingWrite = inflated.writes["cp-1"][0] as unknown as [string, unknown[]];
		expect(pendingWrite[1][0]).toBe(msgs1[1]);
	});

	it("strips the message table from the inflated in-memory thread", () => {
		const deflated = deflateThreadData(makeQuadraticThread());
		const inflated = inflateThreadData(JSON.parse(JSON.stringify(deflated)) as ThreadData);
		expect(inflated.messageTable).toBeUndefined();
	});

	it("keeps divergent copies of a message separate", () => {
		const data = makeQuadraticThread();
		// Simulate a post-hoc annotation on cp-2's copy of the first answer.
		const annotated = getMessages(data, "cp-2")[1] as { kwargs: Record<string, unknown> };
		annotated.kwargs.response_metadata = { thinking_duration_ms: 1234 };

		const deflated = deflateThreadData(data);
		const inflated = inflateThreadData(JSON.parse(JSON.stringify(deflated)) as ThreadData);

		const plain = getMessages(inflated, "cp-1")[1] as { kwargs: Record<string, unknown> };
		const kept = getMessages(inflated, "cp-2")[1] as { kwargs: Record<string, unknown> };
		expect(kept).not.toBe(plain);
		expect(kept.kwargs.response_metadata).toEqual({ thinking_duration_ms: 1234 });
		expect(plain.kwargs.response_metadata).toBeUndefined();
	});

	it("round-trips a genuine object shaped like a ref marker", () => {
		const data = makeQuadraticThread();
		const marker = { $msg: 0 };
		getMessages(data, "cp-1").push(marker);
		const pristine = JSON.parse(JSON.stringify(data));

		const deflated = deflateThreadData(data);
		const inflated = inflateThreadData(JSON.parse(JSON.stringify(deflated)) as ThreadData);

		expect(JSON.parse(JSON.stringify(inflated))).toEqual({ ...pristine, version: THREAD_DATA_VERSION });
	});

	it("passes pre-v2 data through inflation unchanged", () => {
		const legacy = makeQuadraticThread();
		legacy.version = 1;
		const pristine = JSON.parse(JSON.stringify(legacy));

		const inflated = inflateThreadData(legacy);
		expect(inflated).toBe(legacy);
		expect(JSON.parse(JSON.stringify(inflated))).toEqual(pristine);
	});

	it("writes the schema version as the first key so it can be sniffed from a prefix", () => {
		const json = JSON.stringify(deflateThreadData(makeQuadraticThread()));
		expect(json.startsWith(`{"version":${THREAD_DATA_VERSION},`)).toBe(true);
		expect(sniffThreadDataVersion(json.slice(0, 64))).toBe(THREAD_DATA_VERSION);
	});

	it("sniffs legacy and non-thread prefixes as version 0", () => {
		expect(sniffThreadDataVersion(JSON.stringify(makeQuadraticThread()).slice(0, 64))).toBe(0);
		expect(sniffThreadDataVersion('{"threadId":"Chats/t.chat"')).toBe(0);
		expect(sniffThreadDataVersion("not json")).toBe(0);
		expect(sniffThreadDataVersion("")).toBe(0);
	});

	it("persists only `configurable` from each checkpoint's parentConfig", () => {
		const data = makeQuadraticThread();
		const runtimeConfig = {
			configurable: { thread_id: "Chats/t.chat", checkpoint_id: "cp-1" },
			callbacks: [{ name: "StreamMessagesHandler", seen: { "msg-1": { content: "…" } } }],
			tags: ["graph:step:1"],
			metadata: { agent_id: "default-agent" },
			recursionLimit: 25,
			signal: {},
		};
		data.checkpoints["cp-2"].parentConfig = runtimeConfig as unknown as RunnableConfig;

		const deflated = deflateThreadData(data);
		const entry = (deflated.checkpoints as Record<string, { parentConfig?: Record<string, unknown> }>)["cp-2"];
		expect(entry.parentConfig).toEqual({ configurable: runtimeConfig.configurable });
		expect(JSON.stringify(deflated)).not.toContain("StreamMessagesHandler");

		// Stripping happens on the serialized copy, never on the in-memory thread.
		expect(data.checkpoints["cp-2"].parentConfig).toBe(runtimeConfig);
	});

	it("passes an already configurable-only parentConfig through unchanged", () => {
		const data = makeQuadraticThread();
		const before = data.checkpoints["cp-2"].parentConfig;
		const restored = inflateThreadData(JSON.parse(JSON.stringify(deflateThreadData(data))) as ThreadData);
		expect(restored.checkpoints["cp-2"].parentConfig).toEqual(before);
		expect(restored.checkpoints["cp-1"].parentConfig).toBeUndefined();
	});

	it("leaves an unresolvable ref in place instead of throwing", () => {
		const deflated = deflateThreadData(makeQuadraticThread()) as { messageTable: unknown[] };
		deflated.messageTable = deflated.messageTable.slice(0, 1); // corrupt: drop table entries
		const inflated = inflateThreadData(JSON.parse(JSON.stringify(deflated)) as ThreadData);
		const msgs = getMessages(inflated, "cp-2");
		expect(msgs.some((m) => typeof (m as { $msg?: unknown }).$msg === "number")).toBe(true);
	});
});

/* --------------------------------------------------------------------------
 * adoptEqualMessages
 * ------------------------------------------------------------------------*/

describe("adoptEqualMessages", () => {
	it("replaces JSON-equal history messages with the parent's objects", () => {
		const q = makeMessage("human", "hi");
		const a = makeMessage("ai", "hello");
		const parent = makeCheckpoint("cp-1", "2024-01-01T00:00:00Z", [q, a]);
		const child = makeCheckpoint("cp-2", "2024-01-01T00:01:00Z", [
			JSON.parse(JSON.stringify(q)),
			JSON.parse(JSON.stringify(a)),
			makeMessage("human", "more"),
		]);

		adoptEqualMessages(child, parent);

		const childMessages = (child.channel_values as { messages: unknown[] }).messages;
		expect(childMessages[0]).toBe(q);
		expect(childMessages[1]).toBe(a);
		expect(childMessages[2]).not.toBe(q);
	});

	it("keeps diverged messages as separate objects", () => {
		const a = makeMessage("ai", "hello");
		const annotated = JSON.parse(JSON.stringify(a));
		annotated.kwargs.response_metadata = { agent_id: "x" };
		const parent = makeCheckpoint("cp-1", "2024-01-01T00:00:00Z", [annotated]);
		const child = makeCheckpoint("cp-2", "2024-01-01T00:01:00Z", [JSON.parse(JSON.stringify(a))]);

		adoptEqualMessages(child, parent);

		const childMessages = (child.channel_values as { messages: unknown[] }).messages;
		expect(childMessages[0]).not.toBe(annotated);
	});

	it("is a no-op without a parent checkpoint", () => {
		const child = makeCheckpoint("cp-2", "2024-01-01T00:01:00Z", [makeMessage("human", "hi")]);
		expect(() => adoptEqualMessages(child, undefined)).not.toThrow();
	});
});

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------*/

function getMessages(data: ThreadData, checkpointId: string): unknown[] {
	const checkpoint = data.checkpoints[checkpointId].checkpoint as unknown as {
		channel_values: { messages: unknown[] };
	};
	return checkpoint.channel_values.messages;
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}
