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
	| "lmstudio"
	| "openrouter"
	| "huggingface"
	| "google"
	| "mistral";

/**
 * Templates whose models run on the user's own machine. They are trusted with private notes by
 * default, and their first token may wait on weights loading into memory.
 */
export function isLocalProviderTemplate(templateId: ProviderTemplateId | undefined): boolean {
	return templateId === "ollama" || templateId === "omlx" || templateId === "lmstudio";
}

/**
 * Persisted metadata for a configured provider instance.
 */
export interface ProviderInstanceMeta {
	/** The code-defined template backing this provider instance. */
	templateId: ProviderTemplateId;

	/** User-visible display name for the configured instance. */
	displayName: string;
}
