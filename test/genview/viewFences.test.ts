import { describe, expect, it } from "vitest";
import { findViewFences, viewFenceAtLine } from "../../src/genview/viewFences";

const NOTE = [
	"# Dashboard",
	"",
	"```s2b-view",
	"---",
	"title: First",
	"---",
	"<p>one</p>",
	"```",
	"",
	"Some prose with ```inline``` backticks.",
	"",
	"````markdown",
	"```s2b-view",
	"<p>this is an example inside a longer fence, not a view</p>",
	"```",
	"````",
	"",
	"~~~s2b-view",
	"<p>two</p>",
	"~~~",
	"",
	"```js",
	"console.log('```s2b-view is just text here');",
	"```",
	"",
	"  ```s2b-view",
	"  <p>three, indented</p>",
	"  ```",
].join("\n");

describe("findViewFences", () => {
	it("finds top-level view fences of either marker and skips nested and foreign ones", () => {
		const fences = findViewFences(NOTE);
		expect(fences.map((f) => f.index)).toEqual([0, 1, 2]);
		expect(fences[0].spec.title).toBe("First");
		expect(fences[0].source).toBe("---\ntitle: First\n---\n<p>one</p>");
		expect(fences[0].lineStart).toBe(2);
		expect(fences[0].lineEnd).toBe(7);
		expect(fences[1].source).toBe("<p>two</p>");
		expect(fences[2].source).toBe("  <p>three, indented</p>");
	});

	it("ignores an unclosed fence", () => {
		expect(findViewFences("```s2b-view\n<p>never closed</p>")).toEqual([]);
	});

	it("returns nothing for notes without views", () => {
		expect(findViewFences("# Just a note\n\n```js\nlet x = 1;\n```")).toEqual([]);
	});
});

describe("viewFenceAtLine", () => {
	it("maps the opening marker's line to its fence", () => {
		expect(viewFenceAtLine(NOTE, 2)?.index).toBe(0);
		expect(viewFenceAtLine(NOTE, 17)?.index).toBe(1);
		expect(viewFenceAtLine(NOTE, 3)).toBeNull();
	});
});
