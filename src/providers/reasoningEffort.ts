import type { ChatModelConfig } from "../types/provider";

/**
 * Translations of the provider-neutral `reasoningEffort` setting into each vendor's
 * request parameter. Each returns the LangChain constructor fields to spread into the
 * chat model config, and an empty object when no effort is set, so an unset effort
 * never sends anything and the provider's own default applies.
 */

type Options = Partial<ChatModelConfig> | undefined;

/**
 * OpenAI (API key and ChatGPT sign-in). LangChain's `reasoning` field, which it only
 * forwards for models it recognises as reasoning models (o-series, gpt-5), so picking
 * an effort for gpt-4o is a harmless no-op instead of a 400.
 */
export function openAIReasoningFields(options: Options): Record<string, unknown> {
	const effort = options?.reasoningEffort;
	return effort ? { reasoning: { effort } } : {};
}

/**
 * Anthropic. `output_config.effort` only governs reasoning when thinking is on, and
 * several current models (Opus 4.6-4.8) don't think unless asked, so adaptive thinking
 * is requested alongside it. Models older than the 4.6 family reject both.
 */
export function anthropicReasoningFields(options: Options): Record<string, unknown> {
	const effort = options?.reasoningEffort;
	return effort ? { thinking: { type: "adaptive" }, outputConfig: { effort } } : {};
}

/**
 * OpenRouter's unified `reasoning` object, which it maps per upstream model. Sent as a
 * raw body field: LangChain's own `reasoning` is gated on OpenAI model names and
 * OpenRouter ids (`deepseek/deepseek-r1`) never match.
 */
export function openRouterReasoningFields(options: Options): Record<string, unknown> {
	const effort = options?.reasoningEffort;
	return effort ? { modelKwargs: { reasoning: { effort } } } : {};
}

/**
 * Generic OpenAI-compatible servers (LiteLLM, vLLM, oMLX, Hugging Face router): the
 * Chat Completions `reasoning_effort` field, sent raw for the same reason as above.
 */
export function chatCompletionsReasoningFields(options: Options): Record<string, unknown> {
	const effort = options?.reasoningEffort;
	return effort ? { modelKwargs: { reasoning_effort: effort } } : {};
}
