/**
 * Model facts Anthropic's `GET /v1/models` reports about each model.
 *
 * Each entry carries `display_name`, `max_input_tokens` (the context window), `max_tokens` (the
 * output cap) and a `capabilities` tree with `supported` at every leaf: `image_input`,
 * `structured_outputs`, `thinking` (with `types.enabled` / `types.adaptive`) and `effort`
 * (with one child per level: `low`, `medium`, `high`, `xhigh`, `max`). A proxy in front of the
 * API may answer with only `id` and `display_name`; whatever is missing stays unknown.
 *
 * Cached at module level per provider instance, filled by model discovery and read
 * synchronously by hydration (`lib/modelMetadataNormalizer.ts`), like the other provider
 * catalogues.
 */

/** One `/v1/models` entry (only the fields we read). */
export interface AnthropicModelEntry {
	id?: string;
	display_name?: string;
	max_input_tokens?: unknown;
	max_tokens?: unknown;
	capabilities?: unknown;
}

export interface AnthropicModelInfo {
	id: string;
	displayName?: string;
	/** Context window in tokens. */
	maxInputTokens?: number;
	maxOutputTokens?: number;
	vision?: boolean;
	/** The model can think (extended or adaptive thinking). */
	thinking?: boolean;
	structuredOutput?: boolean;
	/** Effort levels the model accepts, in the API's order; absent when not reported. */
	effortLevels?: string[];
}

const cachedModels = new Map<string, Map<string, AnthropicModelInfo>>();

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `supported` flag of a capability node, or undefined when the node isn't there. */
function supported(node: unknown): boolean | undefined {
	return isRecord(node) && typeof node.supported === "boolean" ? node.supported : undefined;
}

function effortLevels(node: unknown): string[] | undefined {
	if (!isRecord(node) || supported(node) === undefined) return undefined;
	if (!supported(node)) return [];
	return Object.entries(node)
		.filter(([key, child]) => key !== "supported" && supported(child) === true)
		.map(([key]) => key);
}

export function summarizeAnthropicModel(entry: AnthropicModelEntry & { id: string }): AnthropicModelInfo {
	const capabilities = isRecord(entry.capabilities) ? entry.capabilities : {};
	const info: AnthropicModelInfo = {
		id: entry.id,
		displayName: entry.display_name?.trim() || undefined,
		maxInputTokens: positiveInt(entry.max_input_tokens),
		maxOutputTokens: positiveInt(entry.max_tokens),
		vision: supported(capabilities.image_input),
		thinking: supported(capabilities.thinking),
		structuredOutput: supported(capabilities.structured_outputs),
		effortLevels: effortLevels(capabilities.effort),
	};
	return info;
}

/** Replace one provider instance's cached models with a fresh `/v1/models` listing. */
export function populateAnthropicCache(providerId: string, entries: readonly AnthropicModelEntry[]): string[] {
	const models = new Map<string, AnthropicModelInfo>();
	for (const entry of entries) {
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		if (id) models.set(id, summarizeAnthropicModel({ ...entry, id }));
	}
	cachedModels.set(providerId, models);
	return [...models.keys()];
}

/** What Anthropic reported for a model, if discovery has run for that provider instance. */
export function getAnthropicModelInfo(providerId: string, modelId: string): AnthropicModelInfo | undefined {
	return cachedModels.get(providerId)?.get(modelId);
}
