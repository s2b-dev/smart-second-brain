interface ModelIdentity {
	provider: string;
	variantKey: string;
	displayName: string;
	paramSize?: string;
	quantization?: string;
}

/**
 * What the model's provider reports about a chat model. Every optional fact is `undefined`
 * when the provider doesn't report it: the plugin never fills a gap from a third-party
 * catalogue, so "unknown" stays visible as unknown.
 */
export interface HydratedChatModelMetadata extends ModelIdentity {
	kind: "chat";
	/** Context window in tokens, when the provider reports one. */
	contextWindow?: number;
	temperature?: number;
	capabilities: {
		toolCalls?: boolean;
		vision?: boolean;
		reasoning?: boolean;
		structuredOutput?: boolean;
		/** Reasoning-effort levels the model accepts (Anthropic, Codex), when reported. */
		effortLevels?: readonly string[];
	};
	pricing?: {
		inputUsdPer1M?: number;
		outputUsdPer1M?: number;
	};
}

export interface HydratedEmbeddingModelMetadata extends ModelIdentity {
	kind: "embedding";
	maxInputTokens: number;
	dimensions?: number;
	similarityThresholdDefault: number;
	pricing?: {
		inputUsdPer1M?: number;
	};
}
