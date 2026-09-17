import { describe, expect, it } from "vitest";
import { resolveViewLibs, VIEW_LIBS } from "../../src/genview/viewLibs";

describe("view libraries", () => {
	it("ships Plotly as a self-contained build that defines its global", () => {
		const plotly = VIEW_LIBS.plotly;
		expect(plotly.global).toBe("Plotly");
		expect(plotly.source.length).toBeGreaterThan(500_000);
		expect(plotly.source).toContain("Plotly");
		// A bundle must not reach for the network on its own.
		expect(plotly.source).not.toMatch(/importScripts\(\s*["']https?:/);
	});

	it("resolves known ids in order, deduplicated, and reports unknown ones", () => {
		const { sources, unknown } = resolveViewLibs(["plotly", "nope", "plotly", "other"]);
		expect(sources).toEqual([VIEW_LIBS.plotly.source]);
		expect(unknown).toEqual(["nope", "other"]);
		expect(resolveViewLibs([])).toEqual({ sources: [], unknown: [] });
	});
});
