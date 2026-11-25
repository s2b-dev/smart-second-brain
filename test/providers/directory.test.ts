import { describe, expect, it } from "vitest";
import {
	directoryHost,
	getDirectoryEntries,
	getDirectoryEntry,
	searchDirectory,
} from "../../src/providers/directory/index";
import { getProviderDefinition } from "../../src/providers/index";
import { resolveApiRoot } from "../../src/providers/openai-compatible";

describe("resolveApiRoot", () => {
	it("appends /v1 only to a bare host", () => {
		expect(resolveApiRoot("http://localhost:8000")).toBe("http://localhost:8000/v1");
		expect(resolveApiRoot("https://api.deepseek.com/")).toBe("https://api.deepseek.com/v1");
	});

	it("uses a URL with a path as given", () => {
		expect(resolveApiRoot("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
		expect(resolveApiRoot("https://api.z.ai/api/paas/v4")).toBe("https://api.z.ai/api/paas/v4");
		expect(resolveApiRoot("https://ark.cn-beijing.volces.com/api/v3/")).toBe(
			"https://ark.cn-beijing.volces.com/api/v3",
		);
		expect(resolveApiRoot("https://api.novita.ai/openai")).toBe("https://api.novita.ai/openai");
		expect(resolveApiRoot("https://api.deepinfra.com/v1/openai")).toBe("https://api.deepinfra.com/v1/openai");
	});

	it("trims whitespace and trailing slashes", () => {
		expect(resolveApiRoot("  https://example.com/v1//  ")).toBe("https://example.com/v1");
	});
});

describe("provider directory snapshot", () => {
	const entries = getDirectoryEntries();

	it("is non-empty, unique, and sorted by name", () => {
		expect(entries.length).toBeGreaterThan(100);
		expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
		const names = entries.map((e) => e.name);
		expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
	});

	it("holds only remote http(s) API roots", () => {
		for (const entry of entries) {
			expect(entry.api, entry.id).toMatch(/^https?:\/\/[^/]+/);
			expect(entry.api, entry.id).not.toMatch(/localhost|127\.0\.0\.1|0\.0\.0\.0|\/$/);
		}
	});

	it("leaves out templates, sign-in-only and plan endpoints", () => {
		for (const id of ["lmstudio", "huggingface", "github-copilot", "zai-coding-plan", "alibaba-token-plan"]) {
			expect(getDirectoryEntry(id), id).toBeUndefined();
		}
	});

	it("carries only inert SVG logos", () => {
		for (const entry of entries) {
			if (!entry.logo) continue;
			expect(entry.logo, entry.id).toMatch(/^<svg[\s>][\s\S]*<\/svg>$/);
			expect(entry.logo, entry.id).not.toMatch(/<script|<foreignObject|\son\w+\s*=|href\s*=|url\(/i);
		}
	});
});

describe("searchDirectory", () => {
	const sample = [
		{ id: "deepseek", name: "DeepSeek", api: "https://api.deepseek.com" },
		{ id: "fireworks-ai", name: "Fireworks AI", api: "https://api.fireworks.ai/inference/v1" },
		{ id: "zai", name: "Z.AI", api: "https://api.z.ai/api/paas/v4" },
	];

	it("returns everything for an empty query", () => {
		expect(searchDirectory("  ", sample)).toHaveLength(3);
	});

	it("matches name, id and host, case-insensitively, all terms required", () => {
		expect(searchDirectory("deep", sample).map((e) => e.id)).toEqual(["deepseek"]);
		expect(searchDirectory("FIREWORKS ai", sample).map((e) => e.id)).toEqual(["fireworks-ai"]);
		expect(searchDirectory("api.z.ai", sample).map((e) => e.id)).toEqual(["zai"]);
		expect(searchDirectory("fireworks zai", sample)).toEqual([]);
	});

	it("shows the host", () => {
		expect(directoryHost(sample[2])).toBe("api.z.ai");
	});
});

describe("directory-backed Custom provider", () => {
	it("defaults its base URL to the entry and takes the entry's logo and docs link", () => {
		const entry = getDirectoryEntry("deepseek");
		expect(entry).toBeDefined();
		const definition = getProviderDefinition("my-deepseek", {
			"my-deepseek": { templateId: "openai-compatible", displayName: "DeepSeek", directoryId: "deepseek" },
		});
		expect(definition?.logo).toBeDefined();
		expect(definition?.setupInstructions.link?.url).toBe(entry?.doc);
		// Same component on every lookup, so a mounted logo isn't remounted.
		const again = getProviderDefinition("my-deepseek", {
			"my-deepseek": { templateId: "openai-compatible", displayName: "DeepSeek", directoryId: "deepseek" },
		});
		expect(again?.logo).toBe(definition?.logo);
	});

	it("falls back to a plain Custom provider for an unknown directory id", () => {
		const definition = getProviderDefinition("x", {
			x: { templateId: "openai-compatible", displayName: "X", directoryId: "no-such-entry" },
		});
		expect(definition?.logo).toBeUndefined();
		expect(definition?.setupInstructions.link).toBeUndefined();
	});
});
