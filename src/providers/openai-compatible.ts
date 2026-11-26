/**
 * OpenAI-Compatible Provider Factory
 *
 * Creates provider definitions for configurable providers that use
 * OpenAI-compatible API endpoints.
 */

import { requestUrl } from "obsidian";
import type { Component } from "svelte";
import {
	createBufferedTransportedChatOpenAI,
	createTransportedChatOpenAI,
	createTransportedOpenAIEmbeddings,
} from "./chatProviders";
import type {
	AuthObject,
	AuthValidationResult,
	BaseProviderDefinition,
	ChatModelConfig,
	EmbeddingProviderDefinition,
	LogoProps,
	ProviderSetupInstructions,
} from "../types/provider/index";
import {
	type CompatibleModelEntry,
	extractCompatibleModelInfo,
	type LiteLLMModelInfoEntry,
	setCompatibleModelInfo,
} from "./openaiCompatibleModels";
import { t } from "../i18n";
import { chatCompletionsReasoningFields } from "./reasoningEffort";
import { liteLLMReasoningEffortSupport, setReasoningEffortSupport } from "./reasoningSupport";

/**
 * The API root requests go to: `<root>/models`, `<root>/chat/completions`.
 *
 * The base URL is that root, used as given, the way OpenAI's SDK reads `baseURL`. Many
 * servers don't live under `/v1` (Z.ai's `/api/paas/v4`, Volcengine's `/api/v3`, Novita's
 * `/openai`), so a fixed suffix can't reach them. Only a bare host (`http://localhost:8000`)
 * gets `/v1` appended: there the user plainly gave the server, not the API.
 */
export function resolveApiRoot(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	return /^[a-z][a-z0-9+.-]*:\/\/[^/]+$/i.test(trimmed) ? `${trimmed}/v1` : trimmed;
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
	const apiUrl = resolveApiRoot(auth.baseUrl || defaultBaseUrl);
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
	const apiUrl = resolveApiRoot(auth.baseUrl || defaultBaseUrl);
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
	let timer: number | undefined;
	const timeout = new Promise<LiteLLMModelInfoEntry[]>((resolve) => {
		timer = window.setTimeout(() => resolve([]), MODEL_INFO_TIMEOUT_MS);
	});
	try {
		return await Promise.race([lookup, timeout]);
	} finally {
		window.clearTimeout(timer);
	}
}

export interface OpenAICompatibleProviderInput {
	id: string;
	displayName: string;
	defaultBaseUrl?: string;
	logo?: Component<LogoProps>;
	setupInstructions?: ProviderSetupInstructions;
}

export function createOpenAICompatibleProvider(
	config: OpenAICompatibleProviderInput,
): BaseProviderDefinition | EmbeddingProviderDefinition {
	const defaultBaseUrl = config.defaultBaseUrl ?? "https://api.openai.com";
	const baseDefinition: BaseProviderDefinition = {
		id: config.id,
		displayName: config.displayName,
		supportsReasoningEffort: true,
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
				label: t("plugin.providers.fields.base_url"),
				description: t("plugin.providers.openai_compatible.base_url_desc"),
				kind: "text",
				required: true,
				placeholder: "https://your-endpoint.example/v1",
			},
			apiKey: {
				label: t("plugin.providers.fields.api_key"),
				description: t("plugin.providers.openai_compatible.api_key_desc"),
				kind: "secret",
				required: true,
				placeholder: "sk-...",
			},
			headers: {
				label: t("plugin.providers.fields.custom_headers"),
				description: t("plugin.providers.fields.custom_headers_desc"),
				kind: "textarea",
				required: false,
				placeholder: '{"X-Custom-Header": "value"}',
			},
		},
		createChatInstance: (auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) => {
			const configuration: Record<string, unknown> = {
				baseURL: resolveApiRoot(auth.baseUrl || defaultBaseUrl),
			};

			if (auth.headers && Object.keys(auth.headers).length > 0) {
				configuration.defaultHeaders = auth.headers;
			}

			const chatConfig: Record<string, unknown> = {
				model: modelId,
				apiKey: auth.apiKey || "not-required",
				configuration,
				...chatCompletionsReasoningFields(options),
			};

			if (options?.temperature !== undefined) {
				chatConfig.temperature = options.temperature;
			}

			return createTransportedChatOpenAI(config.id, chatConfig);
		},
		createSubAgentChatInstance: (auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) => {
			const configuration: Record<string, unknown> = { baseURL: resolveApiRoot(auth.baseUrl || defaultBaseUrl) };
			if (auth.headers && Object.keys(auth.headers).length > 0) {
				configuration.defaultHeaders = auth.headers;
			}
			const chatConfig: Record<string, unknown> = {
				model: modelId,
				apiKey: auth.apiKey || "not-required",
				configuration,
				...chatCompletionsReasoningFields(options),
			};
			if (options?.temperature !== undefined) {
				chatConfig.temperature = options.temperature;
			}
			return createBufferedTransportedChatOpenAI(config.id, chatConfig);
		},
		validateAuth: async (auth: AuthObject): Promise<AuthValidationResult> => {
			const apiUrl = resolveApiRoot(auth.baseUrl || defaultBaseUrl);

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
					return { valid: false, error: errorMessage || t("plugin.provider_auth.auth_failed") };
				}

				return {
					valid: false,
					error: errorMessage || t("plugin.provider_auth.request_failed_status", { status: response.status }),
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { valid: false, error: t("plugin.provider_auth.connection_failed", { error: message }) };
			}
		},
		discoverModels: async (auth: AuthObject): Promise<string[]> => {
			const [entries, liteLLMInfo] = await Promise.all([
				fetchModelEntries(auth, config.id, defaultBaseUrl),
				fetchLiteLLMModelInfo(auth, defaultBaseUrl),
			]);
			setCompatibleModelInfo(config.id, extractCompatibleModelInfo(entries, liteLLMInfo));
			setReasoningEffortSupport(config.id, liteLLMReasoningEffortSupport(liteLLMInfo));
			return entries.filter((r) => r.id && !isEmbeddingEntry(r)).map((r) => r.id as string);
		},
	};

	return {
		...baseDefinition,
		createEmbeddingInstance: (auth: AuthObject, modelId: string) => {
			const configuration: Record<string, unknown> = {
				baseURL: resolveApiRoot(auth.baseUrl || defaultBaseUrl),
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
