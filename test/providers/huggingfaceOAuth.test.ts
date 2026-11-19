/**
 * "Sign in with Hugging Face": the device-code poll loop and access-token renewal.
 */

import { type RequestUrlParam, requestUrl } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelHuggingFaceSignIn,
	getValidHuggingFaceSession,
	signInWithHuggingFace,
} from "../../src/providers/huggingfaceOAuth";
import {
	clearHuggingFaceSession,
	getHuggingFaceSession,
	saveHuggingFaceSession,
} from "../../src/stores/providerRuntime.svelte";
import { setPlugin } from "../../src/stores/state.svelte";
import type SecondBrainPlugin from "../../src/main";
import type { DeviceCodePrompt } from "../../src/types/provider";

const requestUrlMock = vi.mocked(requestUrl);
const CLIENT_ID = "test-client";

type Reply = { status: number; json: unknown };

/** Queue the responses requestUrl returns, in call order, and record the request bodies. */
function replyWith(...replies: Reply[]): URLSearchParams[] {
	const bodies: URLSearchParams[] = [];
	for (const reply of replies) {
		requestUrlMock.mockImplementationOnce(((param: RequestUrlParam) => {
			bodies.push(new URLSearchParams(String(param.body ?? "")));
			return Promise.resolve({ headers: {}, text: JSON.stringify(reply.json), ...reply });
		}) as unknown as typeof requestUrl);
	}
	return bodies;
}

const DEVICE: Reply = {
	status: 200,
	json: {
		device_code: "dev-123",
		user_code: "ABCD-1234",
		verification_uri: "https://hf.co/oauth/device",
		expires_in: 300,
	},
};
const PENDING: Reply = { status: 400, json: { error: "authorization_pending" } };
const TOKENS: Reply = {
	status: 200,
	json: { access_token: "hf_oauth_access", refresh_token: "refresh-1", expires_in: 28800 },
};

beforeEach(() => {
	// mockReset (vitest config) wipes the mock's default implementation between tests.
	requestUrlMock.mockReset();
	vi.useFakeTimers();
	const storage = new Map<string, unknown>();
	setPlugin({
		app: {
			loadLocalStorage: (key: string) => storage.get(key) ?? null,
			saveLocalStorage: (key: string, value: unknown) => storage.set(key, value),
		},
	} as unknown as SecondBrainPlugin);
	// Each test starts signed out; the store is a module singleton.
	clearHuggingFaceSession();
});

afterEach(() => {
	cancelHuggingFaceSignIn();
	vi.useRealTimers();
});

describe("signInWithHuggingFace", () => {
	it("shows the code, polls until approved, and stores the session", async () => {
		const bodies = replyWith(DEVICE, PENDING, PENDING, TOKENS);
		const prompts: DeviceCodePrompt[] = [];

		const done = signInWithHuggingFace((prompt) => prompts.push(prompt), CLIENT_ID);
		await vi.advanceTimersByTimeAsync(15_000);
		await done;

		expect(prompts).toEqual([
			expect.objectContaining({ userCode: "ABCD-1234", verificationUri: "https://hf.co/oauth/device" }),
		]);
		expect(bodies[0].get("scope")).toBe("inference-api");
		expect(bodies[0].get("client_id")).toBe(CLIENT_ID);
		expect(bodies[3].get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
		expect(bodies[3].get("device_code")).toBe("dev-123");
		expect(getHuggingFaceSession()).toMatchObject({ accessToken: "hf_oauth_access", refreshToken: "refresh-1" });
	});

	it("backs off by 5 s on slow_down", async () => {
		replyWith(DEVICE, { status: 400, json: { error: "slow_down" } }, TOKENS);

		const done = signInWithHuggingFace(undefined, CLIENT_ID);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(requestUrlMock).toHaveBeenCalledTimes(2);
		// The next poll waits 10 s, not 5.
		await vi.advanceTimersByTimeAsync(9_000);
		expect(requestUrlMock).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1_000);
		await done;
		expect(requestUrlMock).toHaveBeenCalledTimes(3);
	});

	it("rejects with a readable error when the user denies access", async () => {
		replyWith(DEVICE, { status: 400, json: { error: "access_denied" } });

		const done = signInWithHuggingFace(undefined, CLIENT_ID);
		const settled = expect(done).rejects.toThrow("Sign-in was denied on Hugging Face.");
		await vi.advanceTimersByTimeAsync(5_000);
		await settled;
		expect(getHuggingFaceSession()).toBeNull();
	});

	it("stops polling when cancelled", async () => {
		replyWith(DEVICE);

		const done = signInWithHuggingFace(undefined, CLIENT_ID);
		const settled = expect(done).rejects.toMatchObject({ name: "HuggingFaceSignInCancelledError" });
		await vi.advanceTimersByTimeAsync(0);
		cancelHuggingFaceSignIn();
		await settled;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(requestUrlMock).toHaveBeenCalledTimes(1);
	});

	it("gives up once the code expires", async () => {
		replyWith(DEVICE, ...Array.from({ length: 60 }, () => PENDING));

		const done = signInWithHuggingFace(undefined, CLIENT_ID);
		const settled = expect(done).rejects.toThrow("The sign-in code expired. Try again.");
		await vi.advanceTimersByTimeAsync(301_000);
		await settled;
	});

	it("refuses to start without a client ID", async () => {
		await expect(signInWithHuggingFace(undefined, "")).rejects.toThrow("not configured");
		expect(requestUrlMock).not.toHaveBeenCalled();
	});
});

describe("getValidHuggingFaceSession", () => {
	it("returns a fresh session without a request", async () => {
		saveHuggingFaceSession({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 });
		await expect(getValidHuggingFaceSession()).resolves.toMatchObject({ accessToken: "a" });
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("renews a token close to expiry, keeping the refresh token when none is returned", async () => {
		saveHuggingFaceSession({ accessToken: "old", refreshToken: "r", expiresAt: Date.now() + 60_000 });
		const bodies = replyWith({ status: 200, json: { access_token: "new", expires_in: 28800 } });

		const [first, second] = await Promise.all([getValidHuggingFaceSession(), getValidHuggingFaceSession()]);

		expect(requestUrlMock).toHaveBeenCalledTimes(1);
		expect(bodies[0].get("grant_type")).toBe("refresh_token");
		expect(first).toMatchObject({ accessToken: "new", refreshToken: "r" });
		expect(second).toBe(first);
		expect(getHuggingFaceSession()?.accessToken).toBe("new");
	});

	it("signs out when the refresh grant is rejected", async () => {
		saveHuggingFaceSession({ accessToken: "old", refreshToken: "revoked", expiresAt: 0 });
		replyWith({ status: 400, json: { error: "invalid_grant" } });

		await expect(getValidHuggingFaceSession()).resolves.toBeNull();
		expect(getHuggingFaceSession()).toBeNull();
	});

	it("keeps the session through a transient server error", async () => {
		saveHuggingFaceSession({ accessToken: "old", refreshToken: "r", expiresAt: 0 });
		replyWith({ status: 503, json: {} });

		await expect(getValidHuggingFaceSession()).rejects.toThrow("Couldn't renew the Hugging Face sign-in (503)");
		expect(getHuggingFaceSession()?.refreshToken).toBe("r");
	});
});
