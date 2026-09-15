import { getAgentPathSource } from "./agentPathSource";

/**
 * Fixed subdirectory names under the configurable agent root folder. The root itself
 * (`agentFolder`, default "Agents") is user-configurable; these subdirs are not.
 *
 * - `Memories/` — the agents' shared working-memory notes (writes auto-approve here). Holds the
 *                 remembered *content*; the *instructions* for using it are the `# Memory`
 *                 section of each agent's own AGENT.md (see {@link agentDefinitionPath}).
 * - `Skills/`   — skill `<name>/SKILL.md` dirs (including the bundled core skills that carry
 *                 built-in tools via `allowed-tools`). Discovered by their SKILL.md marker.
 *
 * Everything else directly under the root is one folder per agent (see {@link agentDir}).
 */
const MEMORIES_SUBDIR = "Memories";
const SKILLS_SUBDIR = "Skills";

/**
 * The retired per-agent prompt folder, replaced by `<agentFolder>/<Agent Name>/AGENT.md`. The
 * name stays reserved in {@link sanitizeAgentFileName} only because a vault predating that
 * change can still have this tree on disk, and an agent literally named "System Prompts" must
 * not resolve its folder onto it.
 */
const LEGACY_SYSTEM_PROMPTS_SUBDIR = "System Prompts";

/** Filename of an agent's definition note inside its own folder. */
const AGENT_DEFINITION_FILENAME = "AGENT.md";

/** Default agent root folder when unset. */
const DEFAULT_AGENT_FOLDER = "Agents";

/** The configured agent root folder (falls back to the default before the store exists). */
export function agentRootDir(): string {
	return getAgentPathSource()?.agentFolder() || DEFAULT_AGENT_FOLDER;
}

/** `<agentFolder>/Memories` — shared memory notes folder. */
export function memoriesDir(): string {
	return `${agentRootDir()}/${MEMORIES_SUBDIR}`;
}

/** `<agentFolder>/Skills` — skills (including core skills) live directly under here. */
export function skillsDir(): string {
	return `${agentRootDir()}/${SKILLS_SUBDIR}`;
}

/** Placeholder folder name when an agent's name sanitizes to nothing. */
const FALLBACK_AGENT_FILE_NAME = "Agent";

/**
 * Folder names directly under the agent root that belong to plugin machinery, not to an agent.
 * An agent whose name sanitizes to one of these is suffixed rather than allowed to collide.
 */
const RESERVED_AGENT_FOLDER_NAMES = [MEMORIES_SUBDIR, SKILLS_SUBDIR, LEGACY_SYSTEM_PROMPTS_SUBDIR];

/**
 * Turn an agent's display name into a safe filesystem name (no extension), used for its
 * `<agentFolder>/<name>/` folder. Strips characters Obsidian/OSes reject in filenames,
 * collapses whitespace, trims leading/trailing dots & spaces, and caps length. Falls back to
 * a placeholder when the result would be empty (e.g. a name of only slashes).
 *
 * Names colliding with the fixed sibling folders ({@link RESERVED_AGENT_FOLDER_NAMES}) are
 * suffixed: agent folders are siblings of `Memories/` and `Skills/`, so an agent named
 * "Skills" would otherwise write its AGENT.md into the skills tree.
 */
export function sanitizeAgentFileName(name: string): string {
	const cleaned = (name ?? "")
		// Replace filename-illegal chars (path separators + reserved chars) and control chars (\p{Cc}) with a space.
		.replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		// Obsidian/OSes dislike leading/trailing dots; strip them, then re-trim any exposed space.
		.replace(/^\.+|\.+$/g, "")
		.trim()
		.slice(0, 100)
		.trim();
	if (!cleaned) return FALLBACK_AGENT_FILE_NAME;
	const reserved = RESERVED_AGENT_FOLDER_NAMES.some(
		(reservedName) => reservedName.toLowerCase() === cleaned.toLowerCase(),
	);
	// Re-cap after suffixing so a 100-char reserved name can't push the result over the limit.
	return reserved ? `${cleaned} (${FALLBACK_AGENT_FILE_NAME})`.slice(0, 100) : cleaned;
}

/**
 * An agent's own folder, named after the agent: `<agentFolder>/<Agent Name>/`. Holds that
 * agent's `AGENT.md`, and is the unit rename/duplicate/delete operate on.
 *
 * The name is derived from the agent's *current* display name (looked up live from plugin
 * data), so callers that only hold an agent id still get the right path. Agent display names
 * are kept unique by the data store (see `uniqueAgentName`), so the sanitized names don't
 * collide in practice. Unknown ids fall back to the raw id so stale lookups stay safe.
 */
export function agentDir(agentId: string): string {
	return `${agentRootDir()}/${agentFileStem(agentId)}`;
}

/**
 * Path to an agent's definition note: `<agentDir>/AGENT.md`. Its frontmatter carries the
 * plugin-managed provenance (`author`, `version`); its body IS the agent's system prompt,
 * memory instructions included.
 */
export function agentDefinitionPath(agentId: string): string {
	return `${agentDir(agentId)}/${AGENT_DEFINITION_FILENAME}`;
}

/**
 * The folder-name stem for an agent, derived from the agent's *current* display name so
 * callers holding only an id still resolve the right path. Agent names are kept unique by the
 * data store (see `uniqueAgentName`), so sanitized names don't collide in practice.
 * Unknown/stale ids (or a store that isn't ready) fall back to the id, keeping the path stable
 * and unique rather than throwing.
 */
function agentFileStem(agentId: string): string {
	const name = getAgentPathSource()?.agentName(agentId);
	return name === undefined ? agentId : sanitizeAgentFileName(name);
}
