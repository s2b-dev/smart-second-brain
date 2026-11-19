import type { CodexSession, OAuthSession } from "../types/provider";
import { getPlugin } from "./state.svelte";

type SessionListener = () => void;

/**
 * One OAuth session persisted in the app's local storage (device-local, never synced with
 * the vault) and mirrored into a rune so the setup modal re-renders on sign-in/sign-out.
 *
 * Listeners are installed by `main.ts`, which invalidates the affected providers'
 * auth/state queries: doing it here would pull `dataStore` and `lib/query` into this
 * module and close an import cycle back through the provider definitions.
 */
class StoredOAuthSession<T extends OAuthSession> {
	// The session itself is a plain field, read lazily from storage on first access. Only
	// this counter is reactive: readers track it, save()/clear() bump it. Keeping the lazy
	// load out of `$state` matters because the first read can happen inside a `$derived`
	// (the setup modal's `isSignedIn`), where writing a rune throws state_unsafe_mutation.
	#version = $state(0);
	#session: T | null = null;
	#loaded = false;
	readonly #listeners = new Set<SessionListener>();

	constructor(
		private readonly storageKey: string,
		private readonly parse: (raw: Record<string, unknown>) => T | null,
	) {}

	get(): T | null {
		void this.#version;
		if (!this.#loaded) {
			this.#session = this.#read();
			this.#loaded = true;
		}
		return this.#session;
	}

	save(session: T): void {
		getPlugin().app.saveLocalStorage(this.storageKey, session);
		this.#set(session);
	}

	clear(): void {
		getPlugin().app.saveLocalStorage(this.storageKey, null);
		this.#set(null);
	}

	#set(session: T | null): void {
		this.#session = session;
		this.#loaded = true;
		this.#version++;
		this.#notify();
	}

	onChange(listener: SessionListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}

	#read(): T | null {
		const raw = getPlugin().app.loadLocalStorage(this.storageKey);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			return null;
		}
		return this.parse(raw as Record<string, unknown>);
	}
}

/** Validates the fields every OAuth session shares; null when the stored value is malformed. */
function parseOAuthSession(raw: Record<string, unknown>): OAuthSession | null {
	const { accessToken, refreshToken, expiresAt } = raw;
	if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
		return null;
	}
	if (refreshToken !== undefined && typeof refreshToken !== "string") {
		return null;
	}
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
		return null;
	}
	return { accessToken, refreshToken, expiresAt };
}

const codex = new StoredOAuthSession<CodexSession>("openai-codex-session", (raw) => {
	const base = parseOAuthSession(raw);
	if (!base) return null;
	if (raw.accountId !== undefined && typeof raw.accountId !== "string") {
		return null;
	}
	return { ...base, accountId: raw.accountId };
});

const huggingFace = new StoredOAuthSession<OAuthSession>("huggingface-session", parseOAuthSession);

// =============================================================================
// OpenAI Codex (ChatGPT sign-in)
// =============================================================================

export function onCodexSessionChange(listener: SessionListener): () => void {
	return codex.onChange(listener);
}

export function getCodexSession(): CodexSession | null {
	return codex.get();
}

export function saveCodexSession(session: CodexSession): void {
	codex.save(session);
}

export function clearCodexSession(): void {
	codex.clear();
}

// =============================================================================
// Hugging Face (device-code sign-in)
// =============================================================================

export function onHuggingFaceSessionChange(listener: SessionListener): () => void {
	return huggingFace.onChange(listener);
}

export function getHuggingFaceSession(): OAuthSession | null {
	return huggingFace.get();
}

export function saveHuggingFaceSession(session: OAuthSession): void {
	huggingFace.save(session);
}

export function clearHuggingFaceSession(): void {
	huggingFace.clear();
}
