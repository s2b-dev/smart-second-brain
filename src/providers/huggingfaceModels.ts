/**
 * Model metadata from Hugging Face's router catalog (`router.huggingface.co/v1/models`).
 *
 * Each catalog entry lists the inference providers serving the model, each with its own
 * context length and tool support. The router sends a request to one of them, and a chat
 * with tools only to one that supports tools, so the figures here are taken over the live,
 * tool-capable providers only: the smallest context window among them, since any of them
 * may serve the request.
 *
 * The catalog is cached at module level, filled by the provider's model discovery, and
 * read synchronously by model hydration (`lib/modelMetadataNormalizer.ts`).
 */

export const HF_ROUTER_BASE_URL = "https://router.huggingface.co/v1";

/** One entry of the router's `/v1/models` catalog (only the fields we read). */
export interface RouterCatalogEntry {
	id?: string;
	architecture?: { input_modalities?: string[] };
	providers?: Array<{
		status?: string;
		context_length?: number | null;
		supports_tools?: boolean | null;
		supports_structured_output?: boolean | null;
	}>;
}

export interface HuggingFaceModelInfo {
	id: string;
	/** Smallest context window among the live tool-capable providers, when any reports one. */
	contextLength?: number;
	supportsTools: boolean;
	supportsStructuredOutput: boolean;
	supportsVision: boolean;
}

let cachedModels = new Map<string, HuggingFaceModelInfo>();

function summarize(entry: RouterCatalogEntry & { id: string }): HuggingFaceModelInfo {
	const toolProviders = (entry.providers ?? []).filter((p) => p.status === "live" && p.supports_tools);
	const contexts = toolProviders
		.map((p) => p.context_length)
		.filter((n): n is number => typeof n === "number" && n > 0);
	return {
		id: entry.id,
		contextLength: contexts.length > 0 ? Math.min(...contexts) : undefined,
		supportsTools: toolProviders.length > 0,
		supportsStructuredOutput: toolProviders.some((p) => p.supports_structured_output),
		supportsVision: entry.architecture?.input_modalities?.includes("image") ?? false,
	};
}

/**
 * Replaces the cache with the given catalog and returns the ids of the models usable by
 * the agent: those some live provider serves with tool calling. The agent needs tools for
 * nearly everything it does, so a model without them would fail on the first turn.
 */
export function populateHuggingFaceCache(entries: RouterCatalogEntry[]): string[] {
	const models = new Map<string, HuggingFaceModelInfo>();
	for (const entry of entries) {
		const id = entry.id?.trim();
		if (id) models.set(id, summarize({ ...entry, id }));
	}
	cachedModels = models;
	return [...models.values()]
		.filter((model) => model.supportsTools)
		.map((model) => model.id)
		.sort((a, b) => a.localeCompare(b));
}

/** The cached catalog: empty until the first model discovery of a Hugging Face provider. */
export function getCachedHuggingFaceModels(): ReadonlyMap<string, HuggingFaceModelInfo> {
	return cachedModels;
}

/**
 * Display name for a Hugging Face model id when no catalogue supplies one: the repo name
 * without its owner, dashes turned into spaces ("meta-llama/Llama-3.1-8B-Instruct" →
 * "Llama 3.1 8B Instruct"). The full id stays visible as the subtitle, so nothing is lost,
 * and every model of the provider reads the same way whether or not models.dev knows it.
 */
export function huggingFaceDisplayName(id: string): string {
	const repo = id.slice(id.indexOf("/") + 1);
	return repo.replace(/[-_]+/g, " ").trim() || id;
}
