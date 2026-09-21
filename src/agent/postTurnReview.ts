/**
 * The post-turn review: a short side run, after a busy turn has been answered, that asks a
 * model whether the conversation taught anything worth keeping and routes it — a durable
 * fact about the user into memory, a lesson about how a kind of task is done into the skill
 * that was used. This is the learning step the guidance asks the agent to do at the end of a
 * task; the review runs it on the agent's behalf when a turn was busy enough that the agent
 * likely skipped it. Modelled on Hermes Agent's background review fork.
 *
 * Nothing here schedules anything. The review is a tail on a finished turn, while Obsidian is
 * open and the chat is on screen: if the app closes first, the review simply does not run and
 * the same conversation trips the counter again next time. The pure pieces live here — the
 * trigger, the transcript rendering, the prompt, the summary of what the reviewer did — and
 * `AgentManager.runPostTurnReview` does the model call.
 */

import { AIMessage, type BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { ChatModel } from "../stores/chatTimeline";

/** Per-agent settings (see `AgentConfig.postTurnReview`). */
export interface PostTurnReviewConfig {
	/** Off by default: the review spends tokens on a cadence the user has to opt into. */
	enabled: boolean;
	/** Model for the review; null means the agent's chat model. A cheaper one is the point. */
	model: ChatModel | null;
	/** Tool calls accumulated across turns before a review fires. */
	toolCallThreshold: number;
}

export const DEFAULT_POST_TURN_REVIEW: PostTurnReviewConfig = {
	enabled: false,
	model: null,
	toolCallThreshold: 10,
};

/** What one finished turn contributes to the trigger. */
export interface TurnActivity {
	/** Tool calls the turn made (any tool, subagents included). */
	toolCalls: number;
	/** Whether the turn itself revised or created a skill: the agent already did its review. */
	revisedSkills: boolean;
}

/**
 * Cumulative tool calls per thread since the last review. Deliberately not reset per turn:
 * a session of many small turns earns a review just as one long turn does (Hermes's
 * `_iters_since_skill`). Reset when a review fires, and when the agent revised a skill on its
 * own — the work the review exists to prompt has already been done.
 */
const callsSinceReview = new Map<string, number>();

/** Record a finished turn; true when a review is due (and the counter is reset). */
export function noteTurnForReview(threadId: string, activity: TurnActivity, threshold: number): boolean {
	if (activity.revisedSkills) {
		callsSinceReview.delete(threadId);
		return false;
	}
	const total = (callsSinceReview.get(threadId) ?? 0) + activity.toolCalls;
	if (threshold > 0 && total >= threshold) {
		callsSinceReview.delete(threadId);
		return true;
	}
	callsSinceReview.set(threadId, total);
	return false;
}

/** Test hook. */
export function resetReviewCounters(): void {
	callsSinceReview.clear();
}

// --- transcript --------------------------------------------------------------------------

/** Longest tool result the reviewer is shown; the rest is what the model concluded from it. */
const TOOL_RESULT_MAX = 600;
/** Longest transcript, kept from the end: the latest turns are the ones with the lesson. */
const TRANSCRIPT_MAX = 40_000;

function textOf(message: BaseMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === "string" ? part : ((part as { text?: string }).text ?? "")))
			.join("");
	}
	return "";
}

function clip(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Render a thread's messages as a compact transcript: user and assistant text in full, tool
 * calls as name plus arguments, tool results clipped. Trimmed from the front to
 * {@link TRANSCRIPT_MAX} so a long thread costs a bounded number of tokens.
 */
export function renderTranscript(messages: readonly BaseMessage[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (HumanMessage.isInstance(message)) {
			lines.push(`USER: ${textOf(message).trim()}`);
		} else if (AIMessage.isInstance(message)) {
			const text = textOf(message).trim();
			if (text) lines.push(`ASSISTANT: ${text}`);
			for (const call of message.tool_calls ?? []) {
				lines.push(`TOOL CALL ${call.name}(${clip(JSON.stringify(call.args ?? {}), 300)})`);
			}
		} else if (ToolMessage.isInstance(message)) {
			lines.push(`TOOL RESULT ${message.name ?? ""}: ${clip(textOf(message), TOOL_RESULT_MAX)}`);
		}
	}
	const transcript = lines.join("\n");
	return transcript.length > TRANSCRIPT_MAX ? `…\n${transcript.slice(-TRANSCRIPT_MAX)}` : transcript;
}

// --- prompt ------------------------------------------------------------------------------

export interface ReviewPromptInputs {
	/** The rendered memory index, as substituted into the agent's own prompt. */
	memoryIndex: string;
	/** The memory folder path, for the save_memory tool's guidance. */
	memoryFolder: string;
	/** The `<available_skills>` block the agent itself sees, or empty. */
	skillsXml: string;
	/** Which capabilities the reviewer actually has, so the prompt never teaches an absent tool. */
	canRevise: boolean;
	canRemember: boolean;
}

export function buildReviewSystemPrompt(inputs: ReviewPromptInputs): string {
	const parts: string[] = [];
	parts.push(
		`# Role
You are reviewing a conversation that just finished between a user and their Obsidian assistant. Your only job is to decide whether it taught something worth keeping, and to keep it in the right place. You are not answering the user; nothing you write is shown to them except a one-line summary of what you saved.

# Routing
- A durable fact about the user — who they are, how they work, a preference, a pointer to where something lives in their vault — goes to memory. Write it as a declarative fact ("User prefers short answers"), never as an instruction.
- How a kind of task is done here, a pitfall hit while doing it, or the user's correction about that work goes into the skill that was used for it. Fix the sentence that was wrong in place; do not append an update under it. Write lessons, not logs: one rule per point, imperative plus one clause of why. Only record what the conversation actually confirmed.
- Nothing that only mattered in this conversation is written anywhere: task progress, what was searched, what the answer was, a preference stated for this one request.
- Do not duplicate what is already in memory or in a skill. Check the lists below first.
- "Nothing to save." is a real outcome. Most routine conversations end there.`,
	);

	const tools: string[] = [];
	tools.push("- `read_content` and `list_directory` to check what a memory note or the vault already holds.");
	if (inputs.canRevise) {
		tools.push(
			"- `load_skill` to read a skill, then `manage_skills` to patch the passage that was wrong or missing (patch, not rewrite; a revision is refused until you have loaded the skill). Create a new skill only when the workflow has no home in an existing one.",
		);
	}
	if (inputs.canRemember) {
		tools.push(
			`- \`save_memory\` to write a memory note into \`${inputs.memoryFolder}/\`. A new note needs the full content with a quoted \`description\` in its frontmatter. For an existing note, append the new facts (the default): another review may be writing the same note at the same time, and an append never loses its addition. Replace a whole note (mode "replace") only after reading it in this review, when it needs reorganizing or a new description.`,
		);
	}
	parts.push(`# Tools\n${tools.join("\n")}`);

	if (inputs.canRemember) {
		parts.push(`# Memory\nWhat is already remembered:\n\n${inputs.memoryIndex}`);
	}
	if (inputs.canRevise && inputs.skillsXml) {
		parts.push(`# Skills\nThe skills that exist:\n\n${inputs.skillsXml}`);
	}

	parts.push(
		`# Finish
Make the saves, then reply with one line per thing you saved ("Saved memory: …", "Revised skill: …", "Created skill: …"), or exactly "Nothing to save." Do not explain.`,
	);
	return parts.join("\n\n");
}

/** The user turn handed to the reviewer: the transcript plus the ask. */
export function buildReviewUserMessage(transcript: string): string {
	return `Here is the conversation that just finished.\n\n<conversation>\n${transcript}\n</conversation>\n\nReview it as instructed.`;
}

// --- outcome -----------------------------------------------------------------------------

/**
 * What the reviewer actually did, read from the tool calls in its run rather than from its
 * final text: the model's summary can claim a save that a refused tool call never made.
 */
export function summarizeReviewActions(messages: readonly BaseMessage[]): string[] {
	// Each call is judged by its own result, matched by id: a refusal on a first attempt must
	// not hide a successful retry, and a success elsewhere must not vouch for a refusal.
	const results = new Map<string, ToolMessage>();
	for (const message of messages) {
		if (ToolMessage.isInstance(message)) results.set(message.tool_call_id, message);
	}
	const actions: string[] = [];
	for (const message of messages) {
		if (!AIMessage.isInstance(message)) continue;
		for (const call of message.tool_calls ?? []) {
			const result = call.id ? results.get(call.id) : undefined;
			if (!result || result.status === "error") continue;
			const outcome = textOf(result);
			const args = (call.args ?? {}) as Record<string, unknown>;
			// Positive matching on the tools' own success phrasings: anything else — a
			// refusal, a "no changes" no-op, an unexpected reply — is not a save.
			if (call.name === "manage_skills") {
				const name = String(args.skillName ?? args.name ?? "");
				if (/^Created and attached /.test(outcome)) actions.push(`created skill ${name}`);
				else if (/^(Patched|Updated) the /.test(outcome)) actions.push(`revised skill ${name}`);
			} else if (call.name === "save_memory" && /^(Created|Updated|Appended to) memory note /.test(outcome)) {
				actions.push(`saved memory ${String(args.name ?? "")}`);
			}
		}
	}
	return [...new Set(actions)];
}
