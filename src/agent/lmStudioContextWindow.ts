import { fetchLoadedContextLength } from "../providers/lmstudio";
import { getData } from "../stores/dataStore.svelte";
import type { AgentConfig } from "../types/plugin";

/** How long a turn waits for LM Studio to report a model's loaded length before going ahead. */
export const LMSTUDIO_CHECK_TIMEOUT_MS = 2_000;

/** The query's result, or undefined if it fails, outlasts the deadline, or the turn is cancelled. */
function withinDeadline<T>(query: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
	if (signal?.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const finish = (value: T | undefined) => {
			window.clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => finish(undefined);
		const timer = window.setTimeout(onAbort, LMSTUDIO_CHECK_TIMEOUT_MS);
		signal?.addEventListener("abort", onAbort, { once: true });
		query.then(finish, () => finish(undefined));
	});
}

/**
 * Lowers an LM Studio model's saved context window to the length LM Studio has it loaded with.
 *
 * The window saved when a model is picked is its maximum if it wasn't loaded yet, and LM Studio
 * then JIT-loads it at its own (usually much smaller) load setting, which is what the server
 * enforces. A saved window above that budgets summarization and tool output for room the model
 * doesn't have, so the overflow is rejected or silently truncated. Only lowered, never raised: a
 * smaller saved value is the user's own choice and always fits. Unreachable server or a model that
 * isn't loaded leaves the agent as it is; the run then fails or JIT-loads as it would have.
 *
 * The check is optional, so it never holds a turn up: each query gets
 * `LMSTUDIO_CHECK_TIMEOUT_MS` and stops at once when the turn is cancelled, and either way the
 * agent is left as it is.
 *
 * The server is queried before anything is written, and a field is written only if it still holds
 * the model and window that were queried: the user may pick another model or edit the window in
 * the meantime, and that choice wins.
 */
export async function clampLmStudioContextWindows(agent: AgentConfig, signal?: AbortSignal): Promise<AgentConfig> {
	const data = getData();
	const lowered: Partial<Record<"chatModel" | "summarizationModel", number>> = {};
	for (const field of ["chatModel", "summarizationModel"] as const) {
		const model = agent[field];
		if (!model || data.getProviderTemplateId(model.provider) !== "lmstudio") continue;
		const auth = data.getResolvedAuthState(model.provider);
		if (!auth) continue;
		const loaded = await withinDeadline(fetchLoadedContextLength(model.provider, auth, model.model), signal);
		const saved = model.modelConfig?.contextWindow;
		if (loaded !== undefined && (saved === undefined || saved > loaded)) lowered[field] = loaded;
	}
	if (Object.keys(lowered).length === 0) return agent;

	const current = data.getAgent(agent.id);
	if (!current) return agent;
	const updates: Partial<Pick<AgentConfig, "chatModel" | "summarizationModel">> = {};
	for (const [field, loaded] of Object.entries(lowered) as Array<["chatModel" | "summarizationModel", number]>) {
		const queried = agent[field];
		const now = current[field];
		const unchanged =
			now?.provider === queried?.provider &&
			now?.model === queried?.model &&
			now?.modelConfig?.contextWindow === queried?.modelConfig?.contextWindow;
		if (now && unchanged) updates[field] = { ...now, modelConfig: { ...now.modelConfig, contextWindow: loaded } };
	}
	if (Object.keys(updates).length === 0) return current;
	data.updateAgent(agent.id, updates);
	return data.getAgent(agent.id) ?? { ...current, ...updates };
}
