import { describe, expect, it } from "vitest";
import { isMarkdownListLine } from "../../src/utils/markdownList";

describe("isMarkdownListLine", () => {
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
		expect(isMarkdownListLine(line)).toBe(true);
	});

	it.each(["plain text", "", "-dash", "1.5 apples", "**bold**", "# heading", "---x"])(
		"treats %j as not a list line",
		(line) => {
			expect(isMarkdownListLine(line)).toBe(false);
		},
	);
});
