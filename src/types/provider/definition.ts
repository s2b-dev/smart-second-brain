/**
 * Provider Definition Types
 *
 * Types for defining providers (built-in and custom).
 */

import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Component } from "svelte";
import type { AuthObject, ProviderAuthConfig } from "./auth.ts";
import type { ChatModelConfig } from "./models.ts";

/**
 * Props for provider logo components.
 */
export interface LogoProps {
	width?: number;
	height?: number;
	class?: string;
}

/**
 * Setup instructions for configuring a provider.
 */
export interface ProviderSetupInstructions {
	/** Step-by-step instructions for setting up the provider. */
	steps: string[];

	/** Optional link to an external resource (e.g., API key page). */
	link?: {
		url: string;
		text: string;
	};
}

/**
 * Result of validating provider authentication credentials.
 */
export type AuthValidationResult = { valid: true } | { valid: false; error: string };

/**
 * Result of a completed OAuth sign-in flow, describing how the modal must persist it.
 *  - `apiKey`: store the returned key in the provider's `apiKey` auth field (e.g. OpenRouter).
 *  - `session`: the flow already persisted its own session store (e.g. Codex) — nothing to store.
 */
type OAuthSignInResult = { kind: "apiKey"; apiKey: string } | { kind: "session" };

/**
 * Declares that a provider supports a browser-based OAuth sign-in flow, so the setup
 * modal can render a uniform sign-in UI without hard-coding per-provider branches.
 */
interface ProviderOAuthCapability {
	/** Label for the sign-in tab + CTA button, e.g. "ChatGPT", "OpenRouter". */
	label: string;

	/** Lucide icon id for the sign-in tab (optional; the modal defaults to "log-in"). */
	icon?: string;

	/** Copy shown under the sign-in CTA. */
	description?: string;

	/** Runs the browser OAuth flow and returns how the result must be persisted. */
	signIn: () => Promise<OAuthSignInResult>;

	/**
	 * Aborts an in-progress signIn(): rejects its promise and tears down any callback
	 * server so the user can retry immediately (e.g. after closing the browser tab). The
	 * rejected signIn() error is a cancellation marker the modal treats as "not an error".
	 * Omit for flows that can't be cancelled.
	 */
	cancelSignIn?: () => void;

	/**
	 * True when a session-backed flow is currently signed in (drives Reconnect/Disconnect
	 * and the connection status). API-key-backed flows omit this — their status comes from
	 * the auth-validation query instead.
	 */
	isSignedIn?: () => boolean;

	/** Session-backed disconnect (omit for API-key flows). */
	disconnect?: () => void;

	/**
	 * Whether the provider ALSO supports a manual API-key path. When true the modal shows
	 * the `[ Sign in ] | [ API key ]` switcher; when false it shows the sign-in CTA only
	 * (OAuth-only providers such as Codex).
	 */
	supportsApiKey: boolean;

	/**
	 * Whether this OAuth flow works on Obsidian mobile. Loopback-server flows (Codex) are
	 * desktop-only; flows that catch the redirect via an `obsidian://` protocol handler
	 * (OpenRouter, Hugging Face on mobile) work everywhere. The setup modal gates the sign-in CTA on
	 * `Platform.isDesktopApp || worksOnMobile`. Defaults to false (desktop-only) when omitted.
	 */
	worksOnMobile?: boolean;

	/**
	 * Manual code-paste fallback for `obsidian://` flows: if the deep-link redirect doesn't
	 * fire (e.g. a device that doesn't route it back to Obsidian), the user can copy the
	 * authorization code shown in the browser and submit it here to complete the same pending
	 * sign-in. Resolves the in-progress signIn() promise. Omit for flows without a paste path.
	 */
	submitManualCode?: (code: string) => void;
}

/**
 * Base interface for all provider definitions.
 */
export interface BaseProviderDefinition {
	/** Unique identifier for this provider. */
	id: string;

	/** Human-readable name for the provider. */
	displayName: string;

	/** Optional logo component for displaying the provider's icon. */
	logo?: Component<LogoProps>;

	/** Instructions for setting up this provider. */
	setupInstructions: ProviderSetupInstructions;

	/** Optional browser-based OAuth sign-in capability (rendered by the setup modal). */
	oauth?: ProviderOAuthCapability;

	/** Authentication field definitions for this provider. At least one field must be required. */
	auth: ProviderAuthConfig;

	/** Creates a LangChain chat instance (e.g., ChatOpenAI, ChatAnthropic, ChatOllama). */
	createChatInstance: (auth: AuthObject, modelId: string, options?: Partial<ChatModelConfig>) => BaseChatModel;

	/**
	 * Creates a chat instance for use as a subagent model (optional). Subagents are
	 * invoked non-streaming via the deepagents `task` tool, which the OpenAI-compatible
	 * LiteLLM endpoints only handle correctly over the buffered `requestUrl` transport
	 * with streaming disabled. Providers that need that override this; the registry
	 * falls back to {@link createChatInstance} when it is absent.
	 */
	createSubAgentChatInstance?: (
		auth: AuthObject,
		modelId: string,
		options?: Partial<ChatModelConfig>,
	) => BaseChatModel;

	/** Validates authentication credentials for this provider. */
	validateAuth: (auth: AuthObject) => Promise<AuthValidationResult>;

	/** Discovers available models from the provider's API. */
	discoverModels: (auth: AuthObject) => Promise<string[]>;

	/** Creates a LangChain embedding instance (optional - use EmbeddingProviderDefinition for type safety). */
	createEmbeddingInstance?: (auth: AuthObject, modelId: string) => EmbeddingsInterface;
}

/**
 * Interface for providers that support embedding models.
 * Extends BaseProviderDefinition with required createEmbeddingInstance method.
 */
export interface EmbeddingProviderDefinition extends BaseProviderDefinition {
	/** Creates a LangChain embedding instance. */
	createEmbeddingInstance: (auth: AuthObject, modelId: string) => EmbeddingsInterface;

	/** Discovers available embedding models (optional - falls back to heuristic filtering if not provided). */
	discoverEmbeddingModels?: (auth: AuthObject) => Promise<string[]>;
}

/**
 * Type guard to check if a provider supports embeddings.
 */
export function isEmbeddingProvider(provider: BaseProviderDefinition): provider is EmbeddingProviderDefinition {
	return typeof provider.createEmbeddingInstance === "function";
}
