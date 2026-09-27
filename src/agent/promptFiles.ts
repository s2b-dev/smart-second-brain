import type { App, FileManager, Vault } from "obsidian";
import { SvelteMap } from "svelte/reactivity";
import type { AgentsConfig, PromptFileReader, PromptFileSnapshot } from "../types/plugin";
import { agentDefinitionPath, agentDir, agentRootDir } from "../utils/agentPaths";
import { Logger as Log } from "../utils/logging";
import { currentShippedVersion, shippedVersion } from "../utils/shippedDefaults";
import { DEFAULT_AGENT_PROMPT, SHIPPED_AGENT_PROMPTS } from "./prompts";

// --- note frontmatter ---------------------------------------------------------------------
//
// Each agent definition note carries a small plugin-managed frontmatter block, mirroring how
// bundled skills carry theirs in SKILL.md:
//
//     ---
//     author: S2B
//     version: 1
//     ---
//
// `version` is the shipped baseline the body was last written from — the same role the old
// `AgentConfig.promptBaseVersions` stamp played, but stored IN the note so it travels with
// the file through vault sync, copies, and backups, and is visible to the user as Obsidian
// properties. The keys are deliberately flat (not nested under `metadata:` like SKILL.md):
// Obsidian's Properties UI renders flat keys natively and nested objects poorly, and unlike
// a skill's frontmatter nothing here is model-facing, so there is no spec to match.
//
// Everything model-facing works on the BODY only: assembly, the diff modal, and the shipped
// fingerprints all use the frontmatter-stripped text, so restamping the version never reads
// as a content customization.

const PROMPT_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const VERSION_LINE_RE = /^version:\s*["']?(\d+)["']?\s*$/m;

/** Parse an agent definition note into its frontmatter-stripped body and baseline version. */
export function parsePromptFile(raw: string): PromptFileSnapshot {
	const match = raw.match(PROMPT_FRONTMATTER_RE);
	if (!match) return { body: raw.trim(), version: undefined };
	const versionMatch = match[1].match(VERSION_LINE_RE);
	return {
		body: raw.slice(match[0].length).trim(),
		version: versionMatch ? Number(versionMatch[1]) : undefined,
	};
}

/** Serialize a prompt body with the standard plugin-managed frontmatter block. */
export function serializePromptFile(body: string, version: number | string): string {
	return `---\nauthor: S2B\nversion: ${version}\n---\n\n${body}\n`;
}

/**
 * Stamp `version` into a note's frontmatter while leaving the body — and any user-added
 * frontmatter keys — untouched. A note without frontmatter gets the standard block prepended.
 */
function stampPromptVersion(raw: string, version: number | string): string {
	const match = raw.match(PROMPT_FRONTMATTER_RE);
	if (!match) return serializePromptFile(raw.trim(), version);
	// Normalize CRLF first: a file round-tripped through an editor can carry \r, and keeping
	// it would leave a stray carriage return inside the rewritten YAML values.
	const block = match[1].replace(/\r\n/g, "\n");
	const newBlock = VERSION_LINE_RE.test(block)
		? block.replace(VERSION_LINE_RE, `version: ${version}`)
		: `${block}\nversion: ${version}`;
	// Replacement via callback so `$`-sequences in user frontmatter can't act as patterns.
	return raw.replace(PROMPT_FRONTMATTER_RE, () => `---\n${newBlock}\n---\n`);
}

/**
 * Replace a note's BODY with `body`, stamped at `version`, keeping every other frontmatter
 * key the note already had.
 *
 * Used by the two reconcile paths that rewrite an untouched note (silent update to a newer
 * shipped default; canonical re-stamp of a current-default body). Serializing from scratch
 * there would emit only `author`/`version` and so silently delete properties the user added
 * to a note they never edited the text of — a plain data loss, and exactly the case where
 * they had no reason to expect us to touch the file at all.
 */
function replacePromptBody(raw: string, body: string, version: number | string): string {
	const match = raw.match(PROMPT_FRONTMATTER_RE);
	if (!match) return serializePromptFile(body, version);
	// Stamp the version into the EXISTING block, then swap the body in behind it.
	const stamped = stampPromptVersion(raw, version);
	const stampedMatch = stamped.match(PROMPT_FRONTMATTER_RE);
	if (!stampedMatch) return serializePromptFile(body, version);
	return `${stampedMatch[0].trimEnd()}\n\n${body}\n`;
}

/**
 * File-backed store for each agent's definition note, `<agentFolder>/<Agent Name>/AGENT.md`.
 *
 * The note's body IS the agent's system prompt — base instructions, the `# Current Date`
 * section, and the `# Memory` section all in one editable place, with live values written as
 * placeholders that assembly substitutes (see `prompts.ts`). Deleting a section is how a user
 * opts out of it; deleting `# Memory` is how memory gets disabled, since there is no toggle.
 *
 * The code constant `DEFAULT_AGENT_PROMPT` remains the factory default the diff/reset UI
 * compares against; the file is the editable copy, carrying a plugin-managed frontmatter block
 * recording its shipped baseline (see the frontmatter section above). Content is read through
 * the Vault API — these are ordinary user-editable notes, so reads hit Obsidian's cache and the
 * reconcile rewrites go through `Vault.process`, which is atomic against a user editing the
 * same note — and cached in memory (parsed, body + version) so the synchronous, reactive
 * staleness getter and the frequently-called system-prompt assembly don't hit disk on the hot
 * path. Call {@link refresh} after any write / vault change to the agent folder.
 *
 * Because the note lives in a folder of its own, rename/duplicate/delete are directory
 * operations ({@link renameAgentDir}, {@link deleteAgentDir}).
 *
 * (Skill guidance is not stored here — the former capabilities are core *skills*, whose guidance
 * is the skill body under `Skills/<name>/SKILL.md`, edited via the note.)
 */
export class PromptFilesService {
	private vault: Vault;
	private fileManager: FileManager;

	/**
	 * agentId → parsed note. An absent key means "file missing, use the default".
	 *
	 * Reactive, and mutated in place rather than reassigned: the data store's `staleGuidance`
	 * getter and the Agent editor's drift check read it inside `$derived`s, so a write (e.g.
	 * "Use default" in the diff modal) must re-run them. With a plain Map the update notice
	 * outlived the fix until reload, and clicking it again opened a diff with nothing in it.
	 */
	private readonly cache = new SvelteMap<string, PromptFileSnapshot>();

	constructor(app: App) {
		this.vault = app.vault;
		this.fileManager = app.fileManager;
	}

	/** A synchronous reader over the cache, injected into the data store for staleness detection. */
	get reader(): PromptFileReader {
		return {
			getAgentPromptFile: (agentId) => this.cache.get(agentId) ?? null,
		};
	}

	/** Cached definition body for an agent, or DEFAULT_AGENT_PROMPT when the file is absent. */
	getAgentPrompt(agentId: string): string {
		const cached = this.cache.get(agentId);
		return cached?.body.trim() ? cached.body : DEFAULT_AGENT_PROMPT;
	}

	/**
	 * Seed default notes on first run, and keep untouched ones current on every run.
	 *
	 * - Absent → write the factory default.
	 * - Present with a body matching an OLD shipped default → the user never edited it, so the
	 *   moved default is applied silently (same contract as `SkillsService.reconcileBundledSkill`).
	 *   Without this, an untouched install would be stuck on the old prompt with only a
	 *   notice asking the user to reset by hand.
	 * - Present with a body matching the CURRENT default but missing/stale frontmatter → the
	 *   note is rewritten canonically (self-heal; also how pre-frontmatter files upgrade).
	 * - Present with the user's own body → never clobbered. If the note carries no `version`
	 *   baseline yet, one is stamped into the frontmatter at the current version — not
	 *   backdated, which would fire a notice about a change the edit may already incorporate —
	 *   so drift is detectable from now on. If the shipped default later moves, the staleness
	 *   getter surfaces a notice.
	 */
	async seedDefaults(agents: AgentsConfig): Promise<void> {
		await this.ensureRoot();

		const current = currentShippedVersion(SHIPPED_AGENT_PROMPTS);
		for (const agentId of Object.keys(agents)) {
			const path = agentDefinitionPath(agentId);
			try {
				const file = this.vault.getFileByPath(path);
				if (file) {
					// Decide from a cheap cached read; only when a rewrite is due does the file
					// get touched, with the decision RE-DERIVED inside `Vault.process` so it
					// applies to whatever is on disk at write time — the user may have the note
					// open in an editor right now.
					const initialRaw = await this.vault.cachedRead(file);
					if (reconcileExistingRaw(initialRaw, current) !== null) {
						await this.vault.process(file, (raw) => reconcileExistingRaw(raw, current) ?? raw);
						const matched = shippedVersion(parsePromptFile(initialRaw).body, SHIPPED_AGENT_PROMPTS);
						if (matched !== null && matched !== current) {
							Log.info(`Updated agent prompt for ${agentId} from shipped v${matched} to current`);
						}
					}
					continue;
				}
				await this.ensureParent(path);
				await this.vault.create(
					path,
					current !== undefined ? serializePromptFile(DEFAULT_AGENT_PROMPT, current) : DEFAULT_AGENT_PROMPT,
				);
			} catch (error) {
				Log.error(`Failed to seed agent prompt for ${agentId}:`, error);
			}
		}
	}

	/** Re-read all definition notes into the cache. Cheap: a bounded set of files. */
	async refresh(agents: AgentsConfig): Promise<void> {
		const next = new Map<string, PromptFileSnapshot>();
		for (const agentId of Object.keys(agents)) {
			const path = agentDefinitionPath(agentId);
			try {
				const file = this.vault.getFileByPath(path);
				if (file) {
					next.set(agentId, parsePromptFile(await this.vault.cachedRead(file)));
				}
			} catch (error) {
				Log.error(`Failed to read agent prompt for ${agentId}:`, error);
			}
		}
		// Swap in one synchronous step, so readers never observe a half-refreshed cache.
		this.cache.clear();
		for (const [agentId, snapshot] of next) this.cache.set(agentId, snapshot);
	}

	/**
	 * Write an agent's definition body to its note (stamped at the CURRENT shipped version —
	 * including when the user saves a customization: at that moment their edit is, by
	 * definition, based on today's default. A later bump then makes `version !== current` true
	 * and the drift notice fires exactly once) and update the cache.
	 */
	async writeAgentPrompt(agentId: string, text: string): Promise<void> {
		const path = agentDefinitionPath(agentId);
		const body = text.trim();
		const current = currentShippedVersion(SHIPPED_AGENT_PROMPTS);
		await this.writeFile(path, current !== undefined ? serializePromptFile(body, current) : body);
		this.cache.set(agentId, { body, version: typeof current === "number" ? current : undefined });
	}

	/** Ensure an agent's definition note exists (seed from the default if absent). */
	async ensureAgentPrompt(agentId: string): Promise<void> {
		if (!this.vault.getFileByPath(agentDefinitionPath(agentId))) {
			await this.writeAgentPrompt(agentId, DEFAULT_AGENT_PROMPT);
		}
	}

	/** Reset an agent's definition note to the current DEFAULT_AGENT_PROMPT. */
	async resetAgentPrompt(agentId: string): Promise<void> {
		await this.writeAgentPrompt(agentId, DEFAULT_AGENT_PROMPT);
	}

	/**
	 * Remove an agent's entire folder. Call when an agent is deleted so its note doesn't outlive
	 * it. Goes through the user's configured "Deleted files" preference (`FileManager.trashFile`)
	 * rather than a hard delete — the note can carry the user's own prompt text, so it stays
	 * recoverable. Best-effort.
	 */
	async deleteAgentDir(agentId: string): Promise<void> {
		const dir = agentDir(agentId);
		try {
			const folder = this.vault.getFolderByPath(dir);
			if (folder) await this.fileManager.trashFile(folder);
		} catch (error) {
			Log.debug(`Could not remove agent folder for ${agentId}:`, error);
		}
		this.cache.delete(agentId);
	}

	/**
	 * Reconcile an agent's folder to its current name-based path. Call after an agent is renamed,
	 * passing the folder path captured BEFORE the rename was committed: if a folder exists at the
	 * old path and the desired path (derived from the agent's current name) differs, rename it on
	 * disk so the folder tracks the agent name. Goes through `FileManager.renameFile`, so any
	 * links the user made to the note are updated too. The cache is keyed by id, so it needs no
	 * update. Best-effort.
	 */
	async renameAgentDir(agentId: string, oldDir: string): Promise<void> {
		const newDir = agentDir(agentId);
		if (newDir === oldDir) return;
		try {
			const folder = this.vault.getFolderByPath(oldDir);
			if (!folder) return;
			// Don't clobber an existing folder at the target (e.g. a collision resolved elsewhere).
			if (this.vault.getFolderByPath(newDir) || this.vault.getFileByPath(newDir)) return;
			await this.ensureParent(newDir);
			await this.fileManager.renameFile(folder, newDir);
		} catch (error) {
			Log.debug(`Could not rename agent folder for ${agentId}:`, error);
		}
	}

	/**
	 * Copy one agent's definition note to another (used when duplicating an agent), so the copy
	 * inherits the source's edited prompt rather than starting from the bare default.
	 *
	 * The note is copied VERBATIM: the baseline version lives in the file's frontmatter, so
	 * the duplicate inherits the source's provenance automatically — including an older
	 * baseline (the copied customization keeps the drift notice it is owed) and "no baseline"
	 * for a note whose frontmatter the user removed. An agent with no source note gets the
	 * current factory default.
	 */
	async copyAgentPrompt(fromId: string, toId: string): Promise<void> {
		const src = this.vault.getFileByPath(agentDefinitionPath(fromId));
		if (!src) {
			await this.writeAgentPrompt(toId, DEFAULT_AGENT_PROMPT);
			return;
		}
		const raw = await this.vault.read(src);
		await this.writeFile(agentDefinitionPath(toId), raw);
		this.cache.set(toId, parsePromptFile(raw));
	}

	/**
	 * Full-content upsert: modify the note when it exists, else create it (with its parent
	 * folder). Used for writes whose content does NOT derive from what's on disk — modal
	 * saves, resets, and duplication — where `Vault.modify` is the right tool; the
	 * derive-from-current reconciles in {@link seedDefaults} go through `Vault.process`.
	 */
	private async writeFile(path: string, content: string): Promise<void> {
		const existing = this.vault.getFileByPath(path);
		if (existing) {
			await this.vault.modify(existing, content);
			return;
		}
		await this.ensureParent(path);
		await this.vault.create(path, content);
	}

	/**
	 * Create the configurable agent-root folder. The `agentFolder` setter's createFolder is
	 * unawaited, so a runtime folder change could reach here before the root exists; ensuring it
	 * explicitly avoids a silent seed failure into a stale folder. Per-agent folders are created
	 * on demand by `ensureParent` in {@link writeFile}.
	 */
	private async ensureRoot(): Promise<void> {
		const root = agentRootDir();
		try {
			if (!this.vault.getFolderByPath(root)) await this.vault.createFolder(root);
		} catch (error) {
			Log.error(`Failed to create ${root}:`, error);
		}
	}

	/** Ensure the immediate parent directory of a file path exists. */
	private async ensureParent(filePath: string): Promise<void> {
		const parent = filePath.slice(0, filePath.lastIndexOf("/"));
		if (!parent) return;
		if (!this.vault.getFolderByPath(parent)) {
			await this.vault.createFolder(parent);
		}
	}
}

/**
 * The seeding decision for an EXISTING note as a pure raw → raw transform: returns the
 * rewritten file content, or null when the note needs no touch. Pure so `seedDefaults` can
 * use it twice — once on a cached read to decide whether to write at all (avoiding an mtime
 * bump on every startup), then again inside `Vault.process` so the rewrite is derived from
 * the note's content at write time, not from the earlier read.
 */
function reconcileExistingRaw(raw: string, current: number | string | undefined): string | null {
	if (current === undefined) return null;
	const parsed = parsePromptFile(raw);
	const matched = shippedVersion(parsed.body, SHIPPED_AGENT_PROMPTS);
	if (matched === null) {
		// The user's own text: leave the body alone, but back-fill a baseline into the
		// frontmatter when the note has none.
		return parsed.version === undefined ? stampPromptVersion(raw, current) : null;
	}
	if (matched !== current) {
		// An untouched old default: swap in the new body, but keep any frontmatter keys
		// the user added to the note (see replacePromptBody).
		return replacePromptBody(raw, DEFAULT_AGENT_PROMPT, current);
	}
	if (parsed.version !== current) {
		// Body is already the current default; only the metadata is missing or stale.
		// Re-stamp in place.
		return replacePromptBody(raw, DEFAULT_AGENT_PROMPT, current);
	}
	return null;
}
