import { describe, expect, it } from "vitest";
import {
	buildThemeCss,
	buildViewSrcdoc,
	parseFrameMessage,
	VIEW_CSP,
	VIEW_RUNTIME_SCRIPT,
} from "../../src/genview/viewFrame";

describe("buildThemeCss", () => {
	it("copies only variables that resolve and records the colour scheme", () => {
		const values: Record<string, string> = { "--text-normal": " #eee ", "--interactive-accent": "#7c3aed" };
		const css = buildThemeCss((name) => values[name] ?? "", true);
		expect(css.startsWith(":root { color-scheme: dark; ")).toBe(true);
		expect(css).toContain("--text-normal: #eee;");
		expect(css).toContain("--interactive-accent: #7c3aed;");
		expect(css).not.toContain("--background-primary");
	});
});

describe("buildViewSrcdoc", () => {
	it("locks the frame down with a CSP and installs the runtime before the body", () => {
		const doc = buildViewSrcdoc("<p id=x>hi</p>", ":root { --a: b; }");
		expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">`);
		expect(doc).toContain('<style id="s2b-theme">:root { --a: b; }</style>');
		expect(doc.indexOf(VIEW_RUNTIME_SCRIPT)).toBeLessThan(doc.indexOf("<p id=x>hi</p>"));
	});

	it("blocks every network source", () => {
		expect(VIEW_CSP).toContain("default-src 'none'");
		expect(VIEW_CSP).not.toMatch(/https?:/);
		expect(VIEW_CSP).not.toContain("connect-src");
	});

	it("keeps the runtime free of template placeholders and script terminators", () => {
		expect(VIEW_RUNTIME_SCRIPT).not.toContain("${");
		expect(VIEW_RUNTIME_SCRIPT).not.toContain("</script");
	});
});

describe("parseFrameMessage", () => {
	it("accepts the four frame messages", () => {
		expect(parseFrameMessage({ s2bView: true, type: "ready" })).toEqual({ type: "ready" });
		expect(parseFrameMessage({ s2bView: true, type: "requery" })).toEqual({ type: "requery" });
		expect(parseFrameMessage({ s2bView: true, type: "resize", height: 240.5 })).toEqual({
			type: "resize",
			height: 240.5,
		});
		expect(parseFrameMessage({ s2bView: true, type: "open-note", path: "a/b.md" })).toEqual({
			type: "open-note",
			path: "a/b.md",
		});
	});

	it("drops untagged, unknown or malformed messages", () => {
		expect(parseFrameMessage({ type: "ready" })).toBeNull();
		expect(parseFrameMessage({ s2bView: true, type: "eval", code: "x" })).toBeNull();
		expect(parseFrameMessage({ s2bView: true, type: "resize", height: "big" })).toBeNull();
		expect(parseFrameMessage({ s2bView: true, type: "resize", height: Number.NaN })).toBeNull();
		expect(parseFrameMessage({ s2bView: true, type: "open-note", path: "" })).toBeNull();
		expect(parseFrameMessage("ready")).toBeNull();
		expect(parseFrameMessage(null)).toBeNull();
	});
});
