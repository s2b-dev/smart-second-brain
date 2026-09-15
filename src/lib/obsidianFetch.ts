import { requestUrl, type RequestUrlParam } from "obsidian";
import { Logger } from "../utils/logging";

/**
 * Ceiling on a single request made through this adapter.
 *
 * Neither `requestUrl` nor the native-fetch path has a timeout of its own, so an
 * unreachable host (VPN down, DNS blackhole, endpoint accepting the connection but
 * never responding) leaves the returned promise **permanently unsettled** rather
 * than rejecting. Every caller then waits forever: indexing freezes its progress
 * notice at the last count, and — because the abort check in the indexing loop runs
 * *after* the awaited embedding call — Cancel cannot stop it either.
 *
 * Sized from measured throughput rather than guessed. The slowest embedding model
 * benchmarked here runs at ~120 ms/chunk, and the largest default batch is 100
 * chunks (`getDefaultEmbeddingBatchSize`, OpenAI/OpenRouter), so a worst-case
 * legitimate batch is ~12 s. 60 s leaves a 5x margin over that while keeping the
 * wait short enough that a user learns something is wrong before giving up on the
 * app — the failure this bounds is "endpoint never answers", and every second past
 * the real ceiling is pure dead time.
 *
 * Note this bounds a *single* request, not a user-visible operation: provider SDKs
 * retry internally (the OpenAI client does several attempts with backoff), so an
 * unreachable host can still take a multiple of this before the caller sees an
 * error. That is the SDK's budget to spend, not ours to shorten here.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Reject when `signal` aborts, so a hung request can lose a race against it.
 *
 * Rejecting (rather than resolving) is deliberate: the caller is awaiting a
 * `Response`, and resolving with a sentinel would make every call site check for
 * it. `DOMException("…", "AbortError")` is what native fetch throws on abort, so
 * existing `error.name === "AbortError"` handling keeps working.
 *
 * **The abort *reason* is propagated, not flattened.** A timeout and a user
 * cancellation both abort this signal, but callers need to tell them apart: the
 * indexing loop treats `AbortError` as "the user stopped this" and bails
 * immediately, while a `TimeoutError` must reach the unreachable-provider path so
 * the run can retry once and then notify. Rejecting with a bare `AbortError` in
 * both cases silently disabled that recovery on the `requestUrl` leg.
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
	// Duck-typed rather than `instanceof Error`: `DOMException` is not an `Error`
	// subclass in every environment (notably jsdom, where the test suite runs), so
	// an instanceof check silently discarded the TimeoutError reason and reported
	// every timeout as a user cancellation.
	const abortError = () => {
		const reason: unknown = signal.reason;
		const named =
			typeof reason === "object" && reason !== null && typeof (reason as { name?: unknown }).name === "string";
		return named ? (reason as Error) : new DOMException("Request aborted", "AbortError");
	};
	return new Promise((_, reject) => {
		if (signal.aborted) {
			reject(abortError());
			return;
		}
		signal.addEventListener("abort", () => reject(abortError()), { once: true });
	});
}

/**
 * Creates a custom fetch implementation that uses Obsidian's requestUrl
 * to bypass CORS restrictions in the plugin environment.
 *
 * Strategy:
 * 1. Always try native fetch first - this supports streaming which is needed for LLM APIs
 * 2. Fall back to Obsidian's requestUrl if native fetch fails (CORS errors, etc.)
 *
 * Note: LLM APIs (OpenAI, Anthropic, etc.) have proper CORS headers and work with native fetch.
 * MCP servers may not have CORS headers, so they fall back to requestUrl.
 */
export function createObsidianFetch(
	originalFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = input.toString();

		// One controller per request, aborted by whichever fires first: our timeout,
		// or the caller's own signal. The native-fetch path below gets this signal
		// directly; `requestUrl` cannot be aborted at all, so it is *raced* against
		// it instead — the request keeps running in the background but stops holding
		// the caller hostage.
		const timeoutController = new AbortController();
		const timeoutId = window.setTimeout(() => {
			timeoutController.abort(
				new DOMException(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`, "TimeoutError"),
			);
		}, REQUEST_TIMEOUT_MS);
		const callerSignal = init?.signal;
		const onCallerAbort = () => timeoutController.abort();
		// Check `aborted` before subscribing: a signal that is *already* aborted
		// never fires the event, so listener-only wiring would miss it and the
		// request would hang — the exact failure this whole guard exists to prevent.
		if (callerSignal?.aborted) {
			timeoutController.abort();
		} else {
			callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
		}
		const settled = timeoutController.signal;
		const cleanup = () => {
			window.clearTimeout(timeoutId);
			callerSignal?.removeEventListener("abort", onCallerAbort);
		};

		try {
			return await requestWithFallback(input, init, url, settled, originalFetch);
		} finally {
			cleanup();
		}
	};
}

/**
 * The original two-stage request: native fetch first (needed for streaming), then
 * Obsidian's `requestUrl` as a CORS fallback. Split out so the timeout wiring above
 * can wrap it in a single `try`/`finally` without indenting the whole body.
 */
async function requestWithFallback(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	url: string,
	settled: AbortSignal,
	originalFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<Response> {
	const toPlainArrayBuffer = (view: ArrayBufferView): ArrayBuffer => {
		const copy = new Uint8Array(view.byteLength);
		copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
		return copy.buffer;
	};

	// Try using the original fetch first to support streaming
	// LLM APIs have proper CORS headers and need native fetch for streaming
	if (originalFetch) {
		try {
			// We clone the init object to avoid side effects if fetch modifies it,
			// though usually it doesn't.
			// NOTE: If body is a ReadableStream and it gets locked/consumed by originalFetch,
			// fallback to requestUrl might fail. But usually for LLM calls body is a string (JSON).
			// `settled` merges our timeout with the caller's own signal, so a hung
			// native fetch aborts instead of pinning the caller indefinitely.
			return await originalFetch(input, { ...init, signal: settled });
		} catch (e) {
			// A timeout/abort must NOT fall through to the requestUrl path — that
			// would start a second, equally unbounded request against a host we
			// already know is not answering, doubling the wait.
			if (settled.aborted) throw e;
			// If original fetch fails (likely CORS or network), fallback to requestUrl
			// This handles MCP servers that don't have CORS headers
		}
	}

	const method = init?.method || "GET";
	const body = init?.body;

	// Normalize HeadersInit (Headers | [k,v][] | Record) into the plain record requestUrl
	// expects. This MUST build a new object rather than casting `init.headers` and writing
	// onto it: a `Headers` instance cast to Record aliases itself, so the copy loop below
	// set properties on the Headers object instead of a record, and requestUrl — which
	// only reads own enumerable string props — saw no headers at all. With the auth header
	// silently dropped the request never completed and the returned promise never settled,
	// hanging every caller forever (observed as indexing stuck at 0/N: the OpenAI SDK
	// always passes a Headers instance, so every embedding call wedged).
	const headers: Record<string, string> = {};
	const rawHeaders = init?.headers;
	if (rawHeaders instanceof Headers) {
		rawHeaders.forEach((value, key) => {
			headers[key] = value;
		});
	} else if (Array.isArray(rawHeaders)) {
		for (const [key, value] of rawHeaders) {
			headers[key] = value;
		}
	} else if (rawHeaders) {
		Object.assign(headers, rawHeaders);
	}

	// If the body is a byte array (Uint8Array), requestUrl expects it as an ArrayBuffer
	// However, for multipart/form-data or gzipped content, we might need special handling

	let requestBody: RequestUrlParam["body"] = typeof body === "string" ? body : undefined;
	// Check if body exists and is NOT a string (so it's likely binary)
	if (init?.body && typeof init.body !== "string") {
		// Handle Uint8Array specifically (common in node/browser buffers)
		if (init.body instanceof Uint8Array) {
			requestBody = toPlainArrayBuffer(init.body);
		}
		// Handle generic ArrayBufferView
		else if (ArrayBuffer.isView(init.body)) {
			requestBody = toPlainArrayBuffer(init.body);
		}
		// Handle raw ArrayBuffer
		else if (init.body instanceof ArrayBuffer) {
			requestBody = init.body;
		}
		// Handle Blob
		else if (init.body instanceof Blob) {
			requestBody = await init.body.arrayBuffer();
		}
		// Handle ReadableStream
		else if (init.body instanceof ReadableStream) {
			// We need to read the stream into an ArrayBuffer
			const reader = init.body.getReader();
			const chunks: Uint8Array[] = [];
			let totalLength = 0;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!(value instanceof Uint8Array)) continue;
				chunks.push(value);
				totalLength += value.length;
			}

			// Merge chunks into a single Uint8Array
			const result = new Uint8Array(totalLength);
			let offset = 0;
			for (const chunk of chunks) {
				result.set(chunk, offset);
				offset += chunk.length;
			}

			requestBody = result.buffer;
		}
	}

	// CRITICAL: requestUrl in Obsidian often tries to set Content-Type automatically
	// If we are sending binary data (like gzip), we must ensure we don't double-encode or mess up headers.

	// LangSmith/LangChain sends 'Content-Encoding: gzip' header.
	// Ensure we are passing the raw buffer.

	const requestParams: RequestUrlParam = {
		url,
		method,
		headers,
		body: requestBody,
		throw: false, // Don't throw on 4xx/5xx to match fetch behavior
	};

	try {
		// `requestUrl` accepts no signal and cannot be cancelled, so this races it
		// against the timeout rather than aborting it. The underlying request may
		// still be in flight afterwards — that is an accepted leak, and far better
		// than the caller hanging forever with no way out.
		const response = await Promise.race([requestUrl(requestParams), rejectOnAbort(settled)]);

		const responseHeaders: Record<string, string> = {
			...response.headers,
		};

		// Obsidian's requestUrl may strip the content-type header from responses.
		// The OpenAI SDK requires it to parse JSON responses correctly.
		if (!responseHeaders["content-type"] && !responseHeaders["Content-Type"]) {
			responseHeaders["content-type"] = "application/json";
		}

		// Convert Obsidian response to standard Response object
		return new Response(response.text, {
			status: response.status,
			headers: responseHeaders,
		});
	} catch (error) {
		// Name the timeout explicitly. Without this the failure surfaced as a
		// generic proxy error (or, before the timeout existed, as no log at all
		// and a frozen progress notice), which gave no hint that the endpoint was
		// simply unreachable.
		if (settled.aborted) {
			Logger.error(`Obsidian fetch timed out or was aborted after ${REQUEST_TIMEOUT_MS}ms: ${url}`);
		} else {
			Logger.error("Obsidian fetch proxy error:", error);
		}
		throw error;
	}
}

/**
 * Ref-counted installer for the global `fetch` patch used by MCP clients (which
 * read `globalThis.fetch` at call time and can't be handed a fetch directly).
 *
 * Multiple callers may need the patch concurrently (e.g. two `fetchServerTools`
 * calls, or agent MCP tool-loading overlapping a settings-modal probe). The
 * naive `_originalFetch`-flag + `finally`-restore pattern corrupts under
 * concurrency: one caller's restore fires mid-flight of another, or the
 * original gets captured as an already-wrapped fetch and double-wrapped
 * permanently. Ref-counting installs once (on 0→1) and restores once (on 1→0),
 * so concurrent users are safe. `release()` is idempotent.
 */
let patchDepth = 0;
let savedFetch: typeof fetch | null = null;
/** The window's `fetch` slot, typed as a plain function property: it is swapped, never called via `this`. */
const fetchSlot = window as { fetch: typeof fetch };

export function installObsidianFetch(): { release: () => void } {
	if (patchDepth === 0) {
		savedFetch = fetchSlot.fetch;
		fetchSlot.fetch = createObsidianFetch(savedFetch);
	}
	patchDepth++;

	let released = false;
	return {
		release: () => {
			if (released) return;
			released = true;
			patchDepth--;
			if (patchDepth === 0 && savedFetch) {
				fetchSlot.fetch = savedFetch;
				savedFetch = null;
			}
		},
	};
}
