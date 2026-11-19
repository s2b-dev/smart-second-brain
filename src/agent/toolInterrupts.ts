/**
 * The plugin's side of LangChain's human-in-the-loop middleware, in `per_call` mode:
 * a gated tool call pauses the run before it executes, the pause is stored in the
 * thread's checkpoint, and the run continues once the user's decision is sent back with
 * `Command({ resume })`. Nothing about a paused call lives in memory, so it survives a
 * reload, a restart and a branch switch.
 *
 * Pure and store-free: `Agent`, the checkpoint saver and the chat timeline all read
 * interrupts through here.
 */

/** Tool `metadata` key marking a tool whose calls wait for the user instead of running. */
export const PAUSES_FOR_USER = "s2bPausesForUser";

/** The checkpoint write channel LangGraph records a task's interrupts on. */
export const INTERRUPT_CHANNEL = "__interrupt__";

/** One paused tool call, as the middleware raised it. */
export interface ToolInterrupt {
	/** LangGraph's interrupt id: the key the decision is resumed under. */
	id: string;
	/** The model's tool-call id, which ties the pause to its card in the chat. */
	toolCallId: string;
	/** The tool's name as the model called it (tool names are user-configurable). */
	toolName: string;
	args: Record<string, unknown>;
}

/** The user's answer to one paused call. The message becomes the tool result. */
export interface InterruptResponse {
	interrupt: ToolInterrupt;
	message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a raw `__interrupt__` value (a stream chunk's, or a checkpoint write's) into
 * paused tool calls. Anything that is not a per-call tool interrupt is skipped: nothing
 * else in the graph raises interrupts today, and an unknown one has no UI to answer it.
 */
export function parseToolInterrupts(raw: unknown): ToolInterrupt[] {
	const interrupts: ToolInterrupt[] = [];
	for (const item of Array.isArray(raw) ? raw : []) {
		if (!isRecord(item) || typeof item.id !== "string" || !isRecord(item.value)) continue;
		const value = item.value;
		if (value.type !== "tool_approval") continue;
		if (typeof value.tool_call_id !== "string" || typeof value.name !== "string") continue;
		interrupts.push({
			id: item.id,
			toolCallId: value.tool_call_id,
			toolName: value.name,
			args: isRecord(value.args) ? value.args : {},
		});
	}
	return interrupts;
}

/** The names of the tools in `tools` that pause for the user. */
export function toolsPausingForUser(tools: readonly unknown[]): string[] {
	const names: string[] = [];
	for (const candidate of tools) {
		if (!isRecord(candidate) || typeof candidate.name !== "string") continue;
		if (isRecord(candidate.metadata) && candidate.metadata[PAUSES_FOR_USER] === true) names.push(candidate.name);
	}
	return names;
}

/** The `Command({ resume })` payload answering every given interrupt, keyed by interrupt id. */
export function buildResumeValue(responses: readonly InterruptResponse[]): Record<string, unknown> {
	const resume: Record<string, unknown> = {};
	for (const { interrupt, message } of responses) {
		resume[interrupt.id] = { type: "respond", message };
	}
	return resume;
}
