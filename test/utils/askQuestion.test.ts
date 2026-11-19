import { describe, expect, it } from "vitest";
import {
	formatAnswersResult,
	formatDismissedResult,
	formatInvalidResult,
	formatReplyResult,
	isAnswered,
	parseAskQuestionResult,
	parseAskQuestions,
} from "../../src/utils/askQuestion";

describe("parseAskQuestions", () => {
	it("reads questions with their options", () => {
		const questions = parseAskQuestions({
			questions: [
				{
					question: "Where should the note go?",
					header: "Folder",
					options: [{ label: "Projects", description: "Next to the plan" }, { label: "Inbox" }],
					multiSelect: true,
				},
			],
		});

		expect(questions).toEqual([
			{
				question: "Where should the note go?",
				header: "Folder",
				options: [{ label: "Projects", description: "Next to the plan" }, { label: "Inbox" }],
				multiSelect: true,
			},
		]);
	});

	it("drops malformed questions and options instead of failing", () => {
		const questions = parseAskQuestions({
			questions: [
				null,
				{ question: "   " },
				{ question: "Which one?", options: ["A", { label: "" }, { nope: true }, { label: "B" }, "A"] },
			],
		});

		expect(questions).toEqual([
			{ question: "Which one?", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
		]);
	});

	it("returns nothing for arguments that are not a question list", () => {
		expect(parseAskQuestions(undefined)).toEqual([]);
		expect(parseAskQuestions({ questions: "Which one?" })).toEqual([]);
	});
});

describe("isAnswered", () => {
	it("needs a choice or typed text", () => {
		expect(isAnswered(undefined)).toBe(false);
		expect(isAnswered({ selected: [], custom: "  " })).toBe(false);
		expect(isAnswered({ selected: ["A"] })).toBe(true);
		expect(isAnswered({ selected: [], custom: "mine" })).toBe(true);
	});
});

describe("tool results", () => {
	const questions = parseAskQuestions({
		questions: [
			{ question: "Which folder?", options: [{ label: "Projects" }, { label: "Inbox" }] },
			{ question: "Which tags?", options: [{ label: "work" }, { label: "idea" }], multiSelect: true },
		],
	});

	it("round-trips submitted answers, typed text included", () => {
		const result = formatAnswersResult(questions, [
			{ selected: ["Inbox"] },
			{ selected: ["work", "idea"], custom: " urgent " },
		]);

		expect(parseAskQuestionResult(result)).toEqual({
			status: "answered",
			answers: [
				{ question: "Which folder?", answer: ["Inbox"] },
				{ question: "Which tags?", answer: ["work", "idea", "urgent"] },
			],
		});
	});

	it("round-trips a typed chat reply", () => {
		expect(parseAskQuestionResult(formatReplyResult("  neither, use Archive "))).toEqual({
			status: "replied",
			reply: "neither, use Archive",
		});
	});

	it("reads a dismissal, and a call with nothing to show, as dismissed", () => {
		expect(parseAskQuestionResult(formatDismissedResult())).toEqual({ status: "dismissed" });
		expect(parseAskQuestionResult(formatInvalidResult())).toEqual({ status: "dismissed" });
	});

	it("accepts an already-parsed object and rejects foreign output", () => {
		expect(parseAskQuestionResult({ status: "dismissed" })).toEqual({ status: "dismissed" });
		expect(parseAskQuestionResult("not json")).toBeNull();
		expect(parseAskQuestionResult({ status: "something else" })).toBeNull();
		expect(parseAskQuestionResult(undefined)).toBeNull();
	});
});
