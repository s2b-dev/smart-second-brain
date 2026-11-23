/**
 * Provider Registry
 *
 * This module provides lookup helpers for code-defined provider templates and
 * persisted provider instances created from those templates.
 */

import type {
	BaseProviderDefinition,
	EmbeddingProviderDefinition,
	ProviderInstanceMeta,
	ProviderTemplateId,
} from "../types/provider/index";
import { createOpenAICompatibleProvider } from "./openai-compatible";
import { anthropicProvider, discoverAnthropicModels } from "./anthropic";
import { ollamaProvider } from "./ollama";
import { discoverOpenAIModels, openaiProvider } from "./openai";
import { openrouterProvider } from "./openrouter";
import { huggingfaceProvider } from "./huggingface";
import { createGoogleProvider } from "./google";
import { discoverMistralEmbeddingModels, discoverMistralModels, mistralProvider } from "./mistral";
import { openAICodexProvider } from "./openai-codex";
import { createOmlxProvider } from "./omlx";

export interface ProviderTemplateDefinition {
	id: ProviderTemplateId;
	displayName: string;
	description: string;
}

const PROVIDER_TEMPLATES: readonly ProviderTemplateDefinition[] = [
	{
		id: "openai",
		displayName: "OpenAI",
		description: t("plugin.providers.templates.openai"),
	},
	{
		id: "openai-compatible",
		displayName: "Custom",
		description: t("plugin.providers.templates.openai_compatible"),
	},
	{
		id: "anthropic",
		displayName: "Anthropic",
		description: t("plugin.providers.templates.anthropic"),
	},
	{
		id: "ollama",
		displayName: "Ollama",
		description: t("plugin.providers.templates.ollama"),
	},
	{
		id: "omlx",
		displayName: "oMLX",
		description: t("plugin.providers.templates.omlx"),
	},
	{
		id: "openrouter",
		displayName: "OpenRouter",
		description: t("plugin.providers.templates.openrouter"),
	},
	{
		id: "huggingface",
		displayName: "Hugging Face",
		description: t("plugin.providers.templates.huggingface"),
	},
	{
		id: "google",
		displayName: "Google Gemini",
		description: t("plugin.providers.templates.google"),
	},
	{
		id: "mistral",
		displayName: "Mistral",
		description: t("plugin.providers.templates.mistral"),
	},
] as const;

export function getProviderTemplate(templateId: ProviderTemplateId): ProviderTemplateDefinition | undefined {
	return PROVIDER_TEMPLATES.find((template) => template.id === templateId);
}

function createTemplateDefinition(
	instanceId: string,
	templateId: ProviderTemplateId,
	meta: ProviderInstanceMeta,
): BaseProviderDefinition | undefined {
	switch (templateId) {
		case "openai":
			return {
				...openaiProvider,
				id: instanceId,
				displayName: meta.displayName,
				discoverModels: (auth) => discoverOpenAIModels(auth, instanceId),
			};
		case "openai-compatible":
			return createOpenAICompatibleProvider({
				id: instanceId,
				displayName: meta.displayName,
				defaultBaseUrl: "https://api.openai.com",
			});
		case "omlx":
			return createOmlxProvider(instanceId, meta.displayName);
		case "openai-codex":
			return openAICodexProvider(instanceId, meta.displayName);
		case "anthropic":
			return {
				...anthropicProvider,
				id: instanceId,
				displayName: meta.displayName,
				discoverModels: (auth) => discoverAnthropicModels(auth, instanceId),
			};
		case "ollama":
			return {
				...ollamaProvider,
				id: instanceId,
				displayName: meta.displayName,
			};
		case "openrouter":
			return {
				...openrouterProvider,
				id: instanceId,
				displayName: meta.displayName,
			};
		case "huggingface":
			return {
				...huggingfaceProvider,
				id: instanceId,
				displayName: meta.displayName,
			};
		case "google":
			return createGoogleProvider(instanceId, meta.displayName);
		case "mistral": {
			const mistral: EmbeddingProviderDefinition = {
				...mistralProvider,
				id: instanceId,
				displayName: meta.displayName,
				discoverModels: (auth) => discoverMistralModels(auth, instanceId),
				discoverEmbeddingModels: (auth) => discoverMistralEmbeddingModels(auth, instanceId),
			};
			return mistral;
		}
		default:
			return undefined;
	}
}

export function getProviderDefinition(
	id: string,
	providerMeta: Record<string, ProviderInstanceMeta> = {},
): BaseProviderDefinition | undefined {
	switch (id) {
		case "openai":
			return openaiProvider;
		case "anthropic":
			return anthropicProvider;
		case "ollama":
			return ollamaProvider;
	}

	const meta = providerMeta[id];
	if (!meta) {
		return undefined;
	}

	return createTemplateDefinition(id, meta.templateId, meta);
}

export function getAllProviderTemplates(): readonly ProviderTemplateDefinition[] {
	return PROVIDER_TEMPLATES;
}

export {
	ProviderRegistryError,
	ProviderAuthError,
	ProviderEndpointError,
	ModelNotFoundError,
	ProviderNotFoundError,
} from "./errors";

export { createOpenAICompatibleProvider } from "./openai-compatible";

export type {
	AuthObject,
	AuthFieldDefinition,
	BaseProviderDefinition,
	ChatModelConfig,
	EmbedModelConfig,
	LogoProps,
	OpenAIAuthMode,
	ProviderInstanceMeta,
	ProviderTemplateId,
} from "../types/provider/index";
import { t } from "../i18n";

export { isEmbeddingProvider } from "../types/provider/index";

export { anthropicProvider } from "./anthropic";
export { openaiProvider } from "./openai";
export { ollamaProvider } from "./ollama";
