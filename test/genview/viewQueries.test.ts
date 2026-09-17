import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DATAVIEW_MISSING_ERROR, runViewQueries, serializeDataviewValue } from "../../src/genview/viewQueries";

function appWithDataview(api: unknown): App {
	return { plugins: { plugins: api ? { dataview: { api } } : {} } } as unknown as App;
}

describe("serializeDataviewValue", () => {
	it("flattens links, luxon values and DataArray proxies", () => {
		const link = { path: "Notes/Alpha.md", display: undefined, subpath: undefined, embed: false, type: "file" };
		const date = { isLuxonDateTime: true, toISO: () => "2026-09-17T00:00:00.000Z" };
		const duration = { isLuxonDuration: true, toISO: () => "PT2H" };
		const dataArray = { length: 2, array: () => [1, link] };
		expect(serializeDataviewValue({ link, date, duration, dataArray })).toEqual({
			link: { path: "Notes/Alpha.md", display: "Alpha", subpath: null },
			date: "2026-09-17T00:00:00.000Z",
			duration: "PT2H",
			dataArray: [1, { path: "Notes/Alpha.md", display: "Alpha", subpath: null }],
		});
	});

	it("keeps JSON scalars and nulls out what cannot cross postMessage", () => {
		expect(serializeDataviewValue([1, "a", true, null, undefined, Number.NaN, () => 1, Symbol("s"), 10n])).toEqual([
			1,
			"a",
			true,
			null,
			null,
			null,
			null,
			null,
			"10",
		]);
	});

	it("caps nesting depth instead of recursing forever", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const out = serializeDataviewValue(cyclic) as Record<string, unknown>;
		let depth = 0;
		let cursor: unknown = out;
		while (cursor && typeof cursor === "object") {
			cursor = (cursor as Record<string, unknown>).self;
			depth++;
		}
		expect(depth).toBeGreaterThan(1);
		expect(depth).toBeLessThanOrEqual(7);
	});

	it("caps array length", () => {
		const out = serializeDataviewValue(Array.from({ length: 1500 }, (_, i) => i)) as unknown[];
		expect(out).toHaveLength(1000);
	});
});

describe("runViewQueries", () => {
	it("returns nothing for a view without queries and never touches Dataview", async () => {
		expect(await runViewQueries(appWithDataview(null), {}, "x.md")).toEqual({});
	});

	it("reports a missing Dataview plugin per query", async () => {
		const results = await runViewQueries(appWithDataview(null), { a: "LIST", b: "TABLE" }, "x.md");
		expect(results).toEqual({ a: { error: DATAVIEW_MISSING_ERROR }, b: { error: DATAVIEW_MISSING_ERROR } });
	});

	it("maps table and list results and isolates failures per query", async () => {
		const query = vi.fn(async (source: string) => {
			if (source.startsWith("TABLE")) {
				return {
					successful: true,
					value: {
						type: "table",
						headers: ["File", "n"],
						values: [[{ path: "A.md", subpath: undefined, embed: false }, 3]],
					},
				};
			}
			if (source.startsWith("LIST")) {
				return { successful: true, value: { type: "list", values: { length: 1, array: () => ["x"] } } };
			}
			if (source.startsWith("BOOM")) throw new Error("kaboom");
			return { successful: false, error: "  bad query " };
		});
		const results = await runViewQueries(
			appWithDataview({ query }),
			{ t: "TABLE n FROM #x", l: "LIST", e: "BOOM", f: "nope" },
			"Notes/origin.md",
		);
		expect(results).toEqual({
			t: { type: "table", headers: ["File", "n"], rows: [[{ path: "A.md", display: "A", subpath: null }, 3]] },
			l: { type: "list", items: ["x"] },
			e: { error: "kaboom" },
			f: { error: "bad query" },
		});
		expect(query).toHaveBeenCalledWith("TABLE n FROM #x", "Notes/origin.md");
	});
});
