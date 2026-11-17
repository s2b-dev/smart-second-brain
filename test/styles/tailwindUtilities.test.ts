import postcss, { type AcceptedPlugin } from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import config from "../../tailwind.config.js";

/**
 * Single-word utilities S2B uses as classes. Tailwind's utilities ship unscoped, so in
 * Obsidian each one applies to every plugin's DOM — and a bare generic name is the kind
 * another plugin uses for its own elements (#558: `.static` blanked Excalidraw drawings).
 * Before adding a name here, check that a real class needs it; if Tailwind only picked it up
 * from prose, code or a <style> block, add it to `blocklist` in `tailwind.config.js` instead.
 */
const USED_GENERIC_UTILITIES = [
	"absolute",
	"block",
	"border",
	"flex",
	"group",
	"isolate",
	"relative",
	"rounded",
	"truncate",
	"uppercase",
	"visible",
];

async function shippedClassNames(): Promise<Set<string>> {
	// Tailwind depends on its own copy of postcss, whose plugin type is nominally distinct.
	const plugin = tailwindcss(config) as unknown as AcceptedPlugin;
	const result = await postcss([plugin]).process("@tailwind components;\n@tailwind utilities;", {
		from: undefined,
	});
	const names = new Set<string>();
	result.root.walkRules((rule) => {
		for (const selector of rule.selectors) {
			// The first class of each selector: `.flex`, `.\!block`, `.hover\:x:hover`.
			const match = /^\.((?:\\.|[^\s.:>+~[,])+)/.exec(selector.trim());
			if (match) names.add(match[1].replace(/\\(.)/g, "$1"));
		}
	});
	return names;
}

describe("shipped Tailwind utilities", () => {
	it("ships no generic single-word utility that S2B does not use as a class", async () => {
		const names = await shippedClassNames();
		// Sanity: the scan found the stylesheet at all.
		expect(names.has("flex")).toBe(true);
		const generic = [...names].filter((name) => /^!?[a-z]+$/.test(name)).sort();
		expect(generic).toEqual(USED_GENERIC_UTILITIES);
	});

	it("does not emit `.static`, which overrode Excalidraw's canvas positioning (#558)", async () => {
		expect((await shippedClassNames()).has("static")).toBe(false);
	});
});
