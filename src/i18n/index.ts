/**
 * UI translation.
 *
 * Every user-visible string in the plugin's interface goes through {@link t}. Model-facing
 * text (system prompts, tool descriptions, skill bodies) is NOT translated: it stays English,
 * and the model answers in the user's language on its own (see the `# Formatting` rule in
 * `agent/prompts.ts`).
 *
 * Catalogs live in `locales/<locale>/<namespace>.json`. A key is `<namespace>.<path>`, e.g.
 * `t("chat.input.placeholder")`. English is the source of truth and the type of every key is
 * derived from it, so a typo or a key missing from `en` fails `bun run check`. Other locales may
 * lag behind: a key missing there falls back to English at runtime, and
 * `test/i18n/catalogs.test.ts` fails on missing, extra, or placeholder-mismatched keys.
 *
 * The locale is resolved once from Obsidian's language setting. Obsidian restarts the app when
 * the language changes, so nothing here needs to be reactive and `t()` works the same from
 * TypeScript and from Svelte markup.
 *
 * Messages support two features:
 * - Interpolation: `"Indexed {count} notes"` with `t(key, { count: 3 })`.
 * - Plurals: a message may be an object of `Intl.PluralRules` categories
 *   (`{ "one": "{count} note", "other": "{count} notes" }`); the category is picked from the
 *   numeric `count` variable. `other` is always required; locales add the categories their
 *   language needs (Russian `one`/`few`/`many`/`other`; Japanese, Chinese and Korean only `other`).
 */
import { getLanguage } from "obsidian";

import agents from "./locales/en/agents.json";
import common from "./locales/en/common.json";
import chat from "./locales/en/chat.json";
import graph from "./locales/en/graph.json";
import modals from "./locales/en/modals.json";
import onboarding from "./locales/en/onboarding.json";
import plugin from "./locales/en/plugin.json";
import settings from "./locales/en/settings.json";
import ui from "./locales/en/ui.json";
import widget from "./locales/en/widget.json";

const en = { agents, common, chat, graph, modals, onboarding, plugin, settings, ui, widget };

/** Locales shipped with the plugin, in the codes Obsidian's `getLanguage()` reports. */
export const SUPPORTED_LOCALES = ["en", "de", "fr", "es", "pt-BR", "ru", "tr", "sl", "zh", "ja", "ko"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
type PluralCategory = (typeof PLURAL_CATEGORIES)[number];
type PluralMessage = Partial<Record<PluralCategory, string>> & { other: string };

type Catalog = { [key: string]: string | Catalog };
type Vars = Record<string, string | number>;

type LeafPaths<T, Prefix extends string = ""> = {
	[K in keyof T & string]: T[K] extends string
		? `${Prefix}${K}`
		: T[K] extends { other: string }
			? `${Prefix}${K}`
			: LeafPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every translatable key, derived from the English catalogs. */
export type MessageKey = LeafPaths<typeof en>;

const localeModules = import.meta.glob<Catalog>("./locales/*/*.json", { eager: true, import: "default" });

function buildCatalogs(): Record<string, Catalog> {
	const catalogs: Record<string, Catalog> = {};
	for (const [path, catalog] of Object.entries(localeModules)) {
		const match = /\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
		if (!match) continue;
		const [, locale, namespace] = match;
		catalogs[locale] ??= {};
		catalogs[locale][namespace] = catalog;
	}
	return catalogs;
}

const catalogs = buildCatalogs();

/**
 * Map an Obsidian language code onto a shipped locale: exact match, then the base language
 * (`pt` → `pt-BR`, `de-AT` → `de`), else English. Traditional Chinese (`zh-TW`, `zh-HK`) falls
 * back to English rather than to the Simplified catalog.
 */
export function resolveLocale(language: string | null | undefined): Locale {
	if (!language) return "en";
	const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === language.toLowerCase());
	if (exact) return exact;
	const base = language.split(/[-_]/)[0].toLowerCase();
	if (base === "zh") return /^zh[-_](cn|sg|hans)/i.test(language) ? "zh" : "en";
	return SUPPORTED_LOCALES.find((l) => l.split("-")[0].toLowerCase() === base) ?? "en";
}

function detectLanguage(): string {
	try {
		return getLanguage();
	} catch {
		return "en";
	}
}

let currentLocale: Locale = resolveLocale(detectLanguage());
let pluralRules = new Intl.PluralRules(currentLocale);

/** The locale the UI is rendered in. */
export function getLocale(): Locale {
	return currentLocale;
}

/** Override the locale. Tests only; the plugin resolves it once at load. */
export function setLocale(locale: Locale): void {
	currentLocale = locale;
	pluralRules = new Intl.PluralRules(locale);
}

function lookup(catalog: Catalog | undefined, key: string): string | PluralMessage | undefined {
	let node: string | Catalog | undefined = catalog;
	for (const part of key.split(".")) {
		if (node === undefined || typeof node === "string") return undefined;
		node = node[part];
	}
	if (typeof node === "string") return node;
	if (node && typeof node.other === "string") return node as PluralMessage;
	return undefined;
}

function interpolate(message: string, vars: Vars | undefined): string {
	if (!vars) return message;
	return message.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

function select(message: string | PluralMessage, vars: Vars | undefined, rules: Intl.PluralRules): string {
	if (typeof message === "string") return message;
	const count = typeof vars?.count === "number" ? vars.count : Number(vars?.count ?? Number.NaN);
	const category = Number.isFinite(count) ? rules.select(count) : "other";
	if (count === 0 && message.zero !== undefined) return message.zero;
	return message[category] ?? message.other;
}

const englishRules = new Intl.PluralRules("en");

/**
 * Translate `key` into the UI locale, substituting `{name}` placeholders from `vars`.
 * Falls back to English, then to the key itself (which only happens for a key `check` would
 * already have rejected).
 */
export function t(key: MessageKey, vars?: Vars): string {
	const localized = lookup(catalogs[currentLocale], key);
	if (localized !== undefined) return interpolate(select(localized, vars, pluralRules), vars);
	const fallback = lookup(catalogs.en, key);
	if (fallback !== undefined) return interpolate(select(fallback, vars, englishRules), vars);
	return key;
}

/** Locale-aware number formatting for counts shown next to translated text. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
	return new Intl.NumberFormat(currentLocale, options).format(value);
}
