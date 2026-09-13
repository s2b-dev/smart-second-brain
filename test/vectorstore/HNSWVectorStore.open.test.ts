import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Regression: `indexedDB.open` fires `blocked` — and then NEITHER `success` NOR
 * `error` — when another connection holds the same database at an older version.
 * The DB name is per-vault, so a second Obsidian window on the same vault hits
 * exactly this. Without an `onblocked` handler the open promise never settled,
 * hanging VectorStoreService init forever with no error surfaced anywhere.
 *
 * The mirror image is `versionchange`: without that handler *we* are the
 * connection that never yields, blocking the other window indefinitely.
 */

vi.mock("hnsw", () => ({
	HNSW: class {},
}));

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { HNSWVectorStore } from "../../src/vectorstore/HNSWVectorStore";

type OpenRequest = {
	onerror: null | (() => void);
	onsuccess: null | ((event: unknown) => void);
	onblocked: null | (() => void);
	onupgradeneeded: null | ((event: unknown) => void);
	error: unknown;
	result: unknown;
};

let openRequest: OpenRequest;
let fakeDbInstance: { onversionchange: null | (() => void); close: ReturnType<typeof vi.fn> };

/** Minimal object-store/transaction stand-in for the reads `open()` performs. */
function makeConnection() {
	return {
		onversionchange: null as null | (() => void),
		close: vi.fn(),
		objectStoreNames: { contains: () => true },
		transaction: () => {
			const tx = {
				objectStore: () => ({
					getAll: () => makeReq([]),
					get: () => makeReq(undefined),
					// `open()` reads each id store's high-water mark; null = empty.
					openKeyCursor: () => makeReq(null),
				}),
				onerror: null as null | (() => void),
				onabort: null as null | (() => void),
				error: null,
			};
			return tx;
		},
	};
}

function makeReq(result: unknown) {
	const req = {
		onsuccess: null as null | (() => void),
		onerror: null as null | (() => void),
		result,
		error: null,
	};
	queueMicrotask(() => req.onsuccess?.());
	return req;
}

beforeEach(() => {
	vi.useFakeTimers();
	openRequest = {
		onerror: null,
		onsuccess: null,
		onblocked: null,
		onupgradeneeded: null,
		error: null,
		result: null,
	};
	fakeDbInstance = makeConnection();
	openRequest.result = fakeDbInstance;
	vi.stubGlobal("indexedDB", { open: vi.fn(() => openRequest) });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("HNSWVectorStore.open — blocked handling", () => {
	it("rejects with an actionable error when the open stays blocked", async () => {
		const store = new HNSWVectorStore("vault-1");
		// Settle-or-hang probe rather than a bare `rejects` assertion: without the
		// onblocked handler this promise never settles at all, and awaiting it
		// directly would hang the whole test run instead of failing. Tracking
		// settlement in a variable turns "never settles" into a legible failure.
		let outcome: string | undefined;
		void store.open().then(
			() => {
				outcome = "resolved";
			},
			(e: unknown) => {
				outcome = e instanceof Error ? e.message : String(e);
			},
		);

		// Another connection holds an older version: `blocked` fires, and crucially
		// neither `success` nor `error` ever will.
		openRequest.onblocked?.();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(outcome).toMatch(/another Obsidian window has it open/i);
	});

	it("still succeeds when the blocking connection closes before the timeout", async () => {
		const store = new HNSWVectorStore("vault-1");
		const opened = store.open();

		openRequest.onblocked?.();
		// The other window's versionchange handler closes its connection, so the
		// upgrade proceeds and `success` arrives normally.
		await vi.advanceTimersByTimeAsync(2_000);
		openRequest.onsuccess?.({ target: { result: fakeDbInstance } });
		await vi.advanceTimersByTimeAsync(0);

		await expect(opened).resolves.toBeUndefined();
	});

	it("does not reject after a late timer fires post-success", async () => {
		const store = new HNSWVectorStore("vault-1");
		const opened = store.open();

		openRequest.onblocked?.();
		openRequest.onsuccess?.({ target: { result: fakeDbInstance } });
		await vi.advanceTimersByTimeAsync(0);
		await expect(opened).resolves.toBeUndefined();

		// The blocked timer must have been cancelled; advancing past it changes nothing.
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(opened).resolves.toBeUndefined();
	});

	it("propagates a genuine open error", async () => {
		const store = new HNSWVectorStore("vault-1");
		const opened = store.open();

		openRequest.error = new Error("quota exceeded");
		openRequest.onerror?.();

		await expect(opened).rejects.toThrow(/quota exceeded/);
	});
});

describe("HNSWVectorStore reads — transaction abort", () => {
	/**
	 * A transaction can abort without ever firing `error` on its request — the
	 * connection being force-closed (which our own versionchange handler now does),
	 * or storage eviction. Only `tx.onabort` fires, so a read wired solely to
	 * `request.onerror`/`onsuccess` would hang its caller forever.
	 */
	it("rejects a pending read when the transaction aborts", async () => {
		let capturedTx: { onabort: null | (() => void); onerror: null | (() => void); error: unknown } | null = null;
		const connection = {
			onversionchange: null as null | (() => void),
			close: vi.fn(),
			objectStoreNames: { contains: () => true },
			transaction: () => {
				const tx = {
					// A request that never fires success or error on its own.
					objectStore: () => ({
						getAll: () => ({ onsuccess: null, onerror: null, result: undefined, error: null }),
						get: () => ({ onsuccess: null, onerror: null, result: undefined, error: null }),
					}),
					onerror: null as null | (() => void),
					onabort: null as null | (() => void),
					error: null as unknown,
				};
				capturedTx = tx;
				return tx;
			},
		};
		openRequest.result = connection;

		const store = new HNSWVectorStore("vault-1");
		const opened = store.open();
		openRequest.onsuccess?.({ target: { result: connection } });
		await vi.advanceTimersByTimeAsync(0);

		// open() awaits loadIdMappings, whose transaction we now abort.
		expect(capturedTx).not.toBeNull();
		(capturedTx as unknown as { onabort: () => void }).onabort();

		await expect(opened).rejects.toThrow(/aborted/i);
	});
});

describe("HNSWVectorStore.open — versionchange", () => {
	it("closes our connection so another window's upgrade can proceed", async () => {
		const store = new HNSWVectorStore("vault-1");
		const opened = store.open();

		openRequest.onsuccess?.({ target: { result: fakeDbInstance } });
		await vi.advanceTimersByTimeAsync(0);
		await opened;

		// Regression: without this handler we'd be the connection that blocks the
		// other window forever — the deadlock's other half.
		expect(fakeDbInstance.onversionchange).toBeTypeOf("function");
		fakeDbInstance.onversionchange?.();
		expect(fakeDbInstance.close).toHaveBeenCalled();
	});
});
