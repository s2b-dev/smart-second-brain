import { describe, expect, it } from "vitest";
import {
	isConnectionRefusedError,
	isDocumentRejectionError,
	isProviderUnreachableError,
	isRequestTimeoutError,
} from "../../src/lib/transportErrors";

/*
 * One predicate for "the provider is not answering", shared by the embedding
 * retry policy and the bulk indexer. The failure that motivated it: Electron's
 * network stack reports a stopped local server as `net::ERR_CONNECTION_REFUSED`,
 * which neither layer recognised (both knew only Node's `ECONNREFUSED`).
 */

describe("isConnectionRefusedError", () => {
	it("recognises a refused connection however it is spelled", () => {
		expect(isConnectionRefusedError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(true);
		expect(isConnectionRefusedError(new Error("connect ECONNREFUSED 127.0.0.1:8080"))).toBe(true);
		expect(isConnectionRefusedError(new Error("net::ERR_NAME_NOT_RESOLVED"))).toBe(true);
		expect(isConnectionRefusedError(new Error("getaddrinfo ENOTFOUND example.invalid"))).toBe(true);
	});

	it("reads the cause chain: Node's fetch wraps the socket error", () => {
		const cause = Object.assign(new Error("connect ECONNREFUSED ::1:11434"), { code: "ECONNREFUSED" });
		expect(isConnectionRefusedError(new TypeError("fetch failed", { cause }))).toBe(true);
		// The OpenAI SDK wraps once more, with a message that says nothing on its own.
		const sdkError = Object.assign(new Error("Connection error."), {
			cause: new TypeError("fetch failed", { cause }),
		});
		expect(isConnectionRefusedError(sdkError)).toBe(true);
	});

	it("does not fire for rejections, timeouts or resets", () => {
		expect(isConnectionRefusedError(new Error("the input length exceeds the context length"))).toBe(false);
		expect(isConnectionRefusedError(new DOMException("Request timed out after 60000ms", "TimeoutError"))).toBe(
			false,
		);
		expect(isConnectionRefusedError(new Error("socket hang up"))).toBe(false);
		expect(isConnectionRefusedError(undefined)).toBe(false);
	});
});

describe("isRequestTimeoutError", () => {
	it("recognises a timeout however the client reports it", () => {
		expect(isRequestTimeoutError(new DOMException("Request timed out after 60000ms", "TimeoutError"))).toBe(true);
		// The OpenAI client's own wrapper: its name and message, no cause.
		const sdkTimeout = new Error("Request timed out.");
		sdkTimeout.name = "APIConnectionTimeoutError";
		expect(isRequestTimeoutError(sdkTimeout)).toBe(true);
		expect(isRequestTimeoutError(new Error("net::ERR_CONNECTION_TIMED_OUT"))).toBe(true);
		expect(isRequestTimeoutError(new Error("connect ETIMEDOUT 10.0.0.1:443"))).toBe(true);
		// Wrapped once more, with the DOMException on `cause`.
		expect(
			isRequestTimeoutError(
				new Error("embedding failed", { cause: new DOMException("Request timed out", "TimeoutError") }),
			),
		).toBe(true);
	});

	it("does not fire for other failures", () => {
		expect(isRequestTimeoutError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(false);
		expect(isRequestTimeoutError(new Error("socket hang up"))).toBe(false);
		expect(isRequestTimeoutError(new DOMException("Indexing cancelled", "AbortError"))).toBe(false);
	});
});

describe("isProviderUnreachableError", () => {
	it("covers refused connections, timeouts, resets and gateway errors", () => {
		expect(isProviderUnreachableError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(true);
		expect(isProviderUnreachableError(new DOMException("Request timed out after 60000ms", "TimeoutError"))).toBe(
			true,
		);
		expect(isProviderUnreachableError(new Error("net::ERR_CONNECTION_TIMED_OUT"))).toBe(true);
		expect(isProviderUnreachableError(new TypeError("Failed to fetch"))).toBe(true);
		expect(isProviderUnreachableError(new Error("socket hang up"))).toBe(true);
		expect(isProviderUnreachableError(new Error("Request failed with status 503"))).toBe(true);
	});

	it("never mistakes a cancellation for a provider fault", () => {
		expect(isProviderUnreachableError(new DOMException("Indexing cancelled", "AbortError"))).toBe(false);
	});

	it("leaves per-request rejections to the per-entry path", () => {
		expect(isProviderUnreachableError(new Error("400 the input length exceeds the context length"))).toBe(false);
		expect(isProviderUnreachableError(new Error("content filtered"))).toBe(false);
		// A number inside a longer token is not a gateway status.
		expect(isProviderUnreachableError(new Error("model qwen-1503 not found"))).toBe(false);
	});
});

describe("isDocumentRejectionError", () => {
	it("recognises the statuses that speak to the request body, however the client names them", () => {
		// The OpenAI client's `status`; Ollama's `status_code`; either down a cause chain.
		expect(isDocumentRejectionError(Object.assign(new Error("400 context length exceeded"), { status: 400 }))).toBe(
			true,
		);
		expect(isDocumentRejectionError(Object.assign(new Error("input too long"), { status_code: 413 }))).toBe(true);
		expect(
			isDocumentRejectionError(
				new Error("wrapped", { cause: Object.assign(new Error("unprocessable"), { status: 422 }) }),
			),
		).toBe(true);
	});

	it("leaves provider-wide failures and unclassified errors retryable", () => {
		for (const status of [401, 403, 404, 429, 500, 502, 503]) {
			expect(isDocumentRejectionError(Object.assign(new Error(`HTTP ${status}`), { status }))).toBe(false);
		}
		expect(isDocumentRejectionError(new Error("content policy"))).toBe(false);
		expect(isDocumentRejectionError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(false);
	});
});
