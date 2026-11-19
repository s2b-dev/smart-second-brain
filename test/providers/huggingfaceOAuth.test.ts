/**
 * "Sign in with Hugging Face": the PKCE redirect flow on both platforms, and
 * access-token renewal.
 *
 * The desktop tests run the real loopback server (Node's `http`, handed to the module
 * the same way Electron's `window.require` does) and deliver the browser redirect over
 * HTTP. Only the token endpoint (`requestUrl`) is mocked.
 */

import http from "node:http";
import type { Platform as PlatformType, RequestUrlParam, requestUrl } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type SecondBrainPlugin from "../../src/main";

// Resolved per test from the current module graph: the mobile test resets modules, after
// which a statically imported mock would no longer be the one the code under test calls.
let requestUrlMock: ReturnType<typeof vi.mocked<typeof requestUrl>>;
let Platform: typeof PlatformType;
const CLIENT_ID = "test-client";

type Reply = { status: number; json: unknown };
const TOKENS: Reply = {
	status: 200,
	json: { access_token: "hf_oauth_access", refresh_token: "refresh-1", expires_in: 28800 },
};

/** Queue the responses requestUrl returns, in call order, and record the request bodies. */
function replyWith(replies: Reply[]): URLSearchParams[] {
	const bodies: URLSearchParams[] = [];
	for (const reply of replies) {
		requestUrlMock.mockImplementationOnce(((param: RequestUrlParam) => {
			bodies.push(new URLSearchParams(String(param.body ?? "")));
			return Promise.resolve({ headers: {}, text: JSON.stringify(reply.json), ...reply });
		}) as unknown as typeof requestUrl);
	}
	return bodies;
}

/** App-local storage shared across module reloads, like the real one across app restarts. */
let storage: Map<string, unknown>;

async function loadModules() {
	const state = await import("../../src/stores/state.svelte");
	state.setPlugin({
		app: {
			loadLocalStorage: (key: string) => storage.get(key) ?? null,
			saveLocalStorage: (key: string, value: unknown) => storage.set(key, value),
		},
	} as unknown as SecondBrainPlugin);
	return {
		oauth: await import("../../src/providers/huggingfaceOAuth"),
		runtime: await import("../../src/stores/providerRuntime.svelte"),
	};
}

type Modules = Awaited<ReturnType<typeof loadModules>>;

/** GET the loopback callback the way the browser redirect would. */
function deliverRedirect(url: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		http.get(url, (res) => {
			let body = "";
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		}).on("error", reject);
	});
}

let openSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };

/** Starts a desktop sign-in and returns its promise plus the consent-page parameters. */
async function startDesktopSignIn(oauth: Modules["oauth"]) {
	const done = oauth.signInWithHuggingFace(CLIENT_ID);
	// Keep an early rejection from being reported as unhandled; tests assert on `done`.
	done.catch(() => {});
	await vi.waitFor(() => expect(openSpy).toHaveBeenCalled());
	const authorizeUrl = new URL(String(openSpy.mock.calls[0][0]));
	return { done, authorizeUrl, params: authorizeUrl.searchParams };
}

beforeEach(async () => {
	const obsidian = await import("obsidian");
	requestUrlMock = vi.mocked(obsidian.requestUrl);
	Platform = obsidian.Platform;
	requestUrlMock.mockReset();
	storage = new Map();
	// The session store is a module singleton: start every test signed out.
	(await loadModules()).runtime.clearHuggingFaceSession();
	(window as unknown as { require: (id: string) => unknown }).require = (id) => (id === "http" ? http : undefined);
	openSpy = vi.spyOn(window, "open").mockReturnValue(null);
	Platform.isDesktopApp = true;
});

afterEach(() => {
	openSpy.mockRestore();
	Platform.isDesktopApp = true;
});

describe("desktop sign-in (loopback redirect)", () => {
	it("opens the consent page, exchanges the redirected code, and stores the session", async () => {
		const { oauth, runtime } = await loadModules();
		const bodies = replyWith([TOKENS]);
		const { done, authorizeUrl, params } = await startDesktopSignIn(oauth);

		expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://huggingface.co/oauth/authorize");
		expect(params.get("client_id")).toBe(CLIENT_ID);
		expect(params.get("scope")).toBe("inference-api");
		expect(params.get("response_type")).toBe("code");
		expect(params.get("code_challenge_method")).toBe("S256");
		const redirectUri = params.get("redirect_uri") ?? "";
		expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

		const page = await deliverRedirect(`${redirectUri}?code=the-code&state=${params.get("state")}`);
		await done;

		expect(page.status).toBe(200);
		expect(page.body).toContain("Connected to Hugging Face");
		expect(bodies[0].get("grant_type")).toBe("authorization_code");
		expect(bodies[0].get("code")).toBe("the-code");
		expect(bodies[0].get("redirect_uri")).toBe(redirectUri);
		// The verifier sent with the code must hash to the challenge sent with the consent page.
		const verifier = new TextEncoder().encode(bodies[0].get("code_verifier") ?? "");
		const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", verifier)).toString("base64url");
		expect(challenge).toBe(params.get("code_challenge"));
		expect(runtime.getHuggingFaceSession()).toMatchObject({
			accessToken: "hf_oauth_access",
			refreshToken: "refresh-1",
		});
	});

	it("ignores a redirect with the wrong state and keeps waiting", async () => {
		const { oauth } = await loadModules();
		const { done, params } = await startDesktopSignIn(oauth);
		const redirectUri = params.get("redirect_uri") ?? "";

		const forged = await deliverRedirect(`${redirectUri}?code=evil&state=not-it`);
		expect(forged.status).toBe(400);
		expect(requestUrlMock).not.toHaveBeenCalled();

		replyWith([TOKENS]);
		await deliverRedirect(`${redirectUri}?code=real&state=${params.get("state")}`);
		await expect(done).resolves.toBeUndefined();
	});

	it("rejects when the user declines on Hugging Face", async () => {
		const { oauth, runtime } = await loadModules();
		const { done, params } = await startDesktopSignIn(oauth);

		const page = await deliverRedirect(
			`${params.get("redirect_uri")}?error=access_denied&state=${params.get("state")}`,
		);

		expect(page.status).toBe(400);
		await expect(done).rejects.toThrow("Sign-in was cancelled on Hugging Face.");
		expect(runtime.getHuggingFaceSession()).toBeNull();
	});

	it("cancel rejects with the cancellation marker and closes the listener", async () => {
		const { oauth } = await loadModules();
		const { done, params } = await startDesktopSignIn(oauth);

		oauth.cancelHuggingFaceSignIn();

		await expect(done).rejects.toMatchObject({ name: "HuggingFaceSignInCancelledError" });
		await expect(deliverRedirect(`${params.get("redirect_uri")}?code=late&state=x`)).rejects.toThrow();
	});

	it("refuses to start without a client ID", async () => {
		const { oauth } = await loadModules();
		await expect(oauth.signInWithHuggingFace("")).rejects.toThrow("not configured");
		expect(openSpy).not.toHaveBeenCalled();
	});
});

describe("mobile sign-in (obsidian:// redirect)", () => {
	it("completes from the persisted grant after Obsidian restarted mid-sign-in", async () => {
		Platform.isDesktopApp = false;
		const first = await loadModules();
		const hrefs: string[] = [];
		const realLocation = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: {
				set href(url: string) {
					hrefs.push(url);
				},
			},
		});
		try {
			void first.oauth.signInWithHuggingFace(CLIENT_ID).catch(() => {});
			await vi.waitFor(() => expect(hrefs).toHaveLength(1));
		} finally {
			Object.defineProperty(window, "location", { configurable: true, value: realLocation });
		}
		const params = new URL(hrefs[0]).searchParams;
		expect(params.get("redirect_uri")).toBe("obsidian://s2b-huggingface-auth");
		const state = params.get("state") ?? "";

		// iOS evicted Obsidian while the user was in Safari: fresh modules, same storage.
		vi.resetModules();
		const second = await loadModules();
		requestUrlMock = vi.mocked((await import("obsidian")).requestUrl);
		const bodies = replyWith([TOKENS]);
		await second.oauth.handleHuggingFaceProtocolRedirect({ action: "s2b-huggingface-auth", code: "c", state });

		expect(bodies[0].get("redirect_uri")).toBe("obsidian://s2b-huggingface-auth");
		expect(second.runtime.getHuggingFaceSession()?.accessToken).toBe("hf_oauth_access");

		// The grant is single-use: replaying the same link does nothing.
		await second.oauth.handleHuggingFaceProtocolRedirect({ action: "s2b-huggingface-auth", code: "c", state });
		expect(requestUrlMock).toHaveBeenCalledTimes(1);
	});
});

describe("getValidHuggingFaceSession", () => {
	it("returns a fresh session without a request", async () => {
		const { oauth, runtime } = await loadModules();
		runtime.saveHuggingFaceSession({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 });
		await expect(oauth.getValidHuggingFaceSession()).resolves.toMatchObject({ accessToken: "a" });
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("renews a token close to expiry, keeping the refresh token when none is returned", async () => {
		const { oauth, runtime } = await loadModules();
		runtime.saveHuggingFaceSession({ accessToken: "old", refreshToken: "r", expiresAt: Date.now() + 60_000 });
		const bodies = replyWith([{ status: 200, json: { access_token: "new", expires_in: 28800 } }]);

		const [first, second] = await Promise.all([
			oauth.getValidHuggingFaceSession(),
			oauth.getValidHuggingFaceSession(),
		]);

		expect(requestUrlMock).toHaveBeenCalledTimes(1);
		expect(bodies[0].get("grant_type")).toBe("refresh_token");
		expect(first).toMatchObject({ accessToken: "new", refreshToken: "r" });
		expect(second).toBe(first);
		expect(runtime.getHuggingFaceSession()?.accessToken).toBe("new");
	});

	it("signs out when the refresh grant is rejected", async () => {
		const { oauth, runtime } = await loadModules();
		runtime.saveHuggingFaceSession({ accessToken: "old", refreshToken: "revoked", expiresAt: 0 });
		replyWith([{ status: 400, json: { error: "invalid_grant" } }]);

		await expect(oauth.getValidHuggingFaceSession()).resolves.toBeNull();
		expect(runtime.getHuggingFaceSession()).toBeNull();
	});

	it("keeps the session through a transient server error", async () => {
		const { oauth, runtime } = await loadModules();
		runtime.saveHuggingFaceSession({ accessToken: "old", refreshToken: "r", expiresAt: 0 });
		replyWith([{ status: 503, json: {} }]);

		await expect(oauth.getValidHuggingFaceSession()).rejects.toThrow(
			"Couldn't renew the Hugging Face sign-in (503)",
		);
		expect(runtime.getHuggingFaceSession()?.refreshToken).toBe("r");
	});
});
