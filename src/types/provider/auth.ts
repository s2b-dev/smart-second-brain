/**
 * Auth Field Types
 *
 * Types for defining authentication fields and methods.
 */

/**
 * Standard authentication field keys that ALL field-based providers must define.
 * Each provider decides whether each field is `required: true` or `required: false`.
 *
 * - apiKey: API key or token for authentication
 * - baseUrl: Base URL for the API endpoint
 * - headers: Custom headers for API requests
 */
type AuthObjectKey = "apiKey" | "baseUrl" | "headers";

export type OpenAIAuthMode = "apiKey" | "codex";

/**
 * Definition for a single authentication field in a provider's auth config.
 * Used to dynamically render auth forms in the settings UI.
 *
 * Visibility is determined by `required`:
 * - Required fields (`required: true`) are always visible
 * - Optional fields (`required: false`) are shown in "Advanced Options"
 */
export interface AuthFieldDefinition {
	/**
	 * Display label for the field.
	 * Shown to users in the settings UI.
	 */
	label: string;

	/**
	 * Description of what this field is for.
	 * Shown as helper text in the settings UI.
	 */
	description: string;

	/**
	 * Input type for the field.
	 * - 'text': Regular text input
	 * - 'secret': Password-style input (hidden characters)
	 * - 'textarea': Multi-line text input (for headers, etc.)
	 * - 'select': Dropdown over a fixed set of `options` (e.g. a region that maps to a base URL)
	 */
	kind: "text" | "secret" | "textarea" | "select";

	/**
	 * Whether the field must be filled for the provider to work.
	 * Required fields are always visible; optional fields are hidden behind "Advanced".
	 */
	required: boolean;

	/**
	 * Placeholder text shown when the field is empty.
	 */
	placeholder?: string;

	/**
	 * Choices for a `select` field. The stored value is the option's `value`; an
	 * empty-string value stands for "unset", so the provider's default applies.
	 */
	options?: AuthFieldOption[];
}

/** One choice of a `select` auth field. */
export interface AuthFieldOption {
	value: string;
	label: string;
}

/**
 * Runtime authentication object passed to provider methods.
 * Contains the resolved values for authentication fields.
 */
export interface AuthObject {
	authMode?: OpenAIAuthMode;
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	codexSession?: CodexSession;
}

/** A signed-in OAuth session: a short-lived access token and the means to renew it. */
export interface OAuthSession {
	accessToken: string;
	refreshToken?: string;
	/** Epoch ms after which the access token is no longer accepted. */
	expiresAt: number;
}

export interface CodexSession extends OAuthSession {
	accountId?: string;
}

/**
 * Auth field definition with required: true
 */
type RequiredAuthField = AuthFieldDefinition & { required: true };

/**
 * Provider auth configuration that requires at least one field to be required.
 * Creates a union where each variant has one key with required: true.
 */
export type ProviderAuthConfig = {
	[K in AuthObjectKey]: Partial<Record<AuthObjectKey, AuthFieldDefinition>> & {
		[P in K]: RequiredAuthField;
	};
}[AuthObjectKey];
