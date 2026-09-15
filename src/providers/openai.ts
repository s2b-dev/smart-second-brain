/**
 * OpenAI built-in provider definition
 *
 * This provider supports:
 * - Chat models (gpt-4o, gpt-4o-mini, gpt-4-turbo, etc.)
 * - Embedding models (text-embedding-3-small, text-embedding-3-large, etc.)
 * - Model discovery via OpenAI API
 *
 * Authentication: apiKey (required), baseUrl (optional), headers (optional)
 */

import { fetchModelsDevData, isEmbeddingModel } from "./modelsDevApi";
import { getPlugin } from "../stores/state.svelte";
import OpenAILogo from "../components/ui/logos/OpenAILogo.svelte";
import type {
	AuthObject,
	AuthValidationResult,
	ChatModelConfig,
	EmbeddingProviderDefinition,
} from "../types/provider/index";
import {
	cancelOpenAICodexSignIn,
	clearOpenAICodexSession,
	createOpenAICodexFetch,
	getValidOpenAICodexSession,
	signInWithOpenAICodex,
} from "./openaiCodex";
import { getCodexSession } from "../stores/providerRuntime.svelte";
import {
	createBufferedTransportedChatOpenAI,
	createTransportedChatOpenAI,
	createTransportedChatOpenAIResponses,
	createTransportedOpenAIEmbeddings,
} from "./chatProviders";

// =============================================================================
// Constants
// =============================================================================

/** Default base URL for OpenAI API */
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const FALLBACK_OPENAI_CHAT_MODELS = ["chatgpt-4o-latest", "gpt-4.1-mini-2025-04-14", "gpt-4.1", "o4-mini", "o1"];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Removes trailing slashes from a URL.
 */
function sanitizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

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

interface OpenAIModelResponse {
	data?: Array<{ id?: string }>;
}

// =============================================================================
// Provider Definition
// =============================================================================

/**
 * OpenAI built-in provider definition.
 *
 * Supports chat models, embedding models, and model discovery.
 */
export const openaiProvider: EmbeddingProviderDefinition = {
	// =========================================================================
	// Identity
	// =========================================================================
	id: "openai",
	displayName: "OpenAI",
	logo: OpenAILogo,

	// =========================================================================
	// Setup Instructions
	// =========================================================================
	setupInstructions: {
		steps: [
			"Create an API key from OpenAI's Dashboard",
			"Ensure your OpenAI account has credits loaded",
			"Paste the API key below (starts with 'sk-')",
		],
		link: {
			url: "https://platform.openai.com/api-keys",
			text: "OpenAI Dashboard",
		},
	},

	// =========================================================================
	// OAuth (ChatGPT sign-in) capability
	// =========================================================================
	oauth: {
		label: "ChatGPT",
		icon: "log-in",
		description: "Open a browser window to complete ChatGPT/Codex authorization.",
		signIn: async () => {
			await signInWithOpenAICodex();
			return { kind: "session" };
		},
		cancelSignIn: cancelOpenAICodexSignIn,
		isSignedIn: () => !!getCodexSession(),
		disconnect: clearOpenAICodexSession,
		supportsApiKey: true,
	},

	// =========================================================================
	// Auth Configuration
	// =========================================================================
	auth: {
		apiKey: {
			label: "API Key",
			description: "Your OpenAI API key for authentication",
			kind: "secret",
			required: true,
			placeholder: "sk-...",
		},
		baseUrl: {
			label: "Base URL",
			description: "Custom API endpoint (leave empty for default OpenAI)",
			kind: "text",
			required: false,
			placeholder: "https://api.openai.com/v1",
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
		if (auth.authMode === "codex") {
			return createTransportedChatOpenAIResponses("openai", {
				model: modelId,
				apiKey: async () => {
					const session = await getValidOpenAICodexSession();
					if (!session) {
						throw new Error("ChatGPT sign-in required");
					}
					return session.accessToken;
				},
				configuration: {
					baseURL: OPENAI_DEFAULT_BASE_URL,
					fetch: createOpenAICodexFetch(),
				},
				temperature: options?.temperature,
			});
		}

		const config: Record<string, unknown> = {
			model: modelId,
			apiKey: auth.apiKey,
		};

		if (options?.temperature !== undefined) {
			config.temperature = options.temperature;
		}

		// Add baseUrl configuration if provided
		if (auth.baseUrl && auth.baseUrl.trim() !== "") {
			config.configuration = {
				baseURL: sanitizeBaseUrl(auth.baseUrl),
			};
		}

		// Add custom headers if provided
		if (auth.headers && Object.keys(auth.headers).length > 0) {
			config.configuration = {
				...(config.configuration as Record<string, unknown>),
				defaultHeaders: auth.headers,
			};
		}

		return createTransportedChatOpenAI("openai", config);
	},

	createSubAgentChatInstance: (auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) => {
		// Codex (ChatGPT sign-in) has no API key — authenticate via the Codex session
		// transport, mirroring createChatInstance. Without this branch the subagent reads
		// the absent auth.apiKey and fails with missing authentication.
		if (auth.authMode === "codex") {
			return createTransportedChatOpenAIResponses("openai", {
				model: modelId,
				apiKey: async () => {
					const session = await getValidOpenAICodexSession();
					if (!session) {
						throw new Error("ChatGPT sign-in required");
					}
					return session.accessToken;
				},
				configuration: {
					baseURL: OPENAI_DEFAULT_BASE_URL,
					fetch: createOpenAICodexFetch(),
				},
				temperature: options?.temperature,
			});
		}

		const config: Record<string, unknown> = { model: modelId, apiKey: auth.apiKey };
		if (options?.temperature !== undefined) {
			config.temperature = options.temperature;
		}
		if (auth.baseUrl && auth.baseUrl.trim() !== "") {
			config.configuration = { baseURL: sanitizeBaseUrl(auth.baseUrl) };
		}
		if (auth.headers && Object.keys(auth.headers).length > 0) {
			config.configuration = {
				...(config.configuration as Record<string, unknown>),
				defaultHeaders: auth.headers,
			};
		}
		return createBufferedTransportedChatOpenAI("openai", config);
	},

	createEmbeddingInstance: (auth: AuthObject, modelId: string) => {
		if (auth.authMode === "codex") {
			throw new Error("Codex sign-in does not support embeddings");
		}

		const config: Record<string, unknown> = {
			model: modelId,
			apiKey: auth.apiKey,
		};

		// Add baseUrl configuration if provided
		if (auth.baseUrl && auth.baseUrl.trim() !== "") {
			config.configuration = {
				baseURL: sanitizeBaseUrl(auth.baseUrl),
			};
			// OpenAI SDK v6 defaults to encoding_format:'base64' which many third-party
			// providers don't support, causing malformed responses. Use 'float' explicitly
			// when a custom baseUrl is set (i.e. not targeting OpenAI directly).
			config.encodingFormat = "float";
		}

		// Add custom headers if provided
		if (auth.headers && Object.keys(auth.headers).length > 0) {
			config.configuration = {
				...(config.configuration as Record<string, unknown>),
				defaultHeaders: auth.headers,
			};
		}

		return createTransportedOpenAIEmbeddings(config);
	},

	validateAuth: async (auth: AuthObject): Promise<AuthValidationResult> => {
		if (auth.authMode === "codex") {
			const session = await getValidOpenAICodexSession();
			if (!session) {
				return { valid: false, error: "Sign in with ChatGPT to use OpenAI via Codex" };
			}
			return { valid: true };
		}

		if (!auth.apiKey?.trim()) {
			return { valid: false, error: "API key is required" };
		}

		const baseUrl =
			auth.baseUrl && auth.baseUrl.trim() !== "" ? sanitizeBaseUrl(auth.baseUrl) : OPENAI_DEFAULT_BASE_URL;

		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.apiKey}`,
			"Content-Type": "application/json",
		};

		// Add custom headers if provided
		if (auth.headers) {
			Object.assign(headers, auth.headers);
		}

		let response: Response;
		try {
			response = await window.fetch(`${baseUrl}/models`, {
				method: "GET",
				headers,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { valid: false, error: `Connection failed: ${message}` };
		}

		if (response.ok) {
			return { valid: true };
		}

		// Handle error response
		const errorBody = await safeReadText(response);
		let errorCode: string | undefined;
		let errorMessage: string | undefined;
		try {
			const parsed = errorBody
				? (JSON.parse(errorBody) as { error?: { code?: string; message?: string } })
				: undefined;
			errorCode = parsed?.error?.code;
			errorMessage = parsed?.error?.message;
		} catch {
			// ignore parse errors
		}

		if (response.status === 401 || response.status === 403 || errorCode === "invalid_api_key") {
			return { valid: false, error: errorMessage || `Authentication failed (${response.status})` };
		}

		return { valid: false, error: errorMessage || errorBody || `Request failed with status ${response.status}` };
	},

	discoverModels: async (auth: AuthObject): Promise<string[]> => {
		if (auth.authMode === "codex") {
			const modelsDevData = await fetchModelsDevData();
			const modelsDevOpenAI = modelsDevData?.openai;
			if (modelsDevOpenAI) {
				const discovered = Array.from(
					new Set(
						Object.values(modelsDevOpenAI.models)
							.filter((model) => !isEmbeddingModel(model))
							.map((model) => model.id?.split("/").pop()?.trim())
							.filter((id): id is string => Boolean(id)),
					),
				);

				if (discovered.length > 0) {
					return discovered.sort((a, b) => a.localeCompare(b));
				}
			}

			return Array.from(
				new Set([
					...FALLBACK_OPENAI_CHAT_MODELS,
					...Object.keys(getPlugin().pluginData.getChatModels("openai")),
				]),
			).sort((a, b) => a.localeCompare(b));
		}

		if (!auth.apiKey) {
			throw new Error("OpenAI model discovery requires an API key.");
		}

		const baseUrl =
			auth.baseUrl && auth.baseUrl.trim() !== "" ? sanitizeBaseUrl(auth.baseUrl) : OPENAI_DEFAULT_BASE_URL;

		const headers: Record<string, string> = {
			Authorization: `Bearer ${auth.apiKey}`,
			"Content-Type": "application/json",
		};

		// Add custom headers if provided
		if (auth.headers) {
			Object.assign(headers, auth.headers);
		}

		const response = await window.fetch(`${baseUrl}/models`, {
			method: "GET",
			headers,
		});

		if (!response.ok) {
			const errorBody = await safeReadText(response);
			throw new Error(`Model discovery failed: ${errorBody || response.statusText}`);
		}

		const payload = (await response.json()) as OpenAIModelResponse;
		const resources = Array.isArray(payload.data) ? payload.data : [];

		return resources.map((r) => r.id).filter((id): id is string => typeof id === "string" && id.trim() !== "");
	},

	discoverEmbeddingModels: async (auth: AuthObject): Promise<string[]> => {
		if (auth.authMode === "codex") {
			return [];
		}

		const allModels = await openaiProvider.discoverModels(auth);
		return allModels.filter((model) => model.toLowerCase().includes("embed"));
	},
};
