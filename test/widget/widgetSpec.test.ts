import { describe, expect, it } from "vitest";
import { parseWidgetSpec, widgetFileBasename, widgetIndexText, wrapWidgetFence } from "../../src/widget/widgetSpec";

describe("parseWidgetSpec", () => {
	it("treats a source without frontmatter as body only", () => {
		const spec = parseWidgetSpec("\n<div>hi</div>\n");
		expect(spec).toEqual({ queries: {}, libs: [], body: "<div>hi</div>" });
	});

	it("parses title, height and scalar queries", () => {
		const spec = parseWidgetSpec(
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
		const spec = parseWidgetSpec(
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
		const spec = parseWidgetSpec("---\n# comment\nfoo: bar\nheight: tall\ntitle:\n---\nx");
		expect(spec.title).toBeUndefined();
		expect(spec.height).toBeUndefined();
		expect(spec.body).toBe("x");
	});

	it("parses libs as a scalar, a flow list, or a block list", () => {
		expect(parseWidgetSpec("---\nlibs: plotly\n---\nx").libs).toEqual(["plotly"]);
		expect(parseWidgetSpec("---\nlibs: plotly, three\n---\nx").libs).toEqual(["plotly", "three"]);
		expect(parseWidgetSpec('---\nlibs: ["plotly", three]\n---\nx').libs).toEqual(["plotly", "three"]);
		const block = parseWidgetSpec("---\nlibs:\n  - plotly\n  - 'three'\ntitle: T\n---\nx");
		expect(block.libs).toEqual(["plotly", "three"]);
		expect(block.title).toBe("T");
		expect(parseWidgetSpec("---\ntitle: T\n---\nx").libs).toEqual([]);
	});

	it("falls back to body-only when the frontmatter never closes", () => {
		const spec = parseWidgetSpec("---\ntitle: nope\n<div></div>");
		expect(spec.title).toBeUndefined();
		expect(spec.body).toBe("---\ntitle: nope\n<div></div>");
	});
});

describe("widgetIndexText", () => {
	it("indexes the title and description only, never the body", () => {
		const text = widgetIndexText(
			"---\ntitle: Vault dashboard\ndescription: Edits per day and open tasks\n---\n<div id=app>secret markup</div><script>const x = 1;</script>",
		);
		expect(text).toBe("Vault dashboard\nEdits per day and open tasks");
		expect(text).not.toContain("markup");
	});

	it("is empty for a widget without title or description", () => {
		expect(widgetIndexText("<p>body only</p>")).toBe("");
		expect(parseWidgetSpec("---\ndescription: Only this\n---\nx").description).toBe("Only this");
		expect(parseWidgetSpec("---\nicon: chart-column\n---\nx").icon).toBe("chart-column");
	});
});

describe("wrapWidgetFence", () => {
	it("wraps in a three-backtick fence by default", () => {
		expect(wrapWidgetFence("<b>x</b>\n")).toBe("```s2b-widget\n<b>x</b>\n```\n");
	});

	it("uses a longer fence when the body contains backtick runs", () => {
		const fenced = wrapWidgetFence("<script>const s = `a`; /* ``` */</script>");
		expect(fenced.startsWith("````s2b-widget\n")).toBe(true);
		expect(fenced.endsWith("\n````\n")).toBe(true);
	});
});

describe("widgetFileBasename", () => {
	it("strips characters that are illegal in vault paths", () => {
		expect(widgetFileBasename('Tasks: due/overdue? [#1] "now"')).toBe("Tasks due overdue 1 now");
	});

	it("falls back to Widget", () => {
		expect(widgetFileBasename(undefined)).toBe("Widget");
		expect(widgetFileBasename("///")).toBe("Widget");
	});
});
