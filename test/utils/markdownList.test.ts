import { describe, expect, it } from "vitest";
import { isMarkdownListLineAt } from "../../src/utils/markdownList";

/** Cursor at the end of `text`. */
const atEnd = (text: string) => isMarkdownListLineAt(text, text.length);

describe("isMarkdownListLineAt", () => {
	it.each([
		"- item",
		"* item",
		"+ item",
		"1. item",
		"12) item",
		"- [ ] task",
		"- [x] done",
		"    - nested",
		"\t1. nested",
		"> - quoted",
		"- ",
		"-",
		"1.",
	])("treats %j as a list line", (line) => {
		expect(atEnd(line)).toBe(true);
	});

	it.each(["plain text", "", "-dash", "1.5 apples", "**bold**", "# heading", "---x"])(
		"treats %j as not a list line",
		(line) => {
			expect(atEnd(line)).toBe(false);
		},
	);

	it("reads the whole line the cursor is on, not just the text before it", () => {
		expect(isMarkdownListLineAt("intro\n- item", "intro\n-".length - 1)).toBe(true);
		expect(isMarkdownListLineAt("- item\nplain", 3)).toBe(true);
		expect(isMarkdownListLineAt("- item\nplain", "- item\npl".length)).toBe(false);
	});

	it("ignores list-looking lines inside a fenced code block", () => {
		expect(atEnd("```\n- example")).toBe(false);
		expect(atEnd("~~~ts\n1. step")).toBe(false);
		expect(atEnd("````\n```\n- still code")).toBe(false);
	});

	it("treats lines after a closed fence as normal", () => {
		expect(atEnd("```\ncode\n```\n- item")).toBe(true);
		expect(atEnd("~~~\n```\n~~~\n- item")).toBe(true);
	});
});
