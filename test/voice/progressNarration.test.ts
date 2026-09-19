import { describe, expect, it } from "vitest";
import { describeProgress } from "../../src/voice/progressNarration";

describe("describeProgress", () => {
	it("uses the model's own lead-in when there is one", () => {
		expect(describeProgress({ toolName: "search_notes", preamble: "Let me look for last week's todos." })).toBe(
			"Let me look for last week's todos.",
		);
	});

	it("names the concrete detail from the tool input", () => {
		expect(describeProgress({ toolName: "search_notes", input: { query: "todos last week" } })).toBe(
			'Searching the notes for "todos last week"',
		);
		expect(describeProgress({ toolName: "read_content", input: { path: "Journal/2026-09-12 Weekly.md" } })).toBe(
			'Reading "2026-09-12 Weekly"',
		);
		expect(describeProgress({ toolName: "grep_notes", input: { pattern: "- [ ]" } })).toBe(
			'Looking through note text for "- [ ]"',
		);
		expect(describeProgress({ toolName: "fetch_url", input: { url: "https://www.example.org/a/b" } })).toBe(
			"Reading a page from example.org",
		);
		expect(describeProgress({ toolName: "manage_notes", input: { operations: [] } })).toBe(
			"Drafting the note changes for review",
		);
	});

	it("stays silent when there is nothing specific to say", () => {
		expect(describeProgress({ toolName: "search_notes", input: {} })).toBeNull();
		expect(describeProgress({ toolName: "search_notes", input: { query: "   " } })).toBeNull();
		expect(describeProgress({ toolName: "get_all_tags" })).toBeNull();
		expect(describeProgress({ toolName: "some_mcp_tool", input: { x: 1 } })).toBeNull();
	});

	it("truncates long details", () => {
		const long = "a".repeat(100);
		const text = describeProgress({ toolName: "web_search", input: { query: long } });
		expect(text?.length).toBeLessThan(90);
		expect(text?.endsWith('…"')).toBe(true);
	});
});
