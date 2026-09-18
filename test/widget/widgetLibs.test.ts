import { describe, expect, it } from "vitest";
import { patchVendoredLib, VENDORED_LIB_FORBIDDEN } from "../../src/widget/vendoredLibPatches";
import { resolveWidgetLibs, WIDGET_LIBS } from "../../src/widget/widgetLibs";

const PLOTLY_PATH = "node_modules/plotly.js-gl3d-dist-min/plotly-gl3d.min.js";

describe("widget libraries", () => {
	it("ships Plotly as a self-contained build that defines its global", () => {
		const plotly = WIDGET_LIBS.plotly;
		expect(plotly.global).toBe("Plotly");
		expect(plotly.source.length).toBeGreaterThan(500_000);
		expect(plotly.source).toContain("Plotly");
	});

	it("patches the Plotly build so no dynamic-code construct ships in main.js", () => {
		// The unit-test import is the unpatched file (vitest does not run vite.config's
		// plugins); the build applies exactly this function before inlining it.
		const patched = patchVendoredLib(PLOTLY_PATH, WIDGET_LIBS.plotly.source);
		for (const [, pattern] of VENDORED_LIB_FORBIDDEN) expect(patched).not.toMatch(pattern);
		expect(patched).toContain("globalThis");
		expect(patched.length).toBeLessThan(WIDGET_LIBS.plotly.source.length);
	});

	it("fails loudly when a library changes under a patch", () => {
		expect(() => patchVendoredLib(PLOTLY_PATH, "nothing to patch here")).toThrow(/expected 1 occurrence/);
		expect(() => patchVendoredLib(PLOTLY_PATH, 'new Function("return this")() eval(x)')).toThrow(
			/still contains eval/,
		);
		expect(() => patchVendoredLib("node_modules/other/lib.js", "x")).toThrow(/not a vendored widget library/);
	});

	it("resolves known ids in order, deduplicated, and reports unknown ones", () => {
		const { sources, unknown } = resolveWidgetLibs(["plotly", "nope", "plotly", "other"]);
		expect(sources).toEqual([WIDGET_LIBS.plotly.source]);
		expect(unknown).toEqual(["nope", "other"]);
		expect(resolveWidgetLibs([])).toEqual({ sources: [], unknown: [] });
	});
});
