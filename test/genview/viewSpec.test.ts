import { describe, expect, it } from "vitest";
import { parseViewSpec, viewFileBasename, wrapViewFence } from "../../src/genview/viewSpec";

describe("parseViewSpec", () => {
	it("treats a source without frontmatter as body only", () => {
		const spec = parseViewSpec("\n<div>hi</div>\n");
		expect(spec).toEqual({ queries: {}, libs: [], body: "<div>hi</div>" });
	});

	it("parses title, height and scalar queries", () => {
		const spec = parseViewSpec(
			[
				"---",
				'title: "Tags overview"',
				"height: 320",
				"queries:",
				'  tags: TABLE length(rows) AS n FROM "" GROUP BY file.tags',
				"  recent: LIST SORT file.mtime DESC LIMIT 5",
				"---",
				"<div id=app></div>",
			].join("\n"),
		);
		expect(spec.title).toBe("Tags overview");
		expect(spec.height).toBe(320);
		expect(spec.queries).toEqual({
			tags: 'TABLE length(rows) AS n FROM "" GROUP BY file.tags',
			recent: "LIST SORT file.mtime DESC LIMIT 5",
		});
		expect(spec.body).toBe("<div id=app></div>");
	});

	it("parses block-scalar queries and stops at the next top-level key", () => {
		const spec = parseViewSpec(
			[
				"---",
				"queries:",
				"  tasks: |",
				"    TASK",
				"    WHERE !completed",
				"",
				"    SORT due ASC",
				"  other: LIST",
				"title: After",
				"---",
				"body",
			].join("\n"),
		);
		expect(spec.queries.tasks).toBe("TASK\nWHERE !completed\n\nSORT due ASC");
		expect(spec.queries.other).toBe("LIST");
		expect(spec.title).toBe("After");
	});

	it("ignores unknown keys, comments and invalid heights", () => {
		const spec = parseViewSpec("---\n# comment\nfoo: bar\nheight: tall\ntitle:\n---\nx");
		expect(spec.title).toBeUndefined();
		expect(spec.height).toBeUndefined();
		expect(spec.body).toBe("x");
	});

	it("parses libs as a scalar, a flow list, or a block list", () => {
		expect(parseViewSpec("---\nlibs: plotly\n---\nx").libs).toEqual(["plotly"]);
		expect(parseViewSpec("---\nlibs: plotly, three\n---\nx").libs).toEqual(["plotly", "three"]);
		expect(parseViewSpec('---\nlibs: ["plotly", three]\n---\nx').libs).toEqual(["plotly", "three"]);
		const block = parseViewSpec("---\nlibs:\n  - plotly\n  - 'three'\ntitle: T\n---\nx");
		expect(block.libs).toEqual(["plotly", "three"]);
		expect(block.title).toBe("T");
		expect(parseViewSpec("---\ntitle: T\n---\nx").libs).toEqual([]);
	});

	it("falls back to body-only when the frontmatter never closes", () => {
		const spec = parseViewSpec("---\ntitle: nope\n<div></div>");
		expect(spec.title).toBeUndefined();
		expect(spec.body).toBe("---\ntitle: nope\n<div></div>");
	});
});

describe("wrapViewFence", () => {
	it("wraps in a three-backtick fence by default", () => {
		expect(wrapViewFence("<b>x</b>\n")).toBe("```s2b-view\n<b>x</b>\n```\n");
	});

	it("uses a longer fence when the body contains backtick runs", () => {
		const fenced = wrapViewFence("<script>const s = `a`; /* ``` */</script>");
		expect(fenced.startsWith("````s2b-view\n")).toBe(true);
		expect(fenced.endsWith("\n````\n")).toBe(true);
	});
});

describe("viewFileBasename", () => {
	it("strips characters that are illegal in vault paths", () => {
		expect(viewFileBasename('Tasks: due/overdue? [#1] "now"')).toBe("Tasks due overdue 1 now");
	});

	it("falls back to View", () => {
		expect(viewFileBasename(undefined)).toBe("View");
		expect(viewFileBasename("///")).toBe("View");
	});
});
