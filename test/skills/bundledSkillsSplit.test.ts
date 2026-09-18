import { describe, expect, it } from "vitest";

import {
	BUNDLED_CORE_SKILLS,
	BUNDLED_INTEGRATION_SKILLS,
	BUNDLED_SKILLS,
	getBundledIntegrationSkillForPlugin,
	getBundledSkill,
} from "../../src/skills/defaults";

/** The 4 core skills always seeded at startup (from src/skills/defaults/). */
const CORE_SKILL_NAMES = ["explore-vault", "manage-notes", "manage-skills", "web", "widgets"];

/** The 6 integration skills (from src/skills/integrations/), seeded conditionally. */
const CORE_PLUGIN_INTEGRATIONS: Record<string, string> = { canvas: "canvas", bases: "bases" };
const COMMUNITY_PLUGIN_INTEGRATIONS: Record<string, string> = {
	dataview: "dataview",
	tasks: "obsidian-tasks-plugin",
	tasknotes: "tasknotes",
	"obsidian-charts": "obsidian-charts",
};

describe("bundled skills split (defaults vs integrations)", () => {
	it("BUNDLED_CORE_SKILLS is exactly the 5 core skills", () => {
		expect(BUNDLED_CORE_SKILLS.map((s) => s.name).sort()).toEqual([...CORE_SKILL_NAMES].sort());
	});

	it("core skills carry no plugin linkage", () => {
		for (const skill of BUNDLED_CORE_SKILLS) {
			expect(skill.linkedPluginId).toBeUndefined();
			expect(skill.corePluginId).toBeUndefined();
			expect(skill.category).toBe("core");
		}
	});

	it("BUNDLED_INTEGRATION_SKILLS is the 6 integration skills", () => {
		const names = BUNDLED_INTEGRATION_SKILLS.map((s) => s.name).sort();
		expect(names).toEqual(
			[...Object.keys(CORE_PLUGIN_INTEGRATIONS), ...Object.keys(COMMUNITY_PLUGIN_INTEGRATIONS)].sort(),
		);
	});

	it("core-plugin integrations carry corePluginId and category 'core'", () => {
		for (const [name, corePluginId] of Object.entries(CORE_PLUGIN_INTEGRATIONS)) {
			const skill = BUNDLED_INTEGRATION_SKILLS.find((s) => s.name === name);
			expect(skill, name).toBeDefined();
			expect(skill?.corePluginId).toBe(corePluginId);
			expect(skill?.linkedPluginId).toBeUndefined();
			expect(skill?.category).toBe("core");
		}
	});

	it("community-plugin integrations carry linkedPluginId and category 'plugin'", () => {
		for (const [name, linkedPluginId] of Object.entries(COMMUNITY_PLUGIN_INTEGRATIONS)) {
			const skill = BUNDLED_INTEGRATION_SKILLS.find((s) => s.name === name);
			expect(skill, name).toBeDefined();
			expect(skill?.linkedPluginId).toBe(linkedPluginId);
			expect(skill?.corePluginId).toBeUndefined();
			expect(skill?.category).toBe("plugin");
		}
	});

	it("BUNDLED_SKILLS is the union of core + integration", () => {
		expect(BUNDLED_SKILLS.length).toBe(BUNDLED_CORE_SKILLS.length + BUNDLED_INTEGRATION_SKILLS.length);
		expect(new Set(BUNDLED_SKILLS.map((s) => s.name)).size).toBe(BUNDLED_SKILLS.length);
	});

	it("getBundledSkill resolves across both sources", () => {
		expect(getBundledSkill("manage-notes")?.name).toBe("manage-notes");
		expect(getBundledSkill("tasknotes")?.name).toBe("tasknotes");
		expect(getBundledSkill("nope")).toBeUndefined();
	});
});

describe("getBundledIntegrationSkillForPlugin", () => {
	it("resolves each community-plugin integration by its linked plugin id", () => {
		for (const [name, linkedPluginId] of Object.entries(COMMUNITY_PLUGIN_INTEGRATIONS)) {
			expect(getBundledIntegrationSkillForPlugin(linkedPluginId)?.name).toBe(name);
		}
	});

	it("returns undefined for core-plugin integrations (they carry corePluginId, not linkedPluginId)", () => {
		expect(getBundledIntegrationSkillForPlugin("canvas")).toBeUndefined();
		expect(getBundledIntegrationSkillForPlugin("bases")).toBeUndefined();
	});

	it("returns undefined for a plugin with no prewritten skill", () => {
		expect(getBundledIntegrationSkillForPlugin("some-unknown-plugin")).toBeUndefined();
	});
});
