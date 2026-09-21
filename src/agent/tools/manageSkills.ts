import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import type { App } from "obsidian";
import { z } from "zod";
import { recordSkillLoaded, skillLoadState } from "./skillLoadRegistry";
import type { BuiltInToolId, SkillMetadata } from "../../types/plugin";
import type { SkillsService } from "../../skills/SkillsService";
import { parseFrontmatter } from "../../skills/SkillsService";
import { validateFrontmatter, validateSkillName } from "../../skills/validation";
import { BUNDLED_CORE_SKILLS, BUNDLED_INTEGRATION_SKILLS } from "../../skills/defaults";
import { isInternalPluginEnabled } from "../integrations/pluginIntegrations";
import { getData } from "../../stores/dataStore.svelte";
import { skillsDir } from "../../utils/agentPaths";
import { Logger as Log } from "../../utils/logging";

const SKILL_FILENAME = "SKILL.md";

/**
 * Built-in tools an agent-created skill may request via `allowedTools`. Deliberately narrow and
 * read-only: excludes anything that mutates the vault (`manage_notes`), runs arbitrary code
 * (`execute_javascript`), calls out to the network (`fetch_url`, `web_search`), or grants
 * skill-authoring itself (`manage_skills`) — an agent must never be able to grant itself a new
 * capability by writing a skill that requests it. Since create/delete apply immediately with no
 * review step, this list is the only guard against self-expanding capability.
 */
const CREATABLE_SKILL_ALLOWED_TOOLS = new Set<BuiltInToolId>([
	"search_notes",
	"read_content",
	"list_directory",
	"grep_notes",
	"get_all_tags",
	"get_properties",
]);

/**
 * Skills the given agent is attached to (enabled). Mirrors the enable-state resolution in
 * AgentManager.assembleSystemPrompt: a skill is attached unless explicitly disabled for the agent.
 */
function getAttachedSkillNames(skillsService: SkillsService, agentId: string): string[] {
	const agent = getData().getAgent(agentId) ?? getData().getSelectedAgent();
	const agentSkills = agent?.skills ?? {};
	return Array.from(skillsService.getCachedSkills().keys()).filter((name) => agentSkills[name]?.enabled ?? true);
}

/**
 * True when `skillName` is re-seeded by SkillsService.bootstrapDefaultSkills on every startup —
 * every bundled core skill, plus any bundled core-plugin integration skill (Canvas, Bases, …)
 * whose plugin is currently enabled. Deleting one of these is a confusing no-op: it silently
 * reappears on next launch. Community-plugin integration skills are excluded — those seed only
 * on-demand when the user enables the integration, so deleting one is a real, durable delete.
 * Mirrors SkillsService.getStartupSeedSkills' selection.
 */
function isReseededOnStartup(app: App, skillName: string): boolean {
	if (BUNDLED_CORE_SKILLS.some((s) => s.name === skillName)) return true;
	const integrationSkill = BUNDLED_INTEGRATION_SKILLS.find((s) => s.name === skillName);
	return !!integrationSkill?.corePluginId && isInternalPluginEnabled(app, integrationSkill.corePluginId);
}

/**
 * Rebuild a SKILL.md's raw text, replacing the body and optionally the `description:` frontmatter
 * line while leaving the rest of the frontmatter block byte-for-byte intact. We edit the raw string
 * (rather than parse → serialize) so unrecognized frontmatter keys, ordering, and formatting are
 * preserved — SkillsService.serializeSkillMd is lossy and would reformat the file.
 */
/** The line ending a file uses; CRLF if any line does. */
function lineEndingOf(raw: string): string {
	return raw.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Convert model-supplied text to a file's line ending. `load_skill` shows the model an LF
 * body whatever the file uses (see `parseFrontmatter`), so a passage it copies back, or a
 * body it writes, carries LF; matching or writing that into a CRLF file verbatim would miss
 * every multi-line passage and leave the file with mixed endings.
 */
function toLineEnding(text: string, eol: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\n/g, eol);
}

function rebuildSkillMd(raw: string, newBody: string, newDescription?: string): string | null {
	// Keep the file's own line endings: a CRLF skill rebuilt with LF would read as a whole-file
	// change to sync and to the shipped-history fingerprint alike.
	const eol = lineEndingOf(raw);
	const lines = raw.split(eol);
	if (lines[0]?.trim() !== "---") return null;

	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			endIndex = i;
			break;
		}
	}
	if (endIndex === -1) return null;

	const frontmatterLines = lines.slice(1, endIndex);

	if (newDescription !== undefined) {
		// Replace only the top-level `description:` line (not an indented metadata key).
		const descIdx = frontmatterLines.findIndex((line) => /^description:\s*/.test(line));
		if (descIdx === -1) {
			// No existing description line — insert one after `name:` (or at the top).
			const nameIdx = frontmatterLines.findIndex((line) => /^name:\s*/.test(line));
			frontmatterLines.splice(nameIdx + 1, 0, `description: ${newDescription}`);
		} else {
			frontmatterLines[descIdx] = `description: ${newDescription}`;
		}
	}

	return ["---", ...frontmatterLines, "---", "", toLineEnding(newBody.trim(), eol), ""].join(eol);
}

/**
 * A SKILL.md split at the byte after its closing `---` line: the frontmatter block (verbatim,
 * newline included) and the body. Null when the file has no well-formed frontmatter. A patch is
 * spliced into `body` and the two halves re-joined, so every byte outside the matched passage —
 * indentation, trailing whitespace, CRLF line endings — survives untouched; only the whole-body
 * `update` path goes through the normalizing {@link rebuildSkillMd}. Patches never search the
 * frontmatter: its fields are either locked (name, plugin link) or have their own path
 * (description via update).
 */
function splitSkillMd(raw: string): { head: string; body: string } | null {
	const lines = raw.split("\n");
	if (lines[0]?.trim() !== "---") return null;
	const endIndex = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
	if (endIndex === -1) return null;
	// Length of lines[0..endIndex] plus one "\n" after each of them.
	const headLength = lines.slice(0, endIndex + 1).reduce((sum, line) => sum + line.length + 1, 0);
	return { head: raw.slice(0, headLength), body: raw.slice(headLength) };
}

/**
 * `metadata.author` value stamped on every skill the agent creates. Bundled skills carry
 * `S2B` in the same key and hand-written ones carry whatever the user put there (or nothing),
 * so one existing key tells the three apart — which is what lets anything autonomous later
 * (a curator) confine itself to the agent's own skills. A fixed word rather than the agent's
 * name: consumers need no list of agent names, and a renamed or deleted agent changes nothing.
 */
export const AGENT_SKILL_AUTHOR = "agent";

/** Build a new SKILL.md's raw text: minimal frontmatter plus body. */
function buildNewSkillMd(name: string, description: string, body: string, allowedTools: string[]): string {
	const lines = ["---", `name: ${name}`, `description: ${description}`];
	if (allowedTools.length > 0) lines.push(`allowed-tools: ${allowedTools.join(" ")}`);
	lines.push("metadata:", `  author: ${AGENT_SKILL_AUTHOR}`);
	lines.push("---", "", body.trim(), "");
	return lines.join("\n");
}

const createOperationSchema = z.object({
	type: z.literal("create"),
	name: z
		.string()
		.describe(
			"Lowercase-hyphen slug for the new skill, e.g. 'weekly-review'. Becomes both the folder name and frontmatter name.",
		),
	description: z.string().describe("One-line description of what the skill does and when to use it."),
	body: z.string().describe("The skill's instructions (markdown body, without frontmatter)."),
	allowedTools: z
		.array(z.string())
		.optional()
		.describe(
			"Optional built-in tools to attach to the new skill. Only a fixed read-only subset is actually granted (search_notes, read_content, list_directory, grep_notes, get_all_tags, get_properties); anything else is silently dropped.",
		),
});

const deleteOperationSchema = z.object({
	type: z.literal("delete"),
	name: z.string().describe("The name of the skill to delete. Built-in core skills cannot be deleted."),
});

const patchOperationSchema = z.object({
	type: z.literal("patch"),
	skillName: z.string().describe("The name of the attached skill to patch. Load it with load_skill first."),
	oldText: z
		.string()
		.min(1)
		.describe(
			"The exact passage to replace, copied from the loaded skill body. Must match exactly once — include enough surrounding text to make it unique.",
		),
	newText: z.string().describe("The replacement. An empty string deletes the passage."),
});

const updateOperationSchema = z.object({
	type: z.literal("update"),
	skillName: z.string().describe("The name of the attached skill to rewrite. Load it with load_skill first."),
	newBody: z
		.string()
		.describe(
			"The new full instructions (markdown body, without frontmatter). Replaces the existing body — prefer patch for a targeted change.",
		),
	newDescription: z
		.string()
		.optional()
		.describe("Optional new one-line description of what the skill does and when to use it."),
});

const manageSkillsSchema = z.discriminatedUnion("type", [
	createOperationSchema,
	patchOperationSchema,
	updateOperationSchema,
	deleteOperationSchema,
]);

/**
 * Checks shared by every revision path: the result must still be a valid skill, and the fields
 * the rest of the system wires on (name, plugin link, category) must not have moved. Returns the
 * rejection to hand back, or null when the revision may be written.
 */
function rejectInvalidRevision(
	metadata: { path: string; frontmatter: SkillMetadata["frontmatter"] },
	newContent: string,
) {
	const dirName = metadata.path.split("/").pop() ?? "";
	const { frontmatter: newFm } = parseFrontmatter(newContent);
	const validation = validateFrontmatter(newFm, dirName);
	if (!validation.valid) {
		return `Edit rejected — the result would be an invalid skill: ${validation.errors.map((e) => e.message).join(", ")}`;
	}
	const oldFm = metadata.frontmatter;
	if (newFm.name !== oldFm.name) {
		return "Edit rejected — a skill's name cannot change (would break its folder and wiring).";
	}
	if (
		newFm.metadata?.linkedPlugin !== oldFm.metadata?.linkedPlugin ||
		newFm.metadata?.corePluginId !== oldFm.metadata?.corePluginId ||
		newFm.metadata?.category !== oldFm.metadata?.category
	) {
		return "Edit rejected — a skill's plugin link and category are locked; only the body and description can change.";
	}
	return null;
}

type ManageSkillsInput = z.infer<typeof manageSkillsSchema>;

/**
 * Tool letting an agent create new skills, revise skills attached to it, or delete skills it
 * created. All three operations apply immediately — there is no staging/review step, unlike
 * manage_notes. A created skill is given no explicit `agent.skills` entry, so it reads as
 * attached the moment its file exists (agent.skills[id]?.enabled ?? true): creating IS attaching,
 * with no separate manual "enable" step.
 */
export function createManageSkillsTool(skillsService: SkillsService | undefined, app: App, agentId = "") {
	// For the description only; the checks below re-resolve per call so a skill created
	// earlier in the same turn is already attached when the model patches it.
	const attachedAtBuild = skillsService ? getAttachedSkillNames(skillsService, agentId) : [];

	if (!skillsService) {
		return tool(async () => "Skills are not available yet.", {
			name: "manage_skills",
			description: "Create, update, or delete skills. Skills are not available yet.",
			schema: manageSkillsSchema,
		});
	}

	return tool(
		async (input: ManageSkillsInput, config?: RunnableConfig) => {
			const threadId: string | undefined = config?.configurable?.thread_id;
			const attached = getAttachedSkillNames(skillsService, agentId);

			if (input.type === "create") {
				const nameValidation = validateSkillName(input.name);
				if (!nameValidation.valid) {
					return `Cannot create skill — invalid name: ${nameValidation.errors.map((e) => e.message).join(", ")}`;
				}

				const skillDir = `${skillsDir()}/${input.name}`;
				const skillPath = `${skillDir}/${SKILL_FILENAME}`;
				if (await app.vault.adapter.exists(skillPath)) {
					return `A skill named "${input.name}" already exists. Choose a different name, or use the update operation to revise it.`;
				}

				const requested = input.allowedTools ?? [];
				const granted = requested.filter((t) => CREATABLE_SKILL_ALLOWED_TOOLS.has(t as BuiltInToolId));
				const dropped = requested.filter((t) => !granted.includes(t));

				const content = buildNewSkillMd(input.name, input.description, input.body, granted);
				const { frontmatter } = parseFrontmatter(content);
				const validation = validateFrontmatter(frontmatter, input.name);
				if (!validation.valid) {
					return `Cannot create skill — invalid result: ${validation.errors.map((e) => e.message).join(", ")}`;
				}

				if (!(await app.vault.adapter.exists(skillDir))) await app.vault.adapter.mkdir(skillDir);
				// Through the service so the discovery cache holds the new skill at once: the
				// vault watcher's re-discovery is debounced, and a patch later in this same turn
				// looks the skill up in that cache.
				await skillsService.writeSkillFile(input.name, content);
				// The model wrote this text, so it may patch it in this conversation without a load.
				recordSkillLoaded(threadId, input.name, parseFrontmatter(content).body);

				const droppedNote =
					dropped.length > 0 ? ` Dropped disallowed tool request(s): ${dropped.join(", ")}.` : "";
				return `Created and attached the "${input.name}" skill${granted.length > 0 ? ` with tools: ${granted.join(", ")}` : ""}.${droppedNote}`;
			}

			if (input.type === "delete") {
				const metadata = skillsService.getCachedSkills().get(input.name);
				if (!metadata) {
					return `Skill "${input.name}" not found.`;
				}
				if (isReseededOnStartup(app, input.name)) {
					return `Skill "${input.name}" is a built-in core skill and cannot be deleted — it would just reappear on next startup.`;
				}
				if (!attached.includes(input.name)) {
					return `Skill "${input.name}" is not attached to this agent, so it cannot be deleted here.`;
				}

				try {
					await app.vault.adapter.rmdir(metadata.path, true);
				} catch (error) {
					Log.error(`manage_skills: failed to delete ${metadata.path}`, error);
					return `Could not delete the skill folder at "${metadata.path}".`;
				}

				// Drop the stale enable-state entry so nothing inherits it later, and the usage
				// counters so a later skill of the same name starts from zero.
				const agent = getData().getAgent(agentId) ?? getData().getSelectedAgent();
				if (agent?.skills[input.name]) delete agent.skills[input.name];
				getData().forgetSkillUsage(input.name);

				return `Deleted the "${input.name}" skill.`;
			}

			// input.type === "patch" | "update" — both revise an existing, attached skill.
			const { skillName } = input;
			const metadata = skillsService.getCachedSkills().get(skillName);
			if (!metadata) {
				return `Skill "${skillName}" not found. Attached skills: ${attached.join(", ")}`;
			}
			if (!attached.includes(skillName)) {
				return `Skill "${skillName}" is not attached to this agent, so it cannot be edited here.`;
			}
			const skillPath = `${metadata.path}/${SKILL_FILENAME}`;
			let originalContent: string;
			try {
				originalContent = await app.vault.adapter.read(skillPath);
			} catch (error) {
				Log.error(`manage_skills: failed to read ${skillPath}`, error);
				return `Could not read the skill file at "${skillPath}".`;
			}

			// Read before write: a revision is written against text the model has actually seen
			// in this conversation — not a remembered or summarized copy, and not a version the
			// file has since moved past (see skillLoadRegistry). Fingerprinted through the same
			// parse `load_skill` returns, so the two sides always agree on what "the body" is.
			const loadState = skillLoadState(threadId, skillName, parseFrontmatter(originalContent).body);
			if (loadState === "not-loaded") {
				return `Load the "${skillName}" skill with load_skill first, then revise it: a revision must be written against the skill's current text as you have read it in this conversation.`;
			}
			if (loadState === "stale") {
				return `The "${skillName}" skill has changed since you loaded it. Load it again with load_skill and write the revision against its current text.`;
			}

			let newContent: string | null;
			let verb: string;
			if (input.type === "patch") {
				const split = splitSkillMd(originalContent);
				if (split === null) {
					return `Skill "${skillName}" has malformed frontmatter and cannot be safely edited.`;
				}
				const eol = lineEndingOf(originalContent);
				const oldText = toLineEnding(input.oldText, eol);
				const newText = toLineEnding(input.newText, eol);
				const occurrences = split.body.split(oldText).length - 1;
				if (occurrences === 0) {
					const inFrontmatter = split.head.includes(oldText);
					return inFrontmatter
						? `The passage is in the skill's frontmatter, which a patch cannot change. Use update with newDescription for the description; the other fields are locked.`
						: `Could not find that passage in the "${skillName}" skill's body. Copy oldText exactly from the loaded skill (including whitespace and line breaks), or load it again if it changed.`;
				}
				if (occurrences > 1) {
					return `That passage appears ${occurrences} times in the "${skillName}" skill. Include more surrounding text so oldText matches exactly once.`;
				}
				// Callback form so `$&`-style sequences in the replacement are inserted literally.
				newContent = split.head + split.body.replace(oldText, () => newText);
				verb = "Patched";
			} else {
				newContent = rebuildSkillMd(originalContent, input.newBody, input.newDescription);
				verb = "Updated";
			}
			if (newContent === null) {
				return `Skill "${skillName}" has malformed frontmatter and cannot be safely edited.`;
			}
			if (newContent === originalContent) {
				return "No changes made — the new content matches the current skill.";
			}

			const rejection = rejectInvalidRevision(metadata, newContent);
			if (rejection) return rejection;

			// Through the service: it refreshes this skill's cache entry (a changed description
			// is advertised on the next run) and re-evaluates a bundled skill against the shipped
			// history, so a revised core skill is flagged as customized rather than overwritten
			// by the next upgrade.
			await skillsService.writeSkillFile(skillName, newContent);
			getData().recordSkillRevision(skillName);
			// The model wrote this text too, so a follow-up revision in the same turn needs no reload.
			recordSkillLoaded(threadId, skillName, parseFrontmatter(newContent).body);

			return `${verb} the "${skillName}" skill.`;
		},
		{
			name: "manage_skills",
			description: `Create new skills, revise your own attached skills, or delete skills you created. Changes apply immediately — there is no review step. To revise, load the skill with load_skill first, then patch the exact passage that needs changing (update replaces the whole body; use it only to restructure). A skill's name and plugin link are locked once created. Attached skills: ${attachedAtBuild.join(", ")}`,
			schema: manageSkillsSchema,
		},
	);
}
