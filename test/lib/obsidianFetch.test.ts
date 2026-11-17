import { describe, expect, it, vi, beforeEach } from "vitest";
import { requestUrl } from "obsidian";
import { createObsidianFetch, requestTimeoutMs } from "../../src/lib/obsidianFetch";

const mockRequestUrl = vi.mocked(requestUrl);

function lastHeaders(): Record<string, string> {
	const call = mockRequestUrl.mock.calls.at(-1);
	// requestUrl accepts `string | RequestUrlParam`; every call here passes the param
	// object, and only that form carries headers.
	const param = call?.[0];
	if (typeof param !== "object") return {};
	return (param.headers ?? {}) as Record<string, string>;
}

/**
 * A requestUrl response carrying only the fields these tests read. RequestUrlResponse also
 * declares `arrayBuffer`, which nothing here touches — stubbing it would just be noise, so
 * the cast is centralized in this one helper rather than repeated at each mockResolvedValue.
 */
function okResponse(): Awaited<ReturnType<typeof requestUrl>> {
	return {
		status: 200,
		headers: { "content-type": "application/json" },
		text: '{"ok":true}',
		json: { ok: true },
	} as unknown as Awaited<ReturnType<typeof requestUrl>>;
}

describe("createObsidianFetch header normalization", () => {
	beforeEach(() => {
		mockRequestUrl.mockClear();
		mockRequestUrl.mockResolvedValue(okResponse());
	});

	// The regression this file exists for: the OpenAI SDK always passes a `Headers`
	// instance. The old implementation cast it to Record and copied onto itself, so
	// requestUrl received a Headers object and read no headers from it — the auth
	// header vanished, the request never completed, and the promise never settled
	// (indexing stuck at 0/N with no error).
	it("converts a Headers instance into a plain record", async () => {
		const fetchImpl = createObsidianFetch();
		const headers = new Headers();
		headers.set("authorization", "Bearer secret-token");
		headers.set("content-type", "application/json");

		await fetchImpl("https://example.com/v1/embeddings", {
			method: "POST",
			headers,
			body: '{"input":"probe"}',
		});

		const sent = lastHeaders();
		expect(sent.authorization).toBe("Bearer secret-token");
		expect(sent["content-type"]).toBe("application/json");
		// Must be a real record, not a Headers instance wearing a Record type.
		expect(Object.getPrototypeOf(sent)).toBe(Object.prototype);
	});

	it("does not mutate the caller's Headers instance", async () => {
		const fetchImpl = createObsidianFetch();
		const headers = new Headers();
		headers.set("authorization", "Bearer secret-token");

		await fetchImpl("https://example.com/v1/embeddings", { method: "POST", headers });

		// The old code assigned own properties onto the Headers object.
		expect(Object.keys(headers)).toHaveLength(0);
		expect(headers.get("authorization")).toBe("Bearer secret-token");
	});

	it("accepts an array of header pairs", async () => {
		const fetchImpl = createObsidianFetch();

		await fetchImpl("https://example.com/v1/embeddings", {
			method: "POST",
			headers: [
				["authorization", "Bearer secret-token"],
				["x-custom", "1"],
			],
		});

		const sent = lastHeaders();
		expect(sent.authorization).toBe("Bearer secret-token");
		expect(sent["x-custom"]).toBe("1");
	});

	it("accepts a plain record and preserves its entries", async () => {
		const fetchImpl = createObsidianFetch();

		await fetchImpl("https://example.com/v1/embeddings", {
			method: "POST",
			headers: { authorization: "Bearer secret-token" },
		});

		expect(lastHeaders().authorization).toBe("Bearer secret-token");
	});

	it("sends an empty record when no headers are supplied", async () => {
		const fetchImpl = createObsidianFetch();

		await fetchImpl("https://example.com/v1/embeddings", { method: "POST" });

		expect(lastHeaders()).toEqual({});
	});

	it("prefers native fetch and skips requestUrl when it succeeds", async () => {
		const native = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
		const fetchImpl = createObsidianFetch(native);

		const res = await fetchImpl("https://example.com/v1/embeddings", { method: "POST" });

		expect(native).toHaveBeenCalledTimes(1);
		expect(mockRequestUrl).not.toHaveBeenCalled();
		expect(res.status).toBe(200);
	});

	it("falls back to requestUrl with normalized headers when native fetch throws", async () => {
		const native = vi.fn().mockRejectedValue(new Error("CORS"));
		const fetchImpl = createObsidianFetch(native);
		const headers = new Headers();
		headers.set("authorization", "Bearer secret-token");

		const res = await fetchImpl("https://example.com/v1/embeddings", { method: "POST", headers });

		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
		expect(lastHeaders().authorization).toBe("Bearer secret-token");
		expect(res.status).toBe(200);
	});
});

/*
 * Timeout and cancellation.
 *
 * Neither `requestUrl` nor native fetch has a timeout of its own, so an
 * unreachable host left the returned promise permanently unsettled. That is the
 * same *symptom* as the header bug above (indexing frozen at N/M, no error), but a
 * different cause — and it survived the header fix, so it needs its own guard.
 */
describe("createObsidianFetch timeout", () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
	});

	it("rejects instead of hanging when requestUrl never settles", async () => {
		vi.useFakeTimers();
		try {
			// A host that accepts the connection and never responds: the promise
			// neither resolves nor rejects. Before the timeout this pinned the caller
			// forever, and Cancel could not reach it either.
			mockRequestUrl.mockReturnValue(new Promise(() => {}) as ReturnType<typeof requestUrl>);

			const fetchImpl = createObsidianFetch();
			const pending = fetchImpl("https://unreachable.example/v1/embeddings", { method: "POST", body: "{}" });
			const assertion = expect(pending).rejects.toThrow();

			await vi.advanceTimersByTimeAsync(60_000);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it("propagates the caller's abort signal", async () => {
		mockRequestUrl.mockReturnValue(new Promise(() => {}) as ReturnType<typeof requestUrl>);

		const controller = new AbortController();
		const fetchImpl = createObsidianFetch();
		const pending = fetchImpl("https://unreachable.example/v1/embeddings", {
			method: "POST",
			body: "{}",
			signal: controller.signal,
		});
		const assertion = expect(pending).rejects.toThrow(/abort/i);

		controller.abort();
		await assertion;
	});

	it("rejects immediately when handed an already-aborted signal", async () => {
		mockRequestUrl.mockReturnValue(new Promise(() => {}) as ReturnType<typeof requestUrl>);

		const fetchImpl = createObsidianFetch();
		await expect(
			fetchImpl("https://unreachable.example/v1/embeddings", {
				method: "POST",
				body: "{}",
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow(/abort/i);
	});

	it("does not fall back to requestUrl when native fetch times out", async () => {
		vi.useFakeTimers();
		try {
			// Falling through would start a *second* unbounded request against a host
			// already known to be unresponsive, doubling the wait the timeout exists
			// to bound.
			const nativeFetch = vi.fn(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_, reject) => {
						init?.signal?.addEventListener("abort", () =>
							reject(new DOMException("Aborted", "AbortError")),
						);
					}),
			);
			const fetchImpl = createObsidianFetch(nativeFetch);
			const pending = fetchImpl("https://unreachable.example/v1/embeddings", { method: "POST", body: "{}" });
			const assertion = expect(pending).rejects.toThrow();

			await vi.advanceTimersByTimeAsync(60_000);
			await assertion;
			expect(mockRequestUrl).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("still falls back to requestUrl on an ordinary native-fetch failure", async () => {
		// The CORS fallback must keep working — the timeout guard only suppresses it
		// for aborts, not for genuine errors.
		mockRequestUrl.mockResolvedValue(okResponse());
		const nativeFetch = vi.fn(async () => {
			throw new TypeError("Failed to fetch");
		});

		const fetchImpl = createObsidianFetch(nativeFetch);
		const response = await fetchImpl("https://example.com/v1/embeddings", { method: "POST", body: "{}" });

		expect(response.status).toBe(200);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});

	it("clears its timer on success, so a fast call leaves nothing pending", async () => {
		vi.useFakeTimers();
		try {
			mockRequestUrl.mockResolvedValue(okResponse());

			const fetchImpl = createObsidianFetch();
			await fetchImpl("https://example.com/v1/embeddings", { method: "POST", body: "{}" });

			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

/*
 * The timeout covers the server's whole computation for a non-streamed request,
 * which grows with the input: a flat 60 s timed out every full embedding batch
 * against a slow local server (#544).
 */
describe("requestTimeoutMs", () => {
	it("keeps small requests on the 60 s floor", () => {
		expect(requestTimeoutMs(undefined)).toBe(60_000);
		expect(requestTimeoutMs("{}")).toBe(60_000);
		expect(requestTimeoutMs("x".repeat(1_999))).toBe(60_000);
	});

	it("adds a second per 2,000 characters of body", () => {
		expect(requestTimeoutMs("x".repeat(120_000))).toBe(120_000);
		expect(requestTimeoutMs(new Uint8Array(20_000))).toBe(70_000);
		expect(requestTimeoutMs(new ArrayBuffer(4_000))).toBe(62_000);
	});

	it("caps at five minutes", () => {
		expect(requestTimeoutMs("x".repeat(10_000_000))).toBe(300_000);
	});

	it("fires the scaled timeout, not the floor, for a large body", async () => {
		vi.useFakeTimers();
		try {
			mockRequestUrl.mockReset();
			mockRequestUrl.mockReturnValue(new Promise(() => {}) as ReturnType<typeof requestUrl>);
			const fetchImpl = createObsidianFetch();
			let settled = false;
			const pending = fetchImpl("http://localhost:8008/v1/embeddings", {
				method: "POST",
				body: "x".repeat(120_000),
			}).catch((error: unknown) => {
				settled = true;
				return error;
			});

			await vi.advanceTimersByTimeAsync(60_000);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(await pending).toMatchObject({ name: "TimeoutError" });
		} finally {
			vi.useRealTimers();
		}
	});
});

/*
 * Timeout must be distinguishable from user cancellation.
 *
 * Both abort the same signal, but callers act on them differently: the indexing
 * loop treats a user cancel as "stop now" and a timeout as "the provider may be
 * down — retry once, then notify". Flattening both to `AbortError` silently
 * disabled that recovery path on the requestUrl leg.
 */
describe("createObsidianFetch abort reasons", () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
		mockRequestUrl.mockReturnValue(new Promise(() => {}) as ReturnType<typeof requestUrl>);
	});

	it("rejects with TimeoutError when the timeout fires", async () => {
		vi.useFakeTimers();
		try {
			const fetchImpl = createObsidianFetch();
			const pending = fetchImpl("https://unreachable.example/v1/embeddings", { method: "POST", body: "{}" });
			const assertion = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });

			await vi.advanceTimersByTimeAsync(60_000);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects with AbortError when the caller cancels", async () => {
		const controller = new AbortController();
		const fetchImpl = createObsidianFetch();
		const pending = fetchImpl("https://unreachable.example/v1/embeddings", {
			method: "POST",
			body: "{}",
			signal: controller.signal,
		});
		const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });

		controller.abort();
		await assertion;
	});
});
