import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { SkillsService } from "../../skills/SkillsService";
import type { CommunityPluginStatus } from "../integrations/pluginIntegrations";

/** Frontmatter key (under `metadata:`) listing community plugin ids a skill can make use of. */
export const OPTIONAL_PLUGINS_METADATA_KEY = "optionalPlugins";

const STATUS_TEXT: Record<CommunityPluginStatus, string> = {
	enabled: "enabled",
	disabled: "installed but disabled — the user can enable it under Settings → Community plugins",
	missing: "not installed — the user can install it from Settings → Community plugins → Browse",
};

/** Split a space- or comma-separated id list from frontmatter. */
export function parseOptionalPlugins(metadata: Record<string, string> | undefined): string[] {
	const raw = metadata?.[OPTIONAL_PLUGINS_METADATA_KEY];
	if (!raw) return [];
	return raw
		.split(/[\s,]+/)
		.map((id) => id.trim())
		.filter(Boolean);
}

export interface LoadSkillToolOptions {
	/**
	 * The skills this agent may load — pre-filtered by the caller to the same set the
	 * `# Skills` XML advertises (enabled for the agent, backing plugin available, at
	 * least one declared tool bound). Offering the full discovery cache here would let
	 * the model load skills the prompt deliberately hides.
	 */
	skillNames: string[];
	/**
	 * Whether a tool id a skill declares in `allowed-tools` is actually bound for this
	 * run. Used to annotate the loaded body: a skill can mention a tool that is
	 * individually disabled (e.g. the web skill's `fetch_url` while that tool is off),
	 * and without the note the model would call a tool that doesn't exist.
	 */
	isToolAvailable?: (toolId: string) => boolean;
	/**
	 * Live status of a community plugin a skill lists under `metadata.optionalPlugins`.
	 * Appended to the loaded body so a skill whose *best* path depends on another
	 * plugin (the views skill's Dataview queries) can tell the model up front whether
	 * that path exists, instead of letting it find out from a failed result.
	 */
	pluginStatus?: (pluginId: string) => { status: CommunityPluginStatus; displayName: string };
}

/**
 * Creates a tool that allows the agent to dynamically load skill instructions.
 * This enables on-demand skill loading rather than embedding all skills in the system prompt.
 *
 * @param skillsService - The skills service instance
 * @param options - Per-agent gating (see {@link LoadSkillToolOptions})
 * @returns A LangChain tool for loading skill content
 */
export function createLoadSkillTool(skillsService: SkillsService, options: LoadSkillToolOptions) {
	const { skillNames, isToolAvailable, pluginStatus } = options;

	// If no skills available, return a tool that explains this
	if (skillNames.length === 0) {
		return tool(
			async () => {
				return "No skills are currently available. Skills may not have been discovered yet.";
			},
			{
				name: "load_skill",
				description: "Load detailed instructions for a specific skill. No skills are currently available.",
				schema: z.object({
					skillName: z.string().describe("The name of the skill to load"),
				}),
			},
		);
	}

	const loadable = new Set(skillNames);

	return tool(
		async ({ skillName }: { skillName: string }) => {
			const skill = loadable.has(skillName) ? await skillsService.loadSkill(skillName) : null;

			if (!skill) {
				return `Skill "${skillName}" not found. Available skills: ${skillNames.join(", ")}`;
			}

			// Return the skill content with metadata
			const lines: string[] = [];
			lines.push(`# Skill: ${skill.frontmatter.name}`);
			lines.push("");
			lines.push(`**Description:** ${skill.frontmatter.description}`);

			if (skill.frontmatter.allowedTools) {
				lines.push(`**Allowed Tools:** ${skill.frontmatter.allowedTools}`);
				// Flag declared tools that are not bound in this run, so instructions
				// referencing them read as "work around this" rather than "call this".
				const unavailable = skill.frontmatter.allowedTools
					.split(/\s+/)
					.filter((id) => id && isToolAvailable && !isToolAvailable(id));
				if (unavailable.length > 0) {
					lines.push("");
					lines.push(
						`**Note:** The following tool(s) are currently disabled and cannot be called: ${unavailable.join(", ")}. Follow the rest of the instructions without them, and tell the user a disabled tool would have helped if it blocks the task.`,
					);
				}
			}

			const optionalPlugins = pluginStatus ? parseOptionalPlugins(skill.frontmatter.metadata) : [];
			if (optionalPlugins.length > 0) {
				lines.push("");
				lines.push("## Plugin availability");
				lines.push("");
				for (const pluginId of optionalPlugins) {
					const { status, displayName } = pluginStatus?.(pluginId) ?? {
						status: "missing",
						displayName: pluginId,
					};
					lines.push(`- ${displayName} (\`${pluginId}\`): ${STATUS_TEXT[status]}`);
				}
			}

			lines.push("");
			lines.push("## Instructions");
			lines.push("");
			lines.push(skill.content);

			return lines.join("\n");
		},
		{
			name: "load_skill",
			description: `Load detailed instructions for a specific skill. Use this tool when you need specific guidance on how to perform a task that matches one of the available skills. Available skills: ${skillNames.join(", ")}`,
			schema: z.object({
				skillName: z.enum(skillNames as [string, ...string[]]).describe("The name of the skill to load"),
			}),
		},
	);
}
