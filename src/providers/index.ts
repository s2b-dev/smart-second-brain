/**
 * Provider Registry
 *
 * This module provides lookup helpers for code-defined provider templates and
 * persisted provider instances created from those templates.
 */

import type {
	BaseProviderDefinition,
	EmbeddingProviderDefinition,
	LogoProps,
	ProviderInstanceMeta,
	ProviderTemplateId,
} from "../types/provider/index";
import type { Component } from "svelte";
import DirectoryLogo from "../components/ui/logos/DirectoryLogo.svelte";
import { createOpenAICompatibleProvider, type OpenAICompatibleProviderInput } from "./openai-compatible";
import { getDirectoryEntry } from "./directory/index";
import { anthropicProvider, discoverAnthropicModels } from "./anthropic";
import { ollamaProvider } from "./ollama";
import { discoverOpenAIModels, openaiProvider } from "./openai";
import { openrouterProvider } from "./openrouter";
import { huggingfaceProvider } from "./huggingface";
import { createGoogleProvider } from "./google";
import { discoverMistralEmbeddingModels, discoverMistralModels, mistralProvider } from "./mistral";
import { openAICodexProvider } from "./openai-codex";
import { createOmlxProvider } from "./omlx";
import { createLmStudioProvider } from "./lmstudio";

const directoryLogos = new Map<string, Component<LogoProps>>();

/**
 * A logo component bound to one entry's SVG. Cached so a definition rebuilt on every lookup
 * hands back the same component, and a mounted header logo isn't torn down for nothing.
 */
function directoryLogo(id: string, svg: string | undefined): Component<LogoProps> {
	let logo = directoryLogos.get(id);
	if (!logo) {
		logo = (internals, props) => DirectoryLogo(internals, { ...props, svg });
		directoryLogos.set(id, logo);
	}
	return logo;
}

/**
 * What a directory entry contributes to its Custom instance: the vendor's API root as the
 * default base URL, its logo, and setup steps pointing at its docs. A missing entry (the
 * snapshot dropped it) leaves a plain Custom provider, which still works off its stored URL.
 */
function directoryOverrides(directoryId: string | undefined): Partial<OpenAICompatibleProviderInput> {
	const entry = getDirectoryEntry(directoryId);
	if (!entry) return { defaultBaseUrl: "https://api.openai.com" };
	return {
		defaultBaseUrl: entry.api,
		logo: directoryLogo(entry.id, entry.logo),
		setupInstructions: {
			steps: [`Get an API key from ${entry.name}`, "Paste it below; the base URL is already filled in"],
			...(entry.doc
				? { link: { url: entry.doc, text: t("plugin.providers.directory.docs_link", { name: entry.name }) } }
				: {}),
		},
	};
}

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
		id: "lmstudio",
		displayName: "LM Studio",
		description: t("plugin.providers.templates.lmstudio"),
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
				...directoryOverrides(meta.directoryId),
			});
		case "omlx":
			return createOmlxProvider(instanceId, meta.displayName);
		case "lmstudio":
			return createLmStudioProvider(instanceId, meta.displayName);
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
