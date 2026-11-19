/**
 * Models.dev API Integration
 *
 * Fetches model metadata from the open-source models.dev database.
 * Used to automatically populate model configuration (context window, costs, capabilities).
 *
 * @see https://models.dev
 */

import { Logger } from "../utils/logging";
import { createObsidianFetch } from "../lib/obsidianFetch";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

/** Model metadata from models.dev */
export interface ModelsDevModelInfo {
	id: string;
	name: string;
	family?: string;
	attachment?: boolean;
	reasoning?: boolean;
	tool_call?: boolean;
	structured_output?: boolean;
	temperature?: boolean;
	knowledge?: string;
	release_date?: string;
	last_updated?: string;
	modalities?: {
		input?: string[];
		output?: string[];
	};
	open_weights?: boolean;
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	limit?: {
		context?: number;
		input?: number;
		output?: number;
	};
}

/** Provider entry from models.dev */
interface ModelsDevProvider {
	id: string;
	env?: string[];
	npm?: string;
	api?: string;
	name: string;
	doc?: string;
	models: Record<string, ModelsDevModelInfo>;
}

/** Full API response structure */
export type ModelsDevApiResponse = Record<string, ModelsDevProvider>;

/** Cached data structure */
interface CachedData {
	data: ModelsDevApiResponse;
	timestamp: number;
}

// Module-level cache
let cachedResponse: CachedData | null = null;

/**
 * Fetches and caches the models.dev API response
 */
export async function fetchModelsDevData(): Promise<ModelsDevApiResponse | null> {
	// Return cached data if still valid
	if (cachedResponse && Date.now() - cachedResponse.timestamp < CACHE_TTL_MS) {
		return cachedResponse.data;
	}

	try {
		const obsidianFetch = createObsidianFetch();

		const response = await obsidianFetch(MODELS_DEV_API_URL, {
			method: "GET",
			headers: {
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			Logger.warn(`Failed to fetch models.dev data: ${response.status}`);
			return cachedResponse?.data ?? null;
		}

		const data = (await response.json()) as ModelsDevApiResponse;

		// Cache the response
		cachedResponse = {
			data,
			timestamp: Date.now(),
		};

		return data;
	} catch (error) {
		Logger.warn("Error fetching models.dev data:", error);
		return cachedResponse?.data ?? null;
	}
}

/**
 * Maps our provider IDs to models.dev provider IDs
 */
const PROVIDER_ID_MAP: Record<string, string[]> = {
	openai: ["openai"],
	anthropic: ["anthropic"],
	ollama: [], // Ollama models are local, not in models.dev
	openrouter: ["openrouter"],
	// Custom providers may match various providers in models.dev
};

function normalizeModelToken(value: string): string {
	let token = value.toLowerCase().trim();
	if (token.includes("/")) {
		token = token.split("/").pop() ?? token;
	}

	token = token
		.replace(/:latest$/i, "")
		.replace(/:free$/i, "")
		.replace(/:([0-9.]+[a-z]+)$/i, "-$1")
		.replace(/[^a-z0-9]/g, "");

	return token;
}

/**
 * Match after stripping separators, so "qwen3:8b", "Qwen3-8B" and "qwen/qwen3-8b" all
 * resolve to the same entry. Equality only — no edit-distance tolerance. Model ids pack
 * meaning into single characters (a version digit, a size suffix, a variant letter), so a
 * one-edit "typo" is usually a different model: "qwen3.8" is one edit from "qwen3-8b" and
 * was being renamed to it, inheriting its context window and capability flags (#480).
 */
function findNormalizedModelMatch(
	models: Record<string, ModelsDevModelInfo>,
	modelId: string,
): ModelsDevModelInfo | null {
	const target = normalizeModelToken(modelId);
	if (!target) return null;

	for (const [key, value] of Object.entries(models)) {
		for (const candidate of [key, value.id, value.name]) {
			if (candidate && normalizeModelToken(candidate) === target) {
				return value;
			}
		}
	}

	return null;
}

/**
 * Synchronous lookup of model metadata from cached models.dev data
 *
 * @param data Cached models.dev API response
 * @param providerId Our internal provider ID
 * @param modelId The model identifier (e.g., "gpt-4o", "claude-3-5-sonnet")
 * @returns Model info if found, null otherwise
 */
export function lookupModelInfoSync(
	data: ModelsDevApiResponse,
	providerId: string,
	modelId: string,
): ModelsDevModelInfo | null {
	// Get potential provider IDs to search
	const providerIds = PROVIDER_ID_MAP[providerId] ?? [providerId];

	// Search in mapped providers
	for (const pid of providerIds) {
		const provider = data[pid];
		if (provider?.models) {
			// Direct match
			if (provider.models[modelId]) {
				return provider.models[modelId];
			}

			// Try with provider prefix (e.g., "openai/gpt-4o")
			const prefixedId = `${pid}/${modelId}`;
			if (provider.models[prefixedId]) {
				return provider.models[prefixedId];
			}

			// Try partial match (model ID might be a substring)
			for (const [key, value] of Object.entries(provider.models)) {
				if (key.endsWith(`/${modelId}`) || key === modelId) {
					return value;
				}
			}

			const normalizedMatch = findNormalizedModelMatch(provider.models, modelId);
			if (normalizedMatch) {
				return normalizedMatch;
			}
		}
	}

	// Search across all providers for the model ID.
	//
	// Each tier is exhausted across every provider before the next one starts. Doing this
	// per-provider instead lets an early-iterated provider win with a weak match while a
	// later one holds the exact id: models.dev iterates "digitalocean" before "sap-ai-core",
	// so "anthropic--claude-4.5-sonnet" normalized-matched DigitalOcean's
	// "anthropic-claude-4.5-sonnet" and never reached its own vendor's verbatim entry.
	// Provider order in the catalogue is not a relevance signal, so it must not outrank
	// match quality.
	for (const provider of Object.values(data)) {
		if (provider.models?.[modelId]) {
			return provider.models[modelId];
		}
	}

	// Prefixed variants (e.g. "openai/gpt-4o" for "gpt-4o")
	for (const provider of Object.values(data)) {
		if (!provider.models) continue;
		for (const [key, value] of Object.entries(provider.models)) {
			if (key.endsWith(`/${modelId}`) || key.split("/").pop() === modelId) {
				return value;
			}
		}
	}

	for (const provider of Object.values(data)) {
		if (!provider.models) continue;
		const normalizedMatch = findNormalizedModelMatch(provider.models, modelId);
		if (normalizedMatch) {
			return normalizedMatch;
		}
	}

	return null;
}

/**
 * Looks up model metadata from models.dev (async - fetches data if needed)
 *
 * @param providerId Our internal provider ID
 * @param modelId The model identifier (e.g., "gpt-4o", "claude-3-5-sonnet")
 * @returns Model info if found, null otherwise
 */
export async function lookupModelInfo(providerId: string, modelId: string): Promise<ModelsDevModelInfo | null> {
	const data = await fetchModelsDevData();
	if (!data) return null;

	return lookupModelInfoSync(data, providerId, modelId);
}

/**
 * Checks if a model is likely an embedding model based on its info
 */
export function isEmbeddingModel(info: ModelsDevModelInfo): boolean {
	const name = info.name?.toLowerCase() ?? "";
	const id = info.id?.toLowerCase() ?? "";
	const family = info.family?.toLowerCase() ?? "";

	return name.includes("embed") || id.includes("embed") || family.includes("embed") || family === "text-embedding";
}
