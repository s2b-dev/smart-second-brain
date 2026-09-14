import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `close()` terminates the worker, which discards its reply queue. A request
 * still in flight at that moment must be rejected, not left pending forever:
 * a bulk run whose `upsert` was in flight when its index was deleted hung on
 * that await, so its `finally` never ran and the progress notice never cleared.
 */

const { FakeWorker, workers } = vi.hoisted(() => {
	interface Posted {
		id: number;
		method: string;
	}
	class FakeWorker {
		onmessage: ((e: { data: { id: number; result?: unknown; error?: string } }) => void) | null = null;
		onerror: ((e: { message: string }) => void) | null = null;
		posted: Posted[] = [];
		terminate = vi.fn();

		/** A wedged worker answers nothing, not even `close`. */
		wedged = false;

		postMessage(request: Posted): void {
			this.posted.push(request);
			if (this.wedged) return;
			// Only `init` and `close` are answered; everything else stays in flight,
			// which is the state a deletion mid-build finds the store in.
			if (request.method === "init" || request.method === "close") {
				queueMicrotask(() => this.onmessage?.({ data: { id: request.id } }));
			}
		}
	}
	return { FakeWorker, workers: [] as FakeWorker[] };
});

vi.mock("../../src/vectorstore/hnswWorker?worker&inline", () => ({
	default: class extends FakeWorker {
		constructor() {
			super();
			workers.push(this);
		}
	},
}));

import { HNSWWorkerProxy } from "../../src/vectorstore/HNSWWorkerProxy";

/**
 * Observe how a request settles. The handler is attached at once, so a
 * rejection that lands before the assertion runs is never unhandled.
 */
function settle(request: Promise<unknown>): Promise<string> {
	return request.then(
		() => "resolved",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
}

beforeEach(() => {
	workers.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("HNSWWorkerProxy.close", () => {
	it("rejects every request still in flight, then refuses new ones", async () => {
		const proxy = new HNSWWorkerProxy("vault-1", "index-1");
		const worker = workers[0];
		const inFlight = settle(
			proxy.upsert({
				id: "a.md#0",
				path: "a.md",
				mtime: 1,
				checksum: "c",
				chunkIndex: 0,
				vector: new Float32Array([1, 0]),
			}),
		);
		const alsoInFlight = settle(proxy.count());
		await vi.waitFor(() => expect(worker.posted.map((p) => p.method)).toEqual(["init", "upsert", "count"]));

		await proxy.close();

		expect(worker.terminate).toHaveBeenCalledTimes(1);
		expect(await inFlight).toMatch(/closed/);
		expect(await alsoInFlight).toMatch(/closed/);
		// Nothing is posted into a terminated worker; the call fails at once.
		expect(await settle(proxy.count())).toMatch(/closed/);
		expect(worker.posted.map((p) => p.method)).toEqual(["init", "upsert", "count", "close"]);
	});

	it("terminates a worker that never acknowledges the close, after a bounded wait", async () => {
		vi.useFakeTimers();
		try {
			const proxy = new HNSWWorkerProxy("vault-1", "index-1");
			const worker = workers[0];
			worker.wedged = true;
			const inFlight = settle(proxy.count());
			// Track settlement rather than awaiting: an unbounded wait would hang the run.
			let closed = false;
			const closing = proxy.close().then(() => {
				closed = true;
			});
			await vi.advanceTimersByTimeAsync(9_999);
			expect(closed).toBe(false);
			expect(worker.terminate).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await closing;
			expect(worker.terminate).toHaveBeenCalledTimes(1);
			expect(await inFlight).toMatch(/closed/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a worker script error settles every request in flight", async () => {
		const proxy = new HNSWWorkerProxy("vault-1", "index-1");
		const worker = workers[0];
		const inFlight = settle(proxy.count());
		worker.onerror?.({ message: "boom" });
		expect(await inFlight).toMatch(/worker failed: boom/);
	});

	it("is idempotent", async () => {
		const proxy = new HNSWWorkerProxy("vault-1", "index-1");
		await proxy.close();
		await proxy.close();
		expect(workers[0].terminate).toHaveBeenCalledTimes(1);
	});
});
