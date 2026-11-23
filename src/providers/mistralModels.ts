/**
 * Model metadata from Mistral's catalogue (`api.mistral.ai/v1/models`).
 *
 * Every entry carries a `capabilities` object (`completion_chat`, `function_calling`,
 * `vision`, …) and a `max_context_length`, so chat and embedding models are told apart,
 * and vision is resolved per model, from what the API says rather than from model names.
 *
 * Cached at module level per provider instance (an organisation's fine-tuned models only
 * show up for its own key), filled by model discovery and read synchronously by model
 * hydration (`lib/modelMetadataNormalizer.ts`), like the other provider catalogues.
 */

export const MISTRAL_API_BASE_URL = "https://api.mistral.ai";

/** One entry of `/v1/models` (only the fields we read). */
export interface MistralCatalogEntry {
	id?: string;
	capabilities?: {
		completion_chat?: boolean;
		function_calling?: boolean;
		vision?: boolean;
	};
	max_context_length?: number | null;
	/** ISO date after which the model is retired; null or absent while it is current. */
	deprecation?: string | null;
}

export interface MistralModelInfo {
	id: string;
	contextLength?: number;
	supportsChat: boolean;
	supportsTools: boolean;
	supportsVision: boolean;
	isEmbedding: boolean;
}

const cachedModels = new Map<string, Map<string, MistralModelInfo>>();

function summarize(entry: MistralCatalogEntry & { id: string }): MistralModelInfo {
	const capabilities = entry.capabilities ?? {};
	const contextLength = entry.max_context_length;
	const supportsChat = capabilities.completion_chat === true;
	return {
		id: entry.id,
		contextLength: typeof contextLength === "number" && contextLength > 0 ? contextLength : undefined,
		supportsChat,
		supportsTools: capabilities.function_calling === true,
		supportsVision: capabilities.vision === true,
		// The catalogue has no "embedding" capability; an embedding model is one that
		// can't chat and says what it is in its id (mistral-embed, codestral-embed).
		isEmbedding: !supportsChat && entry.id.toLowerCase().includes("embed"),
	};
}

function isRetired(entry: MistralCatalogEntry, now: number): boolean {
	if (!entry.deprecation) return false;
	const retiresAt = Date.parse(entry.deprecation);
	return Number.isFinite(retiresAt) && retiresAt <= now;
}

/**
 * Replaces one provider instance's cached models with the given catalogue and returns the ids worth offering:
 * `chat` holds models that chat *with tool calling* (the agent needs tools for nearly
 * everything, so a model without them would fail on the first turn), `embedding` the
 * embedding models. Retired models are dropped from both.
 */
export function populateMistralCache(
	providerId: string,
	entries: MistralCatalogEntry[],
	now: number = Date.now(),
): { chat: string[]; embedding: string[] } {
	const models = new Map<string, MistralModelInfo>();
	for (const entry of entries) {
		const id = entry.id?.trim();
		if (!id || isRetired(entry, now)) continue;
		models.set(id, summarize({ ...entry, id }));
	}
	cachedModels.set(providerId, models);
	const all = [...models.values()];
	const sorted = (ids: string[]) => ids.sort((a, b) => a.localeCompare(b));
	return {
		chat: sorted(all.filter((m) => m.supportsChat && m.supportsTools).map((m) => m.id)),
		embedding: sorted(all.filter((m) => m.isEmbedding).map((m) => m.id)),
	};
}

/** What Mistral reported for a model, if discovery has run for that provider instance. */
export function getMistralModelInfo(providerId: string, modelId: string): MistralModelInfo | undefined {
	return cachedModels.get(providerId)?.get(modelId);
}
