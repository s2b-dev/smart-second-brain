import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import postcss, { type AcceptedPlugin } from "postcss";
import { compile } from "svelte/compiler";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import config from "../../tailwind.config.js";

/**
 * Plugin stylesheets are global in Obsidian: every rule S2B ships applies to every plugin's
 * DOM. A rule keyed on a bare class name is therefore a rule on another plugin's elements as
 * soon as they use the same name — `.static{position:static}` blanked Excalidraw's drawings
 * (#558). Every shipped rule must name an `s2b-` class (Tailwind utilities via the `s2b-`
 * prefix, hand-written classes by convention) or carry a Svelte scope hash, so a selector can
 * only match an element S2B itself rendered, or a descendant of one.
 */
const PREFIX = "s2b-";

async function compileUtilities(): Promise<postcss.Root> {
	// Tailwind depends on its own copy of postcss, whose plugin type is nominally distinct.
	const plugin = tailwindcss(config) as unknown as AcceptedPlugin;
	const result = await postcss([plugin]).process("@tailwind base;\n@tailwind components;\n@tailwind utilities;", {
		from: undefined,
	});
	return result.root;
}

/** The utility part of a class name: `hover:!-s2b-mt-2` → `s2b-mt-2`, `[&_p]:s2b-m-0` → `s2b-m-0`. */
function utilityPart(className: string): string {
	let depth = 0;
	let lastColon = -1;
	for (let i = 0; i < className.length; i++) {
		const c = className[i];
		if (c === "[") depth++;
		else if (c === "]") depth--;
		else if (c === ":" && depth === 0) lastColon = i;
	}
	return className.slice(lastColon + 1).replace(/^!?-?/, "");
}

/** Class names in a selector, unescaped: `.hover\:s2b-x:hover` → `hover:s2b-x`. */
function classNames(selector: string): string[] {
	return [...selector.matchAll(/\.((?:\\[0-9a-fA-F]{1,6} ?|\\.|[\w-])+)/g)].map((m) =>
		m[1].replace(/\\([0-9a-fA-F]{1,6}) ?|\\(.)/g, (_, hex: string | undefined, ch: string | undefined) =>
			hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : (ch ?? ""),
		),
	);
}

/** A class that only S2B's own elements carry: an `s2b-` class or utility, or a Svelte scope hash. */
function isScopingClass(name: string): boolean {
	return utilityPart(name).startsWith(PREFIX) || /^svelte-[a-z0-9]+$/.test(name);
}

/**
 * A selector that can only match S2B's own elements: one naming an S2B class, or a
 * `::highlight()` of a Custom Highlight S2B registered (it styles only ranges S2B added to it).
 */
function isScopedSelector(selector: string): boolean {
	return classNames(selector).some(isScopingClass) || new RegExp(`::highlight\\(${PREFIX}`).test(selector);
}

function insideScopedRule(rule: postcss.Rule): boolean {
	let node: postcss.Node | undefined = rule.parent as postcss.Node | undefined;
	while (node && node.type !== "rule") node = node.parent as postcss.Node | undefined;
	if (!node) return false;
	const parent = node as postcss.Rule;
	return parent.selectors.every(isScopedSelector) || insideScopedRule(parent);
}

/** Selectors (of style rules, not keyframe steps) none of whose classes is S2B's own. */
function unscopedSelectors(root: postcss.Root): string[] {
	const unscoped: string[] = [];
	root.walkRules((rule) => {
		if (rule.parent?.type === "atrule" && /keyframes$/.test((rule.parent as postcss.AtRule).name)) return;
		// A rule nested in a scoped rule (native CSS nesting, which Svelte keeps) only matches
		// inside the parent's elements, whatever its own selector.
		if (insideScopedRule(rule)) return;
		for (const selector of rule.selectors) {
			if (!isScopedSelector(selector)) unscoped.push(selector);
		}
	});
	return unscoped;
}

/** Keyframes that could replace, or be replaced by, another plugin's animation of the same name. */
function unscopedKeyframes(root: postcss.Root): string[] {
	const names: string[] = [];
	root.walkAtRules(/keyframes$/, (rule) => {
		if (!rule.params.startsWith(PREFIX) && !/^svelte-[a-z0-9]+-/.test(rule.params)) names.push(rule.params);
	});
	return names;
}

/** Every Svelte component's compiled CSS, keyed by file — what Vite appends to styles.css. */
function componentStylesheets(): [string, postcss.Root][] {
	const files = execSync("git ls-files 'src/*.svelte'", { encoding: "utf8" }).trim().split("\n");
	return files.flatMap((file): [string, postcss.Root][] => {
		const { css } = compile(readFileSync(file, "utf8"), { filename: file, css: "external" });
		return css ? [[file, postcss.parse(css.code)]] : [];
	});
}

describe("shipped Tailwind utilities", () => {
	it("scopes every rule to an element carrying an s2b- class", async () => {
		const root = await compileUtilities();
		// Sanity: the scan found the sources at all.
		expect(root.toString()).toContain(".s2b-flex");
		expect(unscopedSelectors(root)).toEqual([]);
	});

	it("does not emit generic class names another plugin may use (#558)", async () => {
		const css = (await compileUtilities()).toString();
		for (const name of ["static", "flex", "relative", "absolute", "block", "hidden", "group", "truncate"]) {
			expect(css).not.toMatch(new RegExp(`\\.${name}(?![\\w-])`));
		}
	});

	it("prefixes keyframes so they cannot replace another plugin's animation", async () => {
		const root = await compileUtilities();
		expect(root.toString()).toContain("@keyframes s2b-");
		expect(unscopedKeyframes(root)).toEqual([]);
	});

	it("flags an unprefixed arbitrary property, which Tailwind cannot prefix", () => {
		const root = postcss.parse(".\\[overflow-wrap\\:anywhere\\] { overflow-wrap: anywhere }");
		expect(unscopedSelectors(root)).toEqual([".\\[overflow-wrap\\:anywhere\\]"]);
	});
});

describe("hand-written styles", () => {
	it("scopes every rule in src/styles.css to an s2b- class", () => {
		const root = postcss.parse(readFileSync("src/styles.css", "utf8"));
		expect(unscopedSelectors(root)).toEqual([]);
		expect(unscopedKeyframes(root)).toEqual([]);
	});

	it("scopes every Svelte rule, :global() ones included, to an s2b- class or the component", () => {
		const sheets = componentStylesheets();
		// Sanity: the components were found and compiled.
		expect(sheets.length).toBeGreaterThan(20);
		const unscoped = sheets.flatMap(([file, root]) => [
			...unscopedSelectors(root).map((selector) => `${file}: ${selector}`),
			...unscopedKeyframes(root).map((name) => `${file}: @keyframes ${name}`),
		]);
		expect(unscoped).toEqual([]);
	});

	it("flags a :global() rule on a bare class and a :root variable override", () => {
		const { css } = compile(
			"<div class='x'></div><style>:global(.chat-root) { color: red } :global(:root) { --icon-xs: 1px } .x { color: blue }</style>",
			{
				filename: "Probe.svelte",
				css: "external",
			},
		);
		expect(unscopedSelectors(postcss.parse(css?.code ?? ""))).toEqual([".chat-root", ":root"]);
	});
});
