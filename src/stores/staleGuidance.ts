import { SHIPPED_AGENT_PROMPTS } from "../agent/prompts";
import { t } from "../i18n";
import { currentSkillVersion } from "../skills/shippedSkills";
import type { AgentConfig, AgentsConfig, PromptFileReader, PromptFileSnapshot, StaleGuidance } from "../types/plugin";
import { type ShippedHistory, currentShippedVersion, shippedVersion } from "../utils/shippedDefaults";

/**
 * The file-backed prompt surface (`<Agent Name>/AGENT.md`), paired with the history it is
 * checked against and how its notice reads. A list of one: the memory instructions are now a
 * section of this same body rather than a second file, but the shape is kept so a future
 * surface is an entry rather than a refactor.
 */
const PROMPT_SURFACES = [
	{
		kind: "system-prompt",
		label: t("chat.recommendations.stale_label.system_prompt"),
		history: SHIPPED_AGENT_PROMPTS,
		read: (reader: PromptFileReader, agentId: string) => reader.getAgentPromptFile(agentId),
	},
] as const satisfies readonly {
	kind: StaleGuidance["kind"];
	label: string;
	history: ShippedHistory;
	read: (reader: PromptFileReader, agentId: string) => PromptFileSnapshot | null;
}[];

/**
 * Per-agent staleness for the file-backed prompt (`<Agent Name>/AGENT.md`): stale when the file
 * holds an OLD shipped default — i.e. the shipped default moved since the user's copy was
 * written, but the user never touched it, so we could not silently update it either (the file is
 * theirs to edit).
 *
 * A customization we don't recognize is deliberately NOT flagged: the user wrote it on
 * purpose, and nagging about it would be noise. Absence ⇒ the live default is used.
 *
 * Skill staleness is collected separately (skills are files under `Skills/`, not per-agent)
 * and folded in by {@link computeStaleGuidance}.
 */
function detectStaleGuidance(agent: AgentConfig, reader: PromptFileReader | null): StaleGuidance[] {
	if (!reader) return [];
	const stale: StaleGuidance[] = [];

	for (const surface of PROMPT_SURFACES) {
		const file = surface.read(reader, agent.id);
		if (file === null) continue;
		const current = currentShippedVersion(surface.history);
		const version = shippedVersion(file.body, surface.history);

		if (version === null) {
			// The user's own text. It matches no shipped fingerprint, so the body alone
			// can't say whether the default has moved since they wrote it — that's what the
			// note's `version` frontmatter records. Only flag when we have a baseline AND it
			// has been superseded; an absent baseline (e.g. the user removed the frontmatter)
			// stays silent rather than asserting drift we can't substantiate.
			const stamp = file.version;
			if (stamp === undefined || stamp === current) continue;
			stale.push({
				agentId: agent.id,
				agentName: agent.name,
				kind: surface.kind,
				label: surface.label,
				currentVersion: current,
				// Their edit is intact — we never touch a customized file.
				customized: true,
			});
			continue;
		}

		// An OLD shipped default, verbatim: PromptFilesService.seedDefaults rewrites these
		// silently at startup, so reaching here means that rewrite failed (or hasn't run
		// against this file yet). Surface it — but not as a "customization".
		if (version === current) continue;
		stale.push({
			agentId: agent.id,
			agentName: agent.name,
			kind: surface.kind,
			label: surface.label,
			currentVersion: current,
			customized: false,
		});
	}

	return stale;
}

/**
 * Aggregates staleness across all surfaces (pure, no mutation): the per-agent file-backed
 * prompts, plus the bundled skills whose shipped body moved while the user held an edited
 * copy. `reader` is null before the prompt-file layer is ready; `staleSkills` is empty until
 * skill bootstrap has run.
 *
 * Skill records carry no agentId — a skill is a single vault file shared by every agent, not
 * per-agent state — so their notice keys off `global` (see `updateNoticeId`).
 */
export function computeStaleGuidance(
	agents: AgentsConfig,
	reader: PromptFileReader | null,
	staleSkills: readonly string[],
): StaleGuidance[] {
	const stale: StaleGuidance[] = [];
	for (const agent of Object.values(agents)) stale.push(...detectStaleGuidance(agent, reader));
	for (const skillName of staleSkills) {
		stale.push({
			kind: "skill",
			label: t("chat.recommendations.stale_label.skill", { name: skillName }),
			skillName,
			currentVersion: currentSkillVersion(skillName),
			// A skill is only reported when its body matches NO shipped version — the user
			// edited it, and the edit was preserved.
			customized: true,
		});
	}
	return stale;
}
