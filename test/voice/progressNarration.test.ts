import { describe, expect, it } from "vitest";
import { describeProgress } from "../../src/voice/progressNarration";

describe("describeProgress", () => {
	it("speaks the agent's own lead-in", () => {
		expect(
			describeProgress({ toolName: "search_notes", preamble: " Let me look for last week's todos. " }),
		).toEqual({
			text: "Let me look for last week's todos.",
			isLeadIn: true,
		});
	});

	it("stays silent for tool starts without a lead-in, whatever their input", () => {
		expect(describeProgress({ toolName: "search_notes", input: { query: "todos last week" } })).toBeNull();
		expect(describeProgress({ toolName: "read_content", input: { path: "Journal/Weekly.md" } })).toBeNull();
		expect(describeProgress({ toolName: "manage_notes", input: { operations: [] } })).toBeNull();
		expect(describeProgress({ toolName: "search_notes", preamble: "   " })).toBeNull();
	});
});
