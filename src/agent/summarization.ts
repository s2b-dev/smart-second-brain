import { Logger } from "../utils/logging";

const SUMMARY_TRIGGER_RATIO = 0.8;
export const SUMMARY_KEEP_MESSAGE_COUNT = 12;
const SUMMARY_MIN_TRIM_TOKENS = 6_000;
const SUMMARY_MAX_TRIM_TOKENS = 24_000;
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

/**
 * Token count at which history is summarized: a fixed share of the window. There used to be a
 * 12k floor, but on windows under 15k it put the trigger at or past the window itself, so a
 * small local model (e.g. Ollama at 8k) overflowed before summarization could fire.
 */
export function getSummarizationTriggerTokens(contextWindow: number | undefined): number | null {
	if (!contextWindow || contextWindow <= 0) {
		return null;
	}

	return Math.floor(contextWindow * SUMMARY_TRIGGER_RATIO);
}

export function getTrimTokensToSummarize(triggerTokens: number): number {
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
 * LangChain's `summarizationMiddleware` swallows summary-model failures:
 * `createSummary` catches the error and returns `"Error generating summary:
 * ${e}"` (or "…: Invalid response format") as if it were the summary, and the
 * middleware then commits the trim — permanently replacing the trimmed turns
 * with an error stub in the model's context (#435, observed in a real thread
 * where a mid-stream network error became the entire "memory" of 195
 * messages). The summary message content is always
 * `${SUMMARY_PREFIX}\n\n<createSummary result>`, so a failed one is
 * identified by its exact prefix.
 */
export function isFailedSummaryContent(content: unknown): boolean {
	return typeof content === "string" && content.startsWith(`${SUMMARY_PREFIX}\n\nError generating summary:`);
}

/**
 * Whether a `beforeModel` state update from the summarization middleware
 * carries a failed summary. The update's `messages` contain the synthetic
 * summary `HumanMessage`, tagged `lc_source: "summarization"`.
 */
export function isFailedSummaryUpdate(update: unknown): boolean {
	if (!update || typeof update !== "object") return false;
	const messages = (update as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return false;
	return messages.some((msg) => {
		const message = msg as { additional_kwargs?: Record<string, unknown>; content?: unknown } | null;
		return message?.additional_kwargs?.lc_source === "summarization" && isFailedSummaryContent(message.content);
	});
}

/**
 * Wraps the summarization middleware's `beforeModel` hook so a failed summary
 * aborts the trim instead of being committed: the turn runs with the full,
 * untrimmed history (one turn over the trigger ratio is harmless) and
 * summarization simply retries on the next turn. Success and no-op updates
 * pass through untouched.
 */
export function guardSummarizationFailure<T extends { beforeModel?: unknown }>(middleware: T): T {
	const inner = middleware.beforeModel;
	if (typeof inner !== "function") return middleware;

	middleware.beforeModel = async (...args: unknown[]) => {
		const update = await inner.apply(middleware, args);
		if (isFailedSummaryUpdate(update)) {
			Logger.warn(
				"[Agent] Summary generation failed — keeping the full history this turn; summarization retries next turn.",
			);
			return undefined;
		}
		return update;
	};
	return middleware;
}
