/**
 * "Sign in with Hugging Face": OAuth authorization code + PKCE with a public client.
 *
 * The user clicks Sign in, approves in the browser, and lands back in Obsidian connected.
 * How the redirect gets back differs per platform:
 *
 *  - Desktop: a loopback server on `http://127.0.0.1:<free port>/callback`. Hugging Face
 *    accepts any port for a registered port-less loopback URI (RFC 8252 §7.3), so the OS
 *    picks a free one and no fixed port can collide. Loopback is used instead of the
 *    `obsidian://` link because a deep link goes to whichever vault window the OS picks,
 *    which with several vaults open need not be the one that started the sign-in.
 *  - Mobile: `obsidian://s2b-huggingface-auth`, caught by the protocol handler `main.ts`
 *    registers. There is no `node:http` on mobile, and only one vault is open at a time.
 *    iOS may evict Obsidian while the user is in Safari, so the pending sign-in (PKCE
 *    verifier, state) is persisted and the redirect completes it even after a restart.
 *
 * Both redirect URIs must be registered on the Hugging Face OAuth app. The token carries
 * only the `inference-api` scope: it can call Inference Providers on the user's behalf
 * (billed to their account and its free monthly credits) and nothing else. Access tokens
 * are short-lived; the refresh token renews them.
 *
 * OAuth requests go through Obsidian's `requestUrl`: huggingface.co's OAuth endpoints
 * send no CORS headers, so a renderer `fetch` would be blocked.
 */

import { Platform, requestUrl } from "obsidian";
import { escapeHtml } from "../utils/html";
import { Logger } from "../utils/logging";
import { getPlugin } from "../stores/state.svelte";
import type { OAuthSession } from "../types/provider";
import {
	clearHuggingFaceSession,
	getHuggingFaceSession,
	saveHuggingFaceSession,
} from "../stores/providerRuntime.svelte";
import {
	arrayBufferToBase64Url,
	type NodeHttpIncomingMessage as IncomingMessage,
	type NodeHttpServer as Server,
	type NodeHttpServerResponse as ServerResponse,
	requireNodeHttp,
	uint8ToBase64Url,
} from "./oauthNode";

/**
 * Public OAuth app (no client secret) registered on huggingface.co for Smart Second
 * Brain, with the `inference-api` scope and both redirect URIs below. A public client ID
 * is not a secret.
 */
export const HUGGING_FACE_CLIENT_ID = "2fbac6e6-993c-4827-9951-2214a3430470";

/** The `obsidian://` action the mobile redirect lands on (registered in `main.ts`). */
export const HUGGING_FACE_PROTOCOL_ACTION = "s2b-huggingface-auth";

const HF_ORIGIN = "https://huggingface.co";
const AUTHORIZE_ENDPOINT = `${HF_ORIGIN}/oauth/authorize`;
const TOKEN_ENDPOINT = `${HF_ORIGIN}/oauth/token`;
const SCOPE = "inference-api";
const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_PATH = "/callback";
const MOBILE_REDIRECT_URI = `obsidian://${HUGGING_FACE_PROTOCOL_ACTION}`;
/** How long a started sign-in waits for the browser before giving up. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** Renew this long before expiry so a request never leaves with a token about to lapse. */
const REFRESH_BUFFER_MS = 5 * 60_000;
/** Fallback lifetime when the token response omits `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_S = 3600;
/** App-local-storage key of the persisted pending sign-in (mobile restart survival). */
const PENDING_STORAGE_KEY = "huggingface-oauth-pending";

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

/** The parts of a started sign-in needed to finish it; persisted so mobile survives a restart. */
interface PendingGrant {
	state: string;
	codeVerifier: string;
	redirectUri: string;
	clientId: string;
	/** Epoch ms after which a redirect for this grant is refused. */
	expiresAt: number;
}

/** The in-memory side of a sign-in: the promise the setup modal is awaiting. */
interface PendingSignIn {
	grant: PendingGrant;
	resolve: () => void;
	reject: (error: Error) => void;
	server: Server | null;
	timeoutId: number;
}

/** Thrown when the user explicitly cancels an in-progress sign-in (vs. a real failure). */
export class HuggingFaceSignInCancelledError extends Error {
	constructor() {
		super("Hugging Face sign-in cancelled");
		this.name = "HuggingFaceSignInCancelledError";
	}
}

let pendingSignIn: PendingSignIn | null = null;
let pendingRefresh: Promise<OAuthSession | null> | null = null;

// =============================================================================
// Helpers
// =============================================================================

function randomUrlSafe(byteLength: number): string {
	return uint8ToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function codeChallengeFor(verifier: string): Promise<string> {
	return arrayBufferToBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

async function postToken(fields: Record<string, string>) {
	return requestUrl({
		url: TOKEN_ENDPOINT,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams(fields).toString(),
		throw: false,
	});
}

function readTokens(response: { json: unknown }): TokenResponse | undefined {
	try {
		return response.json as TokenResponse;
	} catch {
		return undefined;
	}
}

function toSession(tokens: TokenResponse, previous?: OAuthSession): OAuthSession {
	if (!tokens.access_token) {
		throw new Error("Hugging Face returned no access token");
	}
	return {
		accessToken: tokens.access_token,
		// A refresh response may omit the refresh token, meaning "keep using the old one".
		refreshToken: tokens.refresh_token ?? previous?.refreshToken,
		expiresAt: Date.now() + (tokens.expires_in ?? DEFAULT_TOKEN_LIFETIME_S) * 1000,
	};
}

function buildAuthorizeUrl(grant: PendingGrant, codeChallenge: string): string {
	const params = new URLSearchParams({
		client_id: grant.clientId,
		redirect_uri: grant.redirectUri,
		response_type: "code",
		scope: SCOPE,
		state: grant.state,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
	});
	return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

function persistGrant(grant: PendingGrant | null): void {
	getPlugin().app.saveLocalStorage(PENDING_STORAGE_KEY, grant);
}

function loadPersistedGrant(): PendingGrant | null {
	const raw = getPlugin().app.loadLocalStorage(PENDING_STORAGE_KEY) as Partial<PendingGrant> | null;
	if (!raw || typeof raw !== "object") return null;
	const { state, codeVerifier, redirectUri, clientId, expiresAt } = raw;
	if (
		typeof state !== "string" ||
		typeof codeVerifier !== "string" ||
		typeof redirectUri !== "string" ||
		typeof clientId !== "string" ||
		typeof expiresAt !== "number"
	) {
		return null;
	}
	return { state, codeVerifier, redirectUri, clientId, expiresAt };
}

/**
 * Takes ownership of the sign-in in flight: clears it (memory and storage), stops its
 * timer and loopback server, and returns it so the caller can settle its promise. Taking
 * it before any await means a second delivery of the same redirect finds nothing pending.
 */
function takePendingSignIn(): PendingSignIn | null {
	const taken = pendingSignIn;
	pendingSignIn = null;
	persistGrant(null);
	if (taken) {
		window.clearTimeout(taken.timeoutId);
		taken.server?.close();
	}
	return taken;
}

function fail(error: Error): void {
	takePendingSignIn()?.reject(error);
}

// =============================================================================
// Completing a sign-in (shared by the loopback server and the obsidian:// handler)
// =============================================================================

async function exchangeCode(grant: PendingGrant, code: string): Promise<OAuthSession> {
	const response = await postToken({
		grant_type: "authorization_code",
		code,
		redirect_uri: grant.redirectUri,
		client_id: grant.clientId,
		code_verifier: grant.codeVerifier,
	});
	const tokens = readTokens(response);
	if (response.status !== 200 || !tokens?.access_token) {
		throw new Error(
			tokens?.error_description ?? tokens?.error ?? `Hugging Face sign-in failed (${response.status})`,
		);
	}
	return toSession(tokens);
}

/**
 * Finishes the pending sign-in from the redirect's query parameters. Resolves with an
 * error message for the user, or null on success. A redirect whose `state` doesn't match
 * the pending grant is refused and leaves the pending sign-in alone: it is stale or
 * forged, and must be able neither to complete nor to cancel the real one.
 */
async function completeFromRedirect(query: URLSearchParams): Promise<string | null> {
	const grant = pendingSignIn?.grant ?? loadPersistedGrant();
	if (!grant || query.get("state") !== grant.state) {
		return "This sign-in link is no longer valid. Start the sign-in again from Obsidian.";
	}
	const signIn = takePendingSignIn();
	const settle = (failure: string | null): string | null => {
		if (failure) signIn?.reject(new Error(failure));
		else signIn?.resolve();
		return failure;
	};

	if (Date.now() > grant.expiresAt) {
		return settle("The sign-in timed out. Try again.");
	}
	const error = query.get("error");
	if (error) {
		return settle(error === "access_denied" ? "Sign-in was cancelled on Hugging Face." : error);
	}
	const code = query.get("code");
	if (!code) {
		return settle("Hugging Face returned no authorization code.");
	}
	try {
		saveHuggingFaceSession(await exchangeCode(grant, code));
		return settle(null);
	} catch (exchangeError) {
		return settle(exchangeError instanceof Error ? exchangeError.message : String(exchangeError));
	}
}

/**
 * The `obsidian://s2b-huggingface-auth` protocol handler (mobile redirect). Works whether
 * or not this session started the sign-in: after an iOS restart only the persisted grant
 * is left, and completing it still saves the session the provider reads.
 */
export async function handleHuggingFaceProtocolRedirect(params: Record<string, string>): Promise<void> {
	const failure = await completeFromRedirect(new URLSearchParams(params));
	if (failure) {
		Logger.warn("Hugging Face sign-in redirect failed:", failure);
	}
}

// =============================================================================
// Desktop loopback server
// =============================================================================

function respondWithPage(res: ServerResponse, failure: string | null): void {
	const title = failure ? "Sign-in failed" : "Connected to Hugging Face";
	const body = failure ? escapeHtml(failure) : "You can close this tab and return to Obsidian.";
	res.writeHead(failure ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(`<!doctype html>
<html>
  <head><title>Smart Second Brain - ${title}</title></head>
  <body style="font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
    <div style="text-align:center;padding:2rem;">
      <h1>${title}</h1>
      <p>${body}</p>
    </div>
  </body>
</html>`);
}

async function handleLoopbackRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
	if (url.pathname !== LOOPBACK_PATH) {
		res.writeHead(404);
		res.end();
		return;
	}
	respondWithPage(res, await completeFromRedirect(url.searchParams));
}

/** Starts the loopback server on a free port chosen by the OS; resolves with that port. */
function startLoopbackServer(): Promise<{ server: Server; port: number }> {
	return new Promise((resolve, reject) => {
		const server = requireNodeHttp()((req, res) => {
			void handleLoopbackRequest(req, res);
		});
		server.once("error", (error) => reject(new Error(`Couldn't start the sign-in listener: ${error.message}`)));
		server.listen(0, LOOPBACK_HOST, () => {
			const address = server.address();
			if (address && typeof address === "object") {
				resolve({ server, port: address.port });
			} else {
				server.close();
				reject(new Error("Couldn't start the sign-in listener"));
			}
		});
	});
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Opens Hugging Face's consent page and settles once the redirect comes back: resolves
 * after the session is saved, rejects on denial, timeout, failure, or cancel.
 */
export async function signInWithHuggingFace(clientId = HUGGING_FACE_CLIENT_ID): Promise<void> {
	if (!clientId) {
		throw new Error("Hugging Face sign-in is not configured in this build.");
	}
	cancelHuggingFaceSignIn();

	let server: Server | null = null;
	let redirectUri = MOBILE_REDIRECT_URI;
	if (Platform.isDesktopApp) {
		const loopback = await startLoopbackServer();
		server = loopback.server;
		redirectUri = `http://${LOOPBACK_HOST}:${loopback.port}${LOOPBACK_PATH}`;
	}

	const grant: PendingGrant = {
		state: randomUrlSafe(32),
		codeVerifier: randomUrlSafe(48),
		redirectUri,
		clientId,
		expiresAt: Date.now() + SIGN_IN_TIMEOUT_MS,
	};
	const authorizeUrl = buildAuthorizeUrl(grant, await codeChallengeFor(grant.codeVerifier));

	const done = new Promise<void>((resolve, reject) => {
		pendingSignIn = {
			grant,
			resolve,
			reject,
			server,
			timeoutId: window.setTimeout(
				() => fail(new Error("Timed out waiting for Hugging Face. Try again.")),
				SIGN_IN_TIMEOUT_MS,
			),
		};
	});
	persistGrant(grant);

	if (Platform.isDesktopApp) {
		window.open(authorizeUrl, "_blank", "noopener,noreferrer");
	} else {
		// iOS WKWebView never creates windows, so window.open returns null there; a
		// top-level navigation to an https URL is handed to Safari instead (see
		// navigateToAuthorizeUrl in openrouterOAuth.ts).
		window.location.href = authorizeUrl;
	}
	return done;
}

/** Aborts the sign-in in flight: its promise rejects with {@link HuggingFaceSignInCancelledError}. */
export function cancelHuggingFaceSignIn(): void {
	fail(new HuggingFaceSignInCancelledError());
}

export function clearHuggingFaceSignIn(): void {
	clearHuggingFaceSession();
}

// =============================================================================
// Token renewal
// =============================================================================

async function refreshSession(stored: OAuthSession & { refreshToken: string }): Promise<OAuthSession | null> {
	const response = await postToken({
		grant_type: "refresh_token",
		refresh_token: stored.refreshToken,
		client_id: HUGGING_FACE_CLIENT_ID,
	});
	const tokens = readTokens(response);
	if (response.status === 200 && tokens?.access_token) {
		const next = toSession(tokens, stored);
		saveHuggingFaceSession(next);
		return next;
	}
	// The grant itself was rejected (revoked in the user's HF settings, or expired): the
	// session is dead, so drop it and let the UI ask for a fresh sign-in. Anything else
	// (5xx, rate limit) is transient: keep the session and surface the error instead of
	// signing the user out because huggingface.co hiccuped.
	if (response.status === 400 || response.status === 401) {
		clearHuggingFaceSession();
		return null;
	}
	throw new Error(`Couldn't renew the Hugging Face sign-in (${response.status})`);
}

/**
 * The current session with an access token that is good for at least a few more minutes,
 * renewing it first when needed. Null when signed out or when the grant was revoked.
 * Concurrent callers share one refresh request.
 */
export async function getValidHuggingFaceSession(): Promise<OAuthSession | null> {
	const stored = getHuggingFaceSession();
	if (!stored) return null;
	if (stored.expiresAt - REFRESH_BUFFER_MS > Date.now()) return stored;

	const { refreshToken } = stored;
	if (!refreshToken) {
		clearHuggingFaceSession();
		return null;
	}
	pendingRefresh ??= refreshSession({ ...stored, refreshToken }).finally(() => {
		pendingRefresh = null;
	});
	return pendingRefresh;
}
