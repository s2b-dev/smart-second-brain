/**
 * End-to-end check of the MCP OAuth flow against a real (local) OAuth-protected
 * MCP server built from the MCP SDK: protected-resource discovery, dynamic
 * client registration, authorization code + PKCE through the loopback
 * callback, tool calls with the stored token, transparent refresh after the
 * access token expires, and the background provider refusing to start a login.
 *
 * The only thing faked is the browser: `openUrl` follows the authorization
 * redirect with fetch instead of opening a window.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { DemoInMemoryAuthProvider } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type McpOAuthRecord,
	type McpOAuthStorage,
	ObsidianMcpOAuthProvider,
	hasMcpOAuthSession,
	mcpOAuthSecretId,
	signInToMcpServer,
	signOutOfMcpServer,
} from "../../src/lib/mcpOAuth";

/**
 * Demo provider (registration, authorize, code exchange) plus what a real
 * server has and the demo lacks: refresh tokens, and a 401 (not a 500) for an
 * unknown token. Access tokens are tracked here so the test can expire them.
 */
class RefreshingAuthProvider extends DemoInMemoryAuthProvider {
	private readonly accessTokens = new Map<string, AuthInfo>();
	private readonly refreshTokens = new Map<string, string>();
	refreshCount = 0;

	private issue(clientId: string): OAuthTokens {
		const token = randomUUID();
		const refresh = randomUUID();
		this.accessTokens.set(token, { token, clientId, scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 });
		this.refreshTokens.set(refresh, clientId);
		return { access_token: token, token_type: "bearer", expires_in: 3600, refresh_token: refresh };
	}

	override async exchangeAuthorizationCode(
		client: OAuthClientInformationFull,
		code: string,
		verifier?: string,
	): Promise<OAuthTokens> {
		// Let the demo validate and consume the code, then issue our own tokens.
		await super.exchangeAuthorizationCode(client, code, verifier);
		return this.issue(client.client_id);
	}

	override async exchangeRefreshToken(
		client: OAuthClientInformationFull,
		refreshToken: string,
	): Promise<OAuthTokens> {
		if (this.refreshTokens.get(refreshToken) !== client.client_id) throw new Error("invalid refresh token");
		this.refreshTokens.delete(refreshToken);
		this.refreshCount++;
		return this.issue(client.client_id);
	}

	override async verifyAccessToken(token: string): Promise<AuthInfo> {
		const info = this.accessTokens.get(token);
		if (!info) throw new InvalidTokenError("Invalid or expired token");
		return info;
	}

	expireAllAccessTokens(): void {
		this.accessTokens.clear();
	}
}

function memoryStorage(): McpOAuthStorage & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return { data, get: (id) => data.get(id) ?? null, set: (id, value) => data.set(id, value) };
}

function readRecord(storage: McpOAuthStorage, url: string): McpOAuthRecord {
	return JSON.parse(storage.get(mcpOAuthSecretId(url)) || "{}") as McpOAuthRecord;
}

/** Stand-in for the browser: follow the authorize redirect to the loopback callback. */
async function followAuthorization(url: string): Promise<void> {
	const authorize = await fetch(url, { redirect: "manual" });
	const location = authorize.headers.get("location");
	if (!location) throw new Error(`authorize did not redirect (status ${authorize.status})`);
	const callback = await fetch(location);
	expect(callback.status).toBe(200);
}

async function listTools(url: string, storage: McpOAuthStorage): Promise<MultiServerMCPClient> {
	const client = new MultiServerMCPClient({
		mcpServers: {
			test: {
				transport: "http",
				url,
				authProvider: new ObsidianMcpOAuthProvider(storage, url, { kind: "background" }),
			},
		},
	});
	return client;
}

let server: Server;
let mcpUrl: string;
let authProvider: RefreshingAuthProvider;

beforeAll(async () => {
	const app = express();
	server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = new URL(`http://localhost:${(server.address() as AddressInfo).port}`);
	const mcpEndpoint = new URL("/mcp", base);
	mcpUrl = mcpEndpoint.href;

	authProvider = new RefreshingAuthProvider();
	app.use(express.json());
	app.use(
		mcpAuthRouter({
			provider: authProvider,
			issuerUrl: base,
			resourceServerUrl: mcpEndpoint,
		}),
	);
	const bearer = requireBearerAuth({
		verifier: authProvider,
		resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpEndpoint),
	});
	app.post("/mcp", bearer, async (req, res) => {
		const mcp = new McpServer({ name: "oauth-test", version: "1.0.0" });
		mcp.tool("whoami", "Returns the client the token was issued to", async (extra) => ({
			content: [{ type: "text", text: `client:${extra.authInfo?.clientId ?? "none"}` }],
		}));
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		res.on("close", () => {
			void transport.close();
			void mcp.close();
		});
		await mcp.connect(transport);
		await transport.handleRequest(req, res, req.body);
	});
	app.get("/mcp", bearer, (_req, res) => res.status(405).end());
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("MCP OAuth end to end", () => {
	const storage = memoryStorage();

	it("refuses to start a login from the background (no browser mid-run)", async () => {
		const client = await listTools(mcpUrl, storage);
		await expect(client.getTools()).rejects.toThrow(/Sign-in required for MCP server/);
		await client.close();
		// …and it did not register a client behind the user's back.
		expect(readRecord(storage, mcpUrl).clientInformation).toBeUndefined();
	});

	it("signs in: discovery, registration, PKCE code exchange through the loopback callback", async () => {
		await signInToMcpServer(mcpUrl, {
			storage,
			createServer,
			fetchFn: fetch,
			openUrl: async (url) => {
				// A request without our state must be rejected without ending the sign-in.
				const authorize = new URL(url);
				const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
				const stray = await fetch(`${redirect.href}?code=forged&state=wrong`);
				expect(stray.status).toBe(400);
				await followAuthorization(url);
			},
			timeoutMs: 10_000,
		});

		expect(hasMcpOAuthSession(storage, mcpUrl)).toBe(true);
		const record = readRecord(storage, mcpUrl);
		expect(record.clientInformation?.client_id).toBeTruthy();
		expect(record.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
		expect(record.tokens?.refresh_token).toBeTruthy();
		expect(record.codeVerifier).toBeUndefined();
	});

	it("calls tools with the stored token", async () => {
		const client = await listTools(mcpUrl, storage);
		const tools = await client.getTools();
		expect(tools.map((t) => t.name)).toContain("whoami");
		const result = await tools.find((t) => t.name === "whoami")?.invoke({});
		const clientId = readRecord(storage, mcpUrl).clientInformation?.client_id;
		expect(JSON.stringify(result)).toContain(`client:${clientId}`);
		await client.close();
	});

	it("refreshes an expired access token without user interaction", async () => {
		const before = readRecord(storage, mcpUrl).tokens?.access_token;
		authProvider.expireAllAccessTokens();
		const client = await listTools(mcpUrl, storage);
		const tools = await client.getTools();
		expect(tools.map((t) => t.name)).toContain("whoami");
		await client.close();
		expect(authProvider.refreshCount).toBe(1);
		expect(readRecord(storage, mcpUrl).tokens?.access_token).not.toBe(before);
	});

	it("reuses the client registration for the next sign-in", async () => {
		const clientId = readRecord(storage, mcpUrl).clientInformation?.client_id;
		await signInToMcpServer(mcpUrl, { storage, createServer, fetchFn: fetch, openUrl: followAuthorization });
		expect(readRecord(storage, mcpUrl).clientInformation?.client_id).toBe(clientId);
	});

	it("signs out: the session is gone and the background provider asks for a new sign-in", async () => {
		signOutOfMcpServer(storage, mcpUrl);
		expect(hasMcpOAuthSession(storage, mcpUrl)).toBe(false);
		authProvider.expireAllAccessTokens();
		const client = await listTools(mcpUrl, storage);
		await expect(client.getTools()).rejects.toThrow(/Sign-in required for MCP server/);
		await client.close();
	});
});
