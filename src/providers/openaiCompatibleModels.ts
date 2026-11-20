/**
 * Context windows reported by an OpenAI-compatible endpoint itself.
 *
 * models.dev only knows public model ids, so a model served under a custom name (a LiteLLM
 * alias, an SGLang or vLLM deployment) either misses it and falls back to 128k, or matches some
 * other model's entry and takes its window (#479). Many servers report the real limit, though:
 *
 * - `/v1/models` entries: `max_model_len` (vLLM, SGLang), `context_length` (OpenRouter-style
 *   catalogues, Together, Fireworks), `context_window` (Groq), `max_context_length` (Mistral).
 * - LiteLLM's `/v1/model/info`: `model_info.max_input_tokens`, the value an operator sets for a
 *   custom deployment in the proxy config. Its `/v1/models` carries no limit at all.
 *
 * The windows are cached at module level per provider instance, filled by the provider's model
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
	model_info?: { max_input_tokens?: unknown } | null;
}

const cachedWindows = new Map<string, Map<string, number>>();

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
 * Context window per model id from a `/v1/models` listing and, when the server is a LiteLLM
 * proxy, its `/v1/model/info` deployments. LiteLLM's figure wins: it is what the operator
 * configured for that alias. A model name with several deployments takes the smallest window,
 * since the proxy may route a request to any of them.
 */
export function extractContextWindows(
	entries: readonly CompatibleModelEntry[],
	liteLLMInfo: readonly LiteLLMModelInfoEntry[] = [],
): Map<string, number> {
	const windows = new Map<string, number>();
	for (const entry of entries) {
		const id = entry.id?.trim();
		const window = id ? entryWindow(entry) : undefined;
		if (id && window) windows.set(id, window);
	}
	const liteLLMWindows = new Map<string, number>();
	for (const deployment of liteLLMInfo) {
		const name = deployment.model_name?.trim();
		const window = positiveInt(deployment.model_info?.max_input_tokens);
		if (!name || !window) continue;
		const known = liteLLMWindows.get(name);
		liteLLMWindows.set(name, known === undefined ? window : Math.min(known, window));
	}
	for (const [name, window] of liteLLMWindows) windows.set(name, window);
	return windows;
}

/** Replace the cached windows of one provider instance. */
export function setCompatibleContextWindows(providerId: string, windows: Map<string, number>): void {
	cachedWindows.set(providerId, windows);
}

/** The window the endpoint reported for a model, if discovery has run and it reported one. */
export function getCompatibleContextWindow(providerId: string, modelId: string): number | undefined {
	return cachedWindows.get(providerId)?.get(modelId);
}
