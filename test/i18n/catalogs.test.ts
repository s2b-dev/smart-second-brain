import { afterEach, describe, expect, it } from "vitest";

import { PLURAL_CATEGORIES, resolveLocale, SUPPORTED_LOCALES, setLocale, t } from "../../src/i18n";

type Catalog = { [key: string]: string | Catalog };
type Message = string | Record<string, string>;

const modules = import.meta.glob<Catalog>("../../src/i18n/locales/*/*.json", { eager: true, import: "default" });

function catalogsByLocale(): Record<string, Record<string, Catalog>> {
	const out: Record<string, Record<string, Catalog>> = {};
	for (const [path, catalog] of Object.entries(modules)) {
		const [, locale, namespace] = /locales\/([^/]+)\/([^/]+)\.json$/.exec(path) ?? [];
		out[locale] ??= {};
		out[locale][namespace] = catalog;
	}
	return out;
}

function isPlural(node: unknown): node is Record<string, string> {
	return (
		typeof node === "object" &&
		node !== null &&
		typeof (node as Record<string, unknown>).other === "string" &&
		Object.keys(node).every((k) => (PLURAL_CATEGORIES as readonly string[]).includes(k))
	);
}

function flatten(node: Catalog, prefix = "", out: Record<string, Message> = {}): Record<string, Message> {
	for (const [key, value] of Object.entries(node)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "string" || isPlural(value)) out[path] = value as Message;
		else flatten(value, path, out);
	}
	return out;
}

function placeholders(message: Message): string[] {
	const text = typeof message === "string" ? message : Object.values(message).join(" ");
	return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

const catalogs = catalogsByLocale();
const english = flatten(catalogs.en);

describe("i18n catalogs", () => {
	it("ships a catalog directory for every supported locale and nothing else", () => {
		expect(Object.keys(catalogs).sort()).toEqual([...SUPPORTED_LOCALES].sort());
	});

	it("has English strings", () => {
		expect(Object.keys(english).length).toBeGreaterThan(0);
	});

	for (const locale of SUPPORTED_LOCALES.filter((l) => l !== "en")) {
		describe(locale, () => {
			const localized = flatten(catalogs[locale] ?? {});

			it("has the same namespaces as English", () => {
				expect(Object.keys(catalogs[locale] ?? {}).sort()).toEqual(Object.keys(catalogs.en).sort());
			});

			it("translates every English key", () => {
				expect(Object.keys(english).filter((k) => !(k in localized))).toEqual([]);
			});

			it("has no keys English lacks", () => {
				expect(Object.keys(localized).filter((k) => !(k in english))).toEqual([]);
			});

			it("keeps every key's placeholders", () => {
				const mismatched = Object.keys(localized).filter(
					(k) => k in english && placeholders(localized[k]).join() !== placeholders(english[k]).join(),
				);
				expect(mismatched).toEqual([]);
			});

			it("plural keys stay plural and cover the language's categories", () => {
				const required = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
				const broken = Object.keys(english)
					.filter((k) => k in localized && typeof english[k] !== "string")
					.filter((k) => {
						const message = localized[k];
						return typeof message === "string" || required.some((c) => !(c in message));
					});
				expect(broken).toEqual([]);
			});

			// A form may leave the number out only if it is selected for exactly 1. Russian `one`
			// also covers 21, 31, …; Slovenian `two` covers 102: dropping `{count}` there hides it.
			it("plural forms that cover more than the count 1 show {count}", () => {
				const rules = new Intl.PluralRules(locale);
				const coversOtherCounts = (category: string) =>
					Array.from({ length: 1001 }, (_, n) => n).some((n) => n !== 1 && rules.select(n) === category);
				const hidden = Object.keys(english)
					.filter((k) => k in localized && typeof english[k] !== "string")
					.filter((k) => (english[k] as Record<string, string>).other.includes("{count}"))
					.flatMap((k) =>
						Object.entries(localized[k] as Record<string, string>)
							.filter(([category, text]) => !text.includes("{count}") && coversOtherCounts(category))
							.map(([category]) => `${k}.${category}`),
					);
				expect(hidden).toEqual([]);
			});
		});
	}

	it("English plurals cover one and other", () => {
		const broken = Object.entries(english).filter(
			([, m]) => typeof m !== "string" && (m.one === undefined || m.other === undefined),
		);
		expect(broken).toEqual([]);
	});
});

describe("t", () => {
	afterEach(() => setLocale("en"));

	it("interpolates variables", () => {
		expect(t("settings.troubleshooting.cleared_partial", { indexes: "a, b" })).toContain("a, b");
	});

	it("leaves unknown placeholders untouched", () => {
		expect(t("settings.troubleshooting.cleared_partial")).toContain("{indexes}");
	});

	it("picks the plural form from count", () => {
		expect(t("plugin.indexing.indexed_notes", { count: 1 })).toBe("✓ Indexed 1 note");
		expect(t("plugin.indexing.indexed_notes", { count: 2 })).toBe("✓ Indexed 2 notes");
		setLocale("ja");
		expect(t("plugin.indexing.indexed_notes", { count: 1 })).toContain("1");
	});

	it("uses the selected locale and falls back to English", () => {
		setLocale("de");
		expect(t("settings.troubleshooting.clear")).not.toBe("");
		expect(t("settings.troubleshooting.clear")).not.toBe("settings.troubleshooting.clear");
	});
});

describe("resolveLocale", () => {
	it.each([
		["en", "en"],
		["de", "de"],
		["de-AT", "de"],
		["pt", "pt-BR"],
		["pt-BR", "pt-BR"],
		["zh", "zh"],
		["zh-CN", "zh"],
		["zh-TW", "en"],
		["ja", "ja"],
		["ru", "ru"],
		["ko", "ko"],
		["tr", "tr"],
		["sl", "sl"],
		["it", "en"],
		["", "en"],
		[undefined, "en"],
	])("%s → %s", (input, expected) => {
		expect(resolveLocale(input)).toBe(expected);
	});
});
