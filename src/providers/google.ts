/**
 * Google Gemini provider (Gemini API, keys from Google AI Studio).
 *
 * This provider supports:
 * - Chat models through the native `@langchain/google-genai` client, so images and PDFs
 *   go to Gemini as inline data rather than through an OpenAI-compatible shim
 * - Embedding models (`gemini-embedding-*`) through the `batchEmbedContents` endpoint
 * - Model discovery via the `models` list, split by supported generation method
 *
 * Authentication: apiKey (required), baseUrl (optional), headers (optional)
 *
 * Transport: the Google SDK calls the global `fetch` and has no option to swap it, so
 * chat requests skip the plugin's transport adapter. The Gemini API sends CORS headers
 * for Obsidian's desktop and mobile origins, so the plain fetch works on both.
 */

import { Embeddings, type EmbeddingsParams } from "@langchain/core/embeddings";
import { ChatGoogleGenerativeAI, type GoogleGenerativeAIChatInput } from "@langchain/google-genai";
import { requestUrl } from "obsidian";
import GoogleLogo from "../components/ui/logos/GoogleLogo.svelte";
import { t } from "../i18n";
import { createObsidianFetch } from "../lib/obsidianFetch";
import type {
	AuthObject,
	AuthValidationResult,
	ChatModelConfig,
	EmbeddingProviderDefinition,
} from "../types/provider/index";
import { createNormalizedChatModel, embedFailedAttempt } from "./chatProviders";
import {
	cachedGeminiModelIds,
	GEMINI_API_VERSION,
	GEMINI_DEFAULT_BASE_URL,
	type GeminiCatalogEntry,
	type GeminiModelResponse,
	geminiModelId,
	populateGeminiCache,
} from "./googleModels";

/** Where users create a Gemini API key. */
const GEMINI_API_KEY_URL = "https://aistudio.google.com/apikey";

/** The most requests `batchEmbedContents` accepts in one call. */
const GEMINI_EMBED_BATCH_SIZE = 100;

/** Upper bound on catalog pages, so a server that keeps returning a page token can't loop forever. */
const MAX_CATALOG_PAGES = 20;

// =============================================================================
// Helpers
// =============================================================================

function sanitizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function apiRoot(auth: AuthObject): string {
	return `${sanitizeBaseUrl(auth.baseUrl || GEMINI_DEFAULT_BASE_URL)}/${GEMINI_API_VERSION}`;
}

/** The key goes in a header, never in the URL, so it can't end up in a log line. */
function buildHeaders(auth: AuthObject): Record<string, string> {
	return {
		...(auth.headers ?? {}),
		"x-goog-api-key": auth.apiKey ?? "",
		"Content-Type": "application/json",
	};
}

/** The `error.message` of a Gemini API error body, when there is one. */
function errorMessageOf(body: unknown): string | undefined {
	const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
	return typeof message === "string" && message.trim() ? message : undefined;
}

/**
 * The HTTP status a failed Gemini call stands for. Gemini answers a bad or revoked key
 * with 400 (reason `API_KEY_INVALID`), the status every other API uses for a rejected
 * input. Reported as is, the indexer would take it for a document it can never embed and
 * drop the note's vectors; as 401 it is the auth failure it is, and the notes stay
 * retryable once the key is fixed.
 */
export function geminiErrorStatus(status: number, body: unknown): number {
	if (status !== 400) return status;
	const details = (body as { error?: { details?: Array<{ reason?: unknown }> } } | null)?.error?.details;
	return Array.isArray(details) && details.some((d) => d?.reason === "API_KEY_INVALID") ? 401 : status;
}

async function fetchCatalog(auth: AuthObject): Promise<GeminiCatalogEntry[]> {
	const entries: GeminiCatalogEntry[] = [];
	let pageToken: string | undefined;
	for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
		const query = new URLSearchParams({ pageSize: "1000" });
		if (pageToken) query.set("pageToken", pageToken);
		const response = await requestUrl({
			url: `${apiRoot(auth)}/models?${query}`,
			method: "GET",
			headers: buildHeaders(auth),
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) {
			let message: string | undefined;
			try {
				message = errorMessageOf(response.json);
			} catch {
				// not JSON
			}
			throw new Error(`Model discovery failed: ${message || `status ${response.status}`}`);
		}
		const payload = response.json as GeminiModelResponse;
		entries.push(...(Array.isArray(payload.models) ? payload.models : []));
		pageToken = payload.nextPageToken || undefined;
		if (!pageToken) break;
	}
	return entries;
}

// =============================================================================
// Chat
// =============================================================================

/**
 * `ChatGoogleGenerativeAI` decides whether a model takes images from a fixed list of id
 * prefixes ("gemini-1.5", "gemini-2", ...) and throws on an image for any other model,
 * which would reject every new or aliased id ("gemini-flash-latest"). Whether a model
 * gets images is the plugin's call, made per model from models.dev (`supportsVision`),
 * so the client always accepts them.
 */
class GeminiChatModel extends ChatGoogleGenerativeAI {
	override get _isMultimodalModel(): boolean {
		return true;
	}
}

function createGeminiChat(auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) {
	const fields: GoogleGenerativeAIChatInput = {
		model: geminiModelId(modelId),
		apiKey: auth.apiKey,
		baseUrl: sanitizeBaseUrl(auth.baseUrl || GEMINI_DEFAULT_BASE_URL),
		apiVersion: GEMINI_API_VERSION,
	};
	if (auth.headers && Object.keys(auth.headers).length > 0) {
		fields.customHeaders = auth.headers;
	}
	if (options?.temperature !== undefined) {
		fields.temperature = options.temperature;
	}
	return createNormalizedChatModel(new GeminiChatModel(fields));
}

// =============================================================================
// Embeddings
// =============================================================================

type GeminiTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/** A failed Gemini API call, with the HTTP status where LangChain's retry rules read it. */
class GeminiRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "GeminiRequestError";
	}
}

/**
 * Gemini embeddings over `batchEmbedContents`.
 *
 * Not `GoogleGenerativeAIEmbeddings` from `@langchain/google-genai`: that client answers
 * a failed batch with empty vectors instead of an error (so the index would silently
 * hold notes it can never find), and uses one task type for documents and queries.
 * Gemini's embedding models are trained with distinct document and query task types,
 * and retrieval is measurably better with each side tagged.
 */
export class GeminiEmbeddings extends Embeddings {
	readonly model: string;
	private readonly auth: AuthObject;
	private readonly fetchFn: typeof fetch;

	constructor(auth: AuthObject, modelId: string, params: EmbeddingsParams & { fetch?: typeof fetch } = {}) {
		const { fetch: fetchFn, ...callerParams } = params;
		super({ onFailedAttempt: embedFailedAttempt, ...callerParams });
		this.auth = auth;
		this.model = geminiModelId(modelId);
		this.fetchFn = fetchFn ?? createObsidianFetch();
	}

	async embedDocuments(documents: string[]): Promise<number[][]> {
		const vectors: number[][] = [];
		for (let i = 0; i < documents.length; i += GEMINI_EMBED_BATCH_SIZE) {
			const batch = documents.slice(i, i + GEMINI_EMBED_BATCH_SIZE);
			vectors.push(...(await this.caller.call(() => this.embedBatch(batch, "RETRIEVAL_DOCUMENT"))));
		}
		return vectors;
	}

	async embedQuery(query: string): Promise<number[]> {
		const [vector] = await this.caller.call(() => this.embedBatch([query], "RETRIEVAL_QUERY"));
		return vector;
	}

	private async embedBatch(texts: string[], taskType: GeminiTaskType): Promise<number[][]> {
		const model = `models/${this.model}`;
		const response = await this.fetchFn(`${apiRoot(this.auth)}/${model}:batchEmbedContents`, {
			method: "POST",
			headers: buildHeaders(this.auth),
			body: JSON.stringify({
				requests: texts.map((text) => ({ model, content: { parts: [{ text }] }, taskType })),
			}),
		});
		const body = (await response.json().catch(() => null)) as {
			embeddings?: Array<{ values?: number[] }>;
		} | null;
		if (!response.ok) {
			throw new GeminiRequestError(
				`Gemini embedding request failed: ${errorMessageOf(body) ?? `status ${response.status}`}`,
				geminiErrorStatus(response.status, body),
			);
		}
		const embeddings = body?.embeddings ?? [];
		if (embeddings.length !== texts.length || embeddings.some((e) => !e.values?.length)) {
			throw new Error(
				`Gemini returned ${embeddings.length} embeddings for ${texts.length} inputs, or an empty vector`,
			);
		}
		return embeddings.map((e) => e.values as number[]);
	}
}

// =============================================================================
// Provider Definition
// =============================================================================

/**
 * A Gemini provider instance. A factory rather than one shared definition: each
 * instance caches its own model catalog (it may point at its own endpoint), keyed by
 * the instance id.
 */
export function createGoogleProvider(instanceId: string, displayName: string): EmbeddingProviderDefinition {
	return {
		id: instanceId,
		displayName,
		logo: GoogleLogo,

		setupInstructions: {
			steps: [
				"Sign in to Google AI Studio with your Google account",
				"Create an API key (the free tier needs no billing setup)",
				"Paste the API key below",
			],
			link: {
				url: GEMINI_API_KEY_URL,
				text: t("plugin.providers.google.link"),
			},
		},

		auth: {
			apiKey: {
				label: t("plugin.providers.fields.api_key"),
				description: t("plugin.providers.google.api_key_desc"),
				kind: "secret",
				required: true,
				placeholder: "AIza...",
			},
			baseUrl: {
				label: t("plugin.providers.fields.base_url"),
				description: t("plugin.providers.google.base_url_desc"),
				kind: "text",
				required: false,
				placeholder: GEMINI_DEFAULT_BASE_URL,
			},
			headers: {
				label: t("plugin.providers.fields.custom_headers"),
				description: t("plugin.providers.fields.custom_headers_desc"),
				kind: "textarea",
				required: false,
				placeholder: '{"X-Custom-Header": "value"}',
			},
		},

		createChatInstance: createGeminiChat,

		createEmbeddingInstance: (auth: AuthObject, modelId: string) => new GeminiEmbeddings(auth, modelId),

		validateAuth: async (auth: AuthObject): Promise<AuthValidationResult> => {
			if (!auth.apiKey?.trim()) {
				return { valid: false, error: t("plugin.provider_auth.api_key_required") };
			}
			try {
				const response = await requestUrl({
					url: `${apiRoot(auth)}/models?pageSize=1`,
					method: "GET",
					headers: buildHeaders(auth),
					throw: false,
				});
				if (response.status >= 200 && response.status < 300) {
					return { valid: true };
				}
				let message: string | undefined;
				try {
					message = errorMessageOf(response.json);
				} catch {
					// not JSON
				}
				// Gemini answers an invalid key with 400 API_KEY_INVALID, not 401.
				if (response.status === 400 || response.status === 401 || response.status === 403) {
					return {
						valid: false,
						error: message || t("plugin.provider_auth.auth_failed_status", { status: response.status }),
					};
				}
				return {
					valid: false,
					error: message || t("plugin.provider_auth.request_failed_status", { status: response.status }),
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { valid: false, error: t("plugin.provider_auth.connection_failed", { error: message }) };
			}
		},

		discoverModels: async (auth: AuthObject): Promise<string[]> => {
			if (!auth.apiKey?.trim()) {
				throw new Error("Gemini model discovery requires an API key.");
			}
			populateGeminiCache(instanceId, await fetchCatalog(auth));
			return cachedGeminiModelIds(instanceId, "chat");
		},

		discoverEmbeddingModels: async (auth: AuthObject): Promise<string[]> => {
			if (!auth.apiKey?.trim()) {
				throw new Error("Gemini embedding model discovery requires an API key.");
			}
			populateGeminiCache(instanceId, await fetchCatalog(auth));
			return cachedGeminiModelIds(instanceId, "embedding");
		},
	};
}
