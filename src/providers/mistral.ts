/**
 * Mistral (La Plateforme, `api.mistral.ai`).
 *
 * Mistral's own models, served from the EU. One API key covers chat and embeddings
 * (`mistral-embed`), so a single provider can run both the agent and the index.
 *
 * Built on `ChatOpenAI` / `OpenAIEmbeddings` against Mistral's OpenAI-compatible API,
 * not on `@langchain/mistralai`: the official Mistral SDK under that package imports its
 * Node-only voice-agent transport (`node:module`, `@livekit/rtc-node`) from its root, so
 * it neither bundles nor would load on mobile. The OpenAI path keeps the plugin's
 * transports (streaming fallback, buffered subagents, `requestUrl` for CORS) as they
 * are; what Mistral's stricter validation needs on top is in `mistralTransport.ts`.
 *
 * Authentication: an API key from console.mistral.ai.
 */

import { requestUrl } from "obsidian";
import MistralLogo from "../components/ui/logos/MistralLogo.svelte";
import type {
	AuthObject,
	AuthValidationResult,
	ChatModelConfig,
	EmbeddingProviderDefinition,
} from "../types/provider/index";
import {
	createBufferedTransportedChatMistral,
	createTransportedChatMistral,
	createTransportedMistralEmbeddings,
} from "./chatProviders";
import { MISTRAL_API_BASE_URL, type MistralCatalogEntry, populateMistralCache } from "./mistralModels";
import { t } from "../i18n";

const MISTRAL_API_KEYS_URL = "https://console.mistral.ai/api-keys";

const MISTRAL_V1_URL = `${MISTRAL_API_BASE_URL}/v1`;

function chatConfig(auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) {
	return {
		model: modelId,
		apiKey: auth.apiKey,
		temperature: options?.temperature,
		configuration: { baseURL: MISTRAL_V1_URL },
	};
}

function modelsRequest(apiKey: string) {
	return requestUrl({
		url: `${MISTRAL_V1_URL}/models`,
		method: "GET",
		headers: { Authorization: `Bearer ${apiKey}` },
		throw: false,
	});
}

/** Fetches the catalogue, refreshes the hydration cache, and returns the offerable ids. */
async function discover(auth: AuthObject, providerId: string): Promise<{ chat: string[]; embedding: string[] }> {
	const apiKey = auth.apiKey?.trim();
	if (!apiKey) throw new Error("Mistral model discovery requires an API key.");
	const response = await modelsRequest(apiKey);
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Model discovery failed (${response.status})`);
	}
	return populateMistralCache(providerId, (response.json as { data?: MistralCatalogEntry[] })?.data ?? []);
}

export const mistralProvider: EmbeddingProviderDefinition = {
	id: "mistral",
	displayName: "Mistral",
	logo: MistralLogo,

	setupInstructions: {
		steps: [
			"Create an API key in the Mistral console",
			"Choose a plan (the free Experiment plan works)",
			"Paste the API key below",
		],
		link: {
			url: MISTRAL_API_KEYS_URL,
			text: t("plugin.providers.mistral.link"),
		},
	},

	auth: {
		apiKey: {
			label: t("plugin.providers.fields.api_key"),
			description: t("plugin.providers.mistral.api_key_desc"),
			kind: "secret",
			required: true,
		},
	},

	createChatInstance: (auth, modelId, options) =>
		createTransportedChatMistral("mistral", chatConfig(auth, modelId, options)),

	createSubAgentChatInstance: (auth, modelId, options) =>
		createBufferedTransportedChatMistral("mistral", chatConfig(auth, modelId, options)),

	createEmbeddingInstance: (auth, modelId) =>
		createTransportedMistralEmbeddings({
			model: modelId,
			apiKey: auth.apiKey,
			configuration: { baseURL: MISTRAL_V1_URL },
		}),

	validateAuth: async (auth: AuthObject): Promise<AuthValidationResult> => {
		const apiKey = auth.apiKey?.trim();
		if (!apiKey) return { valid: false, error: t("plugin.provider_auth.api_key_required") };
		try {
			const response = await modelsRequest(apiKey);
			if (response.status >= 200 && response.status < 300) return { valid: true };
			if (response.status === 401 || response.status === 403) {
				return {
					valid: false,
					error: t("plugin.provider_auth.auth_failed_status", { status: response.status }),
				};
			}
			return {
				valid: false,
				error: t("plugin.provider_auth.request_failed_status", { status: response.status }),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { valid: false, error: t("plugin.provider_auth.connection_failed", { error: message }) };
		}
	},

	discoverModels: (auth: AuthObject) => discoverMistralModels(auth, "mistral"),

	discoverEmbeddingModels: (auth: AuthObject) => discoverMistralEmbeddingModels(auth, "mistral"),
};

/** Chat models with tool calling, per the catalogue's `capabilities`. */
export async function discoverMistralModels(auth: AuthObject, providerId: string): Promise<string[]> {
	return (await discover(auth, providerId)).chat;
}

export async function discoverMistralEmbeddingModels(auth: AuthObject, providerId: string): Promise<string[]> {
	return (await discover(auth, providerId)).embedding;
}
