import { type AnthropicModelInfo, getAnthropicModelInfo } from "../providers/anthropicModels";
import { type CodexModelInfo, getCodexModelInfo } from "../providers/codexModels";
import { formatParameterSize, OLLAMA_EMBED_NUM_CTX, type OllamaModelInfo } from "../providers/ollamaModels";
import {
	extractCapabilities as extractOpenRouterCapabilities,
	type OpenRouterModelInfo,
} from "../providers/openrouterModels";
import {
	getCachedHuggingFaceModels,
	type HuggingFaceModelInfo,
	huggingFaceDisplayName,
} from "../providers/huggingfaceModels";
import { getMistralModelInfo, type MistralModelInfo } from "../providers/mistralModels";
import { type CompatibleModelInfo, getCompatibleModelInfo } from "../providers/openaiCompatibleModels";
import { type GeminiModelInfo, getGeminiModelInfo } from "../providers/googleModels";
import { getLmStudioModel, type LmStudioModelInfo } from "../providers/lmstudioModels";
import type { ProviderTemplateId } from "../types/provider";
import type { HydratedChatModelMetadata, HydratedEmbeddingModelMetadata } from "../types/modelMetadata";

/**
 * Context window stored on an agent for a model whose provider reports none. The Agent editor
 * says the provider doesn't report one, so the user can set the real limit. Never shown in the
 * model picker, which leaves an unreported window out.
 */
export const ASSUMED_CONTEXT_WINDOW = 128000;
const DEFAULT_EMBEDDING_MAX_INPUT_TOKENS = 8191;
const DEFAULT_SIMILARITY_THRESHOLD = 0.7;
const DEFAULT_EMBED_MAX_INPUT_TOKENS_BY_PROVIDER: Record<string, number> = {
	openai: 8191,
	openrouter: 8191,
	ollama: 8191,
	anthropic: 8191,
};

/**
 * Input windows of embedding families that commonly sit behind endpoints with no
 * metadata (self-hosted or academic OpenAI-compatible APIs) and are *smaller*
 * than the 8191-token fallback. Without these the chunker sized chunks for 8191
 * tokens, and every long chunk went over the model's real limit. Matched as a
 * case-insensitive substring of the model id, first match wins.
 */
const KNOWN_EMBED_MAX_INPUT_TOKENS: ReadonlyArray<readonly [string, number]> = [
	["e5-mistral", 4096],
	["multilingual-e5", 512],
	["e5-large", 512],
	["e5-base", 512],
	["e5-small", 512],
];

export function knownEmbeddingMaxInputTokens(modelId: string): number | undefined {
	const id = modelId.toLowerCase();
	return KNOWN_EMBED_MAX_INPUT_TOKENS.find(([family]) => id.includes(family))?.[1];
}

/**
 * Inputs to hydration. Every fact comes from the provider serving the model: the catalogues
 * passed in here (OpenRouter, Ollama) or the per-instance caches discovery fills (Anthropic,
 * Codex, Gemini, Hugging Face, OpenAI-compatible endpoints, LM Studio). There is deliberately no third-party
 * fallback; what the provider doesn't report stays undefined.
 */
export interface ModelHydrationSourceData {
	openRouterData?: Map<string, OpenRouterModelInfo> | null;
	ollamaData?: Map<string, OllamaModelInfo> | null;
	/**
	 * Template of the provider instance. Needed where the instance id alone can't tell:
	 * a Hugging Face instance may be named anything ("hugging-face", "hf-work", …), and
	 * the per-instance caches are only read for the template that fills them.
	 */
	templateId?: ProviderTemplateId;
	temperature?: number;
	similarityThresholdDefault?: number;
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

function toUsdPer1MFromPerToken(perToken?: string): number | undefined {
	const perTokenNumber = toNumber(perToken);
	if (perTokenNumber === undefined) {
		return undefined;
	}
	return perTokenNumber * 1_000_000;
}

function normalizeParamSize(size?: string): string | undefined {
	if (!size) {
		return undefined;
	}
	return formatParameterSize(size);
}

/**
 * Drop the "Lab: " prefix catalogues put on display names (OpenRouter ships
 * names like "Qwen: Qwen3.8 Max"), for surfaces that already convey the vendor
 * some other way — a logo, or simply not having room for it. Only strips a
 * short leading segment so a colon inside the name itself (e.g. a version
 * string) is left alone.
 */
export function stripVendorPrefix(displayName: string): string {
	const match = displayName.match(/^([^:]{1,24}):\s+(.*)$/);
	return match ? match[2] : displayName;
}

function buildDisplayName(
	provider: string,
	variantKey: string,
	nameFromMetadata: string | undefined,
	_paramSize: string | undefined,
): string {
	const baseName = nameFromMetadata || variantKey;
	if (provider === "ollama") {
		return baseName.replace(/:latest$/i, "");
	}
	return baseName;
}

interface ProviderMetadata {
	openRouter?: OpenRouterModelInfo;
	ollama?: OllamaModelInfo;
	huggingFace?: HuggingFaceModelInfo;
	anthropic?: AnthropicModelInfo;
	codex?: CodexModelInfo;
	compatible?: CompatibleModelInfo;
	gemini?: GeminiModelInfo;
	mistral?: MistralModelInfo;
	lmStudio?: LmStudioModelInfo;
}

function lookupMetadata(provider: string, variantKey: string, sourceData: ModelHydrationSourceData): ProviderMetadata {
	const { templateId } = sourceData;
	return {
		openRouter:
			provider === "openrouter" && sourceData.openRouterData
				? sourceData.openRouterData.get(variantKey)
				: undefined,
		ollama: provider === "ollama" && sourceData.ollamaData ? sourceData.ollamaData.get(variantKey) : undefined,
		huggingFace: templateId === "huggingface" ? getCachedHuggingFaceModels().get(variantKey) : undefined,
		anthropic: templateId === "anthropic" ? getAnthropicModelInfo(provider, variantKey) : undefined,
		// Only filled for an instance signed in with ChatGPT; an API-key OpenAI instance has none.
		codex:
			templateId === "openai" || templateId === "openai-codex"
				? getCodexModelInfo(provider, variantKey)
				: undefined,
		compatible: templateId === "openai-compatible" ? getCompatibleModelInfo(provider, variantKey) : undefined,
		gemini: templateId === "google" ? getGeminiModelInfo(provider, variantKey) : undefined,
		mistral: templateId === "mistral" ? getMistralModelInfo(provider, variantKey) : undefined,
		lmStudio: templateId === "lmstudio" ? getLmStudioModel(provider, variantKey) : undefined,
	};
}

export function hydrateChatModel(
	provider: string,
	variantKey: string,
	sourceData: ModelHydrationSourceData = {},
): HydratedChatModelMetadata {
	const { openRouter, ollama, huggingFace, anthropic, codex, compatible, gemini, mistral, lmStudio } = lookupMetadata(
		provider,
		variantKey,
		sourceData,
	);
	const paramSize = normalizeParamSize(ollama?.parameterSize ?? lmStudio?.paramSize);
	const quantization = ollama?.quantization ?? lmStudio?.quantization;

	const displayName = buildDisplayName(
		provider,
		variantKey,
		openRouter?.name ||
			ollama?.name ||
			anthropic?.displayName ||
			codex?.displayName ||
			gemini?.displayName ||
			lmStudio?.displayName ||
			(sourceData.templateId === "huggingface" ? huggingFaceDisplayName(variantKey) : undefined),
		paramSize,
	);

	const contextWindow =
		openRouter?.context_length ||
		ollama?.contextLength ||
		huggingFace?.contextLength ||
		anthropic?.maxInputTokens ||
		codex?.contextWindow ||
		compatible?.contextWindow ||
		gemini?.inputTokenLimit ||
		mistral?.contextLength ||
		lmStudio?.contextLength ||
		undefined;

	const inputUsdPer1M = toUsdPer1MFromPerToken(openRouter?.pricing?.prompt);
	const outputUsdPer1M = toUsdPer1MFromPerToken(openRouter?.pricing?.completion);
	const hasPricing = inputUsdPer1M !== undefined || outputUsdPer1M !== undefined;
	const openRouterCapabilities = openRouter ? extractOpenRouterCapabilities(openRouter) : undefined;
	const effortLevels = anthropic?.effortLevels ?? codex?.effortLevels;

	return {
		kind: "chat",
		provider,
		variantKey,
		displayName,
		paramSize,
		quantization,
		contextWindow,
		temperature: sourceData.temperature,
		capabilities: {
			toolCalls:
				openRouterCapabilities?.supportsToolCalls ??
				ollama?.supportsTools ??
				huggingFace?.supportsTools ??
				compatible?.toolCalls ??
				mistral?.supportsTools ??
				lmStudio?.supportsTools,
			vision:
				openRouterCapabilities?.supportsVision ??
				ollama?.supportsVision ??
				huggingFace?.supportsVision ??
				anthropic?.vision ??
				codex?.vision ??
				compatible?.vision ??
				mistral?.supportsVision ??
				lmStudio?.supportsVision,
			reasoning:
				openRouterCapabilities?.supportsReasoning ??
				anthropic?.thinking ??
				(effortLevels ? effortLevels.length > 0 : undefined) ??
				compatible?.reasoning ??
				gemini?.thinking ??
				lmStudio?.reasoning,
			structuredOutput:
				openRouterCapabilities?.supportsStructuredOutput ??
				huggingFace?.supportsStructuredOutput ??
				anthropic?.structuredOutput ??
				compatible?.structuredOutput,
			effortLevels,
		},
		pricing: hasPricing ? { inputUsdPer1M, outputUsdPer1M } : undefined,
	};
}

export function hydrateEmbeddingModel(
	provider: string,
	variantKey: string,
	sourceData: ModelHydrationSourceData = {},
): HydratedEmbeddingModelMetadata {
	const { openRouter, ollama, compatible, gemini, mistral, lmStudio } = lookupMetadata(provider, variantKey, sourceData);
	const paramSize = normalizeParamSize(ollama?.parameterSize ?? lmStudio?.paramSize);
	const quantization = ollama?.quantization ?? lmStudio?.quantization;

	const displayName = buildDisplayName(
		provider,
		variantKey,
		openRouter?.name || ollama?.name || gemini?.displayName || lmStudio?.displayName,
		paramSize,
	);

	const maxInputFromOpenRouter =
		toNumber(openRouter?.per_request_limits?.prompt_tokens) || openRouter?.context_length;

	const providerDefaultMaxInputTokens = DEFAULT_EMBED_MAX_INPUT_TOKENS_BY_PROVIDER[provider];

	const advertisedMaxInputTokens =
		maxInputFromOpenRouter ||
		ollama?.contextLength ||
		compatible?.contextWindow ||
		gemini?.inputTokenLimit ||
		mistral?.contextLength ||
		lmStudio?.contextLength ||
		knownEmbeddingMaxInputTokens(variantKey) ||
		providerDefaultMaxInputTokens ||
		DEFAULT_EMBEDDING_MAX_INPUT_TOKENS;

	// Ollama's `/api/show` reports the architecture's context length (40960 for
	// qwen3-embedding), not what the server will accept: that is bounded by the
	// `num_ctx` each request carries. The embedding client pins num_ctx to
	// OLLAMA_EMBED_NUM_CTX, so the budget the chunker sizes against must be the
	// same number or every long note is rejected (#485).
	const maxInputTokens =
		provider === "ollama" ? Math.min(advertisedMaxInputTokens, OLLAMA_EMBED_NUM_CTX) : advertisedMaxInputTokens;

	const inputUsdPer1M = toUsdPer1MFromPerToken(openRouter?.pricing?.prompt);

	return {
		kind: "embedding",
		provider,
		variantKey,
		displayName,
		paramSize,
		quantization,
		maxInputTokens,
		dimensions: ollama?.embeddingLength,
		similarityThresholdDefault: sourceData.similarityThresholdDefault ?? DEFAULT_SIMILARITY_THRESHOLD,
		pricing: inputUsdPer1M !== undefined ? { inputUsdPer1M } : undefined,
	};
}
