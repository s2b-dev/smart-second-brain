import type { ChatModel } from "../stores/chatTimeline";
import { useAvailableModels } from "../hooks/useAvailableModels.svelte";

/**
 * Build the `ChatModel` record persisted on an agent when a model is picked.
 *
 * Re-picking the model already stored keeps its stored context window: that value may be
 * user-tuned (e.g. an Ollama `num_ctx` sized to the machine), and catalogue metadata —
 * which falls back to a 128k default when the provider reports nothing — must not
 * silently replace it (#542). Picking a different model takes the hydrated catalogue
 * value. Vision support follows the catalogue where known; temperature is always kept.
 *
 * Shared by every model picker (composer pill, agent editor, onboarding, and the
 * "select a model" notice action) so a model selected from any of them persists
 * identically — these were four byte-identical copies before.
 */
export function buildPersistedChatModel(provider: string, model: string, existing?: ChatModel | null): ChatModel {
	const models = useAvailableModels();
	const hydrated = models.hydratedChatModelsByKey.get(`${provider}:${model}`);
	const sameModel = existing?.provider === provider && existing?.model === model;
	const storedContextWindow = sameModel ? existing?.modelConfig?.contextWindow : undefined;
	return {
		provider,
		model,
		modelConfig: {
			contextWindow:
				storedContextWindow ?? hydrated?.contextWindow ?? existing?.modelConfig?.contextWindow ?? 128000,
			supportsVision: hydrated?.capabilities.vision ?? existing?.modelConfig?.supportsVision,
			temperature: existing?.modelConfig?.temperature,
		},
	};
}
