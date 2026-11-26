/**
 * Build-time half of the compressed-asset scheme (runtime half: `lib/compressedAsset.ts`).
 *
 * Obsidian Sync's Standard plan refuses files over 5 MB, and the plugin-review scan warns
 * when `main.js` crosses that. The two largest things in the bundle are text the plugin
 * carries but rarely reads in full: the Plotly build widgets may inline, and ten non-English
 * UI locales of which a user needs at most one. Both ship raw-deflated and base64-encoded,
 * and are inflated on first use. Base64 rather than raw bytes because the minifier escapes
 * every non-ASCII character in a string literal (`\uXXXX`, six bytes), which is also why the
 * Cyrillic and CJK catalogs cost far more as JSON than their UTF-8 size suggests.
 *
 * Two entry points, both registered in `vite.config.ts` and `vitest.config.ts` so tests
 * exercise the same decode path as the plugin:
 * - `import x from "<file>?deflate"`: one file as a deflated string. A vendored widget
 *   library gets its build-time patches (`widget/vendoredLibPatches.ts`) first.
 * - `import packs from "virtual:s2b-locale-packs"`: every non-English locale's catalogs,
 *   one deflated JSON object `{ <namespace>: catalog }` per locale. English stays a plain
 *   import: it is the fallback for every locale and the source of the key types.
 *
 * Build-time only (Node APIs): never import this from plugin code.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Plugin } from "vite";
import { patchVendoredLib, vendoredLibPatchesFor } from "../widget/vendoredLibPatches";

const DEFLATE_QUERY = "deflate";
const LOCALE_PACKS_ID = "virtual:s2b-locale-packs";
const RESOLVED_LOCALE_PACKS_ID = `\0${LOCALE_PACKS_ID}`;

/** Deflate UTF-8 text and encode it as base64, the form `inflateAsset` reads. */
export function deflateToBase64(text: string): string {
	return deflateRawSync(Buffer.from(text, "utf8"), { level: 9 }).toString("base64");
}

/** Locale directory names (dotfiles and stray files such as `.DS_Store` skipped), sorted. */
function localeDirs(localesDir: string): string[] {
	return readdirSync(localesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.sort();
}

/** A locale's catalog files (`<namespace>.json`), sorted. */
function catalogFiles(localeDir: string): string[] {
	return readdirSync(localeDir)
		.filter((file) => file.endsWith(".json"))
		.sort();
}

/** Every locale except English, as `{ <locale>: { <namespace>: catalog } }`. */
export function readLocalePacks(localesDir: string): Record<string, Record<string, unknown>> {
	const packs: Record<string, Record<string, unknown>> = {};
	for (const locale of localeDirs(localesDir)) {
		if (locale === "en") continue;
		const pack: Record<string, unknown> = {};
		for (const file of catalogFiles(join(localesDir, locale))) {
			pack[file.slice(0, -".json".length)] = JSON.parse(readFileSync(join(localesDir, locale, file), "utf8"));
		}
		packs[locale] = pack;
	}
	return packs;
}

export function compressedAssets(options: { localesDir: string }): Plugin {
	return {
		name: "s2b-compressed-assets",
		enforce: "pre",
		resolveId(id) {
			return id === LOCALE_PACKS_ID ? RESOLVED_LOCALE_PACKS_ID : null;
		},
		load(id) {
			if (id === RESOLVED_LOCALE_PACKS_ID) {
				const encoded: Record<string, string> = {};
				for (const [locale, pack] of Object.entries(readLocalePacks(options.localesDir))) {
					encoded[locale] = deflateToBase64(JSON.stringify(pack));
				}
				for (const locale of localeDirs(options.localesDir)) {
					const dir = join(options.localesDir, locale);
					for (const file of catalogFiles(dir)) this.addWatchFile(join(dir, file));
				}
				return { code: `export default ${JSON.stringify(encoded)};`, map: null };
			}
			const [path, query] = id.split("?");
			if (query !== DEFLATE_QUERY) return null;
			this.addWatchFile(path);
			let text = readFileSync(path, "utf8");
			if (vendoredLibPatchesFor(path)) text = patchVendoredLib(path, text);
			return { code: `export default ${JSON.stringify(deflateToBase64(text))};`, map: null };
		},
	};
}
