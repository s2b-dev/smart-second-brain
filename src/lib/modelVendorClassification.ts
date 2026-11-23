import { Logger } from "../utils/logging";
import type { OpenRouterModelInfo } from "../providers/openrouterModels";
import type { ProviderTemplateId } from "../types/provider/index";

export interface UiClassifiableModel {
	provider: string;
	model: string;
	templateId?: ProviderTemplateId;
	baseUrl?: string | null;
	family?: string;
	families?: string[];
}

const UI_VENDOR_IDS = [
	"openai",
	"anthropic",
	"google",
	"microsoft",
	"meta-llama",
	"deepseek",
	"x-ai",
	"mistralai",
	"qwen",
	"z-ai",
	"minimax",
	"nvidia",
	"moonshotai",
	"tencent",
	"bytedance-seed",
	"openrouter",
	"perplexity",
	"kwaipilot",
	"xiaomi",
	"meituan",
	"baidu",
] as const;

const UI_VENDOR_ID_SET = new Set<string>(UI_VENDOR_IDS);

/**
 * Catalogue prefixes that mean a vendor we already draw, under another name.
 * `meta` is Meta's own non-Llama line (the `muse-*` models) and shares Meta's
 * mark; `bytedance` predates the `bytedance-seed` prefix. Mapping them here
 * rather than adding artwork keeps one logo per lab.
 */
const VENDOR_ID_ALIASES: Record<string, string> = {
	meta: "meta-llama",
	bytedance: "bytedance-seed",
};

/**
 * Canonicalizes a raw catalogue prefix.
 *
 * OpenRouter publishes floating aliases under a `~` prefix (`~anthropic/
 * claude-opus-latest`), which is the same lab as `anthropic` and must resolve
 * to the same logo rather than reading as an unknown vendor.
 */
function normalizeVendorId(rawVendor: string): string {
	const withoutAliasMarker = rawVendor.startsWith("~") ? rawVendor.slice(1) : rawVendor;
	return VENDOR_ID_ALIASES[withoutAliasMarker] ?? withoutAliasMarker;
}

type UnclassifiedUiModelReason = "no_vendor_match" | "vendor_not_in_ui";

export interface UnclassifiedUiModel {
	provider: string;
	model: string;
	reason: UnclassifiedUiModelReason;
	extractedVendor?: string;
}

function normalizeComparableToken(model: string): string {
	return model
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]/g, "");
}

function extractPrefixFromOpenRouterModelId(modelId: string): string | null {
	if (!modelId.includes("/")) return null;
	const [prefix] = modelId.split("/", 1);
	return prefix || null;
}

function extractHost(baseUrl?: string | null): string | null {
	if (!baseUrl) return null;
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return baseUrl.toLowerCase();
	}
}

function inferVendorFromBaseUrl(baseUrl?: string | null): string | null {
	const host = extractHost(baseUrl);
	if (!host) return null;

	if (host.includes("azure.com") || host.includes("azure.net")) {
		return "microsoft";
	}
	if (host === "api.openai.com" || host.endsWith(".openai.com")) {
		return "openai";
	}
	if (host.includes("anthropic.com")) {
		return "anthropic";
	}
	if (host.includes("googleapis.com") || host.includes("google.com")) {
		return "google";
	}
	if (host.includes("x.ai")) {
		return "x-ai";
	}
	if (host.includes("mistral.ai")) {
		return "mistralai";
	}

	return null;
}

function inferVendorFromModelName(modelId: string): string | null {
	const prefix = extractPrefixFromOpenRouterModelId(modelId);
	if (prefix) {
		const normalizedPrefix = normalizeVendorId(prefix);
		if (UI_VENDOR_ID_SET.has(normalizedPrefix)) {
			return normalizedPrefix;
		}
	}

	const normalized = modelId.toLowerCase().trim();
	const providerishPrefix = normalized.match(/^([a-z0-9-]+)--/i)?.[1] ?? null;
	if (providerishPrefix) {
		if (providerishPrefix === "meta" || providerishPrefix === "meta-llama") return "meta-llama";
		if (providerishPrefix === "xai") return "x-ai";
		if (UI_VENDOR_ID_SET.has(providerishPrefix)) return providerishPrefix;
	}

	if (/^(gpt|o[1-9]\b|chatgpt)/.test(normalized)) return "openai";
	if (/^claude/.test(normalized)) return "anthropic";
	if (/^gemini/.test(normalized)) return "google";
	if (/^(phi|wizardlm|mai-)/.test(normalized)) return "microsoft";
	if (/^(llama|meta-llama|meta\b)/.test(normalized)) return "meta-llama";
	if (/^deepseek/.test(normalized)) return "deepseek";
	if (/^grok/.test(normalized)) return "x-ai";
	if (/^(mistral|mixtral|ministral|codestral)/.test(normalized)) return "mistralai";
	if (/^qwen/.test(normalized)) return "qwen";

	return null;
}

function inferOllamaVendorFromOpenRouter(
	families: string[],
	openRouterModels: Map<string, OpenRouterModelInfo> | null | undefined,
): string | null {
	if (!openRouterModels || openRouterModels.size === 0) {
		return null;
	}

	const normalizedFamilies = families
		.map((family) => normalizeComparableToken(family))
		.filter((family) => family.length > 0);
	if (normalizedFamilies.length === 0) return null;

	for (const normalizedFamily of normalizedFamilies) {
		const matches = new Set<string>();
		for (const modelInfo of openRouterModels.values()) {
			const sourceId = modelInfo.canonical_slug ?? modelInfo.id;
			const rawPrefix = extractPrefixFromOpenRouterModelId(sourceId);
			if (!rawPrefix) continue;
			const prefix = normalizeVendorId(rawPrefix);

			const modelPart = sourceId.split("/").slice(1).join("/");
			const modelPartNormalized = normalizeComparableToken(modelPart);

			if (modelPartNormalized.startsWith(normalizedFamily)) {
				matches.add(prefix);
			}
		}

		if (matches.size === 1) {
			return Array.from(matches)[0] ?? null;
		}
	}

	return null;
}

export function extractVendor(
	model: UiClassifiableModel,
	openRouterModels?: Map<string, OpenRouterModelInfo> | null,
): string | null {
	if ((model.templateId === "openrouter" || model.provider === "openrouter") && model.model.includes("/")) {
		return normalizeVendorId(model.model.split("/")[0]);
	}

	if (model.templateId === "openai-codex" || model.provider === "openai") {
		return "openai";
	}

	if (model.templateId === "mistral") {
		return "mistralai";
	}

	if (model.templateId === "anthropic" || model.provider === "anthropic") {
		return "anthropic";
	}

	if (model.templateId === "ollama" || model.provider === "ollama") {
		const candidateFamilies = [model.family, ...(model.families ?? [])].filter(
			(family): family is string => typeof family === "string" && family.length > 0,
		);
		if (candidateFamilies.length === 0) return null;
		return inferOllamaVendorFromOpenRouter(candidateFamilies, openRouterModels);
	}

	if (model.templateId === "openai-compatible") {
		return inferVendorFromBaseUrl(model.baseUrl) ?? inferVendorFromModelName(model.model);
	}

	return inferVendorFromBaseUrl(model.baseUrl) ?? inferVendorFromModelName(model.model);
}

export function getUnclassifiedModelsForUi(
	models: readonly UiClassifiableModel[],
	openRouterModels?: Map<string, OpenRouterModelInfo> | null,
): UnclassifiedUiModel[] {
	const unresolvedByKey = new Map<string, UnclassifiedUiModel>();

	for (const model of models) {
		const extractedVendor = extractVendor(model, openRouterModels);
		if (!extractedVendor) {
			const key = `${model.provider}:${model.model}:no_vendor_match`;
			unresolvedByKey.set(key, {
				provider: model.provider,
				model: model.model,
				reason: "no_vendor_match",
			});
			continue;
		}

		if (!UI_VENDOR_ID_SET.has(extractedVendor)) {
			const key = `${model.provider}:${model.model}:vendor_not_in_ui:${extractedVendor}`;
			unresolvedByKey.set(key, {
				provider: model.provider,
				model: model.model,
				extractedVendor,
				reason: "vendor_not_in_ui",
			});
		}
	}

	return Array.from(unresolvedByKey.values()).sort((a, b) => {
		const aKey = `${a.provider}:${a.model}:${a.reason}:${a.extractedVendor ?? ""}`;
		const bKey = `${b.provider}:${b.model}:${b.reason}:${b.extractedVendor ?? ""}`;
		return aKey.localeCompare(bKey);
	});
}

const loggedUnclassifiedSignatures = new Set<string>();

export function logUnclassifiedModelsInfo(
	scope: string,
	models: readonly UiClassifiableModel[],
	openRouterModels?: Map<string, OpenRouterModelInfo> | null,
): void {
	const unresolved = getUnclassifiedModelsForUi(models, openRouterModels);
	if (unresolved.length === 0) {
		return;
	}

	const signature = unresolved
		.map((entry) => `${entry.provider}:${entry.model}:${entry.reason}:${entry.extractedVendor ?? ""}`)
		.sort()
		.join("|");

	if (loggedUnclassifiedSignatures.has(signature)) {
		return;
	}

	loggedUnclassifiedSignatures.add(signature);
	Logger.info("ui.model-classification.unclassified", {
		scope,
		count: unresolved.length,
		models: unresolved,
	});
}
