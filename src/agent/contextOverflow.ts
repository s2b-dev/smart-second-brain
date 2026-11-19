import { ContextOverflowError } from "@langchain/core/errors";
import { AIMessage, RemoveMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { Logger } from "../utils/logging";
import { getUpdateMessages, isSummaryMessage } from "./summarization";

/**
 * Share of the context window kept verbatim when recovering from an overflow.
 * The rest of the history is summarized. It is far below the proactive keep
 * (12 messages), because the provider has just told us that the window we
 * planned against was too optimistic.
 */
export const OVERFLOW_KEEP_RATIO = 0.25;

/** The summarization middleware's `beforeModel`, as `guardSummarizationFailure` leaves it. */
type SummarizerBeforeModel = (state: unknown, runtime: unknown) => Promise<unknown>;

/**
 * Whether `error`, or any error in its `cause` chain, is the provider telling us
 * the request did not fit its context window. `@langchain/anthropic` and
 * `@langchain/openai` (and so every OpenAI-compatible provider) raise a
 * `ContextOverflowError` for this; Ollama never does, since it truncates to
 * `num_ctx` instead.
 */
export function isContextOverflowError(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; current && depth < 10; depth++) {
		if (ContextOverflowError.isInstance(current)) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * Recovers a model call the provider rejected for exceeding its context window.
 *
 * Proactive summarization fires at 80% of the CONFIGURED window, measured with
 * an estimate. When the configured window is larger than the real one, or the
 * estimate is low (images, PDFs, a large tool result), the request overflows
 * before summarization ever triggers, and the turn simply fails.
 *
 * On a `ContextOverflowError` this runs the same guarded summarizer, forced to
 * fire and keeping only `keepTokens` of recent history, retries the call once
 * with the shortened history, and commits that history with the reply: the
 * returned `Command` carries `[RemoveMessage(all), summary, ...kept, reply]`, the
 * same update shape the proactive summarization writes. It lands after the
 * framework's own `[reply]` write, so the reply survives the reset.
 *
 * If nothing could be summarized, the summary failed, or the retry overflows
 * too, the original error propagates and the turn fails as before.
 */
export function createContextOverflowRecoveryMiddleware(options: {
	summarizer: SummarizerBeforeModel;
	keepTokens: number;
}) {
	return createMiddleware({
		name: "S2BContextOverflowRecovery",
		wrapModelCall: async (request, handler) => {
			try {
				return await handler(request);
			} catch (error) {
				if (!isContextOverflowError(error)) throw error;

				Logger.warn("[Agent] Context window exceeded; summarizing the history and retrying once.", error);
				const update = await options.summarizer(request.state, {
					...request.runtime,
					context: {
						...((request.runtime.context as Record<string, unknown> | undefined) ?? {}),
						trigger: { messages: 1 },
						keep: { tokens: options.keepTokens },
					},
				});
				const updateMessages = getUpdateMessages(update);
				if (!updateMessages?.some(isSummaryMessage)) {
					Logger.warn("[Agent] Context overflow recovery had nothing to summarize, or the summary failed.");
					throw error;
				}

				const retried = await handler({
					...request,
					messages: updateMessages.filter((message) => !RemoveMessage.isInstance(message)) as never,
				});
				if (!AIMessage.isInstance(retried)) return retried;
				return new Command({ update: { messages: [...updateMessages, retried] } });
			}
		},
	});
}
