import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performAiFetch } from "../../src/lib/aiTransport";

/**
 * Regression for #472: `electron.remote.net.fetch` runs in the main process,
 * so an `AbortSignal` handed to it crosses the `@electron/remote` bridge as a
 * proxy object, and undici on Electron 40+ (Node 24) rejects it with
 * "RequestInit: Expected signal (...) to be an instance of AbortSignal". The
 * transport must therefore never pass the signal across, and honour
 * cancellation on the renderer side instead.
 */

type FetchInit = RequestInit & { headers?: unknown };
type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type CancelFn = (reason?: unknown) => Promise<void>;

function fakeResponse(cancel = vi.fn<CancelFn>(async () => {})): Response {
	return { ok: true, status: 200, headers: {}, body: { cancel } } as unknown as Response;
}

const URL = "http://127.0.0.1:9/v1/models";

describe("performAiFetch over electron.remote.net.fetch", () => {
	let remoteFetch: ReturnType<typeof vi.fn<FetchFn>>;
	const win = window as unknown as { require?: (id: string) => unknown };
	let originalRequire: typeof win.require;

	beforeEach(() => {
		remoteFetch = vi.fn<FetchFn>(async () => fakeResponse());
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

	it("rejects an in-flight request on abort and cancels the body when it lands", async () => {
		let resolveRemote: (response: Response) => void = () => {};
		remoteFetch.mockImplementation(() => new Promise<Response>((resolve) => (resolveRemote = resolve)));
		const controller = new AbortController();

		const pending = performAiFetch("p", URL, { signal: controller.signal });
		// The transport resolves the Electron fetch asynchronously before calling it;
		// abort only once the request is genuinely in flight.
		await vi.waitFor(() => expect(remoteFetch).toHaveBeenCalledTimes(1));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });

		const cancel = vi.fn<CancelFn>(async () => {});
		resolveRemote(fakeResponse(cancel));
		await new Promise((r) => setTimeout(r, 0));
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("cancels the response body when aborted after the response arrived", async () => {
		const cancel = vi.fn<CancelFn>(async () => {});
		remoteFetch.mockImplementation(async () => fakeResponse(cancel));
		const controller = new AbortController();

		const response = await performAiFetch("p", URL, { signal: controller.signal });
		expect(response.ok).toBe(true);
		expect(cancel).not.toHaveBeenCalled();

		controller.abort();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(cancel.mock.calls[0][0]).toBe(controller.signal.reason);
	});

	it("passes the signal straight through when only window.fetch is available", async () => {
		win.require = undefined;
		const nativeFetch = vi.fn<FetchFn>(async () => fakeResponse());
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
