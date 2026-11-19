import type { MessagePair, ToolCallState } from "../stores/chatTimeline";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
	content: string;
	status: TodoStatus;
}

/** The task list a turn left behind, with the turn it came from. */
export interface TodoListSnapshot {
	todos: TodoItem[];
	/** Index into the message pairs of the turn whose `write_todos` call wrote this list. */
	pairIndex: number;
	/** Whether that call is still running, i.e. the list is being written right now. */
	streaming: boolean;
}

const TODO_TOOL_NAME = "write_todos";

/**
 * Reads a `write_todos` call's input into a list, dropping malformed items rather than
 * failing: the input comes from the model, and a partly-streamed call can be missing
 * fields. Returns `undefined` when there is nothing usable.
 */
export function parseTodos(input: Record<string, unknown> | null | undefined): TodoItem[] | undefined {
	const raw = input?.todos;
	if (!Array.isArray(raw)) return undefined;
	const todos: TodoItem[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const { content, status } = item as Record<string, unknown>;
		if (typeof content !== "string" || !content.trim()) continue;
		const known = (TODO_STATUSES as readonly unknown[]).includes(status);
		todos.push({ content: content.trim(), status: known ? (status as TodoStatus) : "pending" });
	}
	return todos.length > 0 ? todos : undefined;
}

function isTodoCall(call: ToolCallState): boolean {
	// Top-level calls only: a subagent never gets the tool, but a renamed MCP tool could
	// share the name inside one, and its list is not the conversation's.
	return call.name === TODO_TOOL_NAME && !call.parentToolCallId && call.status !== "failed";
}

/**
 * The latest task list on the active branch: the last successful top-level `write_todos`
 * call across the visible turns. Derived from the transcript rather than stored, so it
 * follows edits, regenerations and branch switches for free.
 */
export function latestTodos(pairs: readonly MessagePair[]): TodoListSnapshot | undefined {
	for (let i = pairs.length - 1; i >= 0; i--) {
		const calls = pairs[i].assistantMessage.toolCalls ?? [];
		for (let j = calls.length - 1; j >= 0; j--) {
			const call = calls[j];
			if (!isTodoCall(call)) continue;
			const todos = parseTodos(call.input);
			if (!todos) continue;
			return { todos, pairIndex: i, streaming: call.status === "running" || call.status === "pending" };
		}
	}
	return undefined;
}

/**
 * Whether the bar should show this list. An unfinished list stays up across later turns
 * (the user may say "continue" without the model re-sending it); a finished one only
 * stays for the turn that finished it, so a done plan doesn't linger over the next topic.
 */
export function shouldShowTodos(snapshot: TodoListSnapshot | undefined, pairCount: number): boolean {
	if (!snapshot) return false;
	const unfinished = snapshot.todos.some((t) => t.status !== "completed");
	return unfinished || snapshot.pairIndex === pairCount - 1;
}
