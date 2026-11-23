/**
 * Model Configuration Types
 *
 * Types for configuring chat and embedding models.
 */

/**
 * How hard a reasoning model thinks before answering. One scale for every provider;
 * each provider translates it to its own parameter (OpenAI `reasoning.effort`,
 * Anthropic `output_config.effort` with adaptive thinking, OpenRouter `reasoning`,
 * OpenAI-compatible `reasoning_effort`). See `providers/reasoningEffort.ts`.
 */
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Configuration for a chat model.
 * Stored in data.json under provider.chatModels[modelId]
 *
 * These values are passed to LangChain when creating the model instance.
 * LangChain may ignore unsupported options (e.g., temperature on reasoning models).
 */
export interface ChatModelConfig {
	/**
	 * Sampling temperature (0-2).
	 * Optional - some models (o1, o3, gpt-5) don't support temperature.
	 * If not set, LangChain uses its default.
	 */
	temperature?: number;

	/**
	 * Maximum context window in tokens.
	 * REQUIRED - used by LangChain's trimMessages() for context management.
	 * Also used by our UI to show context usage.
	 */
	contextWindow: number;

	/**
	 * Whether the model supports vision (image input).
	 * Populated from what the provider reports, or set by the user in the Agent editor when the
	 * provider reports nothing. Used at runtime to determine if images can be sent to the model;
	 * undefined is treated as no.
	 */
	supportsVision?: boolean;

	/**
	 * Reasoning effort to request. Unset means "send nothing": the provider's own
	 * default applies, which is the only safe choice for models that reject the
	 * parameter.
	 */
	reasoningEffort?: ReasoningEffort;
}

/**
 * Configuration for an embedding model.
 * Stored in data.json under provider.embedModels[modelId]
 *
 * NOTE: These values are used by our retrieval system, NOT passed to LangChain.
 * LangChain embedding models don't typically need configuration beyond the model name.
 */
export interface EmbedModelConfig {
	/**
	 * Similarity threshold for retrieval (0-1).
	 * Used by our retrieval system to filter results.
	 * A higher value means only more similar results are returned.
	 */
	similarityThreshold: number;
}
