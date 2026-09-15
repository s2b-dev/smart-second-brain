import { beforeEach, describe, expect, it } from "vitest";
import { createAskQuestionTool } from "../../../src/agent/tools/askQuestion";
import {
	getPendingQuestionStore,
	initPendingQuestionStore,
	PendingQuestionStore,
} from "../../../src/stores/pendingQuestionStore.svelte";

describe("askQuestion tool", () => {
	let store: PendingQuestionStore;

	beforeEach(() => {
		store = new PendingQuestionStore();
		initPendingQuestionStore(store);
	});

	it("creates a tool with correct name and schema", () => {
		const tool = createAskQuestionTool();
		expect(tool.name).toBe("ask_question");
		expect(tool.description).toContain("multiple-choice");
	});

	it("executes the tool and waits for user answer", async () => {
		const tool = createAskQuestionTool();
		const toolCallId = "call-123";

		const invokePromise = tool.invoke(
			{
				questions: [
					{
						id: "q_lang",
						question: "Which language do you prefer?",
						options: ["Python", "Rust", "TypeScript"],
					},
				],
			},
			{
				toolCallId,
				configurable: { thread_id: "thread-abc" },
			} as any,
		);

		// Wait a tick for async validation and execution to reach the tool function
		await new Promise((resolve) => setTimeout(resolve, 20));

		// Verify question is registered in store
		const pending = store.getPending(toolCallId);
		expect(pending).toBeDefined();
		expect(pending?.questions[0].question).toBe("Which language do you prefer?");

		// Submit user choice
		store.submitAnswers(toolCallId, [
			{
				questionId: "q_lang",
				question: "Which language do you prefer?",
				selected: ["TypeScript"],
			},
		]);

		const resultStr = (await invokePromise) as string;
		const result = JSON.parse(resultStr);
		expect(result.status).toBe("answered");
		expect(result.answers[0].selected).toEqual(["TypeScript"]);
	});
});
