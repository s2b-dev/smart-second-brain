/**
 * LM Studio model metadata.
 *
 * LM Studio's OpenAI-compatible `/v1/models` lists bare ids, with nothing to tell a chat model from an
 * embedding model, nor any context length. Its native REST API does carry that, in two generations:
 *
 * - `GET /api/v1/models` (LM Studio 0.4+): `models[]` with `key`, `type` ("llm" | "embedding" |
 *   "decision"), `max_context_length`, `capabilities.vision` / `capabilities.trained_for_tool_use`, and
 *   `loaded_instances[].config.context_length`, the window the model is actually loaded with.
 * - `GET /api/v0/models` (LM Studio 0.3.6+): `data[]` with `id`, `type` ("llm" | "vlm" | "embeddings"),
 *   `state` ("loaded" | "not-loaded"), `max_context_length`, and `loaded_context_length` when loaded.
 *
 * Both are normalized to {@link LmStudioModelInfo} and cached at module level per provider instance,
 * filled by the provider's model discovery and read synchronously by model hydration
 * (`lib/modelMetadataNormalizer.ts`), the same way the OpenAI-compatible context windows are.
 *
 * A model that isn't loaded yet reports only its maximum, and LM Studio JIT-loads it on the first
 * request at whatever context its load settings say, usually far less. So the window saved on an
 * agent when the model was picked can exceed what the server then enforces, so each turn clamps
 * it to the loaded length first (`agent/lmStudioContextWindow.ts`).
 *
 * @see https://lmstudio.ai/docs/developer/rest/list
 * @see https://lmstudio.ai/docs/developer/rest/endpoints
 */

export type LmStudioModelKind = "chat" | "embedding";

/** One LM Studio model, normalized across the v1 and v0 REST APIs. */
export interface LmStudioModelInfo {
	/** The id the OpenAI-compatible endpoints accept (`key` in v1, `id` in v0). */
	id: string;
	kind: LmStudioModelKind;
	displayName?: string;
	/** e.g. "Q4_K_M", "4bit". */
	quantization?: string;
	/** e.g. "7B" (v1 only). */
	paramSize?: string;
	/** Whether LM Studio currently has the model in memory. */
	loaded: boolean;
	/**
	 * The context window a request can use. When the model is loaded this is the length it was
	 * loaded with, which is what LM Studio enforces (a model JIT-loaded at 4096 tokens rejects or
	 * truncates anything longer, whatever its architecture supports); otherwise the model's maximum.
	 */
	contextLength?: number;
	/** Undefined when the API doesn't say (v0 reports vision via `type: "vlm"` only). */
	supportsVision?: boolean;
	supportsTools?: boolean;
	/** v1 only: the model exposes a reasoning setting (`capabilities.reasoning`). */
	reasoning?: boolean;
}

// =============================================================================
// Raw response shapes (only the fields we read)
// =============================================================================

interface V1LoadedInstance {
	config?: { context_length?: unknown } | null;
}

interface V1ModelEntry {
	type?: string;
	key?: string;
	display_name?: string;
	quantization?: { name?: string | null } | null;
	params_string?: string | null;
	loaded_instances?: V1LoadedInstance[] | null;
	max_context_length?: unknown;
	capabilities?: { vision?: unknown; trained_for_tool_use?: unknown; reasoning?: unknown } | null;
}

export interface LmStudioV1ModelsResponse {
	models?: V1ModelEntry[];
}

interface V0ModelEntry {
	id?: string;
	type?: string;
	quantization?: string;
	state?: string;
	max_context_length?: unknown;
	loaded_context_length?: unknown;
	capabilities?: unknown;
}

export interface LmStudioV0ModelsResponse {
	data?: V0ModelEntry[];
}

// =============================================================================
// Parsing
// =============================================================================

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function nonEmpty(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Normalizes a `/api/v1/models` response. Decision models (LM Studio's classifier type) can serve
 * neither chat nor embeddings and are dropped, as is anything of an unknown type.
 */
export function parseV1Models(payload: LmStudioV1ModelsResponse): LmStudioModelInfo[] {
	if (!Array.isArray(payload.models)) return [];
	const out: LmStudioModelInfo[] = [];
	for (const entry of payload.models) {
		const id = nonEmpty(entry.key);
		const kind: LmStudioModelKind | undefined =
			entry.type === "llm" ? "chat" : entry.type === "embedding" ? "embedding" : undefined;
		if (!id || !kind) continue;

		// Several instances of one model may be loaded; a request can land on any of them.
		const loadedWindows = (entry.loaded_instances ?? [])
			.map((instance) => positiveInt(instance.config?.context_length))
			.filter((n): n is number => n !== undefined);
		const contextLength =
			loadedWindows.length > 0 ? Math.min(...loadedWindows) : positiveInt(entry.max_context_length);

		const capabilities = entry.capabilities ?? undefined;
		out.push({
			id,
			kind,
			loaded: loadedWindows.length > 0,
			displayName: nonEmpty(entry.display_name),
			quantization: nonEmpty(entry.quantization?.name),
			paramSize: nonEmpty(entry.params_string),
			contextLength,
			supportsVision: typeof capabilities?.vision === "boolean" ? capabilities.vision : undefined,
			supportsTools:
				typeof capabilities?.trained_for_tool_use === "boolean" ? capabilities.trained_for_tool_use : undefined,
			reasoning: capabilities ? Boolean(capabilities.reasoning) : undefined,
		});
	}
	return out;
}

/** Normalizes a `/api/v0/models` response (LM Studio 0.3.x). */
export function parseV0Models(payload: LmStudioV0ModelsResponse): LmStudioModelInfo[] {
	if (!Array.isArray(payload.data)) return [];
	const out: LmStudioModelInfo[] = [];
	for (const entry of payload.data) {
		const id = nonEmpty(entry.id);
		const kind: LmStudioModelKind | undefined =
			entry.type === "llm" || entry.type === "vlm"
				? "chat"
				: entry.type === "embeddings"
					? "embedding"
					: undefined;
		if (!id || !kind) continue;

		const loadedWindow = entry.state === "loaded" ? positiveInt(entry.loaded_context_length) : undefined;
		const contextLength = loadedWindow ?? positiveInt(entry.max_context_length);
		const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : undefined;

		out.push({
			id,
			kind,
			loaded: loadedWindow !== undefined,
			quantization: nonEmpty(entry.quantization),
			contextLength,
			// v0 has no capability flags for vision: LM Studio types a model with a vision adapter "vlm".
			supportsVision: kind === "chat" ? entry.type === "vlm" : undefined,
			supportsTools: capabilities ? capabilities.includes("tool_use") : undefined,
		});
	}
	return out;
}

/**
 * Fallback for servers without the native REST API: `/v1/models` ids only. LM Studio's embedding
 * models are conventionally named `text-embedding-*`, and every embedding model in its catalogue
 * carries "embed" in its id, so that is the split.
 */
export function classifyOpenAIModelIds(ids: readonly string[]): LmStudioModelInfo[] {
	return ids
		.map((id) => id.trim())
		.filter((id) => id !== "")
		.map((id) => ({ id, kind: /embed/i.test(id) ? "embedding" : "chat", loaded: false }));
}

// =============================================================================
// Cache (per provider instance)
// =============================================================================

const cachedModels = new Map<string, Map<string, LmStudioModelInfo>>();

/** Replace the cached models of one provider instance. */
export function setLmStudioModels(providerId: string, models: readonly LmStudioModelInfo[]): void {
	cachedModels.set(providerId, new Map(models.map((model) => [model.id, model])));
}

/** The metadata discovery recorded for a model, if discovery has run for this provider instance. */
export function getLmStudioModel(providerId: string, modelId: string): LmStudioModelInfo | undefined {
	return cachedModels.get(providerId)?.get(modelId);
}

/** Whether discovery has populated the cache for this provider instance. */
export function hasLmStudioModels(providerId: string): boolean {
	return cachedModels.has(providerId);
}
