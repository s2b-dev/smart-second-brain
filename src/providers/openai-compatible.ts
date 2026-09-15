/**
 * OpenAI-Compatible Provider Factory
 *
 * Creates provider definitions for configurable providers that use
 * OpenAI-compatible API endpoints.
 */

import { requestUrl } from "obsidian";
import {
	createBufferedTransportedChatOpenAI,
	createTransportedChatOpenAI,
	createTransportedOpenAIEmbeddings,
} from "./chatProviders";
import OpenAILogo from "../components/ui/logos/OpenAILogo.svelte";
import type {
	AuthObject,
	AuthValidationResult,
	BaseProviderDefinition,
	ChatModelConfig,
	EmbeddingProviderDefinition,
	ProviderSetupInstructions,
} from "../types/provider/index";

function sanitizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

interface OpenAIModelEntry {
	id?: string;
	/** Some servers set type="embedding" on embedding models */
	type?: string;
	/** Alternate field name used by some servers */
	object?: string;
}

interface OpenAIModelResponse {
	data?: Array<OpenAIModelEntry>;
}

function isEmbeddingEntry(entry: OpenAIModelEntry): boolean {
	return entry.type === "embedding" || entry.object === "embedding";
}

async function fetchModelEntries(
	auth: AuthObject,
	providerId: string,
	defaultBaseUrl: string,
): Promise<OpenAIModelEntry[]> {
	const apiUrl = `${sanitizeBaseUrl(auth.baseUrl || defaultBaseUrl)}/v1`;
	const headers: Record<string, string> = { "Content-Type": "application/json" };

	if (auth.apiKey) {
		headers.Authorization = `Bearer ${auth.apiKey}`;
	}
	if (auth.headers) {
		Object.assign(headers, auth.headers);
	}

	const response = await requestUrl({ url: `${apiUrl}/models`, method: "GET", headers, throw: false });

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Model discovery failed for ${providerId}: ${response.text || `status ${response.status}`}`);
	}

	const payload = response.json as OpenAIModelResponse;
	return Array.isArray(payload.data) ? payload.data : [];
}

export interface OpenAICompatibleProviderInput {
	id: string;
	displayName: string;
	defaultBaseUrl?: string;
	logo?: typeof OpenAILogo;
	setupInstructions?: ProviderSetupInstructions;
}

export function createOpenAICompatibleProvider(
	config: OpenAICompatibleProviderInput,
): BaseProviderDefinition | EmbeddingProviderDefinition {
	const defaultBaseUrl = sanitizeBaseUrl(config.defaultBaseUrl ?? "https://api.openai.com");
	const baseDefinition: BaseProviderDefinition = {
		id: config.id,
		displayName: config.displayName,
		logo: config.logo,
		setupInstructions: config.setupInstructions ?? {
			steps: [
				"Enter the base URL for your OpenAI-compatible API endpoint",
				"Provide an API key if the endpoint requires authentication",
				"Optionally add custom headers for authentication or routing",
			],
		},
		auth: {
			baseUrl: {
				label: "Base URL",
				description: "The base URL for the OpenAI-compatible API endpoint",
				kind: "text",
				required: true,
				placeholder: "https://your-endpoint.example/v1",
			},
			apiKey: {
				label: "API Key",
				description: "API key for authentication (leave empty if your endpoint needs none)",
				kind: "secret",
				required: true,
				placeholder: "sk-...",
			},
			headers: {
				label: "Custom Headers",
				description: "Additional headers as JSON (optional)",
				kind: "textarea",
				required: false,
				placeholder: '{"X-Custom-Header": "value"}',
			},
		},
		createChatInstance: (auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) => {
			const resolvedBaseUrl = sanitizeBaseUrl(auth.baseUrl || defaultBaseUrl);
			const configuration: Record<string, unknown> = {
				baseURL: `${resolvedBaseUrl}/v1`,
			};

			if (auth.headers && Object.keys(auth.headers).length > 0) {
				configuration.defaultHeaders = auth.headers;
			}

			const chatConfig: Record<string, unknown> = {
				model: modelId,
				apiKey: auth.apiKey || "not-required",
				configuration,
			};

			if (options?.temperature !== undefined) {
				chatConfig.temperature = options.temperature;
			}

			return createTransportedChatOpenAI(config.id, chatConfig);
		},
		createSubAgentChatInstance: (auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) => {
			const resolvedBaseUrl = sanitizeBaseUrl(auth.baseUrl || defaultBaseUrl);
			const configuration: Record<string, unknown> = { baseURL: `${resolvedBaseUrl}/v1` };
			if (auth.headers && Object.keys(auth.headers).length > 0) {
				configuration.defaultHeaders = auth.headers;
			}
			const chatConfig: Record<string, unknown> = {
				model: modelId,
				apiKey: auth.apiKey || "not-required",
				configuration,
			};
			if (options?.temperature !== undefined) {
				chatConfig.temperature = options.temperature;
			}
			return createBufferedTransportedChatOpenAI(config.id, chatConfig);
		},
		validateAuth: async (auth: AuthObject): Promise<AuthValidationResult> => {
			const apiUrl = `${sanitizeBaseUrl(auth.baseUrl || defaultBaseUrl)}/v1`;

			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
				};

				if (auth.apiKey) {
					headers.Authorization = `Bearer ${auth.apiKey}`;
				}

				if (auth.headers) {
					Object.assign(headers, auth.headers);
				}

				const response = await requestUrl({
					url: `${apiUrl}/models`,
					method: "GET",
					headers,
					throw: false,
				});

				if (response.status >= 200 && response.status < 300) {
					return { valid: true };
				}

				let errorMessage: string | undefined;
				try {
					const parsed = response.json as { error?: { message?: string } };
					errorMessage = parsed?.error?.message;
				} catch {
					errorMessage = undefined;
				}

				if (response.status === 401 || response.status === 403) {
					return { valid: false, error: errorMessage || "Authentication failed" };
				}

				return {
					valid: false,
					error: errorMessage || `Request failed with status ${response.status}`,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { valid: false, error: `Connection failed: ${message}` };
			}
		},
		discoverModels: async (auth: AuthObject): Promise<string[]> => {
			const entries = await fetchModelEntries(auth, config.id, defaultBaseUrl);
			return entries.filter((r) => r.id && !isEmbeddingEntry(r)).map((r) => r.id as string);
		},
	};

	return {
		...baseDefinition,
		createEmbeddingInstance: (auth: AuthObject, modelId: string) => {
			const resolvedBaseUrl = sanitizeBaseUrl(auth.baseUrl || defaultBaseUrl);
			const configuration: Record<string, unknown> = {
				baseURL: `${resolvedBaseUrl}/v1`,
			};

			if (auth.headers && Object.keys(auth.headers).length > 0) {
				configuration.defaultHeaders = auth.headers;
			}

			const embeddingConfig: Record<string, unknown> = {
				model: modelId,
				apiKey: auth.apiKey || "not-required",
				encodingFormat: "float",
				configuration,
			};

			return createTransportedOpenAIEmbeddings(embeddingConfig);
		},
		discoverEmbeddingModels: async (auth: AuthObject): Promise<string[]> => {
			const entries = await fetchModelEntries(auth, config.id, defaultBaseUrl);
			return entries.filter((r) => r.id && isEmbeddingEntry(r)).map((r) => r.id as string);
		},
	} satisfies EmbeddingProviderDefinition;
}
