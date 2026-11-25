/**
 * Regenerates `src/providers/directory/catalog.json`, the bundled snapshot behind the
 * Add-provider "More providers" list (#588).
 *
 *     bun run directory:refresh
 *
 * Source: models.dev (MIT, https://github.com/sst/models.dev). Only the provider
 * *directory* is taken: name, API root, docs link and logo. Model facts (context windows,
 * modalities, reasoning) are deliberately left out; every model fact comes from the
 * provider itself (#586).
 *
 * Run it before a release and commit the result; the plugin never fetches models.dev at
 * runtime.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const CATALOG_URL = "https://models.dev/api.json";
const LOGO_URL = (id: string) => `https://models.dev/logos/${id}.svg`;
const OUT = join(import.meta.dir, "..", "src", "providers", "directory", "catalog.json");

/** The client package models.dev names for providers that speak the plain OpenAI API. */
const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

/**
 * Providers models.dev routes through a vendor SDK package, though their API is
 * OpenAI-compatible. models.dev gives no base URL for these, so it is kept here.
 */
const KNOWN_COMPATIBLE_ROOTS: Record<string, string> = {
	groq: "https://api.groq.com/openai/v1",
	cerebras: "https://api.cerebras.ai/v1",
	deepinfra: "https://api.deepinfra.com/v1/openai",
	xai: "https://api.x.ai/v1",
};

/**
 * Left out on purpose:
 * - covered by a built-in template, which handles the vendor properly;
 * - needs a sign-in rather than an API key (Copilot).
 */
const EXCLUDED_IDS = new Set(["lmstudio", "huggingface", "github-copilot"]);

/** Subscription endpoints sold for coding tools (`zai-coding-plan`, `alibaba-token-plan`, `stepfun-step-plan`). */
const PLAN_VARIANT = /-(coding|token|step)-plan(-|$)/;

/** A local server would land as an untrusted Custom provider; local engines have templates. */
const LOCAL_HOST = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i;

/** Logos larger than this are dropped (the tile falls back to the generic icon). */
const MAX_LOGO_BYTES = 8_000;

interface CatalogProvider {
	id: string;
	name: string;
	npm?: string;
	api?: string;
	doc?: string;
	models?: Record<string, unknown>;
}

interface DirectoryEntry {
	id: string;
	name: string;
	api: string;
	doc?: string;
	logo?: string;
}

/**
 * The logo is rendered as a CSS mask image, which never runs script, so this is defence in
 * depth: anything that isn't plain vector markup is rejected outright rather than repaired.
 */
function sanitizeLogo(svg: string): string | undefined {
	const trimmed = svg.trim().replace(/<\?xml[^>]*>/, "").replace(/<!--[\s\S]*?-->/g, "").trim();
	if (!trimmed.startsWith("<svg") || !trimmed.endsWith("</svg>")) return undefined;
	if (/<script|<foreignObject|<iframe|<image|\son\w+\s*=|javascript:|(xlink:)?href\s*=|@import|url\(/i.test(trimmed)) {
		return undefined;
	}
	const compact = trimmed.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ");
	return new TextEncoder().encode(compact).length <= MAX_LOGO_BYTES ? compact : undefined;
}

async function fetchLogo(id: string): Promise<string | undefined> {
	try {
		const response = await fetch(LOGO_URL(id));
		if (!response.ok) return undefined;
		return sanitizeLogo(await response.text());
	} catch {
		return undefined;
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

async function main() {
	const response = await fetch(CATALOG_URL);
	if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
	const catalog = (await response.json()) as Record<string, CatalogProvider>;

	const candidates: Omit<DirectoryEntry, "logo">[] = [];
	for (const provider of Object.values(catalog)) {
		const api = provider.npm === OPENAI_COMPATIBLE_NPM ? provider.api : KNOWN_COMPATIBLE_ROOTS[provider.id];
		if (!api) continue;
		if (EXCLUDED_IDS.has(provider.id) || PLAN_VARIANT.test(provider.id)) continue;
		if (LOCAL_HOST.test(api)) continue;
		// Per-account endpoints (`${CLOUDFLARE_ACCOUNT_ID}`, `${NEON_AI_GATEWAY_BASE_URL}`):
		// there is no URL to pre-fill, so they stay a hand-made Custom provider.
		if (!/^https?:\/\/[^/{}$]+/i.test(api) || /[{}$]/.test(api)) continue;
		if (!provider.models || Object.keys(provider.models).length === 0) continue;
		candidates.push({
			id: provider.id,
			name: provider.name.trim(),
			api: api.trim().replace(/\/+$/, ""),
			...(provider.doc ? { doc: provider.doc } : {}),
		});
	}

	const entries: DirectoryEntry[] = [];
	const batchSize = 16;
	for (let i = 0; i < candidates.length; i += batchSize) {
		const batch = candidates.slice(i, i + batchSize);
		const logos = await Promise.all(batch.map((entry) => fetchLogo(entry.id)));
		batch.forEach((entry, j) => entries.push(logos[j] ? { ...entry, logo: logos[j] } : entry));
	}
	entries.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

	const snapshot = {
		source: "https://models.dev (MIT)",
		generated: new Date().toISOString().slice(0, 10),
		entries,
	};
	writeFileSync(OUT, `${JSON.stringify(snapshot, null, "\t")}\n`);

	const withLogo = entries.filter((e) => e.logo).length;
	const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
	console.log(`${entries.length} providers (${withLogo} with a logo), ${(bytes / 1024).toFixed(0)} KB → ${OUT}`);
	for (const entry of entries.filter((e) => !e.logo)) console.log(`  no logo: ${entry.id} (${hostOf(entry.api)})`);
}

await main();
