import { Platform, requestUrl } from "obsidian";
import { getPlugin } from "../stores/state.svelte";
import { clearCodexSession, getCodexSession, saveCodexSession } from "../stores/providerRuntime.svelte";
import type { CodexSession } from "../types/provider";
import { Logger } from "../utils/logging";
import { performAiFetch } from "../lib/aiTransport";
import { escapeHtml } from "../utils/html";
import {
	arrayBufferToBase64Url,
	base64UrlToString,
	type NodeHttpIncomingMessage as IncomingMessage,
	type NodeHttpServer as Server,
	type NodeHttpServerResponse as ServerResponse,
	requireNodeHttp,
} from "./oauthNode";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const HEALTHCHECK_PATH = "/health";
const CALLBACK_HOST = "localhost";
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const REFRESH_BUFFER_MS = 60_000;
const OAUTH_TIMEOUT_MS = 5 * 60_000;

interface PkceCodes {
	verifier: string;
	challenge: string;
}

interface TokenResponse {
	id_token?: string;
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
}

interface IdTokenClaims {
	chatgpt_account_id?: string;
	organizations?: Array<{ id: string }>;
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
	};
}

interface PendingOpenAICodexAuth {
	server: Server;
	expectedState: string;
	pkce: PkceCodes;
	redirectUri: string;
	resolve: (session: CodexSession) => void;
	reject: (error: Error) => void;
	timeoutId: number;
}

let pendingOpenAICodexAuth: PendingOpenAICodexAuth | null = null;
let pendingOpenAICodexRefresh: Promise<CodexSession | null> | null = null;

/** Thrown when the user explicitly cancels an in-progress sign-in (vs. a real failure). */
export class OpenAICodexSignInCancelledError extends Error {
	constructor() {
		super("ChatGPT sign-in cancelled");
		this.name = "OpenAICodexSignInCancelledError";
	}
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head><title>Smart2Brain - Authorization Successful</title></head>
  <body style="font-family:system-ui,-apple-system,sans-serif;background:#131010;color:#f1ecec;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
    <div style="text-align:center;padding:2rem;">
      <h1 style="margin-bottom:1rem;">Authorization Successful</h1>
      <p>You can close this window and return to Obsidian.</p>
    </div>
    <script>window.setTimeout(() => window.close(), 1500)</script>
  </body>
</html>`;

const htmlError = (error: string) => `<!doctype html>
<html>
  <head><title>Smart2Brain - Authorization Failed</title></head>
  <body style="font-family:system-ui,-apple-system,sans-serif;background:#131010;color:#f1ecec;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
    <div style="text-align:center;padding:2rem;">
      <h1 style="color:#fc533a;margin-bottom:1rem;">Authorization Failed</h1>
      <p>${escapeHtml(error)}</p>
    </div>
  </body>
</html>`;

const oauthSuccessPage = (res: ServerResponse): void => {
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(HTML_SUCCESS);
};

const oauthErrorPage = (res: ServerResponse, error: string): void => {
	res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
	res.end(htmlError(error));
};

function cleanupPendingOpenAICodexAuth() {
	if (!pendingOpenAICodexAuth) return;
	window.clearTimeout(pendingOpenAICodexAuth.timeoutId);
	pendingOpenAICodexAuth.server.close();
	pendingOpenAICodexAuth = null;
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

function base64UrlEncode(buffer: ArrayBuffer): string {
	return arrayBufferToBase64Url(buffer);
}

function generateState(): string {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

async function generatePkce(): Promise<PkceCodes> {
	const verifier = generateRandomString(43);
	const data = new TextEncoder().encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return { verifier, challenge: base64UrlEncode(hash) };
}

function parseJwtClaims(token: string): IdTokenClaims | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		return JSON.parse(base64UrlToString(parts[1])) as IdTokenClaims;
	} catch {
		return undefined;
	}
}

function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
	return (
		claims.chatgpt_account_id ||
		claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
		claims.organizations?.[0]?.id
	);
}

function extractAccountId(tokens: TokenResponse): string | undefined {
	if (tokens.id_token) {
		const claims = parseJwtClaims(tokens.id_token);
		if (claims) {
			const accountId = extractAccountIdFromClaims(claims);
			if (accountId) return accountId;
		}
	}
	if (tokens.access_token) {
		const claims = parseJwtClaims(tokens.access_token);
		if (claims) return extractAccountIdFromClaims(claims);
	}
	return undefined;
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: redirectUri,
		scope: "openid profile email offline_access",
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		originator: "opencode",
		state,
	});
	return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
	const response = await requestUrl({
		url: `${ISSUER}/oauth/token`,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: CLIENT_ID,
			code_verifier: pkce.verifier,
		}).toString(),
		throw: false,
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Token exchange failed (${response.status})`);
	}
	return response.json as TokenResponse;
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
	const response = await requestUrl({
		url: `${ISSUER}/oauth/token`,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}).toString(),
		throw: false,
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Token refresh failed (${response.status})`);
	}
	return response.json as TokenResponse;
}

function buildCodexSession(tokens: TokenResponse): CodexSession {
	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
		accountId: extractAccountId(tokens),
	};
}

function getStoredOpenAICodexSession(): CodexSession | null {
	return getCodexSession();
}

function saveOpenAICodexSession(session: CodexSession): void {
	saveCodexSession(session);
}

export function clearOpenAICodexSession(): void {
	clearCodexSession();
}

async function refreshStoredOpenAICodexSession(stored: CodexSession): Promise<CodexSession | null> {
	if (!stored.refreshToken) {
		clearOpenAICodexSession();
		return null;
	}

	try {
		const refreshed = await refreshAccessToken(stored.refreshToken);
		const nextSession: CodexSession = {
			accessToken: refreshed.access_token,
			refreshToken: refreshed.refresh_token ?? stored.refreshToken,
			expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
			accountId: extractAccountId(refreshed) ?? stored.accountId,
		};
		saveOpenAICodexSession(nextSession);
		return nextSession;
	} catch {
		clearOpenAICodexSession();
		return null;
	}
}

export async function getValidOpenAICodexSession(forceRefresh = false): Promise<CodexSession | null> {
	const stored = getStoredOpenAICodexSession();
	if (!stored) {
		return null;
	}

	const shouldRefresh = forceRefresh || stored.expiresAt - REFRESH_BUFFER_MS <= Date.now();
	if (!shouldRefresh) {
		return stored;
	}

	if (!stored.refreshToken) {
		clearOpenAICodexSession();
		return null;
	}

	if (!pendingOpenAICodexRefresh) {
		pendingOpenAICodexRefresh = refreshStoredOpenAICodexSession(stored).finally(() => {
			pendingOpenAICodexRefresh = null;
		});
	}

	return pendingOpenAICodexRefresh;
}

async function openBrowser(url: string): Promise<void> {
	const opened = window.open(url, "_blank", "noopener,noreferrer");
	if (!opened) {
		Logger.warn("window.open returned a falsy value while launching ChatGPT sign-in");
	}
}

async function verifyCallbackServer(): Promise<void> {
	const response = await requestUrl({
		url: getHealthcheckUri(),
		method: "GET",
	});
	if (response.status !== 200) {
		throw new Error(`Callback server healthcheck failed (${response.status})`);
	}
	const body = response.text;
	if (body !== "ok") {
		throw new Error("Callback server healthcheck returned unexpected response");
	}
}

async function handleOpenAICodexCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const pending = pendingOpenAICodexAuth;
	if (!pending) {
		oauthErrorPage(res, "No active ChatGPT sign-in session");
		return;
	}

	try {
		const url = new URL(req.url ?? "/", pending.redirectUri);
		Logger.debug("OpenAI Codex callback request received", {
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

		const state = url.searchParams.get("state");
		if (state !== pending.expectedState) {
			oauthErrorPage(res, "Invalid OAuth state");
			const error = new Error("Invalid OAuth state");
			pending.reject(error);
			cleanupPendingOpenAICodexAuth();
			return;
		}

		const error = url.searchParams.get("error");
		if (error) {
			oauthErrorPage(res, error);
			pending.reject(new Error(error));
			cleanupPendingOpenAICodexAuth();
			return;
		}

		const code = url.searchParams.get("code");
		if (!code) {
			oauthErrorPage(res, "Missing authorization code");
			pending.reject(new Error("Missing authorization code"));
			cleanupPendingOpenAICodexAuth();
			return;
		}

		const tokens = await exchangeCodeForTokens(code, pending.redirectUri, pending.pkce);
		const nextSession = buildCodexSession(tokens);
		oauthSuccessPage(res);
		pending.resolve(nextSession);
		cleanupPendingOpenAICodexAuth();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		oauthErrorPage(res, message);
		pending.reject(error instanceof Error ? error : new Error(message));
		cleanupPendingOpenAICodexAuth();
	}
}

async function startOpenAICodexAuthServer(expectedState: string, pkce: PkceCodes, redirectUri: string): Promise<void> {
	if (pendingOpenAICodexAuth) {
		throw new Error("A ChatGPT sign-in flow is already in progress");
	}

	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const createServer = requireNodeHttp();
		const server = createServer((req, res) => {
			void handleOpenAICodexCallback(req, res);
		});

		const finalizeReject = (error: Error) => {
			if (settled) return;
			settled = true;
			server.close();
			reject(error);
		};

		server.once("error", (error) => {
			Logger.error("Failed to start OpenAI Codex callback server", error);
			finalizeReject(
				new Error(`Failed to start OAuth callback server on localhost:${CALLBACK_PORT}: ${error.message}`),
			);
		});

		server.listen(CALLBACK_PORT, () => {
			if (settled) return;
			settled = true;
			pendingOpenAICodexAuth = {
				server,
				expectedState,
				pkce,
				redirectUri,
				resolve: () => undefined,
				reject: () => undefined,
				timeoutId: window.setTimeout(() => undefined, OAUTH_TIMEOUT_MS),
			};
			resolve();
		});
	});
}

export async function signInWithOpenAICodex(): Promise<CodexSession> {
	if (Platform.isMobileApp) {
		throw new Error("ChatGPT sign-in is only available on desktop. Enter an API key instead.");
	}
	const redirectUri = getRedirectUri();
	const pkce = await generatePkce();
	const expectedState = generateState();
	const authorizeUrl = buildAuthorizeUrl(redirectUri, pkce, expectedState);

	await startOpenAICodexAuthServer(expectedState, pkce, redirectUri);

	try {
		Logger.info("OpenAI Codex callback server listening", {
			redirectUri,
			healthcheckUri: getHealthcheckUri(),
		});
		await verifyCallbackServer();
		Logger.info("OpenAI Codex callback server healthcheck passed");
		await openBrowser(authorizeUrl);
	} catch (error) {
		cleanupPendingOpenAICodexAuth();
		throw error;
	}

	const session = await new Promise<CodexSession>((resolve, reject) => {
		if (!pendingOpenAICodexAuth) {
			reject(new Error("ChatGPT sign-in session was not initialized"));
			return;
		}

		pendingOpenAICodexAuth.resolve = resolve;
		pendingOpenAICodexAuth.reject = reject;
		window.clearTimeout(pendingOpenAICodexAuth.timeoutId);
		pendingOpenAICodexAuth.timeoutId = window.setTimeout(() => {
			if (!pendingOpenAICodexAuth) return;
			pendingOpenAICodexAuth.reject(new Error("Timed out waiting for ChatGPT sign-in"));
			cleanupPendingOpenAICodexAuth();
		}, OAUTH_TIMEOUT_MS);
	});

	saveOpenAICodexSession(session);
	return session;
}

/**
 * Aborts an in-progress ChatGPT (Codex) sign-in: rejects the pending promise with a
 * cancellation marker and tears down the callback server (freeing the port), so the user
 * can retry immediately instead of waiting out the timeout. No-op if none pending.
 */
export function cancelOpenAICodexSignIn(): void {
	const pending = pendingOpenAICodexAuth;
	if (!pending) return;
	pending.reject(new OpenAICodexSignInCancelledError());
	cleanupPendingOpenAICodexAuth();
}

function buildHeaders(initHeaders: HeadersInit | undefined, accountId?: string): Headers {
	const headers = new Headers(initHeaders);
	if (accountId) {
		headers.set("ChatGPT-Account-Id", accountId);
	}
	headers.set("originator", "opencode");
	if (!headers.has("User-Agent")) {
		const plugin = getPlugin();
		headers.set("User-Agent", `smart-second-brain/${plugin.manifest.version} (obsidian plugin)`);
	}
	if (!headers.has("session_id")) {
		headers.set("session_id", crypto.randomUUID());
	}
	return headers;
}

function rewriteUrl(input: RequestInfo | URL): URL {
	const parsed =
		input instanceof URL
			? input
			: new URL(typeof input === "string" ? input : input instanceof Request ? input.url : String(input));

	if (
		parsed.pathname.endsWith("/responses") ||
		parsed.pathname.includes("/v1/responses") ||
		parsed.pathname.includes("/chat/completions")
	) {
		return new URL(CODEX_API_ENDPOINT);
	}

	return parsed;
}

function normalizeBody(body: BodyInit | null | undefined): string | undefined {
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
	return undefined;
}

function extractInputTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if ("text" in part && typeof part.text === "string") {
				return part.text;
			}
			return "";
		})
		.filter((part) => part.length > 0)
		.join("\n");
}

function sanitizeCodexPayload(parsed: Record<string, unknown>): void {
	parsed.store = false;
	if ("previous_response_id" in parsed) {
		parsed.previous_response_id = undefined;
	}
	const input = parsed.input;
	if (!Array.isArray(input)) return;

	const instructions: string[] = [];
	const nextInput = input
		.filter((item) => {
			if (!(item && typeof item === "object")) {
				return true;
			}

			if ("type" in item && item.type === "item_reference") {
				return false;
			}

			if (item.type === "message" && (item.role === "system" || item.role === "developer")) {
				const text = extractInputTextContent(item.content);
				if (text) {
					instructions.push(text);
				}
				return false;
			}

			return true;
		})
		.map((item) => {
			if (!item || typeof item !== "object") return item;
			const { id: _unused, ...rest } = item as Record<string, unknown>;
			return rest;
		});

	parsed.input = nextInput;
	if (typeof parsed.instructions !== "string" && instructions.length > 0) {
		parsed.instructions = instructions.join("\n\n");
	}
}

function injectCodexDefaults(init: RequestInit | undefined): RequestInit | undefined {
	const bodyText = normalizeBody(init?.body);
	if (!bodyText) return init;

	try {
		const parsed = JSON.parse(bodyText) as Record<string, unknown>;
		sanitizeCodexPayload(parsed);
		return { ...init, body: JSON.stringify(parsed) };
	} catch {
		return init;
	}
}

export function createOpenAICodexFetch(): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit) => {
		const session = await getValidOpenAICodexSession();
		if (!session) {
			throw new Error("ChatGPT sign-in required");
		}

		const url = rewriteUrl(input);
		const headerSource = init?.headers ?? (input instanceof Request ? input.headers : undefined);
		const headers = buildHeaders(headerSource, session.accountId);
		headers.set("Authorization", `Bearer ${session.accessToken}`);

		return performAiFetch("openai-codex", url, {
			...injectCodexDefaults(init),
			headers,
		});
	};
}
