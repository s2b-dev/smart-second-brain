/**
 * Hugging Face Inference Providers.
 *
 * One OpenAI-compatible endpoint (`router.huggingface.co/v1`) that routes each request
 * to a partner inference provider (Together, Fireworks, Novita, Groq, …) serving open
 * models. Usage is billed to the user's Hugging Face account, which includes free
 * monthly credits.
 *
 * Authentication: "Sign in with Hugging Face" (device-code OAuth, see
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
import {
	cancelHuggingFaceSignIn,
	clearHuggingFaceSignIn,
	getValidHuggingFaceSession,
	signInWithHuggingFace,
} from "./huggingfaceOAuth";

const HF_ROUTER_BASE_URL = "https://router.huggingface.co/v1";
const HF_WHOAMI_URL = "https://huggingface.co/api/whoami-v2";

/** One entry of the router's `/v1/models` catalog (only the fields we read). */
interface RouterModel {
	id?: string;
	providers?: Array<{ status?: string; supports_tools?: boolean }>;
}

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
			return { valid: false, error: "Hugging Face rejected this access token" };
		}
		return { valid: false, error: `Hugging Face returned status ${response.status}` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { valid: false, error: `Connection failed: ${message}` };
	}
}

export const huggingfaceProvider: BaseProviderDefinition = {
	id: "huggingface",
	displayName: "Hugging Face",
	logo: HuggingFaceLogo,

	setupInstructions: {
		steps: [
			"Create a fine-grained access token on Hugging Face",
			'Enable "Make calls to Inference Providers"',
			"Paste the token below",
		],
		link: {
			url: "https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained",
			text: "Hugging Face access tokens",
		},
	},

	oauth: {
		label: "Hugging Face",
		icon: "log-in",
		description: "Enter a short code on huggingface.co to connect, without creating an access token.",
		signIn: async ({ onDeviceCode }) => {
			await signInWithHuggingFace(onDeviceCode);
			return { kind: "session" };
		},
		cancelSignIn: cancelHuggingFaceSignIn,
		isSignedIn: () => !!getHuggingFaceSession(),
		disconnect: clearHuggingFaceSignIn,
		supportsApiKey: true,
		// Device-code flow: nothing redirects back to Obsidian, so no localhost server.
		worksOnMobile: true,
	},

	auth: {
		apiKey: {
			label: "Access Token",
			description: 'A Hugging Face access token with the "Make calls to Inference Providers" permission',
			kind: "secret",
			required: true,
			placeholder: "hf_...",
		},
		headers: {
			label: "Custom Headers",
			description: "Additional headers as JSON (optional)",
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
			return session ? { valid: true } : { valid: false, error: "Sign in with Hugging Face to connect" };
		} catch (error) {
			return { valid: false, error: error instanceof Error ? error.message : String(error) };
		}
	},

	/**
	 * The router's catalog is public. Only models that at least one live inference provider
	 * serves with tool calling are listed: the agent needs tools for nearly everything it
	 * does, and a model without them fails on the first turn rather than degrading.
	 */
	discoverModels: async (): Promise<string[]> => {
		const response = await requestUrl({ url: `${HF_ROUTER_BASE_URL}/models`, method: "GET", throw: false });
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Model discovery failed (${response.status})`);
		}
		const models = (response.json as { data?: RouterModel[] })?.data ?? [];
		return models
			.filter((model) => model.providers?.some((p) => p.status === "live" && p.supports_tools))
			.map((model) => model.id)
			.filter((id): id is string => typeof id === "string" && id.trim() !== "")
			.sort((a, b) => a.localeCompare(b));
	},
};
