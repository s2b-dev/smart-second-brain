import type { ChatModel } from "../stores/chatTimeline";
import { useAvailableModels } from "../hooks/useAvailableModels.svelte";
import { ASSUMED_CONTEXT_WINDOW } from "../lib/modelMetadataNormalizer";

/**
 * Build the `ChatModel` record persisted on an agent when a model is picked.
 *
 * Re-picking the model already stored keeps its stored context window and image-input
 * setting: both may be user-set (e.g. an Ollama `num_ctx` sized to the machine, or vision
 * turned on for a provider that doesn't report it) and must not be silently replaced (#542).
 * Picking a different model takes what its provider reports; a window the provider doesn't
 * report is stored as {@link ASSUMED_CONTEXT_WINDOW} and image input as unknown. Temperature
 * is always kept. Reasoning effort is kept only on a re-pick: levels are model-specific (older
 * Claude models reject the parameter outright), so a different model starts at its default.
 *
 * Shared by every model picker (composer pill, agent editor, onboarding, and the
 * "select a model" notice action) so a model selected from any of them persists
 * identically — these were four byte-identical copies before.
 */
export function buildPersistedChatModel(provider: string, model: string, existing?: ChatModel | null): ChatModel {
	const models = useAvailableModels();
	const hydrated = models.hydratedChatModelsByKey.get(`${provider}:${model}`);
	const sameModel = existing?.provider === provider && existing?.model === model;
	const stored = sameModel ? existing?.modelConfig : undefined;
	return {
		provider,
		model,
		modelConfig: {
			contextWindow: stored?.contextWindow ?? hydrated?.contextWindow ?? ASSUMED_CONTEXT_WINDOW,
			supportsVision: stored?.supportsVision ?? hydrated?.capabilities.vision,
			temperature: existing?.modelConfig?.temperature,
			reasoningEffort: sameModel ? existing?.modelConfig?.reasoningEffort : undefined,
		},
	};
}
