import type { BaseMessage } from "@langchain/core/messages";
import { Logger } from "../utils/logging";

const SUMMARY_TRIGGER_RATIO = 0.8;
export const SUMMARY_KEEP_MESSAGE_COUNT = 12;
const SUMMARY_MIN_TRIGGER_TOKENS = 12_000;
const SUMMARY_MIN_TRIM_TOKENS = 6_000;
const SUMMARY_MAX_TRIM_TOKENS = 24_000;
// Share of the summarization model's own window the history may fill; the rest
// holds the prompt template and the summary it writes back.
const SUMMARY_INPUT_RATIO = 0.85;
const SUMMARY_MIN_INPUT_TOKENS = 1_000;
export const SUMMARY_FAILURE_NOTICE_THRESHOLD = 3;
export const SUMMARY_PREFIX = "Previous conversation summary";
export const SUMMARY_PROMPT = `Summarize the earlier conversation so the assistant can continue the thread accurately.

Preserve:
- user goals, preferences, and constraints
- important facts, decisions, and unresolved questions
- tool results or note/file references that still matter
- any explicit instructions that should continue to apply

Be concise but specific. Do not invent information.

Conversation:
{messages}`;

export function getSummarizationTriggerTokens(contextWindow: number | undefined): number | null {
	if (!contextWindow || contextWindow <= 0) {
		return null;
	}

	return Math.max(Math.floor(contextWindow * SUMMARY_TRIGGER_RATIO), SUMMARY_MIN_TRIGGER_TOKENS);
}

/**
 * How much of the history being replaced the summarization model gets to read.
 *
 * LangChain trims the to-be-summarized messages to this budget (keeping the
 * newest) and then removes ALL of them, so anything over it is lost without a
 * trace (#545). The budget is therefore the summarization model's own window,
 * minus room for the prompt and the summary, so it reads everything it
 * replaces. Only when that window is unknown (a dedicated summary model with no
 * configured context window) does it fall back to a conservative fixed cap.
 */
export function getTrimTokensToSummarize(summarizerContextWindow: number | undefined, triggerTokens: number): number {
	if (summarizerContextWindow && summarizerContextWindow > 0) {
		const promptTokens = Math.ceil(SUMMARY_PROMPT.length / 4);
		return Math.max(
			Math.floor(summarizerContextWindow * SUMMARY_INPUT_RATIO) - promptTokens,
			SUMMARY_MIN_INPUT_TOKENS,
		);
	}
	return Math.max(
		Math.min(Math.floor(triggerTokens / 2), SUMMARY_MAX_TRIM_TOKENS),
		Math.min(SUMMARY_MIN_TRIM_TOKENS, triggerTokens),
	);
}

export function shouldSummarizeForEstimatedTokens(estimatedTokens: number, contextWindow: number | undefined): boolean {
	const triggerTokens = getSummarizationTriggerTokens(contextWindow);
	return triggerTokens !== null && estimatedTokens >= triggerTokens;
}

/**
 * Stub bodies LangChain's `createSummary` returns in place of a summary:
 * - `"Error generating summary: ${e}"` (or "…: Invalid response format") — it
 *   catches summary-model failures and returns this as if it were the summary,
 *   and the middleware then commits the trim, permanently replacing the trimmed
 *   turns with an error stub (#435, observed in a real thread where a mid-stream
 *   network error became the entire "memory" of 195 messages);
 * - `"Previous conversation was too long to summarize."` — the trim left nothing;
 * - an empty string — the model answered with no text.
 * The summary message content is always `${SUMMARY_PREFIX}\n\n<createSummary
 * result>`, so a failed one is identified by what follows the prefix.
 */
export function isFailedSummaryContent(content: unknown): boolean {
	if (typeof content !== "string") return false;
	const head = `${SUMMARY_PREFIX}\n\n`;
	if (!content.startsWith(head)) return false;
	const body = content.slice(head.length).trim();
	return (
		body.length === 0 ||
		body.startsWith("Error generating summary:") ||
		body === "Previous conversation was too long to summarize."
	);
}

function isSummaryMessage(msg: unknown): msg is { additional_kwargs: Record<string, unknown>; content?: unknown } {
	const message = msg as { additional_kwargs?: Record<string, unknown> } | null;
	return message?.additional_kwargs?.lc_source === "summarization";
}

function getUpdateMessages(update: unknown): unknown[] | null {
	if (!update || typeof update !== "object") return null;
	const messages = (update as { messages?: unknown }).messages;
	return Array.isArray(messages) ? messages : null;
}

/**
 * Whether a `beforeModel` state update from the summarization middleware
 * carries a failed summary. The update's `messages` contain the synthetic
 * summary `HumanMessage`, tagged `lc_source: "summarization"`.
 */
export function isFailedSummaryUpdate(update: unknown): boolean {
	const messages = getUpdateMessages(update);
	if (!messages) return false;
	return messages.some((msg) => isSummaryMessage(msg) && isFailedSummaryContent(msg.content));
}

/** The messages a successful summarization update replaced with its summary. */
function getSummarizedMessages(state: unknown, updateMessages: unknown[]): BaseMessage[] {
	const stateMessages = (state as { messages?: unknown } | null)?.messages;
	if (!Array.isArray(stateMessages)) return [];
	// The update is [RemoveMessage(all), summary, ...preserved]; everything in
	// the old state that is not preserved was summarized.
	const preservedIds = new Set(
		updateMessages
			.filter((msg) => !isSummaryMessage(msg))
			.map((msg) => (msg as { id?: unknown }).id)
			.filter((id) => typeof id === "string"),
	);
	return (stateMessages as BaseMessage[]).filter((msg) => !msg.id || !preservedIds.has(msg.id));
}

export interface SummarizationGuardOptions {
	/** The middleware's `tokenCounter`, used to measure what was summarized. */
	tokenCounter?: (messages: BaseMessage[]) => number | Promise<number>;
	/** The middleware's `trimTokensToSummarize`. */
	trimTokensToSummarize?: number;
	/**
	 * Called when the history being replaced was larger than the summarizer's
	 * budget, so its oldest part was dropped instead of summarized.
	 */
	onHistoryDropped?: (info: { summarizedTokens: number; budgetTokens: number; droppedTokens: number }) => void;
	/** Called once when summarization has failed this many turns in a row. */
	onRepeatedFailure?: (consecutiveFailures: number) => void;
}

/**
 * Wraps the summarization middleware's `beforeModel` hook so a failed summary
 * aborts the trim instead of being committed: the turn runs with the full,
 * untrimmed history (one turn over the trigger ratio is harmless) and
 * summarization simply retries on the next turn. Success and no-op updates
 * pass through untouched.
 *
 * Failures are counted across turns, per thread (the runnable is cached per
 * agent config and shared by every chat, so a single counter would mix
 * chats); after `SUMMARY_FAILURE_NOTICE_THRESHOLD` in a row in one thread
 * `onRepeatedFailure` fires once, since by then that thread's history keeps
 * growing toward the provider's limit. A
 * successful summary is measured against the trim budget and reports any
 * history that was dropped unsummarized.
 */
export function guardSummarizationFailure<T extends { beforeModel?: unknown }>(
	middleware: T,
	options: SummarizationGuardOptions = {},
): T {
	const inner = middleware.beforeModel;
	if (typeof inner !== "function") return middleware;

	const failuresByThread = new Map<string, number>();
	middleware.beforeModel = async (...args: unknown[]) => {
		const update = await inner.apply(middleware, args);
		const threadId = getThreadId(args[1]);
		if (isFailedSummaryUpdate(update)) {
			const consecutiveFailures = (failuresByThread.get(threadId) ?? 0) + 1;
			failuresByThread.set(threadId, consecutiveFailures);
			const summary = getUpdateMessages(update)?.find(isSummaryMessage)?.content;
			Logger.warn(
				`[Agent] Summary generation failed (${consecutiveFailures} in a row) — keeping the full history this turn; summarization retries next turn.`,
				summary,
			);
			if (consecutiveFailures === SUMMARY_FAILURE_NOTICE_THRESHOLD) {
				options.onRepeatedFailure?.(consecutiveFailures);
			}
			return undefined;
		}

		const updateMessages = getUpdateMessages(update);
		if (updateMessages?.some(isSummaryMessage)) {
			failuresByThread.delete(threadId);
			await reportDroppedHistory(args[0], updateMessages, options);
		}
		return update;
	};
	return middleware;
}

/** The run's thread id from the middleware runtime (`configurable.thread_id`). */
function getThreadId(runtime: unknown): string {
	const threadId = (runtime as { configurable?: { thread_id?: unknown } } | null)?.configurable?.thread_id;
	return typeof threadId === "string" ? threadId : "";
}

async function reportDroppedHistory(
	state: unknown,
	updateMessages: unknown[],
	options: SummarizationGuardOptions,
): Promise<void> {
	const { tokenCounter, trimTokensToSummarize: budgetTokens } = options;
	if (!tokenCounter || budgetTokens === undefined) return;
	try {
		const summarizedTokens = await tokenCounter(getSummarizedMessages(state, updateMessages));
		if (summarizedTokens <= budgetTokens) return;
		const droppedTokens = summarizedTokens - budgetTokens;
		Logger.warn(
			`[Agent] Summarized ~${budgetTokens} of ~${summarizedTokens} tokens of history; the oldest ~${droppedTokens} did not fit the summarization model's budget and were dropped.`,
		);
		options.onHistoryDropped?.({ summarizedTokens, budgetTokens, droppedTokens });
	} catch (err) {
		Logger.debug("[Agent] Could not measure summarized history", err);
	}
}
