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
import {
	type CompatibleModelEntry,
	extractContextWindows,
	type LiteLLMModelInfoEntry,
	setCompatibleContextWindows,
} from "./openaiCompatibleModels";

function sanitizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

interface OpenAIModelEntry extends CompatibleModelEntry {
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

function requestHeaders(auth: AuthObject): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (auth.apiKey) {
		headers.Authorization = `Bearer ${auth.apiKey}`;
	}
	if (auth.headers) {
		Object.assign(headers, auth.headers);
	}
	return headers;
}

async function fetchModelEntries(
	auth: AuthObject,
	providerId: string,
	defaultBaseUrl: string,
): Promise<OpenAIModelEntry[]> {
	const apiUrl = `${sanitizeBaseUrl(auth.baseUrl || defaultBaseUrl)}/v1`;
	const response = await requestUrl({
		url: `${apiUrl}/models`,
		method: "GET",
		headers: requestHeaders(auth),
		throw: false,
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Model discovery failed for ${providerId}: ${response.text || `status ${response.status}`}`);
	}

	const payload = response.json as OpenAIModelResponse;
	return Array.isArray(payload.data) ? payload.data : [];
}

/** How long discovery waits for `/v1/model/info` before listing models without it. */
export const MODEL_INFO_TIMEOUT_MS = 5000;

/**
 * LiteLLM's per-deployment model info, where the proxy config's `max_input_tokens` lives.
 * Best effort: any other server answers 404 (or something that isn't the expected shape),
 * which reads as "no info", never as a discovery failure. Capped at
 * {@link MODEL_INFO_TIMEOUT_MS}, so a server that never answers this optional route can't
 * hold the model list back.
 */
async function fetchLiteLLMModelInfo(auth: AuthObject, defaultBaseUrl: string): Promise<LiteLLMModelInfoEntry[]> {
	const apiUrl = `${sanitizeBaseUrl(auth.baseUrl || defaultBaseUrl)}/v1`;
	const lookup = (async (): Promise<LiteLLMModelInfoEntry[]> => {
		const response = await requestUrl({
			url: `${apiUrl}/model/info`,
			method: "GET",
			headers: requestHeaders(auth),
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) return [];
		const data = (response.json as { data?: unknown } | null)?.data;
		return Array.isArray(data) ? (data as LiteLLMModelInfoEntry[]) : [];
	})().catch((): LiteLLMModelInfoEntry[] => []);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<LiteLLMModelInfoEntry[]>((resolve) => {
		timer = setTimeout(() => resolve([]), MODEL_INFO_TIMEOUT_MS);
	});
	try {
		return await Promise.race([lookup, timeout]);
	} finally {
		clearTimeout(timer);
	}
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
				const response = await requestUrl({
					url: `${apiUrl}/models`,
					method: "GET",
					headers: requestHeaders(auth),
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
			const [entries, liteLLMInfo] = await Promise.all([
				fetchModelEntries(auth, config.id, defaultBaseUrl),
				fetchLiteLLMModelInfo(auth, defaultBaseUrl),
			]);
			setCompatibleContextWindows(config.id, extractContextWindows(entries, liteLLMInfo));
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
