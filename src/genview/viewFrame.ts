/**
 * The frame a view renders in, and the bridge between it and the host.
 *
 * A view is model-written HTML and JavaScript. On desktop the Obsidian renderer has
 * Node integration, so that code must never run in Obsidian's own document: it runs in
 * an `<iframe sandbox="allow-scripts" srcdoc>` — opaque origin, no parent DOM, no Node —
 * under a Content-Security-Policy that allows nothing but inline script and style. That
 * CSP is what makes it safe to post vault data into the frame: a sandboxed frame could
 * otherwise still `fetch()` it out.
 *
 * ## Two frames, not one
 *
 * CSP governs what a document *loads*, not where it *navigates*: a sandboxed frame may
 * still set `location.href` to an external URL with the data it received in the query
 * string, and no policy inside that document stops it. What does stop it is the
 * `frame-src` of the document that *contains* the frame — navigations of a nested
 * browsing context are checked against the parent's policy, before any request is made
 * (verified in Obsidian's Electron: the `securitypolicyviolation` event fires on the
 * parent with `violatedDirective: frame-src` and the target URL as `blockedURI`). Obsidian's
 * own document has no CSP and must not get one (it would break every other plugin's
 * iframes), so the view is wrapped in a trusted **outer** frame — plugin code only, with
 * `frame-src 'none'` — that hosts the model-written **inner** frame. `about:srcdoc` is
 * exempt from `frame-src`, so the inner still loads; anything it navigates to is refused.
 *
 * The outer frame relays the bridge in both directions and, as a backstop, treats any
 * `load` of the inner frame after it reported `ready` as a navigation: it drops the frame
 * and tells the host, which stops posting data and shows why.
 *
 * ## Bridge
 *
 * Both directions are `postMessage` with a fixed, tagged shape (`s2bView: true`).
 * Host → view: `data` (query results) and `theme` (CSS variables). View → host: `ready`,
 * `resize`, `open-note`, `requery`; outer → host additionally `navigated`. Every hop
 * checks `event.source` against the one window it accepts from. Nothing else crosses.
 *
 * Known residual: hostname-based side channels that CSP does not govern (DNS prefetch
 * hints). `x-dns-prefetch-control: off` is set in the inner document; a view is still
 * model-authored code and should be treated with the same trust as the agent's tools.
 */

/**
 * DOM event a rendered view dispatches (bubbling) on its block once its document
 * reported `ready`; the frame also gets `data-s2b-view-ready`. The chat renderer uses
 * both to hold a settling document off-screen until its views are showing.
 */
export const VIEW_READY_EVENT = "s2b-view-ready";

/** Inner (view) document: only inline script/style and data/blob media; no network, no navigation targets. */
export const VIEW_CSP =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";

/**
 * Space between the card border and the view's content, in px. Lives in the trusted outer
 * document — a view's own `body { padding: 0 }` (which models write reflexively) cannot
 * remove it — so the host adds twice this to every content height it applies to the frame.
 */
export const VIEW_FRAME_PADDING_PX = 12;

/** Outer (relay) document: inline script/style only, and no frame may be navigated anywhere. */
export const OUTER_FRAME_CSP =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/** Obsidian CSS variables copied into the frame so a view tracks the user's theme. */
export const THEME_VARIABLES: readonly string[] = [
	"--background-primary",
	"--background-primary-alt",
	"--background-secondary",
	"--background-secondary-alt",
	"--background-modifier-border",
	"--background-modifier-hover",
	"--background-modifier-error",
	"--background-modifier-success",
	"--interactive-normal",
	"--interactive-hover",
	"--interactive-accent",
	"--interactive-accent-hover",
	"--text-normal",
	"--text-muted",
	"--text-faint",
	"--text-accent",
	"--text-accent-hover",
	"--text-on-accent",
	"--text-error",
	"--text-success",
	"--text-warning",
	"--text-highlight-bg",
	"--color-red",
	"--color-orange",
	"--color-yellow",
	"--color-green",
	"--color-cyan",
	"--color-blue",
	"--color-purple",
	"--color-pink",
	"--font-interface",
	"--font-text",
	"--font-monospace",
	"--font-ui-smaller",
	"--font-ui-small",
	"--font-ui-medium",
	"--font-ui-large",
	"--font-text-size",
	"--font-smallest",
	"--font-smaller",
	"--font-small",
	"--radius-s",
	"--radius-m",
	"--radius-l",
	"--size-2-1",
	"--size-2-2",
	"--size-2-3",
	"--size-4-1",
	"--size-4-2",
	"--size-4-3",
	"--size-4-4",
	"--size-4-6",
	"--size-4-8",
	"--input-height",
];

/** Build the `:root` rule injected into the frame. `read` resolves one variable's computed value. */
export function buildThemeCss(read: (name: string) => string, dark: boolean): string {
	const declarations = [`color-scheme: ${dark ? "dark" : "light"}`];
	for (const name of THEME_VARIABLES) {
		const value = read(name).trim();
		if (value) declarations.push(`${name}: ${value}`);
	}
	return `:root { ${declarations.join("; ")}; }`;
}

/** Read the live theme from Obsidian's document body. */
export function collectThemeCss(doc: Document = document): string {
	const style = getComputedStyle(doc.body);
	return buildThemeCss((name) => style.getPropertyValue(name), doc.body.classList.contains("theme-dark"));
}

/**
 * The script that runs first inside every view document. It installs the `s2b` global
 * the view's own code talks to, listens for relayed host messages, and reports its
 * content height so the host can size the frame. `ready` is sent from the window's
 * `load` event on purpose: the outer frame treats any load after `ready` as a
 * navigation, so `ready` must not precede the document's own load. Kept
 * dependency-free and free of `${}` so it can be a plain template literal.
 */
export const VIEW_RUNTIME_SCRIPT = `
(() => {
	const listeners = [];
	let data = null;
	const send = (message) => {
		window.parent.postMessage(Object.assign({ s2bView: true }, message), "*");
	};
	window.s2b = {
		get data() {
			return data;
		},
		onData(callback) {
			listeners.push(callback);
			if (data !== null) callback(data);
		},
		openNote(path) {
			send({ type: "open-note", path: String(path) });
		},
		refresh() {
			send({ type: "requery" });
		},
	};
	window.addEventListener("message", (event) => {
		if (event.source !== window.parent) return;
		const message = event.data;
		if (!message || message.s2bView !== true) return;
		if (message.type === "data") {
			data = message.data;
			for (const callback of listeners) {
				try {
					callback(data);
				} catch (error) {
					console.error(error);
				}
			}
		} else if (message.type === "theme") {
			const style = document.getElementById("s2b-theme");
			if (style) style.textContent = message.css;
		}
	});
	let lastHeight = -1;
	// In auto-height mode html/body are forced to content height (see AUTO_HEIGHT_CSS),
	// so the body's box is the content's box; scrollHeight also counts overflowing
	// children. Body is not the scrolling element, so neither has the viewport floor.
	const contentHeight = () => {
		const body = document.body;
		if (!body) return document.documentElement.offsetHeight;
		const style = getComputedStyle(body);
		return (
			Math.max(body.offsetHeight, body.scrollHeight) +
			parseFloat(style.marginTop || "0") +
			parseFloat(style.marginBottom || "0")
		);
	};
	// The bottom edge of what is actually drawn: for a declared height the host shrinks
	// the frame to this when it is shorter (an over-estimated height would otherwise show
	// as empty space), while percentage-sized children fill the frame and keep it.
	const contentExtent = () => {
		const body = document.body;
		if (!body) return 0;
		let bottom = 0;
		for (const child of body.children) {
			const rect = child.getBoundingClientRect();
			if (rect.height > 0 || rect.width > 0) bottom = Math.max(bottom, rect.bottom + window.scrollY);
		}
		const style = getComputedStyle(body);
		return bottom + parseFloat(style.paddingBottom || "0") + parseFloat(style.marginBottom || "0");
	};
	let lastExtent = -1;
	const reportHeight = () => {
		const height = Math.ceil(contentHeight());
		const extent = Math.ceil(contentExtent());
		if (height === lastHeight && extent === lastExtent) return;
		lastHeight = height;
		lastExtent = extent;
		send({ type: "resize", height, extent });
	};
	// With a declared height the body keeps the frame's size, so a resize observer on
	// html/body alone never fires again once content is built (typically after data
	// arrives). Watch the body's children as well, follow DOM mutations to pick up
	// new ones, and measure on the next frame after any mutation.
	let measureFrame = 0;
	const scheduleMeasure = () => {
		if (measureFrame) return;
		measureFrame = requestAnimationFrame(() => {
			measureFrame = 0;
			reportHeight();
		});
	};
	const observe = () => {
		const sizes = new ResizeObserver(scheduleMeasure);
		sizes.observe(document.documentElement);
		const body = document.body;
		if (body) {
			sizes.observe(body);
			const watchChildren = () => {
				for (const child of body.children) sizes.observe(child);
			};
			watchChildren();
			new MutationObserver(() => {
				watchChildren();
				scheduleMeasure();
			}).observe(body, { childList: true, subtree: true, attributes: true, characterData: true });
		}
		reportHeight();
	};
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", observe);
	} else {
		observe();
	}
	window.addEventListener("load", () => {
		reportHeight();
		send({ type: "ready" });
	});
})();
`;

/**
 * Applied in auto-height mode: the base style (and views themselves, with `height: 100%`
 * or `min-height: 100vh`) size html/body to the frame, which inside a frame equals its
 * current height and would keep it from ever shrinking to short content (and would make
 * percentage-sized children fill the frame instead of their content). With a declared
 * `height` percentage layouts are the point, so this is left out.
 */
export const AUTO_HEIGHT_CSS =
	"html, body { height: auto !important; min-height: 0 !important; max-height: none !important; }";

/**
 * Make arbitrary JavaScript safe to place inside an inline `<script>`: the only sequence
 * that can end the element early is `</script`, and `<\/script` is the same text to the
 * JavaScript parser in every context (string, regex, comment) where a bundle could carry it.
 */
export function escapeInlineScript(source: string): string {
	return source.replace(/<\/script/gi, "<\\/script");
}

/**
 * The inner document: CSP, theme, base styles, runtime, the requested libraries, then
 * the view's own body. Libraries are inlined whole (see `viewLibs.ts`); a sandboxed frame
 * has nowhere else to load them from.
 */
export function buildViewSrcdoc(
	body: string,
	themeCss: string,
	libSources: readonly string[] = [],
	autoHeight = true,
): string {
	const libScripts = libSources.map((source) => `<script>${escapeInlineScript(source)}</script>`).join("\n");
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">
<meta http-equiv="x-dns-prefetch-control" content="off">
<style id="s2b-theme">${themeCss}</style>
<style>
/* Full height so a declared \`height\` lets percentage-sized children fill the frame; auto mode overrides this below. */
html, body { margin: 0; padding: 0; height: 100%; }
body {
	box-sizing: border-box;
	background: var(--background-primary, transparent);
	color: var(--text-normal, inherit);
	font-family: var(--font-interface, system-ui, sans-serif);
	font-size: var(--font-ui-medium, 15px);
	line-height: 1.4;
}
*, *::before, *::after { box-sizing: inherit; }
a { color: var(--text-accent, inherit); cursor: pointer; }
${autoHeight ? AUTO_HEIGHT_CSS : ""}
</style>
<script>${VIEW_RUNTIME_SCRIPT}</script>
${libScripts}
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * The outer document's script: creates the inner frame from the embedded `INNER`
 * srcdoc, relays bridge messages between the host and the inner frame, and retires
 * the inner frame on any load after `ready` (a navigation the CSP backstop did not
 * catch). Free of `${}`; `INNER` is defined by {@link buildViewFrameSrcdoc}.
 */
export const OUTER_RELAY_SCRIPT = `
(() => {
	let ready = false;
	let retired = false;
	const toHost = (message) => {
		window.parent.postMessage(message, "*");
	};
	const frame = document.createElement("iframe");
	frame.setAttribute("sandbox", "allow-scripts");
	frame.setAttribute("referrerpolicy", "no-referrer");
	frame.addEventListener("load", () => {
		if (!ready || retired) return;
		retired = true;
		frame.remove();
		toHost({ s2bView: true, type: "navigated" });
	});
	window.addEventListener("message", (event) => {
		const message = event.data;
		if (retired || !message || message.s2bView !== true) return;
		if (event.source === window.parent) {
			if (frame.contentWindow) frame.contentWindow.postMessage(message, "*");
		} else if (event.source === frame.contentWindow) {
			if (message.type === "ready") ready = true;
			toHost(message);
		}
	});
	frame.srcdoc = INNER;
	document.body.appendChild(frame);
})();
`;

/** Embed a string in a script as a literal that cannot terminate the surrounding `<script>`. */
function scriptStringLiteral(value: string): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The full `srcdoc` for a view: the trusted outer relay frame wrapping the inner view document. */
export function buildViewFrameSrcdoc(
	body: string,
	themeCss: string,
	libSources: readonly string[] = [],
	autoHeight = true,
): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${OUTER_FRAME_CSP}">
<style>
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: transparent; }
body { box-sizing: border-box; padding: ${VIEW_FRAME_PADDING_PX}px; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<script>const INNER = ${scriptStringLiteral(buildViewSrcdoc(body, themeCss, libSources, autoHeight))};${OUTER_RELAY_SCRIPT}</script>
</body>
</html>`;
}

export type FrameToHostMessage =
	| { type: "ready" }
	| { type: "resize"; height: number; extent: number }
	| { type: "open-note"; path: string }
	| { type: "requery" }
	| { type: "navigated" };

/** Validate a `message` event payload from a frame. Anything off-shape is dropped. */
export function parseFrameMessage(data: unknown): FrameToHostMessage | null {
	if (typeof data !== "object" || data === null) return null;
	const message = data as Record<string, unknown>;
	if (message.s2bView !== true) return null;
	switch (message.type) {
		case "ready":
		case "requery":
		case "navigated":
			return { type: message.type };
		case "resize": {
			const { height, extent } = message;
			if (typeof height !== "number" || !Number.isFinite(height)) return null;
			const validExtent = typeof extent === "number" && Number.isFinite(extent) ? extent : height;
			return { type: "resize", height, extent: validExtent };
		}
		case "open-note":
			return typeof message.path === "string" && message.path.length > 0
				? { type: "open-note", path: message.path }
				: null;
		default:
			return null;
	}
}
