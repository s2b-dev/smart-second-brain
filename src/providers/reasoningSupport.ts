/**
 * Whether a model accepts a reasoning effort, as the provider itself reports it.
 *
 * Filled by each provider's model discovery from its own metadata, never from a third-party
 * catalogue: Anthropic's `/v1/models` capability tree, OpenRouter's `supported_parameters`,
 * LiteLLM's `/v1/model/info` `supports_reasoning`. A model the provider says nothing about
 * has no entry, and `undefined` means unknown, not unsupported: the Agent editor still
 * offers the setting then, and a model that rejects it gets a reset notice
 * (`agent/reasoningEffortErrors.ts`).
 *
 * Module-level per provider instance, read synchronously, like `openaiCompatibleModels.ts`.
 */

import type { LiteLLMModelInfoEntry } from "./openaiCompatibleModels";

const support = new Map<string, Map<string, boolean>>();

/** Replace what one provider instance reported. Models it said nothing about are left out. */
export function setReasoningEffortSupport(providerId: string, byModel: Map<string, boolean>): void {
	support.set(providerId, byModel);
}

/** `true`/`false` when the provider reported it, `undefined` when it didn't (or discovery hasn't run). */
export function getReasoningEffortSupport(providerId: string, modelId: string): boolean | undefined {
	return support.get(providerId)?.get(modelId);
}

/** The fields of an Anthropic `/v1/models` entry's `capabilities` tree that this reads. */
export interface AnthropicModelCapabilities {
	thinking?: { types?: { adaptive?: { supported?: boolean } } };
	effort?: { supported?: boolean };
}

/**
 * Anthropic: the plugin sends `output_config.effort` together with adaptive thinking, so
 * the model must support both. Entries without a capability tree (older API versions,
 * proxies that strip it) stay unknown.
 */
export function anthropicReasoningEffortSupport(
	entries: readonly { id?: string; capabilities?: AnthropicModelCapabilities | null }[],
): Map<string, boolean> {
	const byModel = new Map<string, boolean>();
	for (const entry of entries) {
		const id = entry.id?.trim();
		const caps = entry.capabilities;
		if (!id || !caps) continue;
		byModel.set(id, caps.thinking?.types?.adaptive?.supported === true && caps.effort?.supported === true);
	}
	return byModel;
}

/**
 * LiteLLM: `model_info.supports_reasoning` per deployment. A model name served by several
 * deployments is supported only if every deployment that reports the flag says so, since
 * the proxy may route a request to any of them.
 */
export function liteLLMReasoningEffortSupport(deployments: readonly LiteLLMModelInfoEntry[]): Map<string, boolean> {
	const byModel = new Map<string, boolean>();
	for (const deployment of deployments) {
		const name = deployment.model_name?.trim();
		const flag = deployment.model_info?.supports_reasoning;
		if (!name || typeof flag !== "boolean") continue;
		byModel.set(name, (byModel.get(name) ?? true) && flag);
	}
	return byModel;
}
