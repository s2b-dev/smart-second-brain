import { describe, expect, it } from "vitest";
import {
	McpOAuthRequiredError,
	type McpOAuthStorage,
	ObsidianMcpOAuthProvider,
	hasMcpOAuthSession,
	mcpOAuthSecretId,
	normalizeServerUrl,
	signOutOfMcpServer,
} from "../../src/lib/mcpOAuth";
import { isValidSecretId } from "../../src/lib/secretStorage";

function memoryStorage(): McpOAuthStorage {
	const data = new Map<string, string>();
	return { get: (id) => data.get(id) ?? null, set: (id, value) => data.set(id, value) };
}

const URL_A = "https://mcp.leanix.net/services/mcp-server/v1/mcp";

describe("mcpOAuthSecretId", () => {
	it("is a valid SecretStorage id, also for very long hosts", () => {
		expect(isValidSecretId(mcpOAuthSecretId(URL_A))).toBe(true);
		const long = `https://${"sub.".repeat(30)}example.com/mcp`;
		expect(isValidSecretId(mcpOAuthSecretId(long))).toBe(true);
	});

	it("treats trivially different spellings of one URL as the same server", () => {
		expect(mcpOAuthSecretId(`${URL_A}/`)).toBe(mcpOAuthSecretId(URL_A));
		expect(mcpOAuthSecretId(URL_A.replace("mcp.leanix.net", "MCP.LeanIX.net"))).toBe(mcpOAuthSecretId(URL_A));
		expect(normalizeServerUrl(`${URL_A}#frag`)).toBe(URL_A);
	});

	it("keeps different servers apart", () => {
		expect(mcpOAuthSecretId("https://a.example.com/mcp")).not.toBe(mcpOAuthSecretId("https://a.example.com/other"));
	});
});

describe("ObsidianMcpOAuthProvider", () => {
	it("background mode never registers or redirects", () => {
		const provider = new ObsidianMcpOAuthProvider(memoryStorage(), URL_A, { kind: "background" });
		expect(() => provider.clientInformation()).toThrow(McpOAuthRequiredError);
		expect(() => provider.redirectToAuthorization(new URL("https://auth.example.com"))).toThrow(
			McpOAuthRequiredError,
		);
		expect(() => provider.state()).toThrow(McpOAuthRequiredError);
	});

	it("drops a registration made for another redirect URI in interactive mode", () => {
		const storage = memoryStorage();
		const first = new ObsidianMcpOAuthProvider(storage, URL_A, {
			kind: "interactive",
			redirectUrl: "http://localhost:33418/callback",
			state: "s",
			onAuthorizationUrl: () => {},
		});
		first.saveClientInformation({ client_id: "abc" });
		expect(first.clientInformation()?.client_id).toBe("abc");

		const otherPort = new ObsidianMcpOAuthProvider(storage, URL_A, {
			kind: "interactive",
			redirectUrl: "http://localhost:40000/callback",
			state: "s",
			onAuthorizationUrl: () => {},
		});
		expect(otherPort.clientInformation()).toBeUndefined();
		// The background provider still uses the stored registration for refreshes.
		expect(
			new ObsidianMcpOAuthProvider(storage, URL_A, { kind: "background" }).clientInformation()?.client_id,
		).toBe("abc");
	});

	it("keeps a refresh token the server did not rotate", () => {
		const storage = memoryStorage();
		const provider = new ObsidianMcpOAuthProvider(storage, URL_A, { kind: "background" });
		provider.saveTokens({ access_token: "a1", token_type: "bearer", refresh_token: "r1" });
		provider.saveTokens({ access_token: "a2", token_type: "bearer" });
		expect(provider.tokens()).toMatchObject({ access_token: "a2", refresh_token: "r1" });
	});

	it("invalidateCredentials clears only the requested part", () => {
		const storage = memoryStorage();
		const provider = new ObsidianMcpOAuthProvider(storage, URL_A, { kind: "background" });
		provider.saveTokens({ access_token: "a", token_type: "bearer" });
		provider.saveClientInformation({ client_id: "c" });
		provider.invalidateCredentials("tokens");
		expect(provider.tokens()).toBeUndefined();
		expect(provider.clientInformation()?.client_id).toBe("c");
		provider.invalidateCredentials("all");
		expect(storage.get(mcpOAuthSecretId(URL_A))).toBe("");
	});

	it("sign-out forgets the session but keeps the registration", () => {
		const storage = memoryStorage();
		const provider = new ObsidianMcpOAuthProvider(storage, URL_A, { kind: "background" });
		provider.saveClientInformation({ client_id: "c" });
		provider.saveTokens({ access_token: "a", token_type: "bearer" });
		expect(hasMcpOAuthSession(storage, URL_A)).toBe(true);
		signOutOfMcpServer(storage, URL_A);
		expect(hasMcpOAuthSession(storage, URL_A)).toBe(false);
		expect(provider.clientInformation()?.client_id).toBe("c");
	});
});
