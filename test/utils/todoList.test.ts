import { describe, expect, it } from "vitest";
import type { MessagePair, ToolCallState } from "../../src/stores/chatTimeline";
import { latestTodos, parseTodos, shouldShowTodos } from "../../src/utils/todoList";

function pair(toolCalls: ToolCallState[]): MessagePair {
	return {
		id: crypto.randomUUID(),
		userMessage: { content: "" },
		assistantMessage: { state: 0, content: "", toolCalls },
	} as unknown as MessagePair;
}

function todoCall(todos: unknown, extra: Partial<ToolCallState> = {}): ToolCallState {
	return { id: crypto.randomUUID(), name: "write_todos", input: { todos }, status: "completed", ...extra };
}

describe("parseTodos", () => {
	it("keeps well-formed items and drops malformed ones", () => {
		expect(
			parseTodos({
				todos: [
					{ content: " Read notes ", status: "completed" },
					{ content: "", status: "pending" },
					{ status: "pending" },
					"junk",
					{ content: "Merge duplicates", status: "weird" },
				],
			}),
		).toEqual([
			{ content: "Read notes", status: "completed" },
			{ content: "Merge duplicates", status: "pending" },
		]);
	});

	it("reads an empty array as a cleared list", () => {
		expect(parseTodos({ todos: [] })).toEqual([]);
	});

	it("returns undefined when there is no todos array", () => {
		expect(parseTodos(undefined)).toBeUndefined();
		expect(parseTodos({ todos: "nope" })).toBeUndefined();
	});
});

describe("latestTodos", () => {
	it("picks the last top-level call across turns", () => {
		const pairs = [
			pair([todoCall([{ content: "old", status: "pending" }])]),
			pair([
				todoCall([{ content: "a", status: "in_progress" }]),
				todoCall([{ content: "a", status: "completed" }]),
			]),
			pair([]),
		];
		expect(latestTodos(pairs)).toEqual({
			todos: [{ content: "a", status: "completed" }],
			pairIndex: 1,
			streaming: false,
		});
	});

	it("ignores failed calls, subagent calls and other tools", () => {
		const pairs = [
			pair([todoCall([{ content: "kept", status: "pending" }])]),
			pair([
				todoCall([{ content: "failed", status: "pending" }], { status: "failed" }),
				todoCall([{ content: "nested", status: "pending" }], { parentToolCallId: "t1" }),
				{
					id: "x",
					name: "search_notes",
					input: { todos: [{ content: "no", status: "pending" }] },
					status: "completed",
				},
			]),
		];
		expect(latestTodos(pairs)?.todos).toEqual([{ content: "kept", status: "pending" }]);
	});

	it("stops at a cleared list instead of restoring an older one", () => {
		const pairs = [pair([todoCall([{ content: "open", status: "pending" }])]), pair([todoCall([])])];
		const snapshot = latestTodos(pairs);
		expect(snapshot?.todos).toEqual([]);
		expect(shouldShowTodos(snapshot, pairs.length)).toBe(false);
	});

	it("flags a call that is still running", () => {
		const snapshot = latestTodos([pair([todoCall([{ content: "a", status: "pending" }], { status: "running" })])]);
		expect(snapshot?.streaming).toBe(true);
	});
});

describe("shouldShowTodos", () => {
	const open = { todos: [{ content: "a", status: "pending" as const }], pairIndex: 0, streaming: false };
	const done = { todos: [{ content: "a", status: "completed" as const }], pairIndex: 0, streaming: false };

	it("keeps an unfinished list up across later turns", () => {
		expect(shouldShowTodos(open, 3)).toBe(true);
	});

	it("shows a finished list only in the turn that finished it", () => {
		expect(shouldShowTodos(done, 1)).toBe(true);
		expect(shouldShowTodos(done, 2)).toBe(false);
	});

	it("hides when there is no list", () => {
		expect(shouldShowTodos(undefined, 1)).toBe(false);
	});
});
