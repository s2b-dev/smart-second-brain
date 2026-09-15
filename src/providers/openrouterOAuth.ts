import { Platform, requestUrl } from "obsidian";
import { Logger } from "../utils/logging";
import { escapeHtml } from "../utils/html";
import {
	arrayBufferToBase64Url,
	type NodeHttpIncomingMessage as IncomingMessage,
	type NodeHttpServer as Server,
	type NodeHttpServerResponse as ServerResponse,
	requireNodeHttp,
} from "./oauthNode";

const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
const OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const CALLBACK_HOST = "localhost";
const CALLBACK_PORT = 3000;
const CALLBACK_PATH = "/";
const HEALTHCHECK_PATH = "/health";
const OAUTH_TIMEOUT_MS = 5 * 60_000;

interface PendingOpenRouterAuth {
	/** Desktop only: the localhost callback server catching the redirect. */
	server: Server | null;
	codeVerifier: string;
	resolve: (apiKey: string) => void;
	reject: (error: Error) => void;
	timeoutId: number;
	redirectUri: string;
	/** Guards against a double-resolve (server callback vs. manual paste racing). */
	settled: boolean;
}

interface OpenRouterKeyResponse {
	key?: string;
	error?: { message?: string };
	message?: string;
}

let pendingOpenRouterAuth: PendingOpenRouterAuth | null = null;

/** Thrown when the user explicitly cancels an in-progress sign-in (vs. a real failure). */
export class OpenRouterSignInCancelledError extends Error {
	constructor() {
		super("OpenRouter sign-in cancelled");
		this.name = "OpenRouterSignInCancelledError";
	}
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head><title>Smart2Brain - OpenRouter Connected</title></head>
  <body style="font-family:system-ui,-apple-system,sans-serif;background:#131010;color:#f1ecec;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
    <div style="text-align:center;padding:2rem;">
      <h1 style="margin-bottom:1rem;">OpenRouter Connected</h1>
      <p>You can close this window and return to Obsidian.</p>
    </div>
    <script>window.setTimeout(() => window.close(), 1500)</script>
  </body>
</html>`;

function htmlError(error: string): string {
	return `<!doctype html>
<html>
  <head><title>Smart2Brain - OpenRouter Authentication Failed</title></head>
  <body style="font-family:system-ui,-apple-system,sans-serif;background:#131010;color:#f1ecec;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
    <div style="text-align:center;padding:2rem;">
      <h1 style="color:#fc533a;margin-bottom:1rem;">Authentication Failed</h1>
      <p>${escapeHtml(error)}</p>
    </div>
  </body>
</html>`;
}

function oauthSuccessPage(res: ServerResponse): void {
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(HTML_SUCCESS);
}

function oauthErrorPage(res: ServerResponse, error: string): void {
	res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
	res.end(htmlError(error));
}

function cleanupPendingOpenRouterAuth() {
	if (!pendingOpenRouterAuth) return;
	window.clearTimeout(pendingOpenRouterAuth.timeoutId);
	pendingOpenRouterAuth.server?.close();
	pendingOpenRouterAuth = null;
}

function getRedirectUri(): string {
	return `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
}

function getHealthcheckUri(): string {
	return `http://${CALLBACK_HOST}:${CALLBACK_PORT}${HEALTHCHECK_PATH}`;
}

function generateRandomString(length: number): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return Array.from(bytes)
		.map((b) => chars[b % chars.length])
		.join("");
}

async function createCodeChallenge(codeVerifier: string): Promise<string> {
	const data = new TextEncoder().encode(codeVerifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return arrayBufferToBase64Url(hash);
}

/**
 * Build the authorize URL. On desktop we pass a localhost `callback_url` so the
 * browser redirect is caught by our loopback server. On mobile we OMIT
 * `callback_url` entirely — OpenRouter's headless mode then shows the
 * authorization code on-screen for the user to paste back (there is no localhost
 * server on mobile, and OpenRouter rejects custom URL schemes like obsidian://).
 */
function buildAuthorizeUrl(codeChallenge: string, redirectUri: string | null): string {
	const params = new URLSearchParams({
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
	});
	if (redirectUri) {
		params.set("callback_url", redirectUri);
	}
	return `${OPENROUTER_AUTH_URL}?${params.toString()}`;
}

async function verifyCallbackServer(): Promise<void> {
	const response = await requestUrl({
		url: getHealthcheckUri(),
		method: "GET",
	});
	if (response.status !== 200 || response.text !== "ok") {
		throw new Error("OpenRouter callback server healthcheck failed");
	}
}

async function exchangeCodeForApiKey(code: string, codeVerifier: string): Promise<string> {
	const response = await requestUrl({
		url: OPENROUTER_EXCHANGE_URL,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			code,
			code_verifier: codeVerifier,
			code_challenge_method: "S256",
		}),
		throw: false,
	});

	const payload = response.json as OpenRouterKeyResponse;
	Logger.info("OpenRouter key exchange response received", {
		status: response.status,
		hasKey: Boolean(payload?.key),
		payloadKeys: payload ? Object.keys(payload) : [],
	});
	if (response.status < 200 || response.status >= 300 || !payload?.key) {
		const message = payload?.error?.message ?? payload?.message ?? `Key exchange failed (${response.status})`;
		throw new Error(message);
	}

	Logger.info("OpenRouter API key received", {
		length: payload.key.length,
		prefix: payload.key.slice(0, 8),
	});
	return payload.key;
}

/**
 * Complete a pending sign-in from a raw authorization code (from either the
 * localhost callback or a manual paste). Exchanges the code for an API key and
 * resolves the pending promise. No-op if nothing is pending or already settled.
 */
async function completeWithCode(code: string): Promise<void> {
	const pending = pendingOpenRouterAuth;
	if (!pending || pending.settled) return;
	pending.settled = true;
	try {
		const apiKey = await exchangeCodeForApiKey(code, pending.codeVerifier);
		pending.resolve(apiKey);
	} catch (error) {
		pending.reject(error instanceof Error ? error : new Error(String(error)));
	} finally {
		cleanupPendingOpenRouterAuth();
	}
}

/**
 * Manual code-paste fallback (used by the mobile headless flow, and available as
 * a fallback on desktop if the browser doesn't return): the user copies the
 * authorization code shown by OpenRouter and submits it here.
 */
export function submitOpenRouterAuthCode(code: string): void {
	const trimmed = code.trim();
	if (!trimmed) return;
	void completeWithCode(trimmed);
}

async function handleOpenRouterCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const pending = pendingOpenRouterAuth;
	if (!pending) {
		oauthErrorPage(res, "No active OpenRouter sign-in session");
		return;
	}

	try {
		const url = new URL(req.url ?? "/", pending.redirectUri);
		Logger.debug("OpenRouter callback request received", {
			pathname: url.pathname,
			search: url.search,
		});

		if (url.pathname === HEALTHCHECK_PATH) {
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("ok");
			return;
		}

		if (url.pathname !== CALLBACK_PATH) {
			oauthErrorPage(res, "Unexpected callback path");
			return;
		}

		const callbackError = url.searchParams.get("error");
		if (callbackError) {
			oauthErrorPage(res, callbackError);
			if (!pending.settled) {
				pending.settled = true;
				pending.reject(new Error(callbackError));
				cleanupPendingOpenRouterAuth();
			}
			return;
		}

		const code = url.searchParams.get("code");
		if (!code) {
			oauthErrorPage(res, "Missing authorization code");
			if (!pending.settled) {
				pending.settled = true;
				pending.reject(new Error("Missing authorization code"));
				cleanupPendingOpenRouterAuth();
			}
			return;
		}

		if (pending.settled) return;
		pending.settled = true;
		try {
			const apiKey = await exchangeCodeForApiKey(code, pending.codeVerifier);
			oauthSuccessPage(res);
			pending.resolve(apiKey);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			oauthErrorPage(res, message);
			pending.reject(error instanceof Error ? error : new Error(message));
		} finally {
			cleanupPendingOpenRouterAuth();
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		oauthErrorPage(res, message);
		if (!pending.settled) {
			pending.settled = true;
			pending.reject(error instanceof Error ? error : new Error(message));
			cleanupPendingOpenRouterAuth();
		}
	}
}

async function startOpenRouterAuthServer(): Promise<Server> {
	return await new Promise<Server>((resolve, reject) => {
		let settled = false;
		const createServer = requireNodeHttp();
		const server = createServer((req, res) => {
			void handleOpenRouterCallback(req, res);
		});

		const finalizeReject = (error: Error) => {
			if (settled) return;
			settled = true;
			server.close();
			reject(error);
		};

		server.once("error", (error) => {
			Logger.error("Failed to start OpenRouter callback server", error);
			finalizeReject(
				new Error(`Failed to start OpenRouter callback server on localhost:${CALLBACK_PORT}: ${error.message}`),
			);
		});

		server.listen(CALLBACK_PORT, () => {
			if (settled) return;
			settled = true;
			resolve(server);
		});
	});
}

async function openBrowser(url: string): Promise<void> {
	const opened = window.open(url, "_blank", "noopener,noreferrer");
	if (!opened) {
		Logger.warn("window.open returned a falsy value while launching OpenRouter sign-in");
	}
}

/**
 * Launch the authorize URL on mobile. Obsidian's iOS WKWebView has no `window.open`
 * support at all — its `WKUIDelegate` never implements window creation, so
 * `window.open(...)` unconditionally returns `null` regardless of args or gesture
 * timing (confirmed on-device). A full top-level navigation via `location.href`,
 * on the other hand, is intercepted by WKWebView's navigation-policy handler for
 * external `https:` URLs and handed off to Safari — this is also the pattern used
 * by known-working Obsidian OAuth plugins (e.g. trakt-for-obsidian). The user
 * returns via the `obsidian://` deep link or by switching apps back manually.
 */
function navigateToAuthorizeUrl(url: string): void {
	window.location.href = url;
}

/**
 * Start the OpenRouter OAuth sign-in.
 *
 * Desktop: spins up a localhost callback server, opens the browser to the
 * authorize URL (with a localhost `callback_url`), and resolves when the browser
 * redirect delivers the code.
 *
 * Mobile: no localhost server (and OpenRouter rejects custom URL schemes), so we
 * use OpenRouter's headless mode — omit `callback_url`, OpenRouter shows the code
 * on-screen, and the user pastes it via `submitOpenRouterAuthCode` (surfaced by
 * the setup UI). The returned promise resolves once the pasted code is exchanged.
 */
export async function signInWithOpenRouter(): Promise<string> {
	if (pendingOpenRouterAuth) {
		throw new Error("An OpenRouter sign-in flow is already in progress");
	}

	const isDesktop = Platform.isDesktopApp;
	const codeVerifier = generateRandomString(64);
	const codeChallenge = await createCodeChallenge(codeVerifier);
	const redirectUri = isDesktop ? getRedirectUri() : null;
	const authorizeUrl = buildAuthorizeUrl(codeChallenge, redirectUri);

	let server: Server | null = null;
	if (isDesktop) {
		server = await startOpenRouterAuthServer();
	}

	return new Promise<string>((resolve, reject) => {
		pendingOpenRouterAuth = {
			server,
			codeVerifier,
			resolve,
			reject,
			redirectUri: redirectUri ?? "",
			settled: false,
			timeoutId: window.setTimeout(() => {
				if (!pendingOpenRouterAuth || pendingOpenRouterAuth.settled) return;
				pendingOpenRouterAuth.settled = true;
				pendingOpenRouterAuth.reject(new Error("Timed out waiting for OpenRouter sign-in"));
				cleanupPendingOpenRouterAuth();
			}, OAUTH_TIMEOUT_MS),
		};

		void (async () => {
			try {
				if (isDesktop) {
					Logger.info("OpenRouter callback server listening", {
						redirectUri,
						healthcheckUri: getHealthcheckUri(),
					});
					await verifyCallbackServer();
					Logger.info("OpenRouter callback server healthcheck passed");
					await openBrowser(authorizeUrl);
				} else {
					Logger.info("OpenRouter headless sign-in started (mobile) — awaiting pasted code");
					navigateToAuthorizeUrl(authorizeUrl);
				}
			} catch (error) {
				if (!pendingOpenRouterAuth || pendingOpenRouterAuth.settled) return;
				pendingOpenRouterAuth.settled = true;
				reject(error instanceof Error ? error : new Error(String(error)));
				cleanupPendingOpenRouterAuth();
			}
		})();
	});
}

/**
 * Aborts an in-progress OpenRouter sign-in: rejects the pending promise with a
 * cancellation marker and tears down the callback server (freeing the port), so
 * the user can retry immediately instead of waiting out the timeout. No-op if
 * none pending.
 */
export function cancelOpenRouterSignIn(): void {
	const pending = pendingOpenRouterAuth;
	if (!pending || pending.settled) return;
	pending.settled = true;
	pending.reject(new OpenRouterSignInCancelledError());
	cleanupPendingOpenRouterAuth();
}
