import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => ({ agentFolder: "Agents" }),
}));

import { SkillsService } from "../../src/skills/SkillsService";

const SKILL_MD = `---
name: weekly-review
description: A weekly-review skill
---

# Weekly review
Body.
`;

function makeAdapter(initial: Record<string, string>) {
	const files = new Map(Object.entries(initial));
	const dirs = new Set<string>();
	for (const p of files.keys()) {
		const parts = p.split("/");
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
	}
	return {
		files,
		dirs,
		exists: vi.fn(async (p: string) => files.has(p) || dirs.has(p)),
		read: vi.fn(async (p: string) => {
			if (!files.has(p)) throw new Error(`ENOENT ${p}`);
			return files.get(p)!;
		}),
		list: vi.fn(async (dir: string) => {
			const folders = new Set<string>();
			for (const d of dirs) {
				if (d.split("/").slice(0, -1).join("/") === dir) folders.add(d);
			}
			return { files: [], folders: [...folders] };
		}),
		remove: vi.fn(async (p: string) => {
			files.delete(p);
		}),
		rmdir: vi.fn(async (p: string) => {
			dirs.delete(p);
		}),
	};
}

describe("SkillsService.deleteSkill", () => {
	it("removes the skill's folder and its cache entry", async () => {
		const adapter = makeAdapter({ "Agents/Skills/weekly-review/SKILL.md": SKILL_MD });
		const plugin = { app: { vault: { adapter, configDir: ".obsidian" } } } as never;
		const svc = new SkillsService(plugin);
		await svc.discoverSkills();
		expect(svc.getCachedSkills().has("weekly-review")).toBe(true);

		expect(await svc.deleteSkill("weekly-review")).toBe(true);

		expect(adapter.files.has("Agents/Skills/weekly-review/SKILL.md")).toBe(false);
		expect(svc.getCachedSkills().has("weekly-review")).toBe(false);
	});

	it("reports false for a skill it does not know", async () => {
		const adapter = makeAdapter({});
		const plugin = { app: { vault: { adapter, configDir: ".obsidian" } } } as never;
		const svc = new SkillsService(plugin);
		expect(await svc.deleteSkill("ghost")).toBe(false);
	});
});
