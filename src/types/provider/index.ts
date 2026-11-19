/**
 * Provider Types - Barrel Export
 *
 * Re-exports all provider-related types from their respective modules.
 */

// Model configuration types
export type { ChatModelConfig, EmbedModelConfig } from "./models";

// Auth types
export type {
	AuthFieldDefinition,
	AuthObject,
	CodexSession,
	OAuthSession,
	OpenAIAuthMode,
	ProviderAuthConfig,
} from "./auth";

// Provider definition types
export type {
	DeviceCodePrompt,
	LogoProps,
	OAuthSignInHooks,
	ProviderSetupInstructions,
	AuthValidationResult,
	BaseProviderDefinition,
	EmbeddingProviderDefinition,
} from "./definition";

// Provider definition type guard
export { isEmbeddingProvider } from "./definition";

// Stored provider types
export type { ProviderInstanceMeta, ProviderTemplateId } from "./stored";
