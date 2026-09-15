/**
 * Vitest global setup file
 * Runs before all tests
 */

import { afterEach, beforeAll, vi } from "vitest";

// Force UTC timezone for deterministic date/time tests
beforeAll(() => {
	vi.stubEnv("TZ", "UTC");
});

// Mock localStorage for tests that import modules using it
const localStorageMock = {
	getItem: vi.fn().mockReturnValue(null),
	setItem: vi.fn(),
	removeItem: vi.fn(),
	clear: vi.fn(),
	length: 0,
	key: vi.fn().mockReturnValue(null),
};
vi.stubGlobal("localStorage", localStorageMock);

// Reset mocks between tests
afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Note: We don't globally mock Obsidian here.
 *
 * The provider system (src/providers/) has no Obsidian dependencies,
 * so provider tests don't need Obsidian mocks at all.
 *
 * For tests that DO need Obsidian mocks (UI components, tools, etc.),
 * import the mock explicitly in that test file:
 *
 *   import "../__mocks__/obsidian";
 *
 * This keeps tests fast and explicit about their dependencies.
 */

/**
 * Obsidian augments the DOM with global element factories (`createEl`,
 * `createDiv`, `createSpan`, `createFragment`) and a handful of prototype
 * helpers. The plugin uses them instead of raw `document.createElement`, so a
 * minimal stand-in is installed here for the jsdom environment. Only the
 * behaviour the source relies on is modelled.
 */
type DomElementInfoLike = {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, string | number | boolean | null>;
	parent?: Node;
};

function applyDomInfo(el: HTMLElement, info?: DomElementInfoLike | string): void {
	if (typeof info === "string") {
		el.className = info;
		return;
	}
	if (!info) return;
	if (info.cls) el.className = Array.isArray(info.cls) ? info.cls.join(" ") : info.cls;
	if (info.text !== undefined) el.textContent = info.text;
	if (info.attr) {
		for (const [key, value] of Object.entries(info.attr)) {
			if (value !== null) el.setAttribute(key, String(value));
		}
	}
	info.parent?.appendChild(el);
}

function createElPolyfill<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	info?: DomElementInfoLike | string,
	callback?: (el: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	applyDomInfo(el, info);
	callback?.(el);
	return el;
}

// Assigned directly rather than via `vi.stubGlobal` so a test file's
// `vi.unstubAllGlobals()` cannot strip them mid-run.
const domGlobals = globalThis as Record<string, unknown>;
domGlobals.createEl = createElPolyfill;
domGlobals.createDiv = (info?: DomElementInfoLike | string, cb?: (el: HTMLDivElement) => void) =>
	createElPolyfill("div", info, cb);
domGlobals.createSpan = (info?: DomElementInfoLike | string, cb?: (el: HTMLSpanElement) => void) =>
	createElPolyfill("span", info, cb);
domGlobals.createFragment = () => document.createDocumentFragment();

const elementProto = HTMLElement.prototype as HTMLElement & Record<string, unknown>;
const protoHelpers: Record<string, (this: HTMLElement, ...args: never[]) => unknown> = {
	createEl(this: HTMLElement, tag: keyof HTMLElementTagNameMap, info?: DomElementInfoLike | string) {
		const el = createElPolyfill(tag, info);
		this.appendChild(el);
		return el;
	},
	createDiv(this: HTMLElement, info?: DomElementInfoLike | string) {
		const el = createElPolyfill("div", info);
		this.appendChild(el);
		return el;
	},
	createSpan(this: HTMLElement, info?: DomElementInfoLike | string) {
		const el = createElPolyfill("span", info);
		this.appendChild(el);
		return el;
	},
	empty(this: HTMLElement) {
		this.replaceChildren();
	},
	addClass(this: HTMLElement, ...classes: string[]) {
		this.classList.add(...classes);
	},
	removeClass(this: HTMLElement, ...classes: string[]) {
		this.classList.remove(...classes);
	},
	toggleClass(this: HTMLElement, classes: string | string[], value: boolean) {
		for (const cls of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(cls, value);
	},
	setText(this: HTMLElement, text: string) {
		this.textContent = text;
	},
	appendText(this: HTMLElement, text: string) {
		this.appendChild(document.createTextNode(text));
	},
	setCssStyles(this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
		Object.assign(this.style, styles);
	},
	setCssProps(this: HTMLElement, props: Record<string, string>) {
		for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
	},
};
for (const [name, fn] of Object.entries(protoHelpers)) {
	if (!(name in elementProto)) elementProto[name] = fn;
}
if (!("instanceOf" in Node.prototype)) {
	(Node.prototype as unknown as Record<string, unknown>).instanceOf = function (this: Node, type: unknown) {
		return typeof type === "function" && this instanceof type;
	};
}
