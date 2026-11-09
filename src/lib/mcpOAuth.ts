import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { type App, Platform } from "obsidian";
import {
	type NodeHttpIncomingMessage as IncomingMessage,
	type NodeHttpServer as Server,
	type NodeHttpServerResponse as ServerResponse,
	requireNodeHttp,
} from "../providers/oauthNode";
import { escapeHtml } from "../utils/html";
import { Logger } from "../utils/logging";
import { createObsidianFetch } from "./obsidianFetch";

/**
 * OAuth for remote (Streamable HTTP) MCP servers.
 *
 * The MCP spec's authorization flow — protected-resource discovery (RFC 9728),
 * authorization-server metadata, dynamic client registration (RFC 7591), and the
 * authorization-code grant with PKCE — is implemented by the MCP SDK's `auth()`.
 * What the SDK leaves to the host is everything around it, and that is this file:
 *
 * - **Storage.** One JSON record per server URL in Obsidian's SecretStorage
 *   (client registration, tokens, PKCE verifier, discovery state). Keyed by the
 *   URL rather than by agent/server id, so two agents pointing at the same server
 *   share one sign-in, and a rename never loses it. SecretStorage is per device
 *   and is not synced, which is the right default for bearer tokens.
 * - **The redirect.** Desktop only: a short-lived loopback server catches the
 *   browser redirect (same approach as the OpenRouter/Codex sign-ins, see
 *   `providers/oauthNode.ts`). Mobile has no `node:http`, and most authorization
 *   servers refuse custom URL schemes, so sign-in is desktop-only for now.
 * - **Interactive vs. background.** Only an explicit "Sign in" click may open a
 *   browser. Agent runs and the settings probe use a *background* provider: it
 *   reuses and refreshes stored tokens, but when the server needs a fresh login
 *   it throws {@link McpOAuthRequiredError} instead of popping a window mid-chat.
 */

/** Storage seam: SecretStorage in the plugin, an in-memory map in tests. */
export interface McpOAuthStorage {
	get(id: string): string | null;
	set(id: string, value: string): void;
}

/** What is persisted per server. Every field is optional — a record fills in over the flow. */
export interface McpOAuthRecord {
	/** Redirect URI the stored client registration was made with. */
	redirectUri?: string;
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
	discoveryState?: OAuthDiscoveryState;
}

/** Thrown by a background provider when the server needs the user to sign in again. */
export class McpOAuthRequiredError extends Error {
	constructor(readonly serverUrl: string) {
		super(
			`Sign-in required for MCP server ${serverUrl}. Open the agent's MCP server settings and click "Sign in".`,
		);
		this.name = "McpOAuthRequiredError";
	}
}

export class McpOAuthCancelledError extends Error {
	constructor() {
		super("MCP sign-in cancelled");
		this.name = "McpOAuthCancelledError";
	}
}

const CLIENT_NAME = "Smart Second Brain (Obsidian)";
const CLIENT_URI = "https://smartsecondbrain.dev";
const CALLBACK_PATH = "/callback";
/**
 * Preferred loopback port. Fixed so a dynamic client registration stays valid
 * across sign-ins (its redirect URI includes the port); if the port is taken we
 * fall back to a random one and re-register.
 */
const PREFERRED_CALLBACK_PORT = 33418;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const SECRET_PREFIX = "mcp-oauth-";

/** Secret ids are `[a-z0-9-]{1,64}`; a server URL is reduced to host slug + short hash. */
export function mcpOAuthSecretId(serverUrl: string): string {
	const normalized = normalizeServerUrl(serverUrl);
	let host = "server";
	try {
		host = new URL(normalized).hostname;
	} catch {
		// keep the fallback; the hash still makes the id unique
	}
	const slug = host
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${SECRET_PREFIX}${slug || "server"}-${fnv1a(normalized)}`;
}

/** Same server, same record: ignore a trailing slash, the fragment, and host case. */
export function normalizeServerUrl(serverUrl: string): string {
	try {
		const url = new URL(serverUrl.trim());
		url.hash = "";
		const path = url.pathname.replace(/\/+$/, "");
		return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
	} catch {
		return serverUrl.trim();
	}
}

function fnv1a(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function secretStorageAdapter(app: App): McpOAuthStorage {
	return {
		get: (id) => app.secretStorage.getSecret(id),
		set: (id, value) => app.secretStorage.setSecret(id, value),
	};
}

function readRecord(storage: McpOAuthStorage, serverUrl: string): McpOAuthRecord {
	const raw = storage.get(mcpOAuthSecretId(serverUrl));
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as McpOAuthRecord) : {};
	} catch {
		return {};
	}
}

function writeRecord(storage: McpOAuthStorage, serverUrl: string, record: McpOAuthRecord): void {
	// SecretStorage cannot delete; an empty string reads as "absent" (see secretStorage.ts).
	const empty = Object.values(record).every((v) => v === undefined);
	storage.set(mcpOAuthSecretId(serverUrl), empty ? "" : JSON.stringify(record));
}

export type McpOAuthProviderMode =
	| { kind: "background" }
	| {
			kind: "interactive";
			redirectUrl: string;
			state: string;
			/** Receives the authorization URL; the sign-in flow opens it. */
			onAuthorizationUrl: (url: URL) => void;
	  };

/**
 * `OAuthClientProvider` backed by {@link McpOAuthStorage}. Construct it through
 * {@link createBackgroundMcpOAuthProvider} for agent runs and probes; the
 * interactive variant is only created inside {@link signInToMcpServer}.
 */
export class ObsidianMcpOAuthProvider implements OAuthClientProvider {
	constructor(
		private readonly storage: McpOAuthStorage,
		private readonly serverUrl: string,
		private readonly mode: McpOAuthProviderMode,
	) {}

	private get record(): McpOAuthRecord {
		return readRecord(this.storage, this.serverUrl);
	}

	private update(patch: Partial<McpOAuthRecord>): void {
		writeRecord(this.storage, this.serverUrl, { ...this.record, ...patch });
	}

	get redirectUrl(): string {
		if (this.mode.kind === "interactive") return this.mode.redirectUrl;
		// Only consulted when building an authorization request or a registration,
		// neither of which a background provider ever gets to (see clientInformation).
		return this.record.redirectUri ?? `http://localhost:${PREFERRED_CALLBACK_PORT}${CALLBACK_PATH}`;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: CLIENT_NAME,
			client_uri: CLIENT_URI,
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			// Public client: PKCE instead of a secret, which could not be kept on a user's machine anyway.
			token_endpoint_auth_method: "none",
		};
	}

	state(): string {
		if (this.mode.kind !== "interactive") throw new McpOAuthRequiredError(this.serverUrl);
		return this.mode.state;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		const { clientInformation, redirectUri } = this.record;
		if (this.mode.kind === "background") {
			// Without a registration there is nothing to refresh with, and registering
			// from a background run would only lead to a browser login we must not open.
			if (!clientInformation) throw new McpOAuthRequiredError(this.serverUrl);
			return clientInformation;
		}
		// A registration is bound to its redirect URI; one made for another loopback
		// port would be rejected at the authorization endpoint, so register afresh.
		if (clientInformation && redirectUri === this.mode.redirectUrl) return clientInformation;
		return undefined;
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		this.update({ clientInformation, redirectUri: this.redirectUrl });
	}

	tokens(): OAuthTokens | undefined {
		return this.record.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		// Keep a refresh token the server did not rotate: a refresh response may omit it.
		const previous = this.record.tokens;
		const merged: OAuthTokens =
			!tokens.refresh_token && previous?.refresh_token
				? { ...tokens, refresh_token: previous.refresh_token }
				: tokens;
		this.update({ tokens: merged, codeVerifier: undefined });
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		if (this.mode.kind !== "interactive") throw new McpOAuthRequiredError(this.serverUrl);
		this.mode.onAuthorizationUrl(authorizationUrl);
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.update({ codeVerifier });
	}

	codeVerifier(): string {
		const verifier = this.record.codeVerifier;
		if (!verifier) throw new Error("No PKCE code verifier saved for this MCP sign-in");
		return verifier;
	}

	saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
		this.update({ discoveryState });
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.record.discoveryState;
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		Logger.log(`[MCP OAuth] Server invalidated credentials (${scope}) for ${this.serverUrl}`);
		switch (scope) {
			case "all":
				writeRecord(this.storage, this.serverUrl, {});
				return;
			case "client":
				this.update({ clientInformation: undefined, redirectUri: undefined });
				return;
			case "tokens":
				this.update({ tokens: undefined });
				return;
			case "verifier":
				this.update({ codeVerifier: undefined });
				return;
			case "discovery":
				this.update({ discoveryState: undefined });
				return;
		}
	}
}

/** Provider for agent runs and connection probes — never opens a browser. */
export function createBackgroundMcpOAuthProvider(app: App, serverUrl: string): ObsidianMcpOAuthProvider {
	return new ObsidianMcpOAuthProvider(secretStorageAdapter(app), serverUrl, { kind: "background" });
}

/** True when a token for this server is stored (it may still need a refresh). */
export function hasMcpOAuthSession(storage: McpOAuthStorage, serverUrl: string): boolean {
	return Boolean(readRecord(storage, serverUrl).tokens?.access_token);
}

/** Forget tokens and verifier but keep the client registration, so the next sign-in skips re-registering. */
export function signOutOfMcpServer(storage: McpOAuthStorage, serverUrl: string): void {
	const { clientInformation, redirectUri, discoveryState } = readRecord(storage, serverUrl);
	writeRecord(storage, serverUrl, { clientInformation, redirectUri, discoveryState });
}

/** True when the desktop loopback sign-in is available in this environment. */
export function canSignInToMcpServer(): boolean {
	return Platform.isDesktopApp;
}

type CreateServer = ReturnType<typeof requireNodeHttp>;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface McpSignInOptions {
	storage: McpOAuthStorage;
	/** Optional OAuth scope; when absent the SDK uses what the server advertises. */
	scope?: string;
	/** Aborts a sign-in that is waiting for the browser. */
	signal?: AbortSignal;
	/** Test seams. Default to Electron's `node:http`, the CORS-safe Obsidian fetch, and the system browser. */
	createServer?: CreateServer;
	fetchFn?: FetchLike;
	openUrl?: (url: string) => void | Promise<void>;
	timeoutMs?: number;
}

/**
 * Run the interactive sign-in for one MCP server: register (if needed), open the
 * browser on the authorization page, catch the redirect on a loopback server,
 * exchange the code, and store the tokens. Resolves once tokens are stored.
 */
export async function signInToMcpServer(serverUrl: string, options: McpSignInOptions): Promise<void> {
	const createServer = options.createServer ?? requireNodeHttp();
	const fetchFn: FetchLike = options.fetchFn ?? createObsidianFetch(window.fetch.bind(window));
	const openUrl = options.openUrl ?? openInBrowser;
	const state = randomState();

	// A fresh sign-in replaces any session — but keep the registration.
	signOutOfMcpServer(options.storage, serverUrl);

	const callback = await startCallbackServer(createServer, state);
	let authorizationUrl: URL | null = null;
	try {
		const provider = new ObsidianMcpOAuthProvider(options.storage, serverUrl, {
			kind: "interactive",
			redirectUrl: callback.redirectUrl,
			state,
			onAuthorizationUrl: (url) => {
				authorizationUrl = url;
			},
		});
		// Dynamic import keeps the MCP SDK out of plugin load (see AgentManager.loadMCPTools).
		const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");

		const first = await auth(provider, { serverUrl, scope: options.scope, fetchFn });
		if (first === "AUTHORIZED") return;
		const url = authorizationUrl as URL | null;
		if (!url) throw new Error("The MCP server did not provide an authorization URL");

		Logger.log(`[MCP OAuth] Opening authorization page for ${serverUrl}`);
		await openUrl(url.toString());
		const code = await callback.waitForCode(options.timeoutMs ?? SIGN_IN_TIMEOUT_MS, options.signal);

		const second = await auth(provider, { serverUrl, scope: options.scope, authorizationCode: code, fetchFn });
		if (second !== "AUTHORIZED") throw new Error("The MCP server did not issue tokens");
		Logger.log(`[MCP OAuth] Signed in to ${serverUrl}`);
	} finally {
		callback.close();
	}
}

function randomState(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Open the authorization page in the **system** browser.
 *
 * `window.open` is not enough on desktop: with Obsidian's core "Web viewer"
 * plugin enabled, external links open in an in-app window instead. That window
 * has none of the user's identity-provider session and its own cookie jar, and
 * a real-world login (SAP LeanIX via corporate SSO) ended in "FORBIDDEN" there
 * while the identical URL completed in the system browser. Electron's
 * `shell.openExternal` always hands the URL to the OS default browser.
 * (`window.open` stays as the fallback; never use it on mobile, see AGENTS.md —
 * sign-in is desktop-only.)
 */
async function openInBrowser(url: string): Promise<void> {
	const electron = (window as unknown as { require?: (id: string) => unknown }).require?.("electron") as
		| { shell?: { openExternal?: (url: string) => Promise<void> } }
		| undefined;
	const openExternal = electron?.shell?.openExternal;
	if (openExternal) {
		try {
			await openExternal(url);
			return;
		} catch (error) {
			Logger.warn("[MCP OAuth] shell.openExternal failed, falling back to window.open", error);
		}
	}
	const opened = window.open(url, "_blank", "noopener,noreferrer");
	if (!opened) Logger.warn("[MCP OAuth] window.open returned a falsy value while opening the sign-in page");
}

interface CallbackServer {
	redirectUrl: string;
	waitForCode(timeoutMs: number, signal?: AbortSignal): Promise<string>;
	close(): void;
}

async function startCallbackServer(createServer: CreateServer, expectedState: string): Promise<CallbackServer> {
	let deliver: ((code: string) => void) | null = null;
	let fail: ((error: Error) => void) | null = null;
	let outcome: { code: string } | { error: Error } | null = null;
	const settle = (result: { code: string } | { error: Error }) => {
		if (outcome) return;
		outcome = result;
		if ("code" in result) deliver?.(result.code);
		else fail?.(result.error);
	};

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== CALLBACK_PATH) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not found");
			return;
		}
		// Anything that does not carry our state is not the redirect we are waiting
		// for (a stale tab, another app probing the port) — reject it without
		// letting it end the sign-in.
		if (url.searchParams.get("state") !== expectedState) {
			page(res, 400, "Sign-in failed", "This sign-in link is not the one Obsidian is waiting for. Start again.");
			return;
		}
		const error = url.searchParams.get("error");
		if (error) {
			const description = url.searchParams.get("error_description");
			const message = description ? `${error}: ${description}` : error;
			page(res, 400, "Sign-in failed", message);
			settle({ error: new Error(`Authorization was not granted (${message})`) });
			return;
		}
		const code = url.searchParams.get("code");
		if (!code) {
			page(res, 400, "Sign-in failed", "The redirect did not include an authorization code.");
			settle({ error: new Error("The redirect did not include an authorization code") });
			return;
		}
		page(res, 200, "Signed in", "You can close this window and return to Obsidian.");
		settle({ code });
	});

	const port = await listen(server, PREFERRED_CALLBACK_PORT).catch(() => listen(server, 0));
	const redirectUrl = `http://localhost:${port}${CALLBACK_PATH}`;

	return {
		redirectUrl,
		waitForCode(timeoutMs, signal) {
			return new Promise<string>((resolve, reject) => {
				const timer = setTimeout(
					() => settle({ error: new Error("Timed out waiting for the MCP sign-in to finish") }),
					timeoutMs,
				);
				const onAbort = () => settle({ error: new McpOAuthCancelledError() });
				signal?.addEventListener("abort", onAbort, { once: true });
				const done = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				};
				deliver = (code) => {
					done();
					resolve(code);
				};
				fail = (error) => {
					done();
					reject(error);
				};
				if (signal?.aborted) onAbort();
				const settled = outcome as { code: string } | { error: Error } | null;
				if (settled) {
					if ("code" in settled) deliver(settled.code);
					else fail(settled.error);
				}
			});
		},
		close() {
			server.close();
		},
	};
}

/** Listen on all interfaces (like the other loopback sign-ins) so `localhost` resolving to ::1 or 127.0.0.1 both work. */
function listen(server: Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			const address = server.address();
			resolve(typeof address === "object" && address ? address.port : port);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port);
	});
}

function page(res: ServerResponse, status: number, title: string, message: string): void {
	res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
	res.end(`<!doctype html>
<html>
  <head><title>Smart Second Brain - ${escapeHtml(title)}</title></head>
  <body style="font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
    <div style="text-align:center;padding:2rem;">
      <h1 style="margin-bottom:1rem;">${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </div>
  </body>
</html>`);
}
