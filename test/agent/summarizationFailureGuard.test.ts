import { describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { summarizationMiddleware } from "langchain";
import {
	getTrimTokensToSummarize,
	guardSummarizationFailure,
	isFailedSummaryContent,
	isFailedSummaryUpdate,
	SUMMARY_FAILURE_NOTICE_THRESHOLD,
	SUMMARY_PREFIX,
} from "../../src/agent/summarization";
import { countMessageTokens } from "../../src/utils/tokenEstimator";

/* --------------------------------------------------------------------------
 * Pure helpers
 * ------------------------------------------------------------------------*/

describe("isFailedSummaryContent", () => {
	it("matches the middleware's swallowed-error stubs", () => {
		expect(
			isFailedSummaryContent(
				`${SUMMARY_PREFIX}\n\nError generating summary: Error: net::ERR_INCOMPLETE_CHUNKED_ENCODING`,
			),
		).toBe(true);
		expect(isFailedSummaryContent(`${SUMMARY_PREFIX}\n\nError generating summary: Invalid response format`)).toBe(
			true,
		);
	});

	it("matches an empty summary and the too-long-to-summarize stub (#545)", () => {
		expect(isFailedSummaryContent(`${SUMMARY_PREFIX}\n\n`)).toBe(true);
		expect(isFailedSummaryContent(`${SUMMARY_PREFIX}\n\n   \n`)).toBe(true);
		expect(isFailedSummaryContent(`${SUMMARY_PREFIX}\n\nPrevious conversation was too long to summarize.`)).toBe(
			true,
		);
	});

	it("does not match real summaries, even ones mentioning errors", () => {
		expect(isFailedSummaryContent(`${SUMMARY_PREFIX}\n\nUser debugged an "Error generating summary" bug.`)).toBe(
			false,
		);
		expect(isFailedSummaryContent(`${SUMMARY_PREFIX}\n\nUser is planning a thesis.`)).toBe(false);
		expect(isFailedSummaryContent(undefined)).toBe(false);
		expect(isFailedSummaryContent(42)).toBe(false);
	});
});

describe("isFailedSummaryUpdate", () => {
	it("detects a failed summary message inside a state update", () => {
		const update = {
			messages: [
				new HumanMessage({
					content: `${SUMMARY_PREFIX}\n\nError generating summary: Error: boom`,
					additional_kwargs: { lc_source: "summarization" },
				}),
				new HumanMessage({ content: "kept" }),
			],
		};
		expect(isFailedSummaryUpdate(update)).toBe(true);
	});

	it("passes successful updates, no-ops, and unrelated shapes", () => {
		expect(
			isFailedSummaryUpdate({
				messages: [
					new HumanMessage({
						content: `${SUMMARY_PREFIX}\n\nA proper summary.`,
						additional_kwargs: { lc_source: "summarization" },
					}),
				],
			}),
		).toBe(false);
		expect(isFailedSummaryUpdate(undefined)).toBe(false);
		expect(isFailedSummaryUpdate({})).toBe(false);
		expect(isFailedSummaryUpdate({ messages: "not-an-array" })).toBe(false);
	});
});

describe("getTrimTokensToSummarize", () => {
	it("lets the summarizer read nearly its whole window, so it sees everything it replaces (#545)", () => {
		// At a 128k window the trigger is ~102k; the old cap read only 24k of it.
		const budget = getTrimTokensToSummarize(128_000, 102_400);
		expect(budget).toBeGreaterThan(102_400 - 12 * 1_000);
		expect(budget).toBeLessThan(128_000);
	});

	it("is bounded by a smaller dedicated summary model's window", () => {
		expect(getTrimTokensToSummarize(16_000, 160_000)).toBeLessThan(16_000);
	});

	it("keeps the conservative cap when the summarizer's window is unknown", () => {
		expect(getTrimTokensToSummarize(undefined, 102_400)).toBe(24_000);
		expect(getTrimTokensToSummarize(undefined, 12_000)).toBe(6_000);
	});
});

/* --------------------------------------------------------------------------
 * Guard against the real middleware
 * ------------------------------------------------------------------------*/

function longConversation() {
	return [
		new HumanMessage({ content: "First question about the thesis plan, with plenty of words." }),
		new AIMessage({ content: "A long first answer that costs a good number of tokens overall." }),
		new HumanMessage({ content: "Second question, following up on supervisors." }),
		new AIMessage({ content: "Second answer with more detail than strictly needed." }),
		new HumanMessage({ content: "Third question about the timeline." }),
		new AIMessage({ content: "Third answer, still fairly wordy." }),
		new HumanMessage({ content: "Fourth question that overflows the tiny test budget." }),
	];
}

function makeMiddleware(
	model: { invoke: (...args: unknown[]) => Promise<unknown> },
	extra: { trimTokensToSummarize?: number } = {},
) {
	return summarizationMiddleware({
		model: model as never,
		trigger: { tokens: 10 },
		keep: { messages: 2 },
		summaryPrefix: SUMMARY_PREFIX,
		summaryPrompt: "Summarize:\n{messages}",
		tokenCounter: countMessageTokens,
		...extra,
	});
}

type BeforeModel = (s: unknown, r: unknown) => Promise<unknown>;

function failingModel() {
	return {
		invoke: async () => {
			throw new Error("boom");
		},
	};
}

const runtime = { context: {} } as never;

describe("guardSummarizationFailure (real summarizationMiddleware)", () => {
	it("without the guard, a model failure is committed as the summary (LangChain contract)", async () => {
		const middleware = makeMiddleware({
			invoke: async () => {
				throw new Error("net::ERR_INCOMPLETE_CHUNKED_ENCODING");
			},
		});
		const update = await (middleware.beforeModel as (s: unknown, r: unknown) => Promise<unknown>)(
			{ messages: longConversation() },
			runtime,
		);

		// If this stops matching, LangChain changed its swallowed-error format
		// and isFailedSummaryContent must be updated with it.
		expect(isFailedSummaryUpdate(update)).toBe(true);
	});

	it("aborts the trim when summary generation fails", async () => {
		const middleware = guardSummarizationFailure(
			makeMiddleware({
				invoke: async () => {
					throw new Error("net::ERR_INCOMPLETE_CHUNKED_ENCODING");
				},
			}),
		);
		const update = await (middleware.beforeModel as (s: unknown, r: unknown) => Promise<unknown>)(
			{ messages: longConversation() },
			runtime,
		);

		expect(update).toBeUndefined();
	});

	it("passes a successful summarization through untouched", async () => {
		const middleware = guardSummarizationFailure(
			makeMiddleware({
				invoke: async () => new AIMessage({ content: "User is planning a thesis; supervisor search ongoing." }),
			}),
		);
		const update = (await (middleware.beforeModel as (s: unknown, r: unknown) => Promise<unknown>)(
			{ messages: longConversation() },
			runtime,
		)) as { messages: { content?: unknown; additional_kwargs?: Record<string, unknown> }[] };

		expect(Array.isArray(update?.messages)).toBe(true);
		const summary = update.messages.find((m) => m.additional_kwargs?.lc_source === "summarization");
		expect(summary?.content).toBe(`${SUMMARY_PREFIX}\n\nUser is planning a thesis; supervisor search ongoing.`);
	});

	it("passes a below-trigger no-op through untouched", async () => {
		const middleware = guardSummarizationFailure(
			makeMiddleware({
				invoke: async () => {
					throw new Error("should not be called");
				},
			}),
		);
		const update = await (middleware.beforeModel as (s: unknown, r: unknown) => Promise<unknown>)(
			{ messages: [new HumanMessage({ content: "hi" })] },
			runtime,
		);
		expect(update).toBeUndefined();
	});

	it("leaves middleware without a beforeModel hook untouched", () => {
		const bare = { name: "x" } as { name: string; beforeModel?: unknown };
		expect(guardSummarizationFailure(bare)).toBe(bare);
		expect(bare.beforeModel).toBeUndefined();
	});
});

describe("guardSummarizationFailure — repeated failures and dropped history", () => {
	it("aborts the trim for an empty summary", async () => {
		const middleware = guardSummarizationFailure(
			makeMiddleware({ invoke: async () => new AIMessage({ content: "   " }) }),
		);
		const update = await (middleware.beforeModel as BeforeModel)({ messages: longConversation() }, runtime);
		expect(update).toBeUndefined();
	});

	it("aborts the trim when nothing survived trimming (too-long stub)", async () => {
		const invoke = vi.fn();
		const middleware = guardSummarizationFailure(makeMiddleware({ invoke }, { trimTokensToSummarize: 0 }));
		const update = await (middleware.beforeModel as BeforeModel)({ messages: longConversation() }, runtime);
		expect(invoke).not.toHaveBeenCalled();
		expect(update).toBeUndefined();
	});

	it("reports repeated consecutive failures exactly once per streak", async () => {
		const onRepeatedFailure = vi.fn();
		let fail = true;
		const middleware = guardSummarizationFailure(
			makeMiddleware({
				invoke: async () => {
					if (fail) throw new Error("boom");
					return new AIMessage({ content: "A proper summary." });
				},
			}),
			{ onRepeatedFailure },
		);
		const run = () => (middleware.beforeModel as BeforeModel)({ messages: longConversation() }, runtime);

		for (let i = 1; i < SUMMARY_FAILURE_NOTICE_THRESHOLD; i++) await run();
		expect(onRepeatedFailure).not.toHaveBeenCalled();
		await run();
		expect(onRepeatedFailure).toHaveBeenCalledTimes(1);
		expect(onRepeatedFailure).toHaveBeenCalledWith(SUMMARY_FAILURE_NOTICE_THRESHOLD);
		await run();
		expect(onRepeatedFailure).toHaveBeenCalledTimes(1);

		// A success resets the streak; a fresh streak reports again.
		fail = false;
		await run();
		fail = true;
		for (let i = 0; i < SUMMARY_FAILURE_NOTICE_THRESHOLD; i++) await run();
		expect(onRepeatedFailure).toHaveBeenCalledTimes(2);
	});

	it("counts failure streaks per thread, not across chats sharing the runnable", async () => {
		const onRepeatedFailure = vi.fn();
		const failingThreads = new Set(["a", "b"]);
		const middleware = guardSummarizationFailure(
			makeMiddleware({
				invoke: async (_prompt: unknown, config: unknown) => {
					const threadId = (config as { configurable?: { thread_id?: string } }).configurable?.thread_id;
					if (threadId && failingThreads.has(threadId)) throw new Error("boom");
					return new AIMessage({ content: "A proper summary." });
				},
			}),
			{ onRepeatedFailure },
		);
		const run = (threadId: string) =>
			(middleware.beforeModel as BeforeModel)(
				{ messages: longConversation() },
				{ context: {}, configurable: { thread_id: threadId } },
			);

		// Two failures in "a", then one in "b": neither thread reached the threshold.
		for (let i = 1; i < SUMMARY_FAILURE_NOTICE_THRESHOLD; i++) await run("a");
		await run("b");
		expect(onRepeatedFailure).not.toHaveBeenCalled();

		// A success in "c" must not reset "a"'s streak.
		await run("c");
		await run("a");
		expect(onRepeatedFailure).toHaveBeenCalledTimes(1);
	});

	it("does not report a failure streak for failures interrupted by no-ops", async () => {
		const onRepeatedFailure = vi.fn();
		const middleware = guardSummarizationFailure(makeMiddleware(failingModel()), { onRepeatedFailure });
		await (middleware.beforeModel as BeforeModel)({ messages: longConversation() }, runtime);
		// A below-trigger turn neither fails nor succeeds; it must not reset or count.
		await (middleware.beforeModel as BeforeModel)({ messages: [new HumanMessage("hi")] }, runtime);
		expect(onRepeatedFailure).not.toHaveBeenCalled();
	});

	it("reports history that exceeded the summarizer's budget", async () => {
		const onHistoryDropped = vi.fn();
		const trimTokensToSummarize = 20;
		const middleware = guardSummarizationFailure(
			makeMiddleware(
				{ invoke: async () => new AIMessage({ content: "Summary of what fit." }) },
				{ trimTokensToSummarize },
			),
			{ tokenCounter: countMessageTokens, trimTokensToSummarize, onHistoryDropped },
		);
		const messages = longConversation();
		const update = await (middleware.beforeModel as BeforeModel)({ messages }, runtime);

		expect(update).toBeDefined();
		expect(onHistoryDropped).toHaveBeenCalledTimes(1);
		// Everything but the 2 kept messages was summarized.
		const summarizedTokens = countMessageTokens(messages.slice(0, -2));
		expect(onHistoryDropped).toHaveBeenCalledWith({
			summarizedTokens,
			budgetTokens: trimTokensToSummarize,
			droppedTokens: summarizedTokens - trimTokensToSummarize,
		});
	});

	it("stays silent when the summarizer read everything it replaced", async () => {
		const onHistoryDropped = vi.fn();
		const trimTokensToSummarize = 100_000;
		const middleware = guardSummarizationFailure(
			makeMiddleware(
				{ invoke: async () => new AIMessage({ content: "Full summary." }) },
				{ trimTokensToSummarize },
			),
			{ tokenCounter: countMessageTokens, trimTokensToSummarize, onHistoryDropped },
		);
		await (middleware.beforeModel as BeforeModel)({ messages: longConversation() }, runtime);
		expect(onHistoryDropped).not.toHaveBeenCalled();
	});
});
