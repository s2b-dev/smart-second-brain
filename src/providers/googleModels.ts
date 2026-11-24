/**
 * Model catalog of the Gemini API (`GET /v1beta/models`).
 *
 * The catalog lists every model the key can call, each with the generation methods it
 * supports. Chat models are the ones that support `generateContent`, embedding models the
 * ones that support `embedContent`. A model with both is listed as chat only.
 *
 * The catalog is cached per provider instance, since two instances may point at different
 * endpoints. Each instance's model discovery fills its entry, and model hydration
 * (`lib/modelMetadataNormalizer.ts`) reads it synchronously for display names, token limits
 * and thinking support. The catalog says nothing about image input or tool calling, so those
 * stay unknown (the Agent editor's Image input toggle covers vision).
 */

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
export const GEMINI_API_VERSION = "v1beta";

/** One entry of the `models` list (only the fields we read). */
export interface GeminiCatalogEntry {
	/** Resource name, e.g. "models/gemini-2.5-flash". */
	name?: string;
	displayName?: string;
	inputTokenLimit?: number;
	outputTokenLimit?: number;
	supportedGenerationMethods?: string[];
	/** Whether the model thinks; absent from older entries and some proxies. */
	thinking?: unknown;
}

export interface GeminiModelResponse {
	models?: GeminiCatalogEntry[];
	nextPageToken?: string;
}

export interface GeminiModelInfo {
	/** Model id without the "models/" prefix, e.g. "gemini-2.5-flash". */
	id: string;
	displayName?: string;
	inputTokenLimit?: number;
	/** The model thinks (reasons before answering); undefined when not reported. */
	thinking?: boolean;
	kind: "chat" | "embedding";
}

/**
 * Models that support `generateContent` but do not answer in text: speech synthesis,
 * image generation, and the realtime audio models that only work over the Live API.
 * The catalog has no output-modality field to tell them apart, so this goes by the
 * markers Google puts in those model ids.
 */
const NON_TEXT_OUTPUT = /(?:^|-)(?:tts|image|image-generation|native-audio|live)(?:-|$)/;

const cachedModels = new Map<string, Map<string, GeminiModelInfo>>();

/** "models/gemini-2.5-flash" → "gemini-2.5-flash". */
export function geminiModelId(name: string): string {
	return name.replace(/^models\//, "").trim();
}

function classify(entry: GeminiCatalogEntry, id: string): GeminiModelInfo["kind"] | null {
	const methods = entry.supportedGenerationMethods ?? [];
	if (methods.includes("generateContent")) {
		return NON_TEXT_OUTPUT.test(id) ? null : "chat";
	}
	if (methods.includes("embedContent")) return "embedding";
	return null;
}

/** Replaces the provider instance's cached catalog with the given one. */
export function populateGeminiCache(providerId: string, entries: GeminiCatalogEntry[]): void {
	const models = new Map<string, GeminiModelInfo>();
	for (const entry of entries) {
		const id = entry.name ? geminiModelId(entry.name) : "";
		if (!id) continue;
		const kind = classify(entry, id);
		if (!kind) continue;
		models.set(id, {
			id,
			kind,
			displayName: entry.displayName?.trim() || undefined,
			inputTokenLimit:
				typeof entry.inputTokenLimit === "number" && entry.inputTokenLimit > 0
					? entry.inputTokenLimit
					: undefined,
			thinking: typeof entry.thinking === "boolean" ? entry.thinking : undefined,
		});
	}
	cachedModels.set(providerId, models);
}

/** What the instance's catalog reported for a model, if its discovery has run. */
export function getGeminiModelInfo(providerId: string, modelId: string): GeminiModelInfo | undefined {
	return cachedModels.get(providerId)?.get(modelId);
}

/** Whether the instance's discovery has filled its catalog yet. */
export function hasGeminiModelInfo(providerId: string): boolean {
	return cachedModels.has(providerId);
}

/** Ids of the instance's cached models of one kind, sorted. */
export function cachedGeminiModelIds(providerId: string, kind: GeminiModelInfo["kind"]): string[] {
	return [...getCachedGeminiModels(providerId).values()]
		.filter((model) => model.kind === kind)
		.map((model) => model.id)
		.sort((a, b) => a.localeCompare(b));
}

/** The instance's cached catalog: empty until its first model discovery. */
export function getCachedGeminiModels(providerId: string): ReadonlyMap<string, GeminiModelInfo> {
	return cachedModels.get(providerId) ?? new Map();
}
