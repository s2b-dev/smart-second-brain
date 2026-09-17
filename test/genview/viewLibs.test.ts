import { describe, expect, it } from "vitest";
import { patchVendoredLib, VENDORED_LIB_FORBIDDEN } from "../../src/genview/vendoredLibPatches";
import { resolveViewLibs, VIEW_LIBS } from "../../src/genview/viewLibs";

const PLOTLY_PATH = "node_modules/plotly.js-gl3d-dist-min/plotly-gl3d.min.js";

describe("view libraries", () => {
	it("ships Plotly as a self-contained build that defines its global", () => {
		const plotly = VIEW_LIBS.plotly;
		expect(plotly.global).toBe("Plotly");
		expect(plotly.source.length).toBeGreaterThan(500_000);
		expect(plotly.source).toContain("Plotly");
	});

	it("patches the Plotly build so no dynamic-code construct ships in main.js", () => {
		// The unit-test import is the unpatched file (vitest does not run vite.config's
		// plugins); the build applies exactly this function before inlining it.
		const patched = patchVendoredLib(PLOTLY_PATH, VIEW_LIBS.plotly.source);
		for (const [, pattern] of VENDORED_LIB_FORBIDDEN) expect(patched).not.toMatch(pattern);
		expect(patched).toContain("globalThis");
		expect(patched.length).toBeLessThan(VIEW_LIBS.plotly.source.length);
	});

	it("fails loudly when a library changes under a patch", () => {
		expect(() => patchVendoredLib(PLOTLY_PATH, "nothing to patch here")).toThrow(/expected 1 occurrence/);
		expect(() => patchVendoredLib(PLOTLY_PATH, 'new Function("return this")() eval(x)')).toThrow(
			/still contains eval/,
		);
		expect(() => patchVendoredLib("node_modules/other/lib.js", "x")).toThrow(/not a vendored view library/);
	});

	it("resolves known ids in order, deduplicated, and reports unknown ones", () => {
		const { sources, unknown } = resolveViewLibs(["plotly", "nope", "plotly", "other"]);
		expect(sources).toEqual([VIEW_LIBS.plotly.source]);
		expect(unknown).toEqual(["nope", "other"]);
		expect(resolveViewLibs([])).toEqual({ sources: [], unknown: [] });
	});
});
