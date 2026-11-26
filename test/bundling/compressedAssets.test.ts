import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import localePacks from "virtual:s2b-locale-packs";
import { deflateToBase64, readLocalePacks } from "../../src/bundling/compressedAssets";
import { getLocale, SUPPORTED_LOCALES, setLocale, t } from "../../src/i18n";
import { inflateAsset, lazyAsset } from "../../src/lib/compressedAsset";

const LOCALES_DIR = resolve("src/i18n/locales");

describe("compressed assets", () => {
	it("round-trips text, including non-ASCII, through build-time deflate and runtime inflate", () => {
		const text = "plain ascii · Кириллица · 日本語 · 한국어 · emoji 🧠\n".repeat(50);
		const encoded = deflateToBase64(text);
		expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
		expect(encoded.length).toBeLessThan(text.length);
		expect(inflateAsset(encoded)).toBe(text);
		expect(inflateAsset(deflateToBase64(""))).toBe("");
	});

	it("decodes a lazy asset once", () => {
		let calls = 0;
		const get = lazyAsset(() => ++calls);
		expect(get()).toBe(1);
		expect(get()).toBe(1);
		expect(calls).toBe(1);
	});

	it("packs every non-English locale, and each pack inflates to that locale's catalogs", () => {
		const expected = readLocalePacks(LOCALES_DIR);
		const shipped = SUPPORTED_LOCALES.filter((l) => l !== "en");
		expect(Object.keys(localePacks).sort()).toEqual([...shipped].sort());
		expect(Object.keys(expected).sort()).toEqual([...shipped].sort());
		for (const locale of shipped) expect(JSON.parse(inflateAsset(localePacks[locale]))).toEqual(expected[locale]);
	});

	it("translates from a compressed locale", () => {
		const before = getLocale();
		try {
			setLocale("de");
			const german = t("chat.input.placeholder");
			setLocale("en");
			expect(german).not.toBe(t("chat.input.placeholder"));
			expect(german).toBe(
				(readLocalePacks(LOCALES_DIR).de.chat as { input: { placeholder: string } }).input.placeholder,
			);
		} finally {
			setLocale(before);
		}
	});
});
