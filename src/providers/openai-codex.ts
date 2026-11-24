import OpenAILogo from "../components/ui/logos/OpenAILogo.svelte";
import { createTransportedChatOpenAIResponses } from "./chatProviders";
import type {
	AuthObject,
	AuthValidationResult,
	BaseProviderDefinition,
	ChatModelConfig,
} from "../types/provider/index";
import {
	cancelOpenAICodexSignIn,
	clearOpenAICodexSession,
	createOpenAICodexFetch,
	fetchCodexModelEntries,
	getValidOpenAICodexSession,
	signInWithOpenAICodex,
} from "./openaiCodex";
import { getCodexSession } from "../stores/providerRuntime.svelte";
import { populateCodexCache } from "./codexModels";
import { t } from "../i18n";
import { openAIReasoningFields } from "./reasoningEffort";

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function openAICodexProvider(providerId: string, displayName = "OpenAI Codex"): BaseProviderDefinition {
	return {
		id: providerId,
		displayName,
		logo: OpenAILogo,
		setupInstructions: {
			steps: [
				"Use ChatGPT/Codex sign-in to authorize this provider",
				"Complete the browser-based sign-in flow",
				"Select one of the discovered Codex-backed chat models",
			],
		},
		oauth: {
			label: "ChatGPT",
			icon: "log-in",
			description: t("plugin.providers.openai.oauth_desc"),
			signIn: async () => {
				await signInWithOpenAICodex();
				return { kind: "session" };
			},
			cancelSignIn: cancelOpenAICodexSignIn,
			isSignedIn: () => !!getCodexSession(),
			disconnect: clearOpenAICodexSession,
			supportsApiKey: false,
		},
		supportsReasoningEffort: true,
		auth: {
			apiKey: {
				label: t("plugin.providers.fields.chatgpt_sign_in"),
				description: t("plugin.providers.openai_codex.sign_in_desc"),
				kind: "text",
				required: true,
				placeholder: t("plugin.providers.openai_codex.sign_in_placeholder"),
			},
		},
		createChatInstance: (_auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) =>
			createTransportedChatOpenAIResponses(providerId, {
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
				...openAIReasoningFields(options),
			}),
		validateAuth: async (_auth: AuthObject): Promise<AuthValidationResult> => {
			const session = await getValidOpenAICodexSession();
			if (!session) {
				return { valid: false, error: t("plugin.provider_auth.codex_sign_in_required") };
			}
			return { valid: true };
		},
		discoverModels: async (): Promise<string[]> => populateCodexCache(providerId, await fetchCodexModelEntries()),
	};
}
