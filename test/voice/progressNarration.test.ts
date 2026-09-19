import { describe, expect, it } from "vitest";
import { describeProgress } from "../../src/voice/progressNarration";

describe("describeProgress", () => {
	it("uses the model's own lead-in when there is one", () => {
		expect(describeProgress({ toolName: "search_notes", preamble: "Let me look for last week's todos." })).toEqual({
			text: "Let me look for last week's todos.",
			isLeadIn: true,
		});
	});

	it("names the concrete detail from the tool input", () => {
		expect(describeProgress({ toolName: "search_notes", input: { query: "todos last week" } })).toEqual({
			text: 'Searching the notes for "todos last week"',
			isLeadIn: false,
		});
		expect(
			describeProgress({ toolName: "read_content", input: { path: "Journal/2026-09-12 Weekly.md" } })?.text,
		).toBe('Reading "2026-09-12 Weekly"');
		expect(describeProgress({ toolName: "grep_notes", input: { pattern: "- [ ]" } })?.text).toBe(
			'Looking through note text for "- [ ]"',
		);
		expect(describeProgress({ toolName: "fetch_url", input: { url: "https://www.example.org/a/b" } })?.text).toBe(
			"Reading a page from example.org",
		);
		expect(
			describeProgress({ toolName: "get_properties", input: { note_name: "Projects/Roadmap.md" } })?.text,
		).toBe('Checking the properties of "Roadmap"');
		expect(describeProgress({ toolName: "manage_notes", input: { operations: [] } })?.text).toBe(
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
		const text = describeProgress({ toolName: "web_search", input: { query: long } })?.text;
		expect(text?.length).toBeLessThan(90);
		expect(text?.endsWith('…"')).toBe(true);
	});
});
