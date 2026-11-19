import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage, RemoveMessage } from "@langchain/core/messages";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import type { ThreadData } from "../../src/agent/threadDataCodec";
import {
	createMessageReviver,
	messageListOf,
	orderedStoredWrites,
	replayPathMessages,
	replayThreadMessages,
} from "../../src/agent/threadReplay";

const human = (id: string) => new HumanMessage({ id, content: id }).toJSON();
const ai = (id: string) => new AIMessage({ id, content: id }).toJSON();

/** A checkpoint entry; `messages` omitted means a delta step that stores none. */
function checkpoint(id: string, parent?: string, messages?: unknown) {
	return {
		checkpoint: {
			v: 4,
			id,
			ts: "2026-01-01T00:00:00.000Z",
			channel_values: messages === undefined ? {} : { messages },
			channel_versions: {},
			versions_seen: {},
		},
		metadata: { step: 0 },
		...(parent ? { parentConfig: { configurable: { checkpoint_id: parent } } } : {}),
	};
}

function thread(
	checkpoints: ReturnType<typeof checkpoint>[],
	writes: Record<string, [string, string, unknown, string, number][]>,
): ThreadData {
	return {
		version: 3,
		checkpoints: Object.fromEntries(checkpoints.map((c) => [c.checkpoint.id, c])),
		writes,
	} as unknown as ThreadData;
}

const ids = (messages: { id?: string }[] | undefined) => messages?.map((m) => m.id);

describe("thread replay", () => {
	it("rebuilds each branch of a forked tree from its own seed and the writes on its path", () => {
		// root [h1] → a (+a1) → b (+h2) → c ;  root → edit [h1, h2e] → d (+a2e) → e
		const data = thread(
			[
				checkpoint("root", undefined, [human("h1")]),
				checkpoint("a", "root"),
				checkpoint("b", "a"),
				checkpoint("c", "b"),
				checkpoint("edit", "root", [human("h1"), human("h2e")]),
				checkpoint("d", "edit"),
				checkpoint("e", "d"),
			],
			{
				root: [["t1", "messages", [ai("a1")], "", 0]],
				a: [["t2", "messages", [human("h2")], "", 0]],
				edit: [["t3", "messages", [ai("a2e")], "", 0]],
			},
		);
		const all = replayThreadMessages(data);
		expect(ids(all.get("root"))).toEqual(["h1"]);
		expect(ids(all.get("b"))).toEqual(["h1", "a1", "h2"]);
		expect(ids(all.get("c"))).toEqual(["h1", "a1", "h2"]);
		expect(ids(all.get("e"))).toEqual(["h1", "h2e", "a2e"]);
		for (const id of ["root", "a", "b", "c", "edit", "d", "e"]) {
			expect(ids(replayPathMessages(data, id))).toEqual(ids(all.get(id)));
		}
	});

	it("shares one revived message object across checkpoints and reuses arrays for empty steps", () => {
		const data = thread(
			[checkpoint("root", undefined, [human("h1")]), checkpoint("a", "root"), checkpoint("b", "a")],
			{
				root: [["t1", "messages", [ai("a1")], "", 0]],
			},
		);
		const all = replayThreadMessages(data);
		expect(all.get("a")?.[0]).toBe(all.get("root")?.[0]);
		expect(all.get("b")).toBe(all.get("a"));
	});

	it("applies RemoveMessage, including remove-all, through the channel's reducer", () => {
		const data = thread(
			[checkpoint("root", undefined, [human("h1"), ai("a1")]), checkpoint("a", "root"), checkpoint("b", "a")],
			{
				root: [["t1", "messages", [new RemoveMessage({ id: "a1" }).toJSON()], "", 0]],
				a: [
					[
						"t2",
						"messages",
						[new RemoveMessage({ id: REMOVE_ALL_MESSAGES }).toJSON(), human("summary")],
						"",
						0,
					],
				],
			},
		);
		const all = replayThreadMessages(data);
		expect(ids(all.get("a"))).toEqual(["h1"]);
		expect(ids(all.get("b"))).toEqual(["summary"]);
	});

	it("applies remove-all stored under a minified class name", () => {
		// The production bundle minifies RemoveMessage's class name, and that name is
		// what its serialized id records.
		const removeAll = new RemoveMessage({ id: REMOVE_ALL_MESSAGES }).toJSON() as { id: string[] };
		const minified = { ...removeAll, id: [...removeAll.id.slice(0, -1), "Mh"] };
		const data = thread([checkpoint("root", undefined, [human("h1"), ai("a1")]), checkpoint("a", "root")], {
			root: [["t1", "messages", [minified, human("summary"), ai("a2")], "", 0]],
		});
		expect(ids(replayThreadMessages(data).get("a"))).toEqual(["summary", "a2"]);
	});

	it("replaces the list on an Overwrite write", () => {
		const data = thread([checkpoint("root", undefined, [human("h1")]), checkpoint("a", "root")], {
			root: [["t1", "messages", { __overwrite__: [human("only")] }, "", 0]],
		});
		expect(ids(replayThreadMessages(data).get("a"))).toEqual(["only"]);
	});

	it("starts again from a DeltaSnapshot or a legacy full list below delta steps", () => {
		const data = thread(
			[
				checkpoint("root", undefined, [human("h1")]),
				checkpoint("a", "root"),
				checkpoint("snap", "a", { lg_name: "DeltaSnapshot", value: [human("s1"), ai("s2")] }),
				checkpoint("after", "snap"),
			],
			{
				root: [["t1", "messages", [ai("a1")], "", 0]],
				snap: [["t2", "messages", [human("s3")], "", 0]],
			},
		);
		const all = replayThreadMessages(data);
		expect(ids(all.get("snap"))).toEqual(["s1", "s2"]);
		expect(ids(all.get("after"))).toEqual(["s1", "s2", "s3"]);
		expect(ids(replayPathMessages(data, "after"))).toEqual(["s1", "s2", "s3"]);
	});

	it("orders a checkpoint's writes the way LangGraph applied them, not the way they were stored", () => {
		const data = thread([checkpoint("root", undefined, [])], {
			root: [
				["task-b", "messages", [ai("second")], "~__pregel_pull, tools", 0],
				["task-a", "messages", [ai("first")], "~__pregel_pull, agent", 0],
			],
		});
		expect(orderedStoredWrites(data, "root").map((write) => write[0])).toEqual(["task-a", "task-b"]);
	});

	it("reads message lists through every stored wrapper", () => {
		const list = [human("h1")];
		expect(messageListOf(list)).toBe(list);
		expect(messageListOf({ lg_name: "DeltaSnapshot", value: list })).toBe(list);
		expect(messageListOf({ __overwrite__: list })).toBe(list);
		expect(messageListOf({ type: "__overwrite__", value: list })).toBe(list);
		expect(messageListOf(list[0])).toEqual(list);
		expect(messageListOf("text")).toBeUndefined();
	});

	it("revives each stored object once", () => {
		const revive = createMessageReviver();
		const raw = human("h1");
		expect(revive(raw)).toBe(revive(raw));
		expect(revive(null)).toBeUndefined();
	});
});
