import type { ChatModel } from "../stores/chatTimeline";
import { useAvailableModels } from "../hooks/useAvailableModels.svelte";
import { getData } from "../stores/dataStore.svelte";

/**
 * Build the `ChatModel` record persisted on an agent when a model is picked.
 *
 * Hydrated catalogue metadata wins where available; otherwise the previously stored
 * config is preserved so a re-pick of the same model doesn't silently drop a tuned
 * context window or temperature.
 *
 * Shared by every model picker (composer pill, agent editor, onboarding, and the
 * "select a model" notice action) so a model selected from any of them persists
 * identically — these were four byte-identical copies before.
 */
export function buildPersistedChatModel(provider: string, model: string, existing?: ChatModel | null): ChatModel {
	const models = useAvailableModels();
	let override: number | undefined;
	try {
		const data = getData();
		override = data?.getModelContextOverride?.(model) ?? data?.getModelContextOverride?.(`${provider}:${model}`);
	} catch {
		// Plugin data store not initialized in test environments
	}
	const hydrated = models.hydratedChatModelsByKey.get(`${provider}:${model}`);
	const isSameModel = existing?.provider === provider && existing?.model === model;
	const contextWindow =
		override ??
		(isSameModel && existing?.modelConfig?.contextWindow
			? existing.modelConfig.contextWindow
			: (hydrated?.contextWindow ?? existing?.modelConfig?.contextWindow ?? 128000));

	return {
		provider,
		model,
		modelConfig: {
			contextWindow,
			supportsVision: hydrated?.capabilities?.vision ?? existing?.modelConfig?.supportsVision,
			temperature: existing?.modelConfig?.temperature,
		},
	};
}
