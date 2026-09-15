/**
 * OpenRouter Models API Integration
 *
 * Fetches and caches model metadata from OpenRouter's API.
 * Used for rich model information (context window, pricing, capabilities).
 *
 * @see https://openrouter.ai/docs/api/api-reference/models/get-models
 */

import { Logger } from "../utils/logging";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

/**
 * Model pricing from OpenRouter API (per token costs)
 */
interface OpenRouterPricing {
	/** Cost per prompt/input token (string for precision) */
	prompt: string;
	/** Cost per completion/output token (string for precision) */
	completion: string;
	/** Cost per image (if applicable) */
	image?: string;
	/** Cost per request (if applicable) */
	request?: string;
}

/**
 * Model architecture info from OpenRouter API
 */
interface OpenRouterArchitecture {
	/** Model modality (e.g., "text->text", "text+image->text") */
	modality?: string;
	/** Input modalities (e.g., ["text", "image", "file"]) */
	input_modalities?: string[];
	/** Output modalities (e.g., ["text"]) */
	output_modalities?: string[];
	/** Tokenizer used */
	tokenizer?: string;
	/** Instruction type (e.g., "chat", "completion") */
	instruct_type?: string | null;
}

/**
 * Top provider info from OpenRouter API
 */
interface OpenRouterTopProvider {
	/** Context length for top provider */
	context_length?: number;
	/** Max completion tokens */
	max_completion_tokens?: number;
	/** Whether the provider is moderated */
	is_moderated?: boolean;
}

/**
 * Full model data from OpenRouter API
 */
export interface OpenRouterModelInfo {
	/** Model ID (e.g., "openai/gpt-4o") */
	id: string;
	/** Canonical model slug when provided by OpenRouter (often base model lineage) */
	canonical_slug?: string;
	/** Display name */
	name: string;
	/** Model description */
	description?: string;
	/** Context length in tokens */
	context_length: number;
	/** Pricing info */
	pricing: OpenRouterPricing;
	/** Architecture details */
	architecture?: OpenRouterArchitecture;
	/** Top provider info */
	top_provider?: OpenRouterTopProvider;
	/** When the model was created in OpenRouter */
	created?: number;

	/** Supported API parameters (e.g., "tools", "reasoning", "structured_outputs") */
	supported_parameters?: string[];

	/** Per-request limits */
	per_request_limits?: {
		prompt_tokens?: string;
		completion_tokens?: string;
	};
}

/**
 * OpenRouter models API response
 */
interface OpenRouterModelsResponse {
	data: OpenRouterModelInfo[];
}

/**
 * Cached data structure
 */
interface CachedData {
	/** Map of model ID -> model info */
	models: Map<string, OpenRouterModelInfo>;
	timestamp: number;
}

// Module-level cache
let cachedResponse: CachedData | null = null;

/**
 * Populates the cache with model data from an external source.
 * Used by the OpenRouter provider to avoid duplicate API calls.
 */
export function populateOpenRouterCache(models: OpenRouterModelInfo[]): void {
	const modelMap = new Map<string, OpenRouterModelInfo>();
	for (const model of models) {
		if (model.id) {
			modelMap.set(model.id, model);
		}
	}
	cachedResponse = {
		models: modelMap,
		timestamp: Date.now(),
	};
}

/**
 * Fetches and caches OpenRouter models data.
 * Uses the public endpoint (no auth required).
 */
export async function fetchOpenRouterModels(): Promise<Map<string, OpenRouterModelInfo> | null> {
	// Return cached data if still valid
	if (cachedResponse && Date.now() - cachedResponse.timestamp < CACHE_TTL_MS) {
		return cachedResponse.models;
	}

	try {
		const response = await window.fetch(OPENROUTER_MODELS_URL, {
			method: "GET",
			headers: {
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			Logger.warn(`Failed to fetch OpenRouter models: ${response.status}`);
			return cachedResponse?.models ?? null;
		}

		const data = (await response.json()) as OpenRouterModelsResponse;

		// Build map for fast lookups
		const models = new Map<string, OpenRouterModelInfo>();
		if (Array.isArray(data.data)) {
			for (const model of data.data) {
				if (model.id) {
					models.set(model.id, model);
				}
			}
		}

		// Cache the response
		cachedResponse = {
			models,
			timestamp: Date.now(),
		};

		return models;
	} catch (error) {
		Logger.warn("Error fetching OpenRouter models:", error);
		return cachedResponse?.models ?? null;
	}
}

/**
 * Derive capabilities from OpenRouter model info.
 * The API encodes capabilities via `architecture.input_modalities` and `supported_parameters`.
 */
export function extractCapabilities(info: OpenRouterModelInfo): {
	supportsToolCalls: boolean;
	supportsVision: boolean;
	supportsReasoning: boolean;
	supportsStructuredOutput: boolean;
} {
	const params = info.supported_parameters ?? [];
	const inputModalities = info.architecture?.input_modalities ?? [];

	return {
		supportsToolCalls: params.includes("tools"),
		supportsVision: inputModalities.includes("image"),
		supportsReasoning:
			params.includes("reasoning") || params.includes("include_reasoning") || params.includes("reasoning_effort"),
		supportsStructuredOutput: params.includes("structured_outputs"),
	};
}

/**
 * Checks if a model is an embedding model based on its architecture/modality
 */
export function isEmbeddingModel(info: OpenRouterModelInfo): boolean {
	const id = info.id.toLowerCase();
	const modality = info.architecture?.modality?.toLowerCase() ?? "";

	return (
		modality.includes("embedding") ||
		id.includes("embed") ||
		id.includes("bge-") ||
		id.includes("voyage") ||
		id.includes("e5-") ||
		id.includes("gte-") ||
		id.includes("nomic-") ||
		id.includes("-embedding")
	);
}
