/**
 * OpenRouter built-in provider definition
 *
 * OpenRouter is an OpenAI-compatible API that provides access to multiple
 * AI providers (Anthropic, Google, Meta, etc.) through a single API.
 *
 * This provider supports:
 * - Chat models from various providers via OpenRouter
 * - Embedding models (filtered by name heuristics)
 * - Model discovery via OpenRouter API
 *
 * Authentication: apiKey (required)
 */

import { requestUrl } from "obsidian";
import type {
	AuthObject,
	AuthValidationResult,
	EmbeddingProviderDefinition,
	ChatModelConfig,
} from "../types/provider/index";
import OpenRouterLogo from "../components/ui/logos/OpenRouterLogo.svelte";
import { populateOpenRouterCache, type OpenRouterModelInfo } from "./openrouterModels";
import { signInWithOpenRouter, cancelOpenRouterSignIn, submitOpenRouterAuthCode } from "./openrouterOAuth";
import {
	createBufferedTransportedChatOpenAI,
	createTransportedChatOpenAI,
	createTransportedOpenAIEmbeddings,
} from "./chatProviders";

// =============================================================================
// Constants
// =============================================================================

/** OpenRouter API base URL */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Safely reads response text, returning undefined on error.
 */
async function safeReadText(response: Response): Promise<string | undefined> {
	try {
		return await response.text();
	} catch {
		return undefined;
	}
}

// =============================================================================
// API Response Types
// =============================================================================

interface OpenRouterModelResponse {
	data?: OpenRouterModelInfo[];
}

// =============================================================================
// Provider Definition
// =============================================================================

/**
 * OpenRouter built-in provider definition.
 *
 * Supports chat and embedding models.
 */
export const openrouterProvider: EmbeddingProviderDefinition = {
	// =========================================================================
	// Identity
	// =========================================================================
	id: "openrouter",
	displayName: "OpenRouter",
	logo: OpenRouterLogo,

	// =========================================================================
	// Setup Instructions
	// =========================================================================
	setupInstructions: {
		steps: ["Create an account at OpenRouter", "Generate an API key from the Keys page", "Paste the API key below"],
		link: {
			url: "https://openrouter.ai/keys",
			text: "OpenRouter Keys",
		},
	},

	// =========================================================================
	// OAuth (browser sign-in) capability
	// =========================================================================
	oauth: {
		label: "OpenRouter",
		icon: "log-in",
		description: "Authorize in your browser to connect without manually creating an API key.",
		signIn: async () => ({ kind: "apiKey", apiKey: await signInWithOpenRouter() }),
		cancelSignIn: cancelOpenRouterSignIn,
		supportsApiKey: true,
		// The redirect is caught via an obsidian:// protocol handler, so this flow
		// works on mobile too (no localhost server). submitManualCode is the paste
		// fallback if the deep link doesn't route back to Obsidian.
		worksOnMobile: true,
		submitManualCode: submitOpenRouterAuthCode,
	},

	// =========================================================================
	// Auth Configuration
	// =========================================================================
	auth: {
		apiKey: {
			label: "API Key",
			description: "Your OpenRouter API key for authentication",
			kind: "secret",
			required: true,
			placeholder: "sk-or-...",
		},
		headers: {
			label: "Custom Headers",
			description: "Additional headers as JSON (optional)",
			kind: "textarea",
			required: false,
			placeholder: '{"X-Custom-Header": "value"}',
		},
	},

	// =========================================================================
	// Runtime Methods
	// =========================================================================

	createChatInstance: (auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) => {
		const config: Record<string, unknown> = {
			model: modelId,
			apiKey: auth.apiKey,
			configuration: {
				baseURL: OPENROUTER_BASE_URL,
			},
		};

		if (options?.temperature !== undefined) {
			config.temperature = options.temperature;
		}

		// Add custom headers if provided
		if (auth.headers && Object.keys(auth.headers).length > 0) {
			(config.configuration as Record<string, unknown>).defaultHeaders = auth.headers;
		}

		return createTransportedChatOpenAI("openrouter", config);
	},

	createSubAgentChatInstance: (auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) => {
		const config: Record<string, unknown> = {
			model: modelId,
			apiKey: auth.apiKey,
			configuration: { baseURL: OPENROUTER_BASE_URL },
		};
		if (options?.temperature !== undefined) {
			config.temperature = options.temperature;
		}
		if (auth.headers && Object.keys(auth.headers).length > 0) {
			(config.configuration as Record<string, unknown>).defaultHeaders = auth.headers;
		}
		return createBufferedTransportedChatOpenAI("openrouter", config);
	},

	createEmbeddingInstance: (auth: AuthObject, modelId: string) => {
		const config: Record<string, unknown> = {
			model: modelId,
			apiKey: auth.apiKey,
			// OpenAI SDK v6 defaults to encoding_format:'base64' which many third-party
			// providers don't support, causing malformed responses. Use 'float' explicitly.
			encodingFormat: "float",
			configuration: {
				baseURL: OPENROUTER_BASE_URL,
			},
		};

		// Add custom headers if provided
		if (auth.headers && Object.keys(auth.headers).length > 0) {
			(config.configuration as Record<string, unknown>).defaultHeaders = auth.headers;
		}

		return createTransportedOpenAIEmbeddings(config);
	},

	validateAuth: async (auth: AuthObject): Promise<AuthValidationResult> => {
		if (!auth.apiKey?.trim()) {
			return { valid: false, error: "API key is required" };
		}

		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.apiKey}`,
			"Content-Type": "application/json",
		};

		// Add custom headers if provided
		if (auth.headers) {
			Object.assign(headers, auth.headers);
		}

		try {
			const response = await requestUrl({
				url: `${OPENROUTER_BASE_URL}/key`,
				method: "GET",
				headers,
				throw: false,
			});

			if (response.status >= 200 && response.status < 300) {
				return { valid: true };
			}

			let errorMessage: string | undefined;
			try {
				const parsed = response.json as { error?: { message?: string }; message?: string };
				errorMessage = parsed?.error?.message ?? parsed?.message;
			} catch {
				// ignore parse errors
			}

			if (response.status === 401 || response.status === 403) {
				return {
					valid: false,
					error: errorMessage || `Authentication failed (${response.status})`,
				};
			}

			return {
				valid: false,
				error: errorMessage || response.text || `Request failed with status ${response.status}`,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { valid: false, error: `Connection failed: ${message}` };
		}
	},

	discoverModels: async (auth: AuthObject): Promise<string[]> => {
		if (!auth.apiKey?.trim()) {
			throw new Error("OpenRouter model discovery requires an API key.");
		}

		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.apiKey}`,
			"Content-Type": "application/json",
		};

		// Add custom headers if provided
		if (auth.headers) {
			Object.assign(headers, auth.headers);
		}

		const response = await window.fetch(`${OPENROUTER_BASE_URL}/models`, {
			method: "GET",
			headers,
		});

		if (!response.ok) {
			const errorBody = await safeReadText(response);
			throw new Error(`Model discovery failed: ${errorBody || response.statusText}`);
		}

		const payload = (await response.json()) as OpenRouterModelResponse;
		const resources = Array.isArray(payload.data) ? payload.data : [];

		// Populate the metadata cache with full model info
		populateOpenRouterCache(resources);

		return resources.map((r) => r.id).filter((id): id is string => typeof id === "string" && id.trim() !== "");
	},

	discoverEmbeddingModels: async (auth: AuthObject): Promise<string[]> => {
		if (!auth.apiKey?.trim()) {
			throw new Error("OpenRouter embedding model discovery requires an API key.");
		}

		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.apiKey}`,
			"Content-Type": "application/json",
		};

		// Add custom headers if provided
		if (auth.headers) {
			Object.assign(headers, auth.headers);
		}

		// Use Obsidian's requestUrl to bypass CORS for the dedicated embeddings models endpoint
		try {
			const response = await requestUrl({
				url: `${OPENROUTER_BASE_URL}/embeddings/models`,
				method: "GET",
				headers,
			});

			const payload = response.json as OpenRouterModelResponse;
			const resources = Array.isArray(payload.data) ? payload.data : [];
			return resources.map((r) => r.id).filter((id): id is string => typeof id === "string" && id.trim() !== "");
		} catch {
			// If the dedicated endpoint fails, fall back to filtering all models
			const response = await window.fetch(`${OPENROUTER_BASE_URL}/models`, {
				method: "GET",
				headers,
			});

			if (!response.ok) {
				const errorBody = await safeReadText(response);
				throw new Error(`Embedding model discovery failed: ${errorBody || response.statusText}`);
			}

			const payload = (await response.json()) as OpenRouterModelResponse;
			const resources = Array.isArray(payload.data) ? payload.data : [];

			// Filter to embedding models by name patterns
			return resources
				.map((r) => r.id)
				.filter((id): id is string => {
					if (typeof id !== "string" || !id.trim()) return false;
					const lower = id.toLowerCase();
					return (
						lower.includes("embed") ||
						lower.includes("bge-") ||
						lower.includes("voyage") ||
						lower.includes("e5-") ||
						lower.includes("gte-") ||
						lower.includes("nomic-") ||
						lower.includes("-embedding")
					);
				});
		}
	},
};
