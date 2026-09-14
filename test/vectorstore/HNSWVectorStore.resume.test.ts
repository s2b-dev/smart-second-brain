import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

/*
 * #432 part 2: a bulk embed run can be killed by the OS mid-build. Document
 * rows are durable on every `upsert`, but the graph topology is saved on a
 * debounce and at checkpoints (`flush`). Rows written after the last save used
 * to be silently unsearchable after a reopen while still counting as indexed,
 * so nothing ever repaired them. `loadGraph` now re-links such rows.
 */

import { HNSWVectorStore } from "../../src/vectorstore/HNSWVectorStore";
import type { DocumentVector } from "../../src/vectorstore/types";

function doc(path: string, vector: number[]): DocumentVector {
	return { id: `${path}#0`, path, mtime: 1, chunkIndex: 0, vector: new Float32Array(vector) };
}

async function openStore(): Promise<HNSWVectorStore> {
	const store = new HNSWVectorStore("vault-1", "index-1");
	await store.open();
	return store;
}

/** A build writes the metadata record first (`buildFullIndex` → `setMetadata`); mirror that. */
async function openForBuild(): Promise<HNSWVectorStore> {
	const store = await openStore();
	await store.setMetadata("p", "m", 2);
	return store;
}

/** Graph-side state, to prove hits came through the HNSW graph and not the brute-force fallback. */
function graphNodeCount(store: HNSWVectorStore): number | undefined {
	return (store as unknown as { hnswIndex: { nodes: Map<number, unknown> } | null }).hnswIndex?.nodes.size;
}

beforeEach(() => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	vi.stubGlobal("IDBKeyRange", IDBKeyRange);
	// Only the debounce timer is faked, so the pending graph save never fires —
	// that is the "killed before the debounce" state. fake-indexeddb schedules
	// its own work on setImmediate, which must keep running.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("HNSWVectorStore — resuming after an interrupted build", () => {
	it("re-links rows written after the last checkpoint on the next open", async () => {
		const first = await openForBuild();
		await first.upsert(doc("a.md", [1, 0, 0]));
		await first.upsert(doc("b.md", [0, 1, 0]));
		await first.flush(); // checkpoint: a and b are in the persisted graph
		await first.upsert(doc("c.md", [0, 0, 1])); // after the checkpoint; never saved
		// No close(): the process died here.

		const second = await openStore();
		const hits = await second.search(new Float32Array([0, 0, 1]), 1);
		expect(hits.map((h) => h.path)).toEqual(["c.md"]);
		expect(graphNodeCount(second)).toBe(3);
		// And the earlier rows are still reachable through the graph.
		const older = await second.search(new Float32Array([1, 0, 0]), 1);
		expect(older.map((h) => h.path)).toEqual(["a.md"]);
		await second.close();
	});

	it("builds the graph from rows alone when no checkpoint was ever written", async () => {
		const first = await openForBuild();
		await first.upsert(doc("a.md", [1, 0]));
		await first.upsert(doc("b.md", [0, 1]));

		const second = await openStore();
		expect(await second.count()).toBe(2);
		const hits = await second.search(new Float32Array([0, 1]), 1);
		expect(hits.map((h) => h.path)).toEqual(["b.md"]);
		expect(graphNodeCount(second)).toBe(2);
		await second.close();
	});

	it("listNoteMeta omits a note whose chunk-0 row is missing (write interrupted mid-note)", async () => {
		const store = await openForBuild();
		// Bulk writers store chunk 0 last; a kill after chunk 1 leaves exactly this.
		await store.upsert({
			id: "big.md#1",
			path: "big.md",
			mtime: 5,
			chunkIndex: 1,
			vector: new Float32Array([0, 1]),
		});
		await store.upsert(doc("small.md", [1, 0]));

		expect((await store.listNoteMeta()).map((n) => n.path)).toEqual(["small.md"]);
		expect(await store.countNotes()).toBe(2);
		expect(await store.count()).toBe(2);

		await store.upsert({
			id: "big.md#0",
			path: "big.md",
			mtime: 5,
			chunkIndex: 0,
			vector: new Float32Array([1, 1]),
		});
		expect((await store.listNoteMeta()).map((n) => n.path).sort()).toEqual(["big.md", "small.md"]);
		await store.close();
	});

	it("keeps allocating fresh ids after a reopen when no metadata record was ever written", async () => {
		// The old validation path embedded into a fresh store without `setMetadata`,
		// so nothing persisted the id counter. Reopening restored 0 and every new
		// chunk collided with a live graph node ("Node with id N already exists").
		const first = await openStore(); // no setMetadata: rows and graph only
		await first.upsert(doc("a.md", [1, 0, 0]));
		await first.upsert(doc("b.md", [0, 1, 0]));
		await first.flush();

		const second = await openStore();
		await expect(second.upsert(doc("c.md", [0, 0, 1]))).resolves.toBeUndefined();
		expect(await second.count()).toBe(3);
		expect(graphNodeCount(second)).toBe(3);
		const hits = await second.search(new Float32Array([0, 0, 1]), 1);
		expect(hits.map((h) => h.path)).toEqual(["c.md"]);
		// a.md still resolves to its own row: no mapping was overwritten.
		const older = await second.search(new Float32Array([1, 0, 0]), 1);
		expect(older.map((h) => h.path)).toEqual(["a.md"]);
		await second.close();
	});

	it("clears a graph node whose mapping was lost to an interrupted removal", async () => {
		// `remove()` drops mappings before rows in separate transactions; a kill in
		// between leaves c's row and graph node with no mapping. Its id must still
		// be off limits on the next open, or the next upsert collides with it.
		const first = await openStore();
		await first.upsert(doc("a.md", [1, 0, 0]));
		await first.upsert(doc("b.md", [0, 1, 0]));
		await first.upsert(doc("c.md", [0, 0, 1])); // numeric id 2, the high-water mark
		await first.flush();
		const dbName = (first as unknown as { dbName: string }).dbName;
		await new Promise<void>((resolve, reject) => {
			const open = indexedDB.open(dbName);
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const db = open.result;
				const tx = db.transaction("id_mapping", "readwrite");
				tx.objectStore("id_mapping").delete(2);
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
		});

		const second = await openStore();
		await expect(second.upsert(doc("d.md", [1, 1, 0]))).resolves.toBeUndefined();
		expect(await second.count()).toBe(4);
		const hits = await second.search(new Float32Array([1, 1, 0]), 1);
		expect(hits.map((h) => h.path)).toEqual(["d.md"]);
		await second.close();
	});

	it("loads the persisted graph once when a search and an upsert race to initialise it", async () => {
		const first = await openForBuild();
		await first.upsert(doc("a.md", [1, 0, 0]));
		await first.flush();
		await first.close();

		// A reopened store has its dimensions but no graph yet; both calls try to
		// load it. The upsert's load used to finish first and receive the new point,
		// then the search's load replaced the whole graph and lost it for the session.
		const second = await openStore();
		const loads = vi.spyOn(second as unknown as { loadGraph: () => Promise<void> }, "loadGraph");
		const [, hits] = await Promise.all([
			second.upsert(doc("b.md", [0, 1, 0])),
			second.search(new Float32Array([1, 0, 0]), 1),
		]);
		expect(loads).toHaveBeenCalledTimes(1);
		expect(hits.map((h) => h.path)).toEqual(["a.md"]);
		expect(graphNodeCount(second)).toBe(2);
		expect((await second.search(new Float32Array([0, 1, 0]), 1)).map((h) => h.path)).toEqual(["b.md"]);
		await second.close();
	});

	it("flush() persists the pending graph immediately instead of on the debounce", async () => {
		const first = await openForBuild();
		await first.upsert(doc("a.md", [1, 0]));
		await first.flush();

		// The persisted topology alone must describe the node — no re-link log.
		const second = await openStore();
		const persisted = second as unknown as { getGraphHeader: () => Promise<unknown> };
		expect(await persisted.getGraphHeader()).not.toBeNull();
		await second.search(new Float32Array([1, 0]), 1);
		expect(graphNodeCount(second)).toBe(1);
		await second.close();
	});
});
