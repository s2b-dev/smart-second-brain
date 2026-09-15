/**
 * Service for managing Agent Skills per specification.
 * @see https://agentskills.io/specification
 */

import type { DataAdapter, Plugin } from "obsidian";
import type { Skill, SkillCategory, SkillEnableState, SkillFrontmatter, SkillMetadata } from "../types/plugin";
import { getData } from "../stores/dataStore.svelte";
import { agentRootDir, skillsDir } from "../utils/agentPaths";
import { Logger as Log } from "../utils/logging";
import { StartupProfiler } from "../utils/startupProfiler";
import {
	BUNDLED_CORE_SKILLS,
	BUNDLED_INTEGRATION_SKILLS,
	BUNDLED_SKILLS,
	type BundledSkill,
	getBundledIntegrationSkillForPlugin,
} from "./defaults";
import { isInternalPluginEnabled } from "../agent/integrations/pluginIntegrations";
import { buildPluginApiSkill } from "./templates/pluginApiScripting";
import { RELEASED_EDIT_NOTES_FINGERPRINTS, SHIPPED_SKILL_HISTORY, currentSkillVersion } from "./shippedSkills";
import { fingerprint, shippedVersion } from "../utils/shippedDefaults";
import { validateFrontmatter, type ValidationResult } from "./validation";

/** SKILL.md filename per spec */
const SKILL_FILENAME = "SKILL.md";

/** Legacy skills directory name under the vault config dir, kept for one-time migration. */
const LEGACY_CONFIG_SKILLS_DIR = "skills";

/** Prior (v4) skills location: a top-level vault folder named "Skills". Migrated into the agent folder's Skills/. */
const LEGACY_VAULT_SKILLS_DIR = "Skills";

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Frontmatter is delimited by --- at start and end on their own lines.
 */
function parseFrontmatter(content: string): { frontmatter: Partial<SkillFrontmatter>; body: string } {
	const lines = content.split("\n");

	// Check for opening ---
	if (lines[0]?.trim() !== "---") {
		return { frontmatter: {}, body: content };
	}

	// Find closing ---
	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			endIndex = i;
			break;
		}
	}

	if (endIndex === -1) {
		return { frontmatter: {}, body: content };
	}

	// Parse YAML frontmatter (simple key: value parsing)
	const frontmatterLines = lines.slice(1, endIndex);
	const frontmatter: Partial<SkillFrontmatter> = {};
	const metadata: Record<string, string> = {};
	let inMetadata = false;

	for (const line of frontmatterLines) {
		// Handle metadata block
		if (line.trim() === "metadata:") {
			inMetadata = true;
			continue;
		}

		if (inMetadata) {
			// Check if we've exited metadata block (non-indented line)
			if (line.match(/^[a-z]/)) {
				inMetadata = false;
			} else if (line.match(/^\s+[\w-]+:/)) {
				const match = line.match(/^\s+([\w-]+):\s*"?(.+?)"?\s*$/);
				if (match) {
					metadata[match[1]] = match[2];
				}
				continue;
			}
		}

		// Parse simple key: value
		const match = line.match(/^(\w+(?:-\w+)?):\s*(.+)$/);
		if (match) {
			const key = match[1];
			let value = match[2].trim();
			// Remove quotes if present
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}

			switch (key) {
				case "name":
					frontmatter.name = value;
					break;
				case "description":
					frontmatter.description = value;
					break;
				case "license":
					frontmatter.license = value;
					break;
				case "compatibility":
					frontmatter.compatibility = value;
					break;
				case "allowed-tools":
					frontmatter.allowedTools = value;
					break;
			}
		}
	}

	if (Object.keys(metadata).length > 0) {
		frontmatter.metadata = metadata;
	}

	// Body is everything after frontmatter
	const body = lines
		.slice(endIndex + 1)
		.join("\n")
		.trim();

	return { frontmatter, body };
}

/**
 * Serialize frontmatter and body back to SKILL.md format.
 */
function serializeSkillMd(frontmatter: SkillFrontmatter, body: string): string {
	const lines: string[] = ["---"];

	lines.push(`name: ${frontmatter.name}`);
	lines.push(`description: ${frontmatter.description}`);

	if (frontmatter.license) {
		lines.push(`license: ${frontmatter.license}`);
	}

	if (frontmatter.compatibility) {
		lines.push(`compatibility: ${frontmatter.compatibility}`);
	}

	if (frontmatter.allowedTools) {
		lines.push(`allowed-tools: ${frontmatter.allowedTools}`);
	}

	if (frontmatter.metadata && Object.keys(frontmatter.metadata).length > 0) {
		lines.push("metadata:");
		for (const [key, value] of Object.entries(frontmatter.metadata)) {
			lines.push(`  ${key}: "${value}"`);
		}
	}

	lines.push("---");
	lines.push("");
	lines.push(body);

	return lines.join("\n");
}

/**
 * SkillsService manages Agent Skills discovery, loading, and persistence.
 */
export class SkillsService {
	private plugin: Plugin;
	private adapter: DataAdapter;

	/** Cached skill metadata (name -> SkillMetadata) */
	private skillsCache: Map<string, SkillMetadata> = new Map();

	/** Whether discovery has been run */
	private discovered = false;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
		this.adapter = plugin.app.vault.adapter;
	}

	/**
	 * Get the skills directory path within the vault. Skills live directly under the agent
	 * folder's `Skills/` subdir (each skill is a `<name>/SKILL.md`, core skills included).
	 * They're user-visible/editable, and skill edits flow through the vault-backed
	 * pending-changes review.
	 */
	getSkillsDir(): string {
		return skillsDir();
	}

	/**
	 * Prior skills locations, checked once by the relocation migration:
	 * - the v4 top-level vault `Skills/` folder, and
	 * - the pre-v4 config-dir `<configDir>/skills`.
	 */
	private getLegacyVaultSkillsDir(): string {
		return LEGACY_VAULT_SKILLS_DIR;
	}
	private getLegacyConfigSkillsDir(): string {
		// `configDir` is a documented non-optional string and honours a user-relocated
		// config folder, so it needs neither the widening cast nor a ".obsidian" fallback
		// (which would have pointed at the wrong folder for anyone who moved theirs).
		return `${this.plugin.app.vault.configDir}/${LEGACY_CONFIG_SKILLS_DIR}`;
	}

	/**
	 * Ensure the skills directory exists, creating it if necessary.
	 *
	 * Creates the configurable agent-root folder first, then the nested `Skills/` dir — Obsidian's
	 * DataAdapter.mkdir does not create intermediate parents, and the `agentFolder` setter only
	 * fires an *unawaited* createFolder. Without this, a runtime agent-folder change (settings →
	 * reinitAgentFolder) could try to create `<newFolder>/Skills` before `<newFolder>` exists, throw,
	 * and abort the rest of reinit (prompt refresh + system-prompt cache invalidation) — leaving
	 * conversations serving the old folder's prompts. Awaiting parent creation here removes the race.
	 */
	async ensureSkillsDir(): Promise<void> {
		const rootDir = agentRootDir();
		if (!(await this.adapter.exists(rootDir))) {
			await this.adapter.mkdir(rootDir);
		}
		const skillsDir = this.getSkillsDir();
		if (!(await this.adapter.exists(skillsDir))) {
			await this.adapter.mkdir(skillsDir);
			Log.info(`Created skills directory: ${skillsDir}`);
		}
	}

	/**
	 * The bundled skills seeded at startup: the core skills (always) plus each
	 * *core-plugin* integration skill (canvas/bases, carrying `corePluginId`) whose
	 * core plugin is currently enabled. Community-plugin integration skills are
	 * excluded here — they seed on-demand via `seedIntegrationSkill` when the user
	 * enables the integration.
	 */
	private getStartupSeedSkills(): typeof BUNDLED_CORE_SKILLS {
		const app = this.plugin.app;
		const enabledCorePluginSkills = BUNDLED_INTEGRATION_SKILLS.filter(
			(s) => s.corePluginId && isInternalPluginEnabled(app, s.corePluginId),
		);
		return [...BUNDLED_CORE_SKILLS, ...enabledCorePluginSkills];
	}

	/**
	 * Bootstrap default skills on first run.
	 * Copies the startup seed set (core skills + enabled core-plugin integration skills)
	 * into the vault if they don't already exist. Community integration skills are seeded
	 * on-demand (see `seedIntegrationSkill`), not here.
	 * @returns Number of skills installed
	 */
	async bootstrapDefaultSkills(): Promise<number> {
		await this.ensureSkillsDir();
		const skillsDir = this.getSkillsDir();

		// No fast path here: an "all folders present" early return is exactly what made a
		// bumped skill version unreachable before #401 — the per-skill check never ran, so
		// improvements to bundled skills only ever reached new vaults. Each skill below is
		// now read and compared, which costs one read() per folder (~10; two on the rare
		// update path, which re-verifies before overwriting) on a path already measured by
		// StartupProfiler ("skills:bootstrap").
		//
		// Two groups are reconciled, and the distinction matters:
		//  - the startup seed set (core skills + enabled core-plugin integrations), which is
		//    installed when absent;
		//  - every OTHER bundled skill already present in the vault. Community integration
		//    skills are seeded on demand by `seedIntegrationSkill`, so they're absent from
		//    the seed set — without this they'd be installed once and then never updated or
		//    re-checked again. They are deliberately NOT installed here when absent; opting
		//    into an integration remains the user's call.
		const listing = await this.adapter.list(skillsDir);
		const presentFolders = new Set(listing.folders.map((f) => f.split("/").pop()));
		const seedSkills = this.getStartupSeedSkills();
		const seedNames = new Set(seedSkills.map((s) => s.name));
		const alreadyInstalled = BUNDLED_SKILLS.filter((s) => !seedNames.has(s.name) && presentFolders.has(s.name));

		let installed = 0;
		// Rebuild wholesale rather than append: this pass is the authoritative result for
		// every bundled skill, so one the user has since re-aligned drops out instead of
		// lingering. On-demand reconciles between bootstraps adjust the set incrementally
		// (see recordReconcileOutcome).
		this.staleSkillNames.clear();

		for (const bundledSkill of [...seedSkills, ...alreadyInstalled]) {
			const outcome = await this.reconcileBundledSkill(bundledSkill);
			if (outcome === "installed" || outcome === "updated") installed++;
			this.recordReconcileOutcome(bundledSkill.name, outcome);
		}

		this.publishStaleSkills();

		if (installed > 0) {
			Log.info(`Bootstrapped ${installed} default skills`);
		}

		return installed;
	}

	/**
	 * Bundled skills whose on-disk body is neither the current shipped version nor any older
	 * one — i.e. the user edited them, so reconciliation left them alone. Owned here (not
	 * only in the store) so both reconcile paths — the startup bootstrap and the on-demand
	 * `seedIntegrationSkill` — maintain one consistent set: bootstrap rebuilds it, a single
	 * reconcile flips just its own skill in or out.
	 */
	private staleSkillNames = new Set<string>();

	/** Fold one reconcile outcome into the stale set: `customized` enters, any resolution leaves. */
	private recordReconcileOutcome(
		skillName: string,
		outcome: "installed" | "updated" | "current" | "customized" | "failed",
	): void {
		if (outcome === "customized") this.staleSkillNames.add(skillName);
		// `installed`/`updated`/`current` mean the file now matches a shipped body, so any
		// earlier stale mark is resolved. `failed` keeps whatever state we last knew.
		else if (outcome !== "failed") this.staleSkillNames.delete(skillName);
	}

	/** Push the current stale set into the store, where the reactive notice surface reads it. */
	private publishStaleSkills(): void {
		getData().setStaleSkills([...this.staleSkillNames]);
	}

	/**
	 * Bring one bundled skill's on-disk copy in line with what we ship, without ever
	 * clobbering the user's own writing:
	 *
	 * - absent              → write it (`"installed"`)
	 * - current version     → leave it (`"current"`)
	 * - an OLD shipped body → overwrite silently (`"updated"`) — untouched, so safe to move
	 * - anything else       → the user edited it: leave it and report `"customized"` so the
	 *                         caller can raise a notice offering to reconcile by hand
	 *
	 * A skill with no entry in {@link SHIPPED_SKILL_HISTORY} (no `metadata.version`) keeps
	 * the old existence-only behaviour — we can't reason about its provenance.
	 */
	private async reconcileBundledSkill(
		skill: BundledSkill,
	): Promise<"installed" | "updated" | "current" | "customized" | "failed"> {
		const path = `${this.getSkillsDir()}/${skill.name}/${SKILL_FILENAME}`;

		if (!(await this.adapter.exists(path))) {
			return (await this.writeBundledSkill(skill)) ? "installed" : "failed";
		}

		const history = SHIPPED_SKILL_HISTORY.get(skill.name);
		if (!history) return "current";

		let existing: string;
		try {
			existing = await this.adapter.read(path);
		} catch (error) {
			// Unreadable: treat as customized rather than overwriting something we can't see.
			Log.error(`Could not read skill ${skill.name} to check its version:`, error);
			return "customized";
		}

		const version = shippedVersion(existing, history);
		if (version === null) return "customized";
		if (version === currentSkillVersion(skill.name)) return "current";

		// Re-verify immediately before overwriting: the provenance check above read the file
		// at some earlier point, and a sync client (or the user) can write to it in between —
		// startup, when this runs, is exactly when Obsidian Sync delivers edits from other
		// devices. The adapter has no compare-and-swap, so this cannot close the race
		// entirely, but it shrinks the window from the whole decision path to the write call
		// and turns the realistic case into "customized" instead of a destroyed edit.
		try {
			if ((await this.adapter.read(path)) !== existing) {
				Log.info(`Skill ${skill.name} changed while reconciling; treating as customized`);
				return "customized";
			}
		} catch {
			return "customized";
		}

		if (await this.writeBundledSkill(skill, { overwrite: true })) {
			Log.info(`Updated bundled skill ${skill.name} from v${version} to v${skill.version}`);
			return "updated";
		}
		return "failed";
	}

	/**
	 * Write a bundled skill's verbatim SKILL.md to disk (creating its dir), preserving the
	 * file byte-for-byte rather than round-tripping through parse/serialize — the fingerprint
	 * in `SHIPPED_SKILL_HISTORY` is taken over exactly these bytes, so a re-serialized copy
	 * would not match its own shipped version. Returns true on success.
	 *
	 * Callers must establish that overwriting is safe before passing `overwrite` — see
	 * {@link reconcileBundledSkill}, which only does so for a body matching an older shipped
	 * version (i.e. one the user demonstrably never edited).
	 */
	private async writeBundledSkill(skill: BundledSkill, opts?: { overwrite?: boolean }): Promise<boolean> {
		const skillDir = `${this.getSkillsDir()}/${skill.name}`;
		const path = `${skillDir}/${SKILL_FILENAME}`;
		try {
			if (!(await this.adapter.exists(skillDir))) {
				await this.adapter.mkdir(skillDir);
			}
			if (!opts?.overwrite && (await this.adapter.exists(path))) return false;
			await this.adapter.write(path, skill.content);
			return true;
		} catch (error) {
			Log.error(`Failed to write skill ${skill.name}:`, error);
			return false;
		}
	}

	/**
	 * Seed the skill documenting a community-plugin integration, on demand (called when the
	 * user enables the integration). Prefers a *prewritten* bundled integration skill for the
	 * plugin (written verbatim); if none exists, falls back to the introspect-first
	 * `buildPluginApiSkill` template (written via `saveSkill`). Callers should re-discover
	 * afterwards so the new skill enters the cache.
	 *
	 * An already-present bundled skill is reconciled rather than skipped (see
	 * {@link reconcileBundledSkill}): re-enabling an integration picks up an improved body,
	 * but never overwrites one the user has edited. The generated-template path still skips
	 * when present — a template has no shipped version to compare against.
	 *
	 * @returns the seeded skill's name, or null if seeding failed.
	 */
	async seedIntegrationSkill(pluginId: string, displayName: string): Promise<string | null> {
		await this.ensureSkillsDir();
		const bundled = getBundledIntegrationSkillForPlugin(pluginId);

		if (bundled) {
			// The user may already have a skill for this plugin under a DIFFERENT name — the
			// generated template is named from the plugin's display name, which needn't match
			// our bundled folder name (e.g. "Tasks" → `tasks` vs our `tasks` for plugin id
			// `obsidian-tasks-plugin`). Seeding regardless would leave two skills describing
			// the same plugin, both advertised to the model. Their own skill wins: it's
			// theirs, and it may already be specialized to how they use the plugin.
			const existing = this.findSkillForPlugin(pluginId, bundled.name);
			if (existing) {
				Log.info(
					`Skill "${existing}" already covers plugin ${pluginId}; not seeding bundled "${bundled.name}"`,
				);
				return existing;
			}

			// Same three-way reconcile as startup bootstrap, so a community integration skill
			// that improves upstream reaches vaults that already have it — the on-demand path
			// had the identical skip-if-exists gap. Fold the outcome into the stale set too:
			// a `customized` result here must raise its notice NOW, not wait for the next
			// startup's bootstrap pass to rediscover it.
			const outcome = await this.reconcileBundledSkill(bundled);
			this.recordReconcileOutcome(bundled.name, outcome);
			this.publishStaleSkills();
			return outcome === "failed" ? null : bundled.name;
		}

		// No prewritten skill — generate the introspect-first template.
		const generated = buildPluginApiSkill(pluginId, displayName);
		if (await this.adapter.exists(`${this.getSkillsDir()}/${generated.frontmatter.name}/${SKILL_FILENAME}`)) {
			return generated.frontmatter.name;
		}
		const result = await this.saveSkill(generated);
		return result.valid ? generated.frontmatter.name : null;
	}

	/**
	 * An already-discovered skill covering `pluginId` under some name other than `exceptName`,
	 * or undefined. Matches on `metadata.linkedPlugin` — the field that actually wires a skill
	 * to its `exec_<plugin>` tool — rather than on the folder name, because a user's generated
	 * skill is named from the plugin's *display* name and needn't match our bundled name.
	 *
	 * Relies on the discovery cache; if discovery hasn't run there is nothing to collide with
	 * from this service's point of view, and the pre-write existence check still applies.
	 */
	private findSkillForPlugin(pluginId: string, exceptName: string): string | undefined {
		for (const [name, metadata] of this.skillsCache) {
			if (name !== exceptName && metadata.linkedPluginId === pluginId) return name;
		}
		return undefined;
	}

	/**
	 * One-time migration: consolidate skills under the agent folder's `Skills/` dir.
	 * Moves skill folders from either prior location — the v4 top-level vault `Skills/` folder,
	 * or the pre-v4 config-dir `<configDir>/skills` — into the agent folder's `Skills/`. Idempotent
	 * (gated by the `agentFolderMigrated` flag), and skips any skill already present at the
	 * destination so a user's customized copy isn't overwritten. Copies rather than moves, leaving
	 * legacy files in place as a safety net.
	 */
	async migrateAgentFolder(): Promise<void> {
		const data = getData();
		if (data.agentFolderMigrated) return;

		const destDir = this.getSkillsDir();
		// Prefer the newer vault `Skills/` location; fall back to the config-dir one.
		const sources = [this.getLegacyVaultSkillsDir(), this.getLegacyConfigSkillsDir()];

		try {
			let anySource = false;
			for (const legacyDir of sources) {
				if (!(await this.adapter.exists(legacyDir))) continue;
				anySource = true;
				await this.ensureSkillsDir();
				const listing = await this.adapter.list(legacyDir);
				let migrated = 0;

				for (const folder of listing.folders) {
					const name = folder.split("/").pop();
					if (!name) continue;
					const legacyPath = `${folder}/${SKILL_FILENAME}`;
					const destSkillDir = `${destDir}/${name}`;
					const destPath = `${destSkillDir}/${SKILL_FILENAME}`;

					if (!(await this.adapter.exists(legacyPath))) continue;
					// Don't clobber a skill the user already has at the destination.
					if (await this.adapter.exists(destPath)) continue;

					try {
						const content = await this.adapter.read(legacyPath);
						if (!(await this.adapter.exists(destSkillDir))) {
							await this.adapter.mkdir(destSkillDir);
						}
						await this.adapter.write(destPath, content);
						migrated++;
					} catch (error) {
						Log.error(`Failed to migrate skill ${name} into ${destDir}:`, error);
					}
				}

				if (migrated > 0) {
					Log.info(`Migrated ${migrated} skills from ${legacyDir} into ${destDir}`);
				}
			}

			if (!anySource) {
				Log.debug("No legacy skills location found — nothing to consolidate");
			}
			data.agentFolderMigrated = true;
		} catch (error) {
			// Leave the flag unset so we retry next start rather than losing skills silently.
			Log.error("Agent folder consolidation migration failed:", error);
		}
	}

	/**
	 * One-time migration for "everything is a skill" (schema v6): the 4 former capabilities
	 * (vault/notes/web/update) are now bundled core skills. Their editable guidance used to live
	 * in `Skills/<id>/GUIDANCE.md`; those files are now orphaned. Delete each orphan
	 * GUIDANCE.md (and only that file) so `bootstrapDefaultSkills` can seed the new `SKILL.md`
	 * into the same dir. Idempotent (gated by `coreSkillsSeeded`); the flag is set only on success
	 * so a failure retries next start rather than leaving a half-migrated tree. Must run BEFORE
	 * bootstrap so the fresh SKILL.md lands cleanly.
	 */
	async migrateCoreSkills(): Promise<void> {
		const data = getData();
		if (data.coreSkillsSeeded) return;

		const dir = this.getSkillsDir();
		const CORE_SKILL_NAMES = ["vault", "notes", "web", "update"];

		try {
			for (const name of CORE_SKILL_NAMES) {
				const guidancePath = `${dir}/${name}/GUIDANCE.md`;
				if (await this.adapter.exists(guidancePath)) {
					await this.adapter.remove(guidancePath);
					Log.info(`Removed orphaned core-skill guidance: ${guidancePath}`);
				}
			}
			data.coreSkillsSeeded = true;
		} catch (error) {
			// Leave the flag unset so we retry next start.
			Log.error("Core-skill migration (orphan guidance cleanup) failed:", error);
		}
	}

	/**
	 * One-time migration (schema v8): the `update-skills` core skill folder is renamed
	 * `manage-skills` (the tool gained create/delete, not just edit). Renames the on-disk
	 * directory so `bootstrapDefaultSkills` doesn't seed a duplicate `manage-skills/` alongside
	 * an orphaned `update-skills/`. A no-op (and immediately marks done) when no legacy folder
	 * exists — covers fresh installs. Idempotent via `manageSkillsFolderMigrated`; never clobbers
	 * an existing `manage-skills/` (e.g. a user who already has a custom skill at that name).
	 * Must run BEFORE bootstrap so discovery sees the renamed folder, not a stale duplicate.
	 *
	 * The directory rename alone is not enough: skills are keyed by `frontmatter.name` during
	 * discovery, not the folder name (verified live — a folder rename with a stale `name:` inside
	 * makes the skill vanish from `getCachedSkills()` entirely, silently dropping `manage_skills`
	 * for every agent). So after the rename, also rewrite the `name:` and `allowed-tools:`
	 * frontmatter lines to match — these two fields must structurally track the new folder/tool id
	 * regardless of customization. `description:`, `metadata:`, and the body are left untouched so
	 * a user's edits to those survive.
	 */
	async migrateManageSkillsFolder(): Promise<void> {
		const data = getData();
		if (data.manageSkillsFolderMigrated) return;

		const dir = this.getSkillsDir();
		const oldDir = `${dir}/update-skills`;
		const newDir = `${dir}/manage-skills`;

		try {
			if (!(await this.adapter.exists(oldDir))) {
				data.manageSkillsFolderMigrated = true;
				return;
			}
			if (await this.adapter.exists(newDir)) {
				// Both exist — leave the legacy folder in place rather than guess which to keep.
				Log.debug(`Both ${oldDir} and ${newDir} exist; leaving legacy folder for manual cleanup`);
				data.manageSkillsFolderMigrated = true;
				return;
			}
			await this.adapter.rename(oldDir, newDir);

			const skillPath = `${newDir}/${SKILL_FILENAME}`;
			if (await this.adapter.exists(skillPath)) {
				const raw = await this.adapter.read(skillPath);
				const updated = raw
					.replace(/^name:\s*update-skills\s*$/m, "name: manage-skills")
					.replace(/^allowed-tools:\s*update_skill\s*$/m, "allowed-tools: manage_skills");
				if (updated !== raw) await this.adapter.write(skillPath, updated);
			}

			Log.info(`Renamed core-skill folder ${oldDir} -> ${newDir}`);
			data.manageSkillsFolderMigrated = true;
		} catch (error) {
			// Leave the flag unset so we retry next start.
			Log.error("manage-skills folder migration failed:", error);
		}
	}

	/**
	 * One-time migration (schema v11): the `edit-notes` core skill is renamed `manage-notes`,
	 * matching its attached tool (`manage_notes`) — the same treatment `update-skills` got in
	 * v8. Unlike v8 the skill restarts at version 1.0 under its new name, so an old folder
	 * can't be reconciled by `bootstrapDefaultSkills` against `manage-notes`' shipped history;
	 * this decides its fate instead:
	 *
	 * - untouched shipped copy (any released `edit-notes` body) → delete the folder, and let
	 *   bootstrap seed a fresh `manage-notes/` right after;
	 * - user-edited copy → rename the folder and rewrite the `name:` frontmatter line (the
	 *   discovery key — see migrateManageSkillsFolder for why the rename alone isn't enough),
	 *   preserving the edits. Bootstrap then flags it `customized`, which is accurate.
	 *
	 * A no-op (marked done immediately) when no legacy folder exists; never clobbers an
	 * existing `manage-notes/`. Must run BEFORE bootstrap so it sees the folder state this
	 * leaves behind. Idempotent via `manageNotesFolderMigrated`, set only on success so a
	 * failure retries next start.
	 */
	async migrateManageNotesFolder(): Promise<void> {
		const data = getData();
		if (data.manageNotesFolderMigrated) return;

		const dir = this.getSkillsDir();
		const oldDir = `${dir}/edit-notes`;
		const newDir = `${dir}/manage-notes`;

		try {
			if (!(await this.adapter.exists(oldDir))) {
				// No legacy folder — but a PREVIOUS attempt may have renamed it and then
				// failed before the frontmatter rewrite (the flag is only set on full
				// success). Finish that rewrite here rather than reading "no edit-notes/"
				// as "nothing to do", or the retry path would seal a manage-notes/ whose
				// `name:` still says edit-notes — undiscoverable forever.
				await this.rewriteLegacyEditNotesName(newDir);
				data.manageNotesFolderMigrated = true;
				return;
			}
			if (await this.adapter.exists(newDir)) {
				// Both exist — leave the legacy folder in place rather than guess which to keep.
				Log.debug(`Both ${oldDir} and ${newDir} exist; leaving legacy folder for manual cleanup`);
				data.manageNotesFolderMigrated = true;
				return;
			}

			const oldPath = `${oldDir}/${SKILL_FILENAME}`;
			const customized =
				(await this.adapter.exists(oldPath)) &&
				!RELEASED_EDIT_NOTES_FINGERPRINTS.has(fingerprint(await this.adapter.read(oldPath)));

			if (!customized) {
				await this.adapter.rmdir(oldDir, true);
				Log.info(`Removed untouched core-skill folder ${oldDir}; bootstrap will seed ${newDir}`);
				data.manageNotesFolderMigrated = true;
				return;
			}

			await this.adapter.rename(oldDir, newDir);
			await this.rewriteLegacyEditNotesName(newDir);

			Log.info(`Renamed customized core-skill folder ${oldDir} -> ${newDir}`);
			data.manageNotesFolderMigrated = true;
		} catch (error) {
			// Leave the flag unset so we retry next start.
			Log.error("manage-notes folder migration failed:", error);
		}
	}

	/**
	 * Rewrite a migrated skill file's `name: edit-notes` frontmatter line to `manage-notes`.
	 * Tolerates optionally quoted YAML (`name: "edit-notes"` / `'edit-notes'` are valid and
	 * accepted by discovery, so they must be matched too — an unquoted-only regex would leave
	 * the old name in place and the skill undiscoverable). A no-op when the file is absent or
	 * already carries another name; throws on I/O failure so the caller's flag stays unset and
	 * the migration retries.
	 */
	private async rewriteLegacyEditNotesName(skillDir: string): Promise<void> {
		const path = `${skillDir}/${SKILL_FILENAME}`;
		if (!(await this.adapter.exists(path))) return;
		const raw = await this.adapter.read(path);
		const updated = raw.replace(/^name:\s*(["']?)edit-notes\1\s*$/m, "name: manage-notes");
		if (updated !== raw) {
			await this.adapter.write(path, updated);
			Log.info(`Rewrote legacy skill name in ${path}`);
		}
	}

	/**
	 * Initialize the skills service.
	 * Consolidates legacy skills into the agent folder's Skills/ dir, cleans up orphaned
	 * core-skill guidance (v6 core-skill migration), renames update-skills -> manage-skills
	 * (v8) and edit-notes -> manage-notes (v11), bootstraps default skills if needed, then
	 * discovers all available skills. Call this once on plugin load.
	 */
	async initialize(): Promise<void> {
		await StartupProfiler.measure("skills:migrate", () => this.migrateAgentFolder());
		await StartupProfiler.measure("skills:migrate-core", () => this.migrateCoreSkills());
		await StartupProfiler.measure("skills:migrate-manage-skills", () => this.migrateManageSkillsFolder());
		await StartupProfiler.measure("skills:migrate-manage-notes", () => this.migrateManageNotesFolder());
		await StartupProfiler.measure("skills:bootstrap", () => this.bootstrapDefaultSkills());
		await StartupProfiler.measure("skills:discover", () => this.discoverSkills());
	}

	/**
	 * Discover all skills in the skills directory.
	 * Only parses frontmatter for efficient context usage.
	 * @returns Map of skill name to SkillMetadata
	 */
	async discoverSkills(): Promise<Map<string, SkillMetadata>> {
		const skillsDir = this.getSkillsDir();
		// Build into a fresh map and swap it in only once the scan completes. Clearing the
		// live cache up front would leave it EMPTY if any I/O below threw — and since callers
		// may (correctly) treat a failed rediscovery as non-fatal, the next agent run would
		// then assemble its prompt from no skills at all, silently dropping every skill the
		// user has until some later discovery happened to succeed.
		const discovered = new Map<string, SkillMetadata>();

		if (!(await this.adapter.exists(skillsDir))) {
			Log.debug("Skills directory does not exist yet");
			this.skillsCache = discovered;
			this.discovered = true;
			return this.skillsCache;
		}

		// List directories in skills folder
		const listing = await this.adapter.list(skillsDir);

		// Diagnostics: skills discovery can dominate a cold start (per-folder exists+read
		// filesystem I/O). Track the folder count and the slowest single folder so a slow
		// startup file shows *which* skill folder was expensive, not just the total.
		StartupProfiler.setMeta("skillFolderCount", listing.folders.length);
		let slowestFolder = "";
		let slowestFolderMs = 0;

		for (const folder of listing.folders) {
			const folderStart = performance.now();
			const dirName = folder.split("/").pop() || "";

			// Every folder under the skills root is a skill dir: it must contain a SKILL.md.
			const skillPath = `${folder}/${SKILL_FILENAME}`;

			if (!(await this.adapter.exists(skillPath))) {
				Log.debug(`No SKILL.md found in ${folder}`);
				continue;
			}

			try {
				const content = await this.adapter.read(skillPath);
				const { frontmatter } = parseFrontmatter(content);

				// Validate frontmatter (dirName computed at the top of the loop)
				const validation = validateFrontmatter(frontmatter, dirName);
				if (!validation.valid) {
					Log.info(
						`Skipping invalid skill in ${folder}: ${validation.errors.map((e) => e.message).join(", ")}`,
					);
					continue;
				}

				// After validation, frontmatter.name is guaranteed to exist
				const skillName = frontmatter.name as string;
				const { category, linkedPluginId, corePluginId } = this.extractSkillLinks(frontmatter.metadata);

				const metadata: SkillMetadata = {
					frontmatter: frontmatter as SkillFrontmatter,
					path: folder,
					linkedPluginId,
					category,
					corePluginId,
				};

				discovered.set(skillName, metadata);
				Log.debug(`Discovered skill: ${skillName}`);
			} catch (error) {
				Log.error(`Error reading skill from ${folder}:`, error);
			} finally {
				const folderMs = performance.now() - folderStart;
				if (folderMs > slowestFolderMs) {
					slowestFolderMs = folderMs;
					slowestFolder = folder.split("/").pop() || folder;
				}
			}
		}

		if (slowestFolder) {
			StartupProfiler.setMeta("slowestSkillFolder", slowestFolder);
			StartupProfiler.setMeta("slowestSkillFolderMs", Math.round(slowestFolderMs));
		}

		// Scan completed: publish it. Anything that threw above skipped this line, leaving the
		// previous cache intact rather than empty.
		this.skillsCache = discovered;
		this.discovered = true;
		Log.info(`Discovered ${this.skillsCache.size} skills`);
		return this.skillsCache;
	}

	/**
	 * Get cached skill metadata. Returns empty map if discovery hasn't run.
	 */
	getCachedSkills(): Map<string, SkillMetadata> {
		return this.skillsCache;
	}

	/**
	 * Check if discovery has been completed.
	 */
	isDiscovered(): boolean {
		return this.discovered;
	}

	/**
	 * Load a skill's full content (for activation phase).
	 * @param skillName - Name of the skill to load
	 * @returns Full Skill object or null if not found
	 */
	/**
	 * A skill's raw `SKILL.md` bytes, unparsed. The diff view compares against the bundled
	 * body verbatim, so it must not round-trip through parse/serialize — that would normalize
	 * the text and show spurious differences (and, if saved, change the file's fingerprint).
	 */
	async readSkillFile(skillName: string): Promise<string> {
		return this.adapter.read(`${this.getSkillsDir()}/${skillName}/${SKILL_FILENAME}`);
	}

	/**
	 * Overwrite a skill's `SKILL.md` verbatim and re-discover, so an edit made in the diff
	 * view reaches the next agent run. Same verbatim contract as {@link readSkillFile}: text
	 * saved as the bundled body must fingerprint as that shipped version, or the skill would
	 * immediately re-report as customized.
	 */
	async writeSkillFile(skillName: string, content: string): Promise<void> {
		// Only the write itself is allowed to fail the save: once these bytes are on disk the
		// user's edit is durable, and callers surface a rejection as "could not save".
		await this.adapter.write(`${this.getSkillsDir()}/${skillName}/${SKILL_FILENAME}`, content);

		// Re-evaluate against the shipped history rather than assuming: accepting the new
		// default in the diff view resolves the notice, while saving a further edit keeps it.
		const history = SHIPPED_SKILL_HISTORY.get(skillName);
		if (history) {
			this.recordReconcileOutcome(
				skillName,
				shippedVersion(content, history) === null ? "customized" : "current",
			);
			this.publishStaleSkills();
		}

		// Refresh THIS skill's cache entry from the bytes we just wrote, rather than
		// rescanning the folder. The edit may have changed frontmatter the runtime depends on
		// — `description` (advertised to the model), `allowed-tools` (which built-in tools get
		// bound), `metadata.linkedPlugin` — so leaving the old entry in place would let the
		// next run advertise a stale description or attach the wrong tool set.
		//
		// Parsing in-process needs no I/O, so unlike a rescan it cannot half-fail; and it
		// leaves every OTHER skill's entry untouched, so one save can't disturb the rest of
		// the cache.
		const { frontmatter } = parseFrontmatter(content);
		const { category, linkedPluginId, corePluginId } = this.extractSkillLinks(frontmatter.metadata);

		// Apply exactly the checks discovery applies, so this path can never admit a skill a
		// folder scan would have rejected. That covers the name/folder match — we always
		// write to `<skillName>/SKILL.md`, so an edit changing `name:` doesn't rename the
		// skill, it invalidates the file — and the required `description`, which is
		// interpolated unguarded into the `<available_skills>` block: caching an entry
		// without one would throw in `escapeXml` and take down system-prompt assembly
		// entirely, so an invalid save must not be able to break the next agent run.
		//
		// Evicting matches what the next discovery pass would do (it skips invalid files),
		// rather than leaving stale metadata that advertises a description, tool set, or
		// plugin wiring the file on disk no longer declares. (A real rename is a folder move
		// — `saveSkill` / `manage_skills` territory, not this path.)
		const validation = validateFrontmatter(frontmatter, skillName);
		if (!validation.valid) {
			this.skillsCache.delete(skillName);
			Log.info(
				`Skill ${skillName} saved with invalid frontmatter (${validation.errors
					.map((e) => e.message)
					.join(", ")}) — dropped from the cache until corrected`,
			);
			return;
		}

		this.skillsCache.set(skillName, {
			frontmatter: frontmatter as SkillFrontmatter,
			path: `${this.getSkillsDir()}/${skillName}`,
			linkedPluginId,
			category,
			corePluginId,
		});
	}

	async loadSkill(skillName: string): Promise<Skill | null> {
		const metadata = this.skillsCache.get(skillName);
		if (!metadata) {
			Log.debug(`Skill not found: ${skillName}`);
			return null;
		}

		const skillPath = `${metadata.path}/${SKILL_FILENAME}`;

		try {
			const content = await this.adapter.read(skillPath);
			const { frontmatter, body } = parseFrontmatter(content);

			return {
				...metadata,
				frontmatter: frontmatter as SkillFrontmatter,
				content: body,
			};
		} catch (error) {
			Log.error(`Error loading skill ${skillName}:`, error);
			return null;
		}
	}

	/**
	 * Save a skill to disk.
	 * Creates the directory if it doesn't exist.
	 * @param skill - The skill to save
	 * @returns Validation result
	 */
	async saveSkill(skill: { frontmatter: SkillFrontmatter; content: string }): Promise<ValidationResult> {
		// Validate before saving
		const validation = validateFrontmatter(skill.frontmatter);
		if (!validation.valid) {
			return validation;
		}

		const skillDir = `${this.getSkillsDir()}/${skill.frontmatter.name}`;
		const skillPath = `${skillDir}/${SKILL_FILENAME}`;

		try {
			// Ensure directory exists
			if (!(await this.adapter.exists(skillDir))) {
				await this.adapter.mkdir(skillDir);
			}

			// Write SKILL.md
			const content = serializeSkillMd(skill.frontmatter, skill.content);
			await this.adapter.write(skillPath, content);

			// Update cache
			const { category, linkedPluginId, corePluginId } = this.extractSkillLinks(skill.frontmatter.metadata);

			const metadata: SkillMetadata = {
				frontmatter: skill.frontmatter,
				path: skillDir,
				linkedPluginId,
				category,
				corePluginId,
			};
			this.skillsCache.set(skill.frontmatter.name, metadata);

			Log.info(`Saved skill: ${skill.frontmatter.name}`);
			return { valid: true, errors: [] };
		} catch (error) {
			Log.error(`Error saving skill ${skill.frontmatter.name}:`, error);
			return {
				valid: false,
				errors: [{ field: "save", message: `Failed to save: ${error}` }],
			};
		}
	}

	/**
	 * Delete a skill from disk.
	 * @param skillName - Name of the skill to delete
	 * @returns true if deleted, false if not found or error
	 */
	async deleteSkill(skillName: string): Promise<boolean> {
		const metadata = this.skillsCache.get(skillName);
		if (!metadata) {
			Log.debug(`Cannot delete - skill not found: ${skillName}`);
			return false;
		}

		try {
			const skillPath = `${metadata.path}/${SKILL_FILENAME}`;

			// Delete SKILL.md
			if (await this.adapter.exists(skillPath)) {
				await this.adapter.remove(skillPath);
			}

			// Try to remove directory (may fail if not empty)
			try {
				await this.adapter.rmdir(metadata.path, false);
			} catch {
				// Directory not empty or other issue, that's okay
				Log.debug(`Could not remove skill directory ${metadata.path}, may not be empty`);
			}

			this.skillsCache.delete(skillName);
			Log.info(`Deleted skill: ${skillName}`);
			return true;
		} catch (error) {
			Log.error(`Error deleting skill ${skillName}:`, error);
			return false;
		}
	}

	/**
	 * Generate available_skills XML for system prompt context.
	 * Per spec recommendation for Claude models.
	 * @param enableState - Optional enable/disable state to filter skills
	 * @param isPluginEnabled - Optional check for whether a linked community plugin is enabled
	 * @param isInternalPluginEnabled - Optional check for whether a linked core plugin is enabled
	 * @returns XML string for injection into system prompt
	 */
	generateContextXml(
		enableState?: SkillEnableState,
		isPluginEnabled?: (pluginId: string) => boolean,
		isInternalPluginEnabled?: (pluginId: string) => boolean,
	): string {
		if (this.skillsCache.size === 0) {
			return "";
		}

		const lines: string[] = ["<available_skills>"];

		for (const [name, metadata] of this.skillsCache) {
			// Skip disabled skills if enableState provided
			if (enableState && enableState[name] === false) {
				continue;
			}

			// Skip skills whose linked plugin isn't enabled — an unavailable plugin has
			// no runtime api/behavior to back the skill, so advertising it misleads the
			// agent into thinking it can use capabilities that aren't present.
			if (metadata.linkedPluginId && isPluginEnabled && !isPluginEnabled(metadata.linkedPluginId)) {
				continue;
			}
			if (metadata.corePluginId && isInternalPluginEnabled && !isInternalPluginEnabled(metadata.corePluginId)) {
				continue;
			}

			lines.push("  <skill>");
			lines.push(`    <name>${this.escapeXml(name)}</name>`);
			lines.push(`    <description>${this.escapeXml(metadata.frontmatter.description)}</description>`);
			lines.push(`    <location>${this.escapeXml(metadata.path)}</location>`);
			lines.push("  </skill>");
		}

		lines.push("</available_skills>");

		return lines.join("\n");
	}

	/**
	 * Get skill content for enabled skills to append to system prompt.
	 * This is the activation phase - loads full content.
	 * @param enableState - Enable/disable state for skills
	 * @param isPluginEnabled - Function to check if community plugin is enabled
	 * @param isInternalPluginEnabled - Function to check if core plugin is enabled
	 * @returns Combined skill content
	 */
	async getEnabledSkillsContent(
		enableState: SkillEnableState,
		isPluginEnabled: (pluginId: string) => boolean,
		isInternalPluginEnabled?: (pluginId: string) => boolean,
	): Promise<string> {
		const contentParts: string[] = [];

		Log.debug(`getEnabledSkillsContent: Processing ${this.skillsCache.size} skills`);

		for (const [name, metadata] of this.skillsCache) {
			// Check if skill is enabled
			if (enableState[name] === false) {
				Log.debug(`Skill ${name}: Skipped (disabled by user)`);
				continue;
			}

			// Check if linked community plugin is enabled (if applicable)
			if (metadata.linkedPluginId && !isPluginEnabled(metadata.linkedPluginId)) {
				Log.debug(`Skill ${name}: Skipped (community plugin ${metadata.linkedPluginId} not enabled)`);
				continue;
			}

			// Check if linked core plugin is enabled (if applicable)
			if (metadata.corePluginId && isInternalPluginEnabled && !isInternalPluginEnabled(metadata.corePluginId)) {
				Log.debug(`Skill ${name}: Skipped (core plugin ${metadata.corePluginId} not enabled)`);
				continue;
			}

			const skill = await this.loadSkill(name);
			if (skill?.content.trim()) {
				Log.debug(`Skill ${name}: Added (${skill.content.length} chars)`);
				contentParts.push(skill.content);
			} else {
				Log.debug(`Skill ${name}: Skipped (no content)`);
			}
		}

		Log.debug(`getEnabledSkillsContent: Returning ${contentParts.length} skill contents`);
		return contentParts.join("\n\n");
	}

	/**
	 * Extract skill links and category from metadata.
	 * Determines linkedPluginId, corePluginId, and category.
	 */
	private extractSkillLinks(metadata?: Record<string, string>): {
		category: SkillCategory;
		linkedPluginId?: string;
		corePluginId?: string;
	} {
		const metaCategory = metadata?.category as SkillCategory | undefined;
		const linkedPluginId = metadata?.linkedPlugin;
		const corePluginId = metadata?.corePluginId;

		// Determine category from metadata or infer from plugin IDs
		let category: SkillCategory;
		if (metaCategory && ["core", "plugin", "custom"].includes(metaCategory)) {
			category = metaCategory;
		} else if (corePluginId) {
			category = "core";
		} else if (linkedPluginId) {
			category = "plugin";
		} else {
			category = "custom";
		}

		return { category, linkedPluginId, corePluginId };
	}

	/**
	 * Escape special XML characters.
	 *
	 * Tolerates a missing value rather than throwing: every caller interpolates into the
	 * `<available_skills>` block, so a `.replace` on undefined would abort system-prompt
	 * assembly and break the whole agent run over one malformed skill. Entries are validated
	 * before they enter the cache; this is the backstop for anything that slips past.
	 */
	private escapeXml(text: string | undefined): string {
		if (!text) return "";
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&apos;");
	}
}

export { parseFrontmatter, serializeSkillMd };
