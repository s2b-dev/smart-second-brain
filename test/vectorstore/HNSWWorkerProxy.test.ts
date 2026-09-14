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

		postMessage(request: Posted): void {
			this.posted.push(request);
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
		const inFlight = proxy.upsert({
			id: "a.md#0",
			path: "a.md",
			mtime: 1,
			checksum: "c",
			chunkIndex: 0,
			vector: new Float32Array([1, 0]),
		});
		const alsoInFlight = proxy.count();
		await vi.waitFor(() => expect(worker.posted.map((p) => p.method)).toEqual(["init", "upsert", "count"]));

		await proxy.close();

		expect(worker.terminate).toHaveBeenCalledTimes(1);
		await expect(inFlight).rejects.toThrow(/closed/);
		await expect(alsoInFlight).rejects.toThrow(/closed/);
		// Nothing is posted into a terminated worker; the call fails at once.
		await expect(proxy.count()).rejects.toThrow(/closed/);
		expect(worker.posted.map((p) => p.method)).toEqual(["init", "upsert", "count", "close"]);
	});

	it("is idempotent", async () => {
		const proxy = new HNSWWorkerProxy("vault-1", "index-1");
		await proxy.close();
		await proxy.close();
		expect(workers[0].terminate).toHaveBeenCalledTimes(1);
	});
});
