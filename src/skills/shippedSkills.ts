/**
 * Shipped-version history for the *bundled* skills, so seeding can tell an untouched old
 * default (safe to overwrite) from a body the user edited (leave alone, flag it).
 *
 * Before #401 this didn't exist: `bootstrapDefaultSkills` skipped any skill whose folder was
 * already present, and `metadata.version` was decorative. An improvement to a bundled skill
 * therefore reached new vaults only — hit concretely when `explore-vault` gained reformulation
 * guidance in #399 and existing vaults had no way to receive it.
 *
 * Only bundled skills are covered. User-created skills have no shipped version and are never
 * touched by any of this.
 */

import { BUNDLED_SKILLS } from "./defaults";
import { type ShippedHistory, currentShippedVersion, fingerprint } from "../utils/shippedDefaults";
import dataview10 from "./history/dataview-1.0.md?raw";
import dataview11 from "./history/dataview-1.1.md?raw";
import editNotes10 from "./history/edit-notes-1.0.md?raw";
import editNotes11 from "./history/edit-notes-1.1.md?raw";
import exploreVault10 from "./history/explore-vault-1.0.md?raw";
import exploreVault11 from "./history/explore-vault-1.1.md?raw";
import tasknotes10 from "./history/tasknotes-1.0.md?raw";

/**
 * Fingerprints of bundled-skill bodies we shipped in a PREVIOUS version and no longer ship
 * as the current default.
 *
 * ## How to add an entry (do this when you change a bundled SKILL.md)
 *
 * 1. BEFORE your edit, record the current body's fingerprint under the skill's name and its
 *    *current* version: log `fingerprint(<SKILL.md text>)` once and inline the hex string,
 *    with a comment naming the release that shipped it.
 * 2. Then make your edit and bump `metadata.version` in the SKILL.md.
 *
 * The literal is not taken on trust: the tag-replay test below pulls every released body
 * out of git and checks it against this table, so a mistyped hash fails the suite. Git is
 * the archive of old text; this table only needs the index into it. (Earlier entries retain
 * the old body as a `?raw` import instead — same result, more bundle text; new entries
 * should be literals.)
 *
 * Skip step 1-2 and existing vaults will read their untouched copy as a user customization:
 * they'll get a notice asking them to reconcile by hand instead of a silent update. Skip step
 * 3 and it's the same outcome by a different route — the new body is recorded under the old
 * version, so the body that actually shipped under it is no longer in history at all.
 *
 * You do not have to remember any of this: `test/skills/shippedSkillHistory.test.ts` replays
 * every release tag and fails if a released body has no fingerprint or a version covers two
 * bodies. Retain only bodies that were actually *released* (present at a tag) — an
 * intermediate commit within one version never reached a vault, so pinning it protects
 * nothing.
 *
 * Entries are append-only — removing one has the same effect as never adding it.
 */
const PRIOR_SKILL_FINGERPRINTS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
	// 1.0: before the "Compute, don't estimate" execute_javascript guidance was added.
	// 1.1: still told the model to call `list_directory` first, before tags and properties,
	//      when the vault's organisation was unknown — the root cause of context-filling
	//      listings in large vaults once the tool itself was bounded.
	[
		"explore-vault",
		new Map([
			["1.0", fingerprint(exploreVault10)],
			["1.1", fingerprint(exploreVault11)],
		]),
	],
	// 1.0 as actually released in 2.0.2-beta — i.e. the post-#381 body, which #381 edited
	// *without* bumping the version. That silent reuse is the same failure as an unretained
	// body, just quieter: the new text went out still labelled 1.0, so the version could no
	// longer identify a body. Bumping the current body to 1.1 (and pinning the released text
	// here) is what lets those installs update instead of reading as customized.
	//
	// Note this is the tagged body, not the pre-#381 one: that earlier text was never
	// released, so no vault holds it and fingerprinting it would protect nothing.
	// 1.1: before the "When to reach for it" section and the description that names the
	//      category / filter / count questions Dataview answers in one query.
	[
		"dataview",
		new Map([
			["1.0", fingerprint(dataview10)],
			["1.1", fingerprint(dataview11)],
		]),
	],
	["tasknotes", new Map([["1.0", fingerprint(tasknotes10)]])],
	// 1.0 (shipped in 2.2.0): before the routing guidance — revise the skill you used when it
	//      misled you; the user's corrections about a kind of task live in its skill, not memory.
	["manage-skills", new Map([["1.0", "4f7b8ff2b47b60e2"]])],
	// 1.0 (shipped in 2.2.0): before the note that memory-folder writes apply immediately.
	["manage-notes", new Map([["1.0", "eab47f33c57cb977"]])],
]);

/**
 * Every released body of the `edit-notes` core skill, which was renamed `manage-notes`
 * (schema v11) to match its attached tool, `manage_notes`. Like the earlier
 * `update-skills` → `manage-skills` rename, the skill restarts at version 1.0 under its new
 * name, so these fingerprints live outside {@link SHIPPED_SKILL_HISTORY} (which is keyed by
 * bundled-skill name). Their one consumer is `SkillsService.migrateManageNotesFolder`, which
 * uses them to tell an untouched shipped copy (delete the old folder and let bootstrap seed
 * `manage-notes/` fresh) from a user-edited one (rename the folder in place so the edits
 * survive).
 *
 * 1.0 shipped before the "Correcting an Edit You Already Staged" section; 1.1 (with it) was
 * the current body when the skill was renamed.
 */
export const RELEASED_EDIT_NOTES_FINGERPRINTS: ReadonlySet<string> = new Set([
	fingerprint(editNotes10),
	fingerprint(editNotes11),
]);

/**
 * skill name → (version → fingerprint of the body shipped at that version).
 *
 * Built at module load: each bundled skill's *current* body under its own
 * `metadata.version`, plus any retained prior bodies. Insertion order is oldest → newest, so
 * the last entry is the current version (see `currentSkillVersion`).
 */
export const SHIPPED_SKILL_HISTORY: ReadonlyMap<string, ShippedHistory> = buildHistory();

function buildHistory(): Map<string, ShippedHistory> {
	const history = new Map<string, ShippedHistory>();

	for (const skill of BUNDLED_SKILLS) {
		// A bundled skill with no `metadata.version` can't participate: there'd be no key to
		// record it under, so it keeps the old existence-only behaviour (seed if absent,
		// otherwise never touch). Validation requires the field, so this is defensive.
		if (!skill.version) continue;

		const versions = new Map<string, string>(PRIOR_SKILL_FINGERPRINTS.get(skill.name) ?? []);
		// Current last, so it's the newest entry even if a prior fingerprint was recorded late.
		versions.set(skill.version, fingerprint(skill.content));
		history.set(skill.name, versions);
	}

	return history;
}

/** The version a bundled skill currently ships at, or undefined if it isn't tracked. */
export function currentSkillVersion(skillName: string): string | undefined {
	const versions = SHIPPED_SKILL_HISTORY.get(skillName);
	if (!versions) return undefined;
	return currentShippedVersion(versions) as string | undefined;
}
