import { describe, expect, it } from "vitest";
import { PendingQuestionStore } from "../../src/stores/pendingQuestionStore.svelte";

describe("PendingQuestionStore", () => {
	it("registers a question and resolves when answers are submitted", async () => {
		const store = new PendingQuestionStore();
		const threadId = "thread-1";
		const toolCallId = "tool-1";
		const questions = [
			{
				id: "q1",
				question: "Do you prefer TypeScript or JavaScript?",
				options: ["TypeScript", "JavaScript"],
				isMultiSelect: false,
			},
		];

		const askPromise = store.ask(threadId, toolCallId, questions);
		expect(store.getPending(toolCallId)).toBeDefined();
		expect(store.getPendingForThread(threadId)).toBeDefined();

		const submitted = store.submitAnswers(toolCallId, [
			{
				questionId: "q1",
				question: "Do you prefer TypeScript or JavaScript?",
				selected: ["TypeScript"],
			},
		]);

		expect(submitted).toBe(true);
		const result = await askPromise;
		expect(result).toHaveLength(1);
		expect(result[0].selected).toEqual(["TypeScript"]);
		expect(store.getPending(toolCallId)).toBeUndefined();
	});

	it("cancels a pending question and rejects the promise", async () => {
		const store = new PendingQuestionStore();
		const threadId = "thread-2";
		const toolCallId = "tool-2";

		const askPromise = store.ask(threadId, toolCallId, [
			{
				id: "q1",
				question: "Choose one",
				options: ["A", "B"],
			},
		]);

		const cancelled = store.cancel(toolCallId, new Error("User cancelled question"));
		expect(cancelled).toBe(true);

		await expect(askPromise).rejects.toThrow("User cancelled question");
		expect(store.getPending(toolCallId)).toBeUndefined();
	});

	it("aborts when AbortSignal fires", async () => {
		const store = new PendingQuestionStore();
		const controller = new AbortController();
		const threadId = "thread-3";
		const toolCallId = "tool-3";

		const askPromise = store.ask(
			threadId,
			toolCallId,
			[
				{
					id: "q1",
					question: "Choose one",
					options: ["A", "B"],
				},
			],
			controller.signal,
		);

		controller.abort();

		await expect(askPromise).rejects.toThrow("Tool execution was aborted");
		expect(store.getPending(toolCallId)).toBeUndefined();
	});

	it("immediately rejects if signal is already aborted", async () => {
		const store = new PendingQuestionStore();
		const controller = new AbortController();
		controller.abort();

		await expect(
			store.ask(
				"thread-4",
				"tool-4",
				[
					{
						id: "q1",
						question: "Choose one",
						options: ["A", "B"],
					},
				],
				controller.signal,
			),
		).rejects.toThrow("Tool execution was aborted");
	});

	it("clears pending questions for a thread", async () => {
		const store = new PendingQuestionStore();
		const askPromise = store.ask("thread-5", "tool-5", [
			{ id: "q1", question: "Q", options: ["1", "2"] },
		]);

		store.clearForThread("thread-5");
		await expect(askPromise).rejects.toThrow("Thread session cleared or reset");
		expect(store.getPendingForThread("thread-5")).toBeUndefined();
	});
});
