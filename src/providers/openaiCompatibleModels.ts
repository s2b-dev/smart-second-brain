/**
 * Model facts an OpenAI-compatible endpoint reports about its own models.
 *
 * A public catalogue only knows public model ids, so a model served under a custom name (a
 * LiteLLM alias, an SGLang or vLLM deployment) would either miss it or match some other model's
 * entry (#479). Many servers describe their models themselves, though:
 *
 * - `/v1/models` entries: `max_model_len` (vLLM, SGLang), `context_length` (OpenRouter-style
 *   catalogues, Together, Fireworks), `context_window` (Groq), `max_context_length` (Mistral).
 * - LiteLLM's `/v1/model/info`: per deployment, `model_info.max_input_tokens` (the value an
 *   operator sets for a custom deployment in the proxy config) and the `supports_*` flags.
 *   Its `/v1/models` carries none of this.
 *
 * A flag LiteLLM leaves out or sets to null is unknown, not false: a live proxy omits
 * `supports_vision` for models that do take images. Only an explicit `false` counts as "no".
 *
 * The facts are cached at module level per provider instance, filled by the provider's model
 * discovery, and read synchronously by model hydration (`lib/modelMetadataNormalizer.ts`), the
 * same way the Hugging Face catalogue is.
 */

/** The limit fields of one `/v1/models` entry that this module reads. */
export interface CompatibleModelEntry {
	id?: string;
	max_model_len?: unknown;
	context_length?: unknown;
	context_window?: unknown;
	max_context_length?: unknown;
}

/** One deployment in LiteLLM's `/v1/model/info` response (only the fields we read). */
export interface LiteLLMModelInfoEntry {
	model_name?: string;
	model_info?: {
		max_input_tokens?: unknown;
		supports_vision?: unknown;
		supports_function_calling?: unknown;
		supports_reasoning?: unknown;
		supports_response_schema?: unknown;
	} | null;
}

/** What the endpoint said about one model. Every field is absent when it said nothing. */
export interface CompatibleModelInfo {
	/** Input window in tokens: the chat context window, or an embedding model's input limit. */
	contextWindow?: number;
	vision?: boolean;
	toolCalls?: boolean;
	reasoning?: boolean;
	structuredOutput?: boolean;
}

type CapabilityKey = "vision" | "toolCalls" | "reasoning" | "structuredOutput";

const LITELLM_FLAGS: ReadonlyArray<readonly [CapabilityKey, keyof NonNullable<LiteLLMModelInfoEntry["model_info"]>]> = [
	["vision", "supports_vision"],
	["toolCalls", "supports_function_calling"],
	["reasoning", "supports_reasoning"],
	["structuredOutput", "supports_response_schema"],
];

const cachedInfo = new Map<string, Map<string, CompatibleModelInfo>>();

function positiveInt(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function entryWindow(entry: CompatibleModelEntry): number | undefined {
	return (
		positiveInt(entry.max_model_len) ??
		positiveInt(entry.context_length) ??
		positiveInt(entry.context_window) ??
		positiveInt(entry.max_context_length)
	);
}

/**
 * Fold one more LiteLLM deployment of the same model name into what is known so far. The proxy
 * may route a request to any deployment, so the model gets the smallest window and a capability
 * only every reporting deployment has; any explicit `false` wins.
 */
function mergeDeployment(known: CompatibleModelInfo, deployment: LiteLLMModelInfoEntry): CompatibleModelInfo {
	const info = deployment.model_info ?? {};
	const merged: CompatibleModelInfo = { ...known };
	const window = positiveInt(info.max_input_tokens);
	if (window !== undefined) {
		merged.contextWindow = merged.contextWindow === undefined ? window : Math.min(merged.contextWindow, window);
	}
	for (const [key, field] of LITELLM_FLAGS) {
		const value = info[field];
		if (typeof value !== "boolean") continue;
		merged[key] = merged[key] === false ? false : value;
	}
	return merged;
}

function isEmpty(info: CompatibleModelInfo): boolean {
	return Object.values(info).every((value) => value === undefined);
}

/**
 * Model facts per model id from a `/v1/models` listing and, when the server is a LiteLLM
 * proxy, its `/v1/model/info` deployments. LiteLLM's figures win: they are what the operator
 * configured for that alias.
 */
export function extractCompatibleModelInfo(
	entries: readonly CompatibleModelEntry[],
	liteLLMInfo: readonly LiteLLMModelInfoEntry[] = [],
): Map<string, CompatibleModelInfo> {
	const models = new Map<string, CompatibleModelInfo>();
	for (const entry of entries) {
		const id = entry.id?.trim();
		const window = id ? entryWindow(entry) : undefined;
		if (id && window) models.set(id, { contextWindow: window });
	}
	const liteLLMModels = new Map<string, CompatibleModelInfo>();
	for (const deployment of liteLLMInfo) {
		const name = deployment.model_name?.trim();
		if (!name) continue;
		liteLLMModels.set(name, mergeDeployment(liteLLMModels.get(name) ?? {}, deployment));
	}
	for (const [name, info] of liteLLMModels) {
		if (isEmpty(info)) continue;
		const fromListing = models.get(name);
		models.set(name, {
			...fromListing,
			...Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)),
		});
	}
	return models;
}

/** Replace the cached facts of one provider instance. */
export function setCompatibleModelInfo(providerId: string, models: Map<string, CompatibleModelInfo>): void {
	cachedInfo.set(providerId, models);
}

/** What the endpoint reported for a model, if discovery has run and it reported anything. */
export function getCompatibleModelInfo(providerId: string, modelId: string): CompatibleModelInfo | undefined {
	return cachedInfo.get(providerId)?.get(modelId);
}
