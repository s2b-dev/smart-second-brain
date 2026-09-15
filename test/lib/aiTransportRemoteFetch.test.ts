import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performAiFetch } from "../../src/lib/aiTransport";

/**
 * Regression for #472: `electron.remote.net.fetch` runs in the main process, so
 * an `AbortSignal` handed to it crosses the `@electron/remote` bridge as a proxy
 * object, and undici on Electron 40+ (Node 24) rejects it with "RequestInit:
 * Expected signal (...) to be an instance of AbortSignal". The transport must
 * never pass the signal across, and honour cancellation on the renderer side —
 * including after a streaming consumer has locked the response body (the case
 * that a plain `body.cancel()` cannot handle).
 */

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type FetchInit = RequestInit & { headers?: unknown };

const URL = "http://127.0.0.1:9/v1/models";

function streamOf(chunks: Uint8Array[], onCancel?: (reason?: unknown) => void): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(chunks[i++]);
			} else {
				controller.close();
			}
		},
		cancel(reason) {
			onCancel?.(reason);
		},
	});
}

/** A pending stream that never yields until cancelled — models an open request. */
function openStream(onCancel: (reason?: unknown) => void): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		pull() {
			// Never resolves on its own; only cancellation ends it.
			return new Promise<void>(() => {});
		},
		cancel(reason) {
			onCancel(reason);
		},
	});
}

describe("performAiFetch over electron.remote.net.fetch", () => {
	let remoteFetch: ReturnType<typeof vi.fn<FetchFn>>;
	const win = window as unknown as { require?: (id: string) => unknown };
	let originalRequire: typeof win.require;

	beforeEach(() => {
		remoteFetch = vi.fn<FetchFn>(async () => new Response("ok", { status: 200 }));
		originalRequire = win.require;
		win.require = (id: string) => (id === "electron" ? { remote: { net: { fetch: remoteFetch } } } : undefined);
	});

	afterEach(() => {
		win.require = originalRequire;
	});

	it("never hands the AbortSignal to the main-process fetch", async () => {
		const controller = new AbortController();
		await performAiFetch("p", URL, {
			method: "POST",
			body: "{}",
			headers: { "content-type": "application/json" },
			signal: controller.signal,
		});

		expect(remoteFetch).toHaveBeenCalledTimes(1);
		const init = remoteFetch.mock.calls[0][1] as FetchInit;
		expect("signal" in init).toBe(false);
		expect(init.method).toBe("POST");
		// Headers cross the bridge as a plain record, not a Headers instance.
		expect(init.headers).toEqual({ "content-type": "application/json" });
	});

	it("rejects with an AbortError up front when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(performAiFetch("p", URL, { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(remoteFetch).not.toHaveBeenCalled();
	});

	it("rejects an in-flight request on abort and cancels the source when it lands", async () => {
		let resolveRemote: (response: Response) => void = () => {};
		remoteFetch.mockImplementation(() => {
			return new Promise<Response>((resolve) => {
				resolveRemote = resolve;
			});
		});
		const controller = new AbortController();

		const pending = performAiFetch("p", URL, { signal: controller.signal });
		await vi.waitFor(() => expect(remoteFetch).toHaveBeenCalledTimes(1));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });

		const cancel = vi.fn<(reason?: unknown) => void>();
		resolveRemote(new Response(openStream(cancel), { status: 200 }));
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
	});

	it("tears down a locked, actively-read stream on abort", async () => {
		const cancel = vi.fn<(reason?: unknown) => void>();
		remoteFetch.mockImplementation(async () => new Response(openStream(cancel), { status: 200 }));
		const controller = new AbortController();

		const response = await performAiFetch("p", URL, { signal: controller.signal });
		// The OpenAI SDK acquires a reader immediately, locking the body.
		const reader = response.body!.getReader();
		const read = reader.read();

		controller.abort();

		// The pending read rejects with the abort reason, and the source (which the
		// wrapper — not the SDK — owns) is cancelled, tearing down the request.
		await expect(read).rejects.toMatchObject({ name: "AbortError" });
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("streams the body through unchanged when never aborted", async () => {
		const enc = new TextEncoder();
		remoteFetch.mockImplementation(
			async () => new Response(streamOf([enc.encode("hello "), enc.encode("world")]), { status: 200 }),
		);
		const controller = new AbortController();

		const response = await performAiFetch("p", URL, { signal: controller.signal });
		expect(await response.text()).toBe("hello world");
	});

	it("passes the signal straight through when only window.fetch is available", async () => {
		win.require = undefined;
		const nativeFetch = vi.fn<FetchFn>(async () => new Response("ok", { status: 200 }));
		const originalFetch = window.fetch;
		window.fetch = nativeFetch as unknown as typeof fetch;
		try {
			const controller = new AbortController();
			await performAiFetch("p", URL, { signal: controller.signal });
			expect(nativeFetch).toHaveBeenCalledTimes(1);
			expect(nativeFetch.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
		} finally {
			window.fetch = originalFetch;
		}
	});
});
