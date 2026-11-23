/**
 * Hugging Face Inference Providers.
 *
 * One OpenAI-compatible endpoint (`router.huggingface.co/v1`) that routes each request
 * to a partner inference provider (Together, Fireworks, Novita, Groq, …) serving open
 * models. Usage is billed to the user's Hugging Face account, which includes free
 * monthly credits.
 *
 * Authentication: "Sign in with Hugging Face" (OAuth with PKCE, see
 * `huggingfaceOAuth.ts`), or a pasted access token. A pasted token wins when both are
 * present, so a user can pin a fine-grained token without signing out first.
 *
 * Chat only. The router's OpenAI-compatible surface exposes no embeddings endpoint.
 */

import { requestUrl } from "obsidian";
import HuggingFaceLogo from "../components/ui/logos/HuggingFaceLogo.svelte";
import { getHuggingFaceSession } from "../stores/providerRuntime.svelte";
import type {
	AuthObject,
	AuthValidationResult,
	BaseProviderDefinition,
	ChatModelConfig,
} from "../types/provider/index";
import { createBufferedTransportedChatOpenAI, createTransportedChatOpenAI } from "./chatProviders";
import { HF_ROUTER_BASE_URL, populateHuggingFaceCache, type RouterCatalogEntry } from "./huggingfaceModels";
import {
	cancelHuggingFaceSignIn,
	clearHuggingFaceSignIn,
	getValidHuggingFaceSession,
	signInWithHuggingFace,
} from "./huggingfaceOAuth";
import { t } from "../i18n";
import { chatCompletionsReasoningFields } from "./reasoningEffort";

const HF_WHOAMI_URL = "https://huggingface.co/api/whoami-v2";

/**
 * The bearer token for a request: the pasted access token when there is one, otherwise
 * the signed-in session's access token (renewed first if it is about to expire).
 */
async function resolveToken(auth: AuthObject): Promise<string> {
	const pasted = auth.apiKey?.trim();
	if (pasted) return pasted;
	const session = await getValidHuggingFaceSession();
	if (!session) {
		throw new Error("Sign in with Hugging Face to use this provider");
	}
	return session.accessToken;
}

function chatConfig(auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>): Record<string, unknown> {
	const configuration: Record<string, unknown> = { baseURL: HF_ROUTER_BASE_URL };
	if (auth.headers && Object.keys(auth.headers).length > 0) {
		configuration.defaultHeaders = auth.headers;
	}
	return {
		model: modelId,
		// A function, so every request reads the current (possibly just renewed) token
		// instead of one captured when the chat model was built.
		apiKey: () => resolveToken(auth),
		temperature: options?.temperature,
		configuration,
		...chatCompletionsReasoningFields(options),
	};
}

async function validatePastedToken(token: string): Promise<AuthValidationResult> {
	try {
		const response = await requestUrl({
			url: HF_WHOAMI_URL,
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
			throw: false,
		});
		if (response.status >= 200 && response.status < 300) {
			return { valid: true };
		}
		if (response.status === 401 || response.status === 403) {
			return { valid: false, error: t("plugin.provider_auth.huggingface_token_rejected") };
		}
		return { valid: false, error: t("plugin.provider_auth.huggingface_status", { status: response.status }) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { valid: false, error: t("plugin.provider_auth.connection_failed", { error: message }) };
	}
}

export const huggingfaceProvider: BaseProviderDefinition = {
	id: "huggingface",
	displayName: "Hugging Face",
	supportsReasoningEffort: true,
	logo: HuggingFaceLogo,

	setupInstructions: {
		steps: [
			"Create a fine-grained access token on Hugging Face",
			'Enable "Make calls to Inference Providers"',
			"Paste the token below",
		],
		link: {
			url: "https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained",
			text: t("plugin.providers.huggingface.link"),
		},
	},

	oauth: {
		label: "Hugging Face",
		icon: "log-in",
		description: t("plugin.providers.huggingface.oauth_desc"),
		signIn: async () => {
			await signInWithHuggingFace();
			return { kind: "session" };
		},
		cancelSignIn: cancelHuggingFaceSignIn,
		isSignedIn: () => !!getHuggingFaceSession(),
		disconnect: clearHuggingFaceSignIn,
		supportsApiKey: true,
		// Mobile gets the redirect through an obsidian:// protocol handler instead of the
		// desktop loopback server.
		worksOnMobile: true,
	},

	auth: {
		apiKey: {
			label: t("plugin.providers.fields.access_token"),
			description: 'A Hugging Face access token with the "Make calls to Inference Providers" permission',
			kind: "secret",
			required: true,
			placeholder: "hf_...",
		},
		headers: {
			label: t("plugin.providers.fields.custom_headers"),
			description: t("plugin.providers.fields.custom_headers_desc"),
			kind: "textarea",
			required: false,
			placeholder: '{"X-Custom-Header": "value"}',
		},
	},

	createChatInstance: (auth, modelId, options) =>
		createTransportedChatOpenAI("huggingface", chatConfig(auth, modelId, options)),

	createSubAgentChatInstance: (auth, modelId, options) =>
		createBufferedTransportedChatOpenAI("huggingface", chatConfig(auth, modelId, options)),

	validateAuth: async (auth: AuthObject): Promise<AuthValidationResult> => {
		const pasted = auth.apiKey?.trim();
		if (pasted) return validatePastedToken(pasted);
		try {
			const session = await getValidHuggingFaceSession();
			return session
				? { valid: true }
				: { valid: false, error: t("plugin.provider_auth.huggingface_sign_in_required") };
		} catch (error) {
			return { valid: false, error: error instanceof Error ? error.message : String(error) };
		}
	},

	/** The router's catalog is public; only tool-capable models are listed (see populateHuggingFaceCache). */
	discoverModels: async (): Promise<string[]> => {
		const response = await requestUrl({ url: `${HF_ROUTER_BASE_URL}/models`, method: "GET", throw: false });
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Model discovery failed (${response.status})`);
		}
		return populateHuggingFaceCache((response.json as { data?: RouterCatalogEntry[] })?.data ?? []);
	},
};
