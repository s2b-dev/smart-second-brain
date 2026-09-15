/**
 * Anthropic built-in provider definition
 *
 * This provider supports:
 * - Chat models (claude-3-5-sonnet, claude-3-5-haiku, claude-3-opus, etc.)
 * - NO embedding models (Anthropic doesn't offer embeddings)
 * - Model discovery via Anthropic API (/v1/models)
 *
 * Authentication: apiKey (required), baseUrl (optional), headers (optional)
 */

import { requestUrl } from "obsidian";
import AnthropicLogo from "../components/ui/logos/AnthropicLogo.svelte";
import type {
	AuthObject,
	AuthValidationResult,
	BaseProviderDefinition,
	ChatModelConfig,
} from "../types/provider/index";
import { createBufferedTransportedChatAnthropic, createTransportedChatAnthropic } from "./chatProviders";

// =============================================================================
// Constants
// =============================================================================

/** Default base URL for Anthropic API */
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Anthropic API version header value */
const ANTHROPIC_API_VERSION = "2023-06-01";

// =============================================================================
// Helper Functions
// =============================================================================

function sanitizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function buildAnthropicHeaders(auth: AuthObject): Record<string, string> {
	const headers: Record<string, string> = {
		"x-api-key": auth.apiKey ?? "",
		"anthropic-version": ANTHROPIC_API_VERSION,
		"Content-Type": "application/json",
	};

	if (auth.headers) {
		Object.assign(headers, auth.headers);
	}

	return headers;
}

// =============================================================================
// Types
// =============================================================================

interface AnthropicModelResponse {
	data: Array<{
		id: string;
		created_at?: string;
		display_name?: string;
		type?: string;
	}>;
	has_more?: boolean;
}

// =============================================================================
// Provider Definition
// =============================================================================

/**
 * Anthropic built-in provider definition.
 *
 * Supports chat models only (no embeddings).
 */
export const anthropicProvider: BaseProviderDefinition = {
	// =========================================================================
	// Identity
	// =========================================================================
	id: "anthropic",
	displayName: "Anthropic",
	logo: AnthropicLogo,

	// =========================================================================
	// Setup Instructions
	// =========================================================================
	setupInstructions: {
		steps: [
			"Create an API key from Anthropic's Console",
			"Ensure your Anthropic account has credits available",
			"Paste the API key below (starts with 'sk-ant-')",
		],
		link: {
			url: "https://console.anthropic.com/settings/keys",
			text: "Anthropic Console",
		},
	},

	// =========================================================================
	// Auth Configuration
	// =========================================================================
	auth: {
		apiKey: {
			label: "API Key",
			description: "Your Anthropic API key for authentication",
			kind: "secret",
			required: true,
			placeholder: "sk-ant-...",
		},
		baseUrl: {
			label: "Base URL",
			description: "The base URL for the Anthropic-compatible API endpoint",
			kind: "text",
			required: false,
			placeholder: ANTHROPIC_DEFAULT_BASE_URL,
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
		const resolvedBaseUrl = sanitizeBaseUrl(auth.baseUrl || ANTHROPIC_DEFAULT_BASE_URL);
		const config: Record<string, unknown> = {
			model: modelId,
			apiKey: auth.apiKey,
			clientOptions: {
				baseURL: resolvedBaseUrl,
				defaultHeaders: auth.headers,
			},
		};

		if (options?.temperature !== undefined) {
			config.temperature = options.temperature;
		}

		// Forward Anthropic-specific `thinking` config when provided (e.g. to
		// disable extended thinking for lightweight tasks like cluster labeling).
		if (options && "thinking" in options && options.thinking !== undefined) {
			config.thinking = options.thinking;
		}

		return createTransportedChatAnthropic("anthropic", config);
	},

	createSubAgentChatInstance: (auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) => {
		const resolvedBaseUrl = sanitizeBaseUrl(auth.baseUrl || ANTHROPIC_DEFAULT_BASE_URL);
		const config: Record<string, unknown> = {
			model: modelId,
			apiKey: auth.apiKey,
			clientOptions: { baseURL: resolvedBaseUrl, defaultHeaders: auth.headers },
		};
		if (options?.temperature !== undefined) {
			config.temperature = options.temperature;
		}
		if (options && "thinking" in options && options.thinking !== undefined) {
			config.thinking = options.thinking;
		}
		return createBufferedTransportedChatAnthropic("anthropic", config);
	},

	validateAuth: async (auth: AuthObject): Promise<AuthValidationResult> => {
		if (!auth.apiKey?.trim()) {
			return { valid: false, error: "API key is required" };
		}

		try {
			const baseUrl = sanitizeBaseUrl(auth.baseUrl || ANTHROPIC_DEFAULT_BASE_URL);
			const response = await requestUrl({
				url: `${baseUrl}/v1/models`,
				method: "GET",
				headers: buildAnthropicHeaders(auth),
				throw: false,
			});

			if (response.status >= 200 && response.status < 300) {
				return { valid: true };
			}

			let errorType: string | undefined;
			let errorMessage: string | undefined;
			try {
				const parsed = response.json as { error?: { type?: string; message?: string } };
				errorType = parsed?.error?.type;
				errorMessage = parsed?.error?.message;
			} catch {
				// ignore parse errors
			}

			if (response.status === 401 || response.status === 403 || errorType === "authentication_error") {
				return { valid: false, error: errorMessage || `Authentication failed (${response.status})` };
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
			throw new Error("Anthropic model discovery requires an API key.");
		}

		const baseUrl = sanitizeBaseUrl(auth.baseUrl || ANTHROPIC_DEFAULT_BASE_URL);
		const response = await requestUrl({
			url: `${baseUrl}/v1/models`,
			method: "GET",
			headers: buildAnthropicHeaders(auth),
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Model discovery failed: ${response.text || `status ${response.status}`}`);
		}

		const payload = response.json as AnthropicModelResponse;
		const resources = Array.isArray(payload.data) ? payload.data : [];

		return resources.map((r) => r.id).filter((id): id is string => typeof id === "string" && id.trim() !== "");
	},
};
