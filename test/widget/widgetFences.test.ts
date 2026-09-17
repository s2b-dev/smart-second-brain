import { describe, expect, it } from "vitest";
import { findWidgetFences, stripWidgetFences } from "../../src/widget/widgetFences";

const NOTE = [
	"# Dashboard",
	"",
	"```s2b-widget",
	"---",
	"title: First",
	"---",
	"<p>one</p>",
	"```",
	"",
	"Some prose with ```inline``` backticks.",
	"",
	"````markdown",
	"```s2b-widget",
	"<p>this is an example inside a longer fence, not a widget</p>",
	"```",
	"````",
	"",
	"~~~s2b-widget",
	"<p>two</p>",
	"~~~",
	"",
	"```js",
	"console.log('```s2b-widget is just text here');",
	"```",
	"",
	"  ```s2b-widget",
	"  <p>three, indented</p>",
	"  ```",
].join("\n");

describe("findWidgetFences", () => {
	it("finds top-level widget fences of either marker and skips nested and foreign ones", () => {
		const fences = findWidgetFences(NOTE);
		expect(fences.map((f) => f.index)).toEqual([0, 1, 2]);
		expect(fences[0].spec.title).toBe("First");
		expect(fences[0].source).toBe("---\ntitle: First\n---\n<p>one</p>");
		expect(fences[0].lineStart).toBe(2);
		expect(fences[0].lineEnd).toBe(7);
		expect(fences[1].source).toBe("<p>two</p>");
		expect(fences[2].source).toBe("  <p>three, indented</p>");
	});

	it("ignores an unclosed fence", () => {
		expect(findWidgetFences("```s2b-widget\n<p>never closed</p>")).toEqual([]);
	});

	it("returns nothing for notes without widgets", () => {
		expect(findWidgetFences("# Just a note\n\n```js\nlet x = 1;\n```")).toEqual([]);
	});
});

describe("stripWidgetFences", () => {
	it("replaces each fence with a titled marker and leaves the rest untouched", () => {
		const stripped = stripWidgetFences(NOTE);
		expect(stripped).not.toContain("<p>one</p>");
		expect(stripped).not.toContain("<p>two</p>");
		expect(stripped).toContain("(widget: First)");
		expect(stripped).toContain("(widget)");
		// Content that only looked like a fence (nested, or inside a js block) stays.
		expect(stripped).toContain("this is an example inside a longer fence");
		expect(stripped).toContain("console.log('```s2b-widget is just text here');");
		expect(stripped.startsWith("# Dashboard\n\n(widget: First)\n\nSome prose")).toBe(true);
	});

	it("returns the input unchanged when there is nothing to strip", () => {
		const note = "# Just a note\n\n```js\nlet x = 1;\n```";
		expect(stripWidgetFences(note)).toBe(note);
	});
});
