import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

/*
 * Regression: `clear()` used to recreate the in-memory graph wrapper without
 * deleting the *persisted* graph. Because clear() also resets `nextHnswId` to 0,
 * the next indexing run reassigned numeric ids that were already present in the
 * resurrected graph. `search()` resolves each hit through `numericToId` and
 * `continue`s on a miss, so those collisions silently dropped results — semantic
 * search returned too few results, or none at all, for valid queries.
 *
 * Measured in the test vault before the fix: 337 indexed chunks but 10,161 nodes
 * in the persisted graph, with only 377 surviving id mappings.
 *
 * Since schema v3 the graph topology lives in the store's own database, so these
 * run against a real (in-memory) IndexedDB rather than mocking the old sidecar.
 */

import { HNSWVectorStore } from "../../src/vectorstore/HNSWVectorStore";
import type { DocumentVector } from "../../src/vectorstore/types";

type Internals = {
	hnswIndex: { nodes: Map<number, unknown> } | null;
	nextHnswId: number;
	hasPendingIndexSave: boolean;
	dimensions: number | null;
};
const internals = (store: HNSWVectorStore) => store as unknown as Internals;

function doc(path: string, vector: number[]): DocumentVector {
	return { id: `${path}#0`, path, mtime: 1, checksum: "c", chunkIndex: 0, vector: new Float32Array(vector) };
}

async function openStore(): Promise<HNSWVectorStore> {
	const store = new HNSWVectorStore("vault-1", "index-1");
	await store.open();
	return store;
}

beforeEach(() => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("HNSWVectorStore.clear", () => {
	it("deletes the persisted graph rather than only dropping the in-memory handle", async () => {
		const first = await openStore();
		await first.upsert(doc("a.md", [1, 0]));
		await first.upsert(doc("b.md", [0, 1]));
		await first.setMetadata("p", "m", 2);
		await first.close();

		const second = await openStore();
		await second.clear();
		// Re-index with ids starting at 0 again, then reopen: only the new graph may exist.
		await second.upsert(doc("c.md", [1, 1]));
		await second.setMetadata("p", "m", 2);
		await second.close();

		const third = await openStore();
		const hits = await third.search(new Float32Array([1, 1]), 10);
		expect(hits.map((h) => h.path)).toEqual(["c.md"]);
		// The whole point: stale nodes from the first run must not be resurrected.
		expect(internals(third).hnswIndex?.nodes.size).toBe(1);
		await third.close();
	});

	it("leaves a store that later upserts can insert into and search", async () => {
		const store = await openStore();
		await store.upsert(doc("a.md", [1, 0, 0]));
		await store.clear();

		await store.upsert(doc("b.md", [0, 1, 0]));
		const hits = await store.search(new Float32Array([0, 1, 0]), 5);
		expect(hits.map((h) => h.path)).toEqual(["b.md"]);
		await store.close();
	});

	it("resets the numeric id counter that the deleted graph was keyed on", async () => {
		const store = await openStore();
		for (let i = 0; i < 5; i++) await store.upsert(doc(`n${i}.md`, [i, 1]));
		expect(internals(store).nextHnswId).toBe(5);

		await store.clear();

		expect(internals(store).nextHnswId).toBe(0);
		await store.close();
	});

	it("forgets the dimensions so a differently sized model can take over", async () => {
		const store = await openStore();
		await store.upsert(doc("a.md", [1, 0, 0]));
		await store.clear();
		expect(internals(store).dimensions).toBeNull();

		await store.upsert(doc("b.md", [1, 0]));
		const hits = await store.search(new Float32Array([1, 0]), 1);
		expect(hits.map((h) => h.path)).toEqual(["b.md"]);
		await store.close();
	});

	it("drops any pending graph save so it cannot rewrite the cleared graph", async () => {
		// Only the debounce timer is faked: fake-indexeddb schedules its own work
		// on setImmediate, which must keep running for the store to respond.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const store = await openStore();
			await store.upsert(doc("a.md", [1, 0]));
			expect(internals(store).hasPendingIndexSave).toBe(true);

			await store.clear();
			expect(internals(store).hasPendingIndexSave).toBe(false);

			// Let the debounced save fire; it must be a no-op now.
			await vi.advanceTimersByTimeAsync(5_000);
			await store.close();

			const reopened = await openStore();
			expect(await reopened.count()).toBe(0);
			expect(await reopened.getMetadata()).toBeNull();
			await reopened.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears metadata, mappings and rows together", async () => {
		const store = await openStore();
		await store.upsert(doc("a.md", [1, 0]));
		await store.setMetadata("p", "m", 2);

		await store.clear();

		expect(await store.count()).toBe(0);
		expect(await store.getMetadata()).toBeNull();
		expect(await store.listNoteMeta()).toEqual([]);
		expect(store.providerId).toBeNull();
		expect(store.modelId).toBeNull();
		await store.close();
	});
});
