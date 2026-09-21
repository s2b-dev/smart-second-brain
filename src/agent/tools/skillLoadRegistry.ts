/**
 * Which skills a conversation has actually read, and what text it read.
 *
 * `manage_skills` refuses to patch or rewrite a skill the model has not loaded in the current
 * thread. Without that gate the model revises from memory — a summarized transcript, a guess at
 * the wording, a version from another conversation — and a patch whose `oldText` was never
 * read is exactly how a skill gets a duplicated paragraph or a rewrite that drops sections.
 * Hermes Agent enforces the same read-before-write rule for its autonomous skill editor.
 *
 * A load is recorded with a fingerprint of the body the model saw. The gate compares it with
 * the file at revision time, so a skill changed in between — by another conversation, a hand
 * edit, sync, or a bundled-skill upgrade — has to be loaded again before it can be revised;
 * otherwise a whole-body update written against the old text would silently discard those
 * changes.
 *
 * Keyed by LangGraph thread id, which subagent (`task`) runs inherit, so a subagent may revise
 * what its parent loaded. Creating or revising a skill counts as having read the result: the
 * model just wrote that text. Bounded so a long session never grows it without limit; evicting
 * a thread only means the model has to load the skill again.
 */

import { fingerprint } from "../../utils/shippedDefaults";

const MAX_THREADS = 200;

const loadedByThread = new Map<string, Map<string, string>>();

/** Note that `skillName` was loaded (or written) in `threadId` with this body. Ignored without a thread. */
export function recordSkillLoaded(threadId: string | undefined, skillName: string, body: string): void {
	if (!threadId) return;
	let loaded = loadedByThread.get(threadId);
	if (!loaded) {
		if (loadedByThread.size >= MAX_THREADS) {
			const oldest = loadedByThread.keys().next().value;
			if (oldest !== undefined) loadedByThread.delete(oldest);
		}
		loaded = new Map();
		loadedByThread.set(threadId, loaded);
	}
	loaded.set(skillName, fingerprint(body));
}

/** How the recorded load of `skillName` in `threadId` relates to the body on disk now. */
export type SkillLoadState = "not-loaded" | "stale" | "current";

export function skillLoadState(threadId: string | undefined, skillName: string, currentBody: string): SkillLoadState {
	const recorded = threadId ? loadedByThread.get(threadId)?.get(skillName) : undefined;
	if (recorded === undefined) return "not-loaded";
	return recorded === fingerprint(currentBody) ? "current" : "stale";
}

/** Test hook. */
export function resetSkillLoadRegistry(): void {
	loadedByThread.clear();
}
