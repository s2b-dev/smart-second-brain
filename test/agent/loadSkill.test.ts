import { describe, expect, it, vi } from "vitest";

import { createLoadSkillTool } from "../../src/agent/tools/loadSkill";
import type { SkillsService } from "../../src/skills/SkillsService";

function mockSkillsService(
	skills: Record<
		string,
		{ description?: string; allowedTools?: string; body?: string; metadata?: Record<string, string> }
	>,
) {
	return {
		loadSkill: vi.fn(async (name: string) => {
			const skill = skills[name];
			if (!skill) return null;
			return {
				frontmatter: {
					name,
					description: skill.description ?? `${name} description`,
					allowedTools: skill.allowedTools,
					metadata: skill.metadata,
				},
				content: skill.body ?? `${name} instructions`,
			};
		}),
	} as unknown as SkillsService;
}

describe("load_skill tool", () => {
	it("reports the live status of plugins a skill lists as optional", async () => {
		const service = mockSkillsService({
			views: { metadata: { optionalPlugins: "dataview, obsidian-charts" }, body: "Write s2b-view fences." },
			web: { body: "No plugins here." },
		});
		const tool = createLoadSkillTool(service, {
			skillNames: ["views", "web"],
			pluginStatus: (id) =>
				id === "dataview"
					? { status: "disabled", displayName: "Dataview" }
					: { status: "missing", displayName: id },
		});

		const views = String(await tool.invoke({ skillName: "views" }));
		expect(views).toContain("## Plugin availability");
		expect(views).toContain("- Dataview (`dataview`): installed but disabled");
		expect(views).toContain("- obsidian-charts (`obsidian-charts`): not installed");
		// The status block precedes the instructions the skill tells the model to consult it from.
		expect(views.indexOf("## Plugin availability")).toBeLessThan(views.indexOf("## Instructions"));

		const web = String(await tool.invoke({ skillName: "web" }));
		expect(web).not.toContain("## Plugin availability");
	});

	it("only offers (and loads) the skill names the caller passed", async () => {
		const service = mockSkillsService({
			"explore-vault": {},
			"manage-skills": {},
		});
		const tool = createLoadSkillTool(service, { skillNames: ["explore-vault"] });

		expect(tool.description).toContain("explore-vault");
		expect(tool.description).not.toContain("manage-skills");

		// A skill outside the offered set must not load even though the service knows it —
		// the caller's filter mirrors the `# Skills` XML gating (disabled skills, skills
		// with every declared tool vetoed). The enum schema rejects the call outright.
		await expect(tool.invoke({ skillName: "manage-skills" })).rejects.toThrow();

		// The offered skill still loads normally.
		const result = String(await tool.invoke({ skillName: "explore-vault" }));
		expect(result).toContain("# Skill: explore-vault");
	});

	it("annotates declared tools that are not bound in this run", async () => {
		const service = mockSkillsService({
			web: { allowedTools: "fetch_url web_search", body: "Use fetch_url to read pages." },
		});
		const tool = createLoadSkillTool(service, {
			skillNames: ["web"],
			isToolAvailable: (id) => id !== "fetch_url",
		});

		const result = String(await tool.invoke({ skillName: "web" }));
		expect(result).toContain("currently disabled and cannot be called: fetch_url");
		// web_search is bound, so it isn't flagged.
		expect(result).not.toMatch(/cannot be called:.*web_search/);
		expect(result).toContain("Use fetch_url to read pages.");
	});

	it("omits the availability note when every declared tool is bound", async () => {
		const service = mockSkillsService({
			web: { allowedTools: "fetch_url web_search" },
		});
		const tool = createLoadSkillTool(service, {
			skillNames: ["web"],
			isToolAvailable: () => true,
		});

		const result = String(await tool.invoke({ skillName: "web" }));
		expect(result).not.toContain("currently disabled");
	});
});
