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
 * Both directions of the bridge are `postMessage` with a fixed, tagged shape
 * (`s2bView: true`). Host → frame: `data` (query results) and `theme` (CSS variables).
 * Frame → host: `ready`, `resize`, `open-note`, `requery`. The host verifies
 * `event.source` against the frame's window; the frame verifies `event.source` against
 * `parent`. Nothing else crosses.
 */

/** Allows only inline script/style and data/blob images; blocks every network request. */
export const VIEW_CSP =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

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
 * The script that runs first inside every frame. It installs the `s2b` global the view's
 * own code talks to, listens for host messages, and reports its content height so the
 * host can size the frame. Kept dependency-free and free of `${}` so it can be a plain
 * template literal.
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
	const reportHeight = () => {
		const height = Math.ceil(
			Math.max(document.documentElement.offsetHeight, document.body ? document.body.offsetHeight : 0),
		);
		if (height === lastHeight) return;
		lastHeight = height;
		send({ type: "resize", height });
	};
	const observe = () => {
		const observer = new ResizeObserver(reportHeight);
		observer.observe(document.documentElement);
		if (document.body) observer.observe(document.body);
		reportHeight();
	};
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", observe);
	} else {
		observe();
	}
	window.addEventListener("load", reportHeight);
	send({ type: "ready" });
})();
`;

/** The full `srcdoc` for a view: CSP, theme, base styles, runtime, then the view's own body. */
export function buildViewSrcdoc(body: string, themeCss: string): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">
<style id="s2b-theme">${themeCss}</style>
<style>
html, body { margin: 0; padding: 0; height: auto; }
body {
	box-sizing: border-box;
	padding: var(--size-4-3, 12px);
	background: var(--background-primary, transparent);
	color: var(--text-normal, inherit);
	font-family: var(--font-interface, system-ui, sans-serif);
	font-size: var(--font-ui-medium, 15px);
	line-height: 1.4;
}
*, *::before, *::after { box-sizing: inherit; }
a { color: var(--text-accent, inherit); cursor: pointer; }
</style>
<script>${VIEW_RUNTIME_SCRIPT}</script>
</head>
<body>
${body}
</body>
</html>`;
}

export type FrameToHostMessage =
	| { type: "ready" }
	| { type: "resize"; height: number }
	| { type: "open-note"; path: string }
	| { type: "requery" };

/** Validate a `message` event payload from a frame. Anything off-shape is dropped. */
export function parseFrameMessage(data: unknown): FrameToHostMessage | null {
	if (typeof data !== "object" || data === null) return null;
	const message = data as Record<string, unknown>;
	if (message.s2bView !== true) return null;
	switch (message.type) {
		case "ready":
		case "requery":
			return { type: message.type };
		case "resize":
			return typeof message.height === "number" && Number.isFinite(message.height)
				? { type: "resize", height: message.height }
				: null;
		case "open-note":
			return typeof message.path === "string" && message.path.length > 0
				? { type: "open-note", path: message.path }
				: null;
		default:
			return null;
	}
}
