import postcss, { type AcceptedPlugin } from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import config from "../../tailwind.config.js";

/**
 * Plugin stylesheets are global in Obsidian: every rule S2B ships applies to every plugin's
 * DOM. An unprefixed Tailwind utility is therefore a rule on another plugin's elements as soon
 * as they use the same class name — `.static{position:static}` blanked Excalidraw's drawings
 * (#558). Every utility carries the `s2b-` prefix, so a selector can only match an element
 * that S2B itself put an `s2b-` class on (or a descendant of one, for `[&_p]:…` variants).
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

/** Selectors (of style rules, not keyframe steps) none of whose classes is an `s2b-` utility. */
function unscopedSelectors(root: postcss.Root): string[] {
	const unscoped: string[] = [];
	root.walkRules((rule) => {
		if (rule.parent?.type === "atrule" && /keyframes$/.test((rule.parent as postcss.AtRule).name)) return;
		for (const selector of rule.selectors) {
			if (!classNames(selector).some((name) => utilityPart(name).startsWith(PREFIX))) unscoped.push(selector);
		}
	});
	return unscoped;
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
		const keyframes: string[] = [];
		root.walkAtRules(/keyframes$/, (rule) => {
			keyframes.push(rule.params);
		});
		expect(keyframes.length).toBeGreaterThan(0);
		expect(keyframes.filter((name) => !name.startsWith(PREFIX))).toEqual([]);
	});

	it("flags an unprefixed arbitrary property, which Tailwind cannot prefix", () => {
		const root = postcss.parse(".\\[overflow-wrap\\:anywhere\\] { overflow-wrap: anywhere }");
		expect(unscopedSelectors(root)).toEqual([".\\[overflow-wrap\\:anywhere\\]"]);
	});
});
