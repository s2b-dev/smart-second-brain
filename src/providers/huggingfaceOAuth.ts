/**
 * "Sign in with Hugging Face" via the OAuth device-code flow (RFC 8628).
 *
 * The plugin asks Hugging Face for a short user code, the user enters it at
 * huggingface.co on any device, and we poll the token endpoint until they approve. No
 * redirect comes back to Obsidian, so unlike the loopback flows (Codex) this needs no
 * `node:http` server and works on mobile too.
 *
 * The resulting token carries only the `inference-api` scope: it can call Inference
 * Providers on the user's behalf (billed to their account and its free monthly credits)
 * and nothing else. Access tokens are short-lived; the refresh token renews them.
 *
 * All requests go through Obsidian's `requestUrl`: huggingface.co's OAuth endpoints send
 * no CORS headers, so a renderer `fetch` would be blocked.
 */

import { requestUrl } from "obsidian";
import type { DeviceCodePrompt, OAuthSession } from "../types/provider";
import {
	clearHuggingFaceSession,
	getHuggingFaceSession,
	saveHuggingFaceSession,
} from "../stores/providerRuntime.svelte";

/**
 * Public OAuth app (no client secret) registered on huggingface.co for Smart Second
 * Brain, with the `inference-api` scope enabled. A public client ID is not a secret.
 */
export const HUGGING_FACE_CLIENT_ID = "";

const HF_ORIGIN = "https://huggingface.co";
const DEVICE_ENDPOINT = `${HF_ORIGIN}/oauth/device`;
const TOKEN_ENDPOINT = `${HF_ORIGIN}/oauth/token`;
const SCOPE = "inference-api";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** RFC 8628 §3.5: poll every 5 s unless the server says otherwise, +5 s on `slow_down`. */
const DEFAULT_POLL_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;
/** Renew this long before expiry so a request never leaves with a token about to lapse. */
const REFRESH_BUFFER_MS = 5 * 60_000;
/** Fallback lifetime when the token response omits `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_S = 3600;

interface DeviceAuthorizationResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in: number;
	interval?: number;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

/** Thrown when the user explicitly cancels an in-progress sign-in (vs. a real failure). */
export class HuggingFaceSignInCancelledError extends Error {
	constructor() {
		super("Hugging Face sign-in cancelled");
		this.name = "HuggingFaceSignInCancelledError";
	}
}

/** Cancels the poll loop of the sign-in in flight, if any. */
let cancelPendingSignIn: (() => void) | null = null;
let pendingRefresh: Promise<OAuthSession | null> | null = null;

function formBody(fields: Record<string, string>): string {
	return new URLSearchParams(fields).toString();
}

async function postForm(url: string, fields: Record<string, string>) {
	return requestUrl({
		url,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: formBody(fields),
		throw: false,
	});
}

function readJson<T>(response: { json: unknown }): T | undefined {
	try {
		return response.json as T;
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

/** Resolves after `ms`, or rejects with the cancellation error as soon as the user cancels. */
function sleep(ms: number, onCancel: (cancel: () => void) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(resolve, ms);
		onCancel(() => {
			window.clearTimeout(timer);
			reject(new HuggingFaceSignInCancelledError());
		});
	});
}

/**
 * Runs the device-code flow end to end and persists the resulting session. `onDeviceCode`
 * is called once with the code the user must enter; the promise settles when they approve
 * (resolves), deny, let the code expire, or cancel (rejects).
 */
export async function signInWithHuggingFace(
	onDeviceCode?: (prompt: DeviceCodePrompt) => void,
	clientId = HUGGING_FACE_CLIENT_ID,
): Promise<void> {
	if (!clientId) {
		throw new Error("Hugging Face sign-in is not configured in this build.");
	}
	cancelHuggingFaceSignIn();

	let cancelled = false;
	let cancelSleep: (() => void) | null = null;
	cancelPendingSignIn = () => {
		cancelled = true;
		cancelSleep?.();
	};

	try {
		const deviceResponse = await postForm(DEVICE_ENDPOINT, { client_id: clientId, scope: SCOPE });
		if (cancelled) throw new HuggingFaceSignInCancelledError();
		const device = readJson<DeviceAuthorizationResponse>(deviceResponse);
		if (deviceResponse.status !== 200 || !device?.device_code || !device.user_code) {
			throw new Error(`Couldn't start Hugging Face sign-in (${deviceResponse.status})`);
		}

		const expiresAt = Date.now() + device.expires_in * 1000;
		onDeviceCode?.({
			userCode: device.user_code,
			verificationUri: device.verification_uri_complete ?? device.verification_uri,
			expiresAt,
		});

		let intervalS = device.interval ?? DEFAULT_POLL_INTERVAL_S;
		while (Date.now() < expiresAt) {
			await sleep(intervalS * 1000, (cancel) => {
				cancelSleep = cancel;
			});
			cancelSleep = null;
			if (cancelled) throw new HuggingFaceSignInCancelledError();

			const response = await postForm(TOKEN_ENDPOINT, {
				grant_type: DEVICE_CODE_GRANT,
				device_code: device.device_code,
				client_id: clientId,
			});
			if (cancelled) throw new HuggingFaceSignInCancelledError();
			const tokens = readJson<TokenResponse>(response);

			if (response.status === 200 && tokens?.access_token) {
				saveHuggingFaceSession(toSession(tokens));
				return;
			}
			switch (tokens?.error) {
				case "authorization_pending":
					continue;
				case "slow_down":
					intervalS += SLOW_DOWN_STEP_S;
					continue;
				case "access_denied":
					throw new Error("Sign-in was denied on Hugging Face.");
				case "expired_token":
					throw new Error("The sign-in code expired. Try again.");
				default:
					throw new Error(
						tokens?.error_description ??
							tokens?.error ??
							`Hugging Face sign-in failed (${response.status})`,
					);
			}
		}
		throw new Error("The sign-in code expired. Try again.");
	} finally {
		cancelPendingSignIn = null;
	}
}

/** Aborts the sign-in in flight: its promise rejects with {@link HuggingFaceSignInCancelledError}. */
export function cancelHuggingFaceSignIn(): void {
	cancelPendingSignIn?.();
}

export function clearHuggingFaceSignIn(): void {
	clearHuggingFaceSession();
}

async function refreshSession(stored: OAuthSession & { refreshToken: string }): Promise<OAuthSession | null> {
	const response = await postForm(TOKEN_ENDPOINT, {
		grant_type: "refresh_token",
		refresh_token: stored.refreshToken,
		client_id: HUGGING_FACE_CLIENT_ID,
	});
	const tokens = readJson<TokenResponse>(response);
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
