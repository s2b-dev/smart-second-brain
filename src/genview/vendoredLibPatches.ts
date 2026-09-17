/**
 * Source patches applied at build time to the browser bundles a view can request
 * (`viewLibs.ts`). Those bundles ship inside main.js as string literals, and the
 * production build refuses a main.js containing `new Function(` or `eval(` — the
 * plugin-review scan reads text, not semantics, and a view library's global-detection
 * fallback would read as the plugin executing dynamic code.
 *
 * Every patch is semantics-preserving for the runtimes a frame can run in, is pinned to
 * an exact occurrence count, and fails the build if the count drifts: a library upgrade
 * that adds or moves such a construct must surface as a red build, not slip through.
 *
 * Pure and dependency-free so `vite.config.ts` and the unit tests can both import it.
 */

export interface VendoredLibPatch {
	/** Exact text to replace. */
	from: string;
	/** Replacement text. */
	to: string;
	/** How many times `from` must occur; any other count throws. */
	count: number;
	/** Why the replacement is equivalent. */
	why: string;
}

/** Keyed by the tail of the vendored file's path. */
export const VENDORED_LIB_PATCHES: Readonly<Record<string, readonly VendoredLibPatch[]>> = {
	"plotly.js-gl3d-dist-min/plotly-gl3d.min.js": [
		{
			from: 'new Function("return this")()',
			to: "globalThis",
			count: 1,
			why:
				"A `global` polyfill's last-resort fallback for finding the global object, reached only when " +
				"`globalThis` is not an object. Every runtime a view frame runs in (Chromium in Electron, " +
				"WebKit on iOS) defines `globalThis`, so the fallback is dead; naming `globalThis` directly " +
				"keeps the same result without constructing code from a string.",
		},
	],
};

/** Text patterns that must not survive in any vendored library after patching. */
export const VENDORED_LIB_FORBIDDEN: ReadonlyArray<[label: string, pattern: RegExp]> = [
	["new Function()", /new Function\(/],
	["eval()", /[^\w.$]eval\(/],
	["importScripts()", /importScripts\(/],
];

/** The patch set for a vendored file path, or null when the path is not a vendored view library. */
export function vendoredLibPatchesFor(path: string): readonly VendoredLibPatch[] | null {
	for (const [tail, patches] of Object.entries(VENDORED_LIB_PATCHES)) {
		if (path.endsWith(tail)) return patches;
	}
	return null;
}

/** Apply a library's patches to its source and verify nothing forbidden remains. Throws on any drift. */
export function patchVendoredLib(path: string, source: string): string {
	const patches = vendoredLibPatchesFor(path);
	if (!patches) throw new Error(`vendored-lib-patches: ${path} is not a vendored view library`);
	let patched = source;
	for (const { from, to, count } of patches) {
		const occurrences = patched.split(from).length - 1;
		if (occurrences !== count) {
			const hint = "The library changed; review the patch in src/genview/vendoredLibPatches.ts.";
			throw new Error(
				`vendored-lib-patches: expected ${count} occurrence(s) of ${JSON.stringify(from)} in ${path}, found ${occurrences}. ${hint}`,
			);
		}
		patched = patched.split(from).join(to);
	}
	for (const [label, pattern] of VENDORED_LIB_FORBIDDEN) {
		const match = pattern.exec(patched);
		if (match) {
			const at = Math.max(0, match.index - 60);
			throw new Error(
				`vendored-lib-patches: ${path} still contains ${label} after patching near: …${patched.slice(at, match.index + 60)}…`,
			);
		}
	}
	return patched;
}
