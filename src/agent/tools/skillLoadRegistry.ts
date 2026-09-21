/**
 * Which skills a conversation has actually read.
 *
 * `manage_skills` refuses to patch or rewrite a skill the model has not loaded in the current
 * thread. Without that gate the model revises from memory — a summarized transcript, a guess at
 * the wording, a version from another conversation — and a patch whose `oldText` was never
 * read is exactly how a skill gets a duplicated paragraph or a rewrite that drops sections.
 * Hermes Agent enforces the same read-before-write rule for its autonomous skill editor.
 *
 * Keyed by LangGraph thread id, which subagent (`task`) runs inherit, so a subagent may revise
 * what its parent loaded. Creating a skill counts as having read it: the model just wrote the
 * text. Bounded so a long session never grows it without limit; evicting a thread only means
 * the model has to load the skill again.
 */

const MAX_THREADS = 200;

const loadedByThread = new Map<string, Set<string>>();

/** Note that `skillName` was loaded (or created) in `threadId`. Ignored without a thread. */
export function recordSkillLoaded(threadId: string | undefined, skillName: string): void {
	if (!threadId) return;
	let loaded = loadedByThread.get(threadId);
	if (!loaded) {
		if (loadedByThread.size >= MAX_THREADS) {
			const oldest = loadedByThread.keys().next().value;
			if (oldest !== undefined) loadedByThread.delete(oldest);
		}
		loaded = new Set();
		loadedByThread.set(threadId, loaded);
	}
	loaded.add(skillName);
}

/** True when `skillName` was loaded or created in `threadId`. */
export function wasSkillLoaded(threadId: string | undefined, skillName: string): boolean {
	if (!threadId) return false;
	return loadedByThread.get(threadId)?.has(skillName) ?? false;
}

/** Test hook. */
export function resetSkillLoadRegistry(): void {
	loadedByThread.clear();
}
