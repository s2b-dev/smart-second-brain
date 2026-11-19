import { describe, expect, it } from "vitest";
import {
	PAUSES_FOR_USER,
	buildResumeValue,
	parseToolInterrupts,
	toolsPausingForUser,
} from "../../src/agent/toolInterrupts";

const RAISED = {
	id: "int-1",
	value: {
		type: "tool_approval",
		tool_call_id: "call_a",
		name: "ask_question",
		args: { questions: [] },
		description: "Waiting for the user's answer.",
	},
};

describe("parseToolInterrupts", () => {
	it("reads a per-call tool interrupt", () => {
		expect(parseToolInterrupts([RAISED])).toEqual([
			{ id: "int-1", toolCallId: "call_a", toolName: "ask_question", args: { questions: [] } },
		]);
	});

	it("skips anything that is not a per-call tool interrupt", () => {
		expect(parseToolInterrupts(undefined)).toEqual([]);
		expect(parseToolInterrupts("nope")).toEqual([]);
		expect(
			parseToolInterrupts([
				null,
				{ id: "x", value: { actionRequests: [], reviewConfigs: [] } },
				{ value: RAISED.value },
				{ id: "y", value: { ...RAISED.value, tool_call_id: 7 } },
			]),
		).toEqual([]);
	});
});

describe("toolsPausingForUser", () => {
	it("names only the tools marked as waiting for the user", () => {
		const tools = [
			{ name: "search_notes", metadata: {} },
			{ name: "ask_me", metadata: { [PAUSES_FOR_USER]: true } },
			{ name: "no_metadata" },
			null,
		];
		expect(toolsPausingForUser(tools)).toEqual(["ask_me"]);
	});
});

describe("buildResumeValue", () => {
	it("answers each interrupt under its own id with a respond decision", () => {
		const [interrupt] = parseToolInterrupts([RAISED]);
		expect(buildResumeValue([{ interrupt, message: "the answer" }])).toEqual({
			"int-1": { type: "respond", message: "the answer" },
		});
	});
});
