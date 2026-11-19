/**
 * Stored Provider Types
 *
 * Types for provider data that gets persisted in settings.
 */

/**
 * Code-defined provider template identifiers.
 */
export type ProviderTemplateId =
	| "openai"
	| "openai-compatible"
	| "openai-codex"
	| "anthropic"
	| "ollama"
	| "omlx"
	| "openrouter"
	| "huggingface";

/**
 * Persisted metadata for a configured provider instance.
 */
export interface ProviderInstanceMeta {
	/** The code-defined template backing this provider instance. */
	templateId: ProviderTemplateId;

	/** User-visible display name for the configured instance. */
	displayName: string;
}
