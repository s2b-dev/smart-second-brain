/**
 * Ollama Models API Integration
 *
 * Fetches and caches model metadata from Ollama's /api/show endpoint.
 * Used for rich model information (context window, parameter size, capabilities).
 *
 * @see https://github.com/ollama/ollama/blob/main/docs/api.md#show-model-information
 */

import { Logger } from "../utils/logging";

const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour (shorter than cloud APIs since local)

/**
 * `num_ctx` sent with every Ollama embedding request, and the ceiling on the
 * input budget the chunker sizes Ollama models against.
 *
 * The server accepts min(num_ctx, model context) tokens per input, and its
 * num_ctx default is chosen from free VRAM (4k and up) — not readable through
 * the API, and unrelated to the architecture context `/api/show` reports.
 * Pinning one value on both sides is what makes a chunk that fits the budget
 * fit the server (#485). 8k covers every current embedding model's useful
 * range while keeping the KV allocation modest on small GPUs.
 */
export const OLLAMA_EMBED_NUM_CTX = 8192;

/**
 * Model details from Ollama API
 */
interface OllamaModelDetails {
	parent_model?: string;
	format?: string;
	family?: string;
	families?: string[];
	parameter_size?: string;
	quantization_level?: string;
}

/**
 * Model info from Ollama API (the nested model_info object)
 */
interface OllamaModelInfoRaw {
	"general.architecture"?: string;
	"general.parameter_count"?: number;
	"llama.context_length"?: number;
	"llama.embedding_length"?: number;
	[key: string]: unknown;
}

/**
 * Full response from /api/show endpoint
 */
interface OllamaShowResponse {
	modelfile?: string;
	parameters?: string;
	template?: string;
	details?: OllamaModelDetails;
	model_info?: OllamaModelInfoRaw;
	capabilities?: string[];
}

/**
 * Normalized model info for display
 */
export interface OllamaModelInfo {
	/** Model name */
	name: string;
	/** Model family (e.g., "llama", "mistral") */
	family?: string;
	/** Additional family aliases returned by Ollama */
	families?: string[];
	/** Parameter size (e.g., "8.0B", "70B") */
	parameterSize?: string;
	/** Quantization level (e.g., "Q4_0", "Q8_0") */
	quantization?: string;
	/** Context window length */
	contextLength?: number;
	/** Embedding dimensions (for embedding models) */
	embeddingLength?: number;
	/** Supported capabilities */
	capabilities?: string[];
	/** Whether model supports vision */
	supportsVision?: boolean;
	/** Whether model supports tool/function calling */
	supportsTools?: boolean;
}

/**
 * Cached data structure
 */
interface CachedData {
	/** Map of model name -> model info */
	models: Map<string, OllamaModelInfo>;
	/** Base URL this cache is for */
	baseUrl: string;
	timestamp: number;
}

// Module-level cache (per base URL)
let cachedResponse: CachedData | null = null;

/**
 * Fetches model info from Ollama's /api/show endpoint
 */
async function fetchModelInfo(baseUrl: string, modelName: string): Promise<OllamaModelInfo | null> {
	try {
		const response = await window.fetch(`${baseUrl}/api/show`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model: modelName }),
		});

		if (!response.ok) {
			Logger.warn(`Failed to fetch Ollama model info for ${modelName}: ${response.status}`);
			return null;
		}

		const data = (await response.json()) as OllamaShowResponse;

		// Extract context length from model_info (try different architecture prefixes)
		let contextLength: number | undefined;
		let embeddingLength: number | undefined;

		if (data.model_info) {
			// Try common architecture prefixes
			const archPrefixes = ["llama", "mistral", "gemma", "phi", "qwen", "starcoder", "codellama"];
			for (const prefix of archPrefixes) {
				if (data.model_info[`${prefix}.context_length`] !== undefined) {
					contextLength = data.model_info[`${prefix}.context_length`] as number;
				}
				if (data.model_info[`${prefix}.embedding_length`] !== undefined) {
					embeddingLength = data.model_info[`${prefix}.embedding_length`] as number;
				}
			}
			// Also check direct keys
			if (data.model_info["llama.context_length"] !== undefined) {
				contextLength = data.model_info["llama.context_length"];
			}
		}

		// Parse capabilities
		const capabilities = data.capabilities ?? [];
		const supportsVision = capabilities.includes("vision");
		const supportsTools = capabilities.includes("tools");

		return {
			name: modelName,
			family: data.details?.family ?? data.details?.families?.[0],
			families: data.details?.families,
			parameterSize: data.details?.parameter_size,
			quantization: data.details?.quantization_level,
			contextLength,
			embeddingLength,
			capabilities,
			supportsVision,
			supportsTools,
		};
	} catch (error) {
		Logger.warn(`Error fetching Ollama model info for ${modelName}:`, error);
		return null;
	}
}

/**
 * Fetches and caches model metadata for all models.
 * Called during model discovery to populate the cache.
 *
 * @param baseUrl The Ollama server URL
 * @param modelNames List of model names to fetch info for
 */
export async function fetchOllamaModelsInfo(
	baseUrl: string,
	modelNames: string[],
): Promise<Map<string, OllamaModelInfo>> {
	// Check if cache is still valid for this base URL
	if (cachedResponse && cachedResponse.baseUrl === baseUrl && Date.now() - cachedResponse.timestamp < CACHE_TTL_MS) {
		// Return cached models, but fetch any missing ones
		const missing = modelNames.filter((name) => !cachedResponse?.models.has(name));
		if (missing.length === 0) {
			return cachedResponse.models;
		}

		// Fetch missing models
		const newModels = await Promise.all(missing.map((name) => fetchModelInfo(baseUrl, name)));

		for (let i = 0; i < missing.length; i++) {
			const info = newModels[i];
			if (info) {
				cachedResponse.models.set(missing[i], info);
			}
		}

		return cachedResponse.models;
	}

	// Fetch all models in parallel (limit concurrency to avoid overwhelming local server)
	const BATCH_SIZE = 5;
	const models = new Map<string, OllamaModelInfo>();

	for (let i = 0; i < modelNames.length; i += BATCH_SIZE) {
		const batch = modelNames.slice(i, i + BATCH_SIZE);
		const results = await Promise.all(batch.map((name) => fetchModelInfo(baseUrl, name)));

		for (let j = 0; j < batch.length; j++) {
			const info = results[j];
			if (info) {
				models.set(batch[j], info);
			}
		}
	}

	// Cache the results
	cachedResponse = {
		models,
		baseUrl,
		timestamp: Date.now(),
	};

	return models;
}

/**
 * Gets cached Ollama models data (synchronous).
 * Returns null if cache is empty or for a different base URL.
 */
export function getOllamaModelsCache(baseUrl: string): Map<string, OllamaModelInfo> | null {
	if (cachedResponse && cachedResponse.baseUrl === baseUrl && Date.now() - cachedResponse.timestamp < CACHE_TTL_MS) {
		return cachedResponse.models;
	}
	return null;
}

/**
 * Format parameter size for display (e.g., "8.0B" -> "8B")
 */
export function formatParameterSize(size?: string): string {
	if (!size) return "—";
	// Remove trailing decimals from size (8.0B -> 8B)
	return size.replace(/\.0([BKMGT])$/, "$1");
}
