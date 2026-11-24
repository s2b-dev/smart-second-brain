/**
 * LM Studio built-in provider definition
 *
 * LM Studio (https://lmstudio.ai) is a desktop app for downloading and running local models, with
 * a local server (default http://localhost:1234) that speaks the OpenAI wire protocol under `/v1`.
 * Chat and embeddings therefore go through the shared `createTransported*` helpers, exactly like
 * oMLX. What is LM Studio-specific lives here and in `lmstudioModels.ts`: setup instructions, a
 * plain-language message when the server isn't running, and model discovery through LM Studio's
 * native REST API, which says which models are chat and which are embedding models, which can see
 * images, and how large a context each one is loaded with.
 *
 * Authentication: baseUrl (required, pre-filled), apiKey (optional — LM Studio 0.4 can require an
 * API token, but doesn't by default), headers (optional).
 */

import { requestUrl } from "obsidian";
import LmStudioLogo from "../components/ui/logos/LmStudioLogo.svelte";
import { t } from "../i18n";
import { isProviderUnreachableError } from "../lib/transportErrors";
import type {
	AuthObject,
	AuthValidationResult,
	ChatModelConfig,
	EmbeddingProviderDefinition,
} from "../types/provider/index";
import {
	createBufferedTransportedChatOpenAI,
	createTransportedChatOpenAI,
	createTransportedOpenAIEmbeddings,
} from "./chatProviders";
import {
	classifyOpenAIModelIds,
	type LmStudioModelInfo,
	type LmStudioModelKind,
	type LmStudioV0ModelsResponse,
	type LmStudioV1ModelsResponse,
	parseV0Models,
	parseV1Models,
	setLmStudioModels,
} from "./lmstudioModels";

// =============================================================================
// Constants
// =============================================================================

/** Default LM Studio server URL. */
export const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234";

// =============================================================================
// Helper Functions
// =============================================================================

/** Removes a trailing slash and a trailing `/v1` (users often paste the OpenAI base URL). */
function resolveServerUrl(auth: AuthObject): string {
	return (auth.baseUrl?.trim() || LMSTUDIO_DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/** Builds request headers, applying the optional API token + custom headers. */
function buildHeaders(auth: AuthObject): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (auth.apiKey) {
		headers.Authorization = `Bearer ${auth.apiKey}`;
	}
	if (auth.headers) {
		Object.assign(headers, auth.headers);
	}
	return headers;
}

/** Builds the ChatOpenAI/OpenAIEmbeddings `configuration` block (baseURL + optional headers). */
function buildClientConfiguration(auth: AuthObject): Record<string, unknown> {
	const configuration: Record<string, unknown> = { baseURL: `${resolveServerUrl(auth)}/v1` };
	if (auth.headers && Object.keys(auth.headers).length > 0) {
		configuration.defaultHeaders = auth.headers;
	}
	return configuration;
}

/** Nothing answers at the server URL. Its message says where LM Studio's server switch is. */
class LmStudioNotRunningError extends Error {
	constructor(auth: AuthObject) {
		super(t("plugin.provider_auth.lmstudio_not_running", { url: resolveServerUrl(auth) }));
		this.name = "LmStudioNotRunningError";
	}
}

/** GETs a path on the LM Studio server, turning "nothing is listening" into the setup message. */
async function getJson(auth: AuthObject, path: string): Promise<{ status: number; json: unknown; text: string }> {
	try {
		const response = await requestUrl({
			url: `${resolveServerUrl(auth)}${path}`,
			method: "GET",
			headers: buildHeaders(auth),
			throw: false,
		});
		let json: unknown;
		try {
			json = response.json;
		} catch {
			json = undefined;
		}
		return { status: response.status, json, text: response.text };
	} catch (error) {
		if (isProviderUnreachableError(error)) throw new LmStudioNotRunningError(auth);
		throw error;
	}
}

function isOk(status: number): boolean {
	return status >= 200 && status < 300;
}

/**
 * Lists the server's models, preferring the richest API the installed LM Studio offers:
 * `/api/v1/models` (0.4+), then `/api/v0/models` (0.3.6+), then the OpenAI-compatible
 * `/v1/models`, which every version has but which carries no type or context length.
 *
 * An older LM Studio answers an unknown path with an error body rather than a 404 in some
 * versions, so a native endpoint counts as present only when its payload has the expected shape.
 */
export async function listModels(auth: AuthObject): Promise<LmStudioModelInfo[]> {
	const v1 = await getJson(auth, "/api/v1/models");
	if (isOk(v1.status) && Array.isArray((v1.json as LmStudioV1ModelsResponse | undefined)?.models)) {
		return parseV1Models(v1.json as LmStudioV1ModelsResponse);
	}
	if (v1.status === 401 || v1.status === 403) throw new Error(t("plugin.provider_auth.auth_failed"));

	const v0 = await getJson(auth, "/api/v0/models");
	if (isOk(v0.status) && Array.isArray((v0.json as LmStudioV0ModelsResponse | undefined)?.data)) {
		return parseV0Models(v0.json as LmStudioV0ModelsResponse);
	}

	const openai = await getJson(auth, "/v1/models");
	if (!isOk(openai.status)) {
		throw new Error(`Model discovery failed for LM Studio: ${openai.text || `status ${openai.status}`}`);
	}
	const data = (openai.json as { data?: Array<{ id?: unknown }> } | undefined)?.data;
	const ids = Array.isArray(data)
		? data.map((entry) => entry.id).filter((id): id is string => typeof id === "string")
		: [];
	return classifyOpenAIModelIds(ids);
}

/**
 * The context length LM Studio currently has a model loaded with, or undefined when the model
 * isn't loaded (or the server can't say). Records the fresh listing for hydration as well.
 */
export async function fetchLoadedContextLength(
	instanceId: string,
	auth: AuthObject,
	modelId: string,
): Promise<number | undefined> {
	const models = await listModels(auth);
	setLmStudioModels(instanceId, models);
	const model = models.find((m) => m.id === modelId);
	return model?.loaded ? model.contextLength : undefined;
}

// =============================================================================
// Provider Definition
// =============================================================================

/**
 * Creates an LM Studio provider instance definition.
 *
 * @param instanceId - Persisted provider instance id.
 * @param displayName - User-visible display name.
 */
export function createLmStudioProvider(instanceId: string, displayName: string): EmbeddingProviderDefinition {
	/** Lists models, records their metadata for hydration, and returns the ids of one kind. */
	const discover = async (auth: AuthObject, kind: LmStudioModelKind): Promise<string[]> => {
		const models = await listModels(auth);
		setLmStudioModels(instanceId, models);
		return models.filter((model) => model.kind === kind).map((model) => model.id);
	};

	const chatConfig = (auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) => {
		const config: Record<string, unknown> = {
			model: modelId,
			apiKey: auth.apiKey || "not-required",
			configuration: buildClientConfiguration(auth),
		};
		if (options?.temperature !== undefined) {
			config.temperature = options.temperature;
		}
		return config;
	};

	return {
		// =====================================================================
		// Identity
		// =====================================================================
		id: instanceId,
		displayName,
		logo: LmStudioLogo,

		// =====================================================================
		// Setup Instructions
		// =====================================================================
		setupInstructions: {
			steps: [
				"Download and install LM Studio from lmstudio.ai",
				"Download a model in LM Studio (and an embedding model if you want semantic search)",
				'Open the Developer tab in LM Studio and switch the server on ("Status: Running")',
				"The default server URL is http://localhost:1234",
			],
			link: {
				url: "https://lmstudio.ai/docs/developer/core/server",
				text: t("plugin.providers.lmstudio.link"),
			},
		},

		// =====================================================================
		// Auth Configuration
		// =====================================================================
		auth: {
			baseUrl: {
				label: t("plugin.providers.fields.server_url"),
				description: t("plugin.providers.lmstudio.server_url_desc"),
				kind: "text",
				required: true,
				placeholder: LMSTUDIO_DEFAULT_BASE_URL,
			},
			apiKey: {
				label: t("plugin.providers.fields.api_key"),
				description: t("plugin.providers.lmstudio.api_key_desc"),
				kind: "secret",
				required: false,
			},
			headers: {
				label: t("plugin.providers.fields.custom_headers"),
				description: t("plugin.providers.fields.custom_headers_desc"),
				kind: "textarea",
				required: false,
				placeholder: '{"X-Custom-Header": "value"}',
			},
		},

		// =====================================================================
		// Runtime Methods — transport delegated to shared helpers
		// =====================================================================

		createChatInstance: (auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) =>
			createTransportedChatOpenAI(instanceId, chatConfig(auth, modelId, options)),

		createSubAgentChatInstance: (auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) =>
			createBufferedTransportedChatOpenAI(instanceId, chatConfig(auth, modelId, options)),

		createEmbeddingInstance: (auth: AuthObject, modelId: string) =>
			createTransportedOpenAIEmbeddings({
				model: modelId,
				apiKey: auth.apiKey || "not-required",
				encodingFormat: "float",
				configuration: buildClientConfiguration(auth),
			}),

		validateAuth: async (auth: AuthObject): Promise<AuthValidationResult> => {
			let response: Awaited<ReturnType<typeof getJson>>;
			try {
				response = await getJson(auth, "/v1/models");
			} catch (error) {
				if (error instanceof LmStudioNotRunningError) return { valid: false, error: error.message };
				const message = error instanceof Error ? error.message : String(error);
				return { valid: false, error: t("plugin.provider_auth.connection_failed", { error: message }) };
			}

			if (isOk(response.status)) return { valid: true };

			const errorMessage = (response.json as { error?: { message?: string } | string } | undefined)?.error;
			const detail = typeof errorMessage === "string" ? errorMessage : errorMessage?.message;
			if (response.status === 401 || response.status === 403) {
				return { valid: false, error: detail || t("plugin.provider_auth.auth_failed") };
			}
			return {
				valid: false,
				error: detail || t("plugin.provider_auth.request_failed_status", { status: response.status }),
			};
		},

		discoverModels: (auth: AuthObject): Promise<string[]> => discover(auth, "chat"),

		discoverEmbeddingModels: (auth: AuthObject): Promise<string[]> => discover(auth, "embedding"),
	};
}
