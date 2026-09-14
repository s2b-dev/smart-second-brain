import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

/*
 * Notes are written whole: `putNote` replaces every chunk of a path in one
 * transaction (rows, id mappings, metadata), `renameNote` re-keys them without
 * touching the graph, the graph save writes only the nodes an insert changed,
 * and search compensates for the nodes the library cannot delete.
 */

import { HNSWVectorStore } from "../../src/vectorstore/HNSWVectorStore";
import type { DocumentVector } from "../../src/vectorstore/types";

function chunk(path: string, vector: number[], chunkIndex = 0, mtime = 1_000): DocumentVector {
	return { id: `${path}#${chunkIndex}`, path, mtime, chunkIndex, vector: new Float32Array(vector) };
}

/** A one-hot vector of width `dim`. */
function oneHot(i: number, dim: number): number[] {
	const v = new Array<number>(dim).fill(0);
	v[i % dim] = 1;
	return v;
}

/** Deterministic pseudo-random unit-ish vectors, so graph shapes are stable across runs. */
function randomVectors(count: number, dim: number): number[][] {
	let seed = 42;
	const next = () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
	return Array.from({ length: count }, () => Array.from({ length: dim }, () => next() - 0.5));
}

type Internals = {
	hnswIndex: { nodes: Map<number, unknown> } | null;
	idToNumeric: Map<string, number>;
	numericToId: Map<number, string>;
	deadNodes: number;
	lastGraphSaveNodeCount: number;
	graphNeedsFullSave: boolean;
};
const internals = (store: HNSWVectorStore) => store as unknown as Internals;

async function openStore(): Promise<HNSWVectorStore> {
	const store = new HNSWVectorStore("vault-1", "index-1");
	await store.open();
	await store.setMetadata("p", "m", 2);
	return store;
}

beforeEach(() => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	vi.stubGlobal("IDBKeyRange", IDBKeyRange);
	// Only the debounce timer is faked: a graph save happens when a test flushes.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("HNSWVectorStore.putNote", () => {
	it("replaces every chunk of the note in one write: no leftovers, mappings match rows, and it persists", async () => {
		const store = await openStore();
		await store.putNote([chunk("a.md", [1, 0, 0], 0), chunk("a.md", [0, 1, 0], 1), chunk("a.md", [0, 0, 1], 2)]);
		expect(await store.count()).toBe(3);

		// The note shrank to one chunk with a new vector.
		await store.putNote([chunk("a.md", [0, 0, 1], 0, 2_000)]);
		expect(await store.count()).toBe(1);
		expect(internals(store).idToNumeric.size).toBe(1);
		expect(await store.listNoteMeta()).toEqual([{ path: "a.md", mtime: 2_000 }]);
		const hits = await store.search(new Float32Array([0, 0, 1]), 3);
		expect(hits.map((h) => h.id)).toEqual(["a.md#0"]);
		await store.close();

		const second = new HNSWVectorStore("vault-1", "index-1");
		await second.open();
		expect(await second.count()).toBe(1);
		expect(internals(second).numericToId.size).toBe(1);
		expect((await second.search(new Float32Array([0, 0, 1]), 3)).map((h) => h.id)).toEqual(["a.md#0"]);
		await second.close();
	});

	it("rejects an empty or mixed-path write without touching the store", async () => {
		const store = await openStore();
		await store.putNote([chunk("a.md", [1, 0])]);
		await expect(store.putNote([])).rejects.toThrow(/at least one chunk/);
		await expect(store.putNote([chunk("a.md", [1, 0]), chunk("b.md", [0, 1])])).rejects.toThrow(/belong/);
		expect(await store.count()).toBe(1);
		await store.close();
	});
});

describe("HNSWVectorStore — dead graph nodes", () => {
	it("search still returns k live hits after a session of replacements", async () => {
		const vectors = randomVectors(35, 8);
		const store = await openStore();
		for (let i = 0; i < 20; i++) await store.putNote([chunk(`n${i}.md`, vectors[i])]);
		// Replace three quarters of them: each replacement leaves a dead node behind.
		for (let i = 0; i < 15; i++) await store.putNote([chunk(`n${i}.md`, vectors[20 + i], 0, 2_000)]);
		expect(internals(store).hnswIndex?.nodes.size).toBe(35);
		expect(internals(store).deadNodes).toBe(15);

		// Twenty live notes, twenty asked for, twenty returned — the dead ones
		// used to occupy result slots and leave the caller short. (Random vectors
		// can be anti-correlated; the threshold must not hide any of them.)
		const hits = await store.search(new Float32Array(vectors[0]), 20, -1);
		expect(hits).toHaveLength(20);
		expect(new Set(hits.map((h) => h.path)).size).toBe(20);
		// And each live note still resolves to its own current vector.
		for (let i = 0; i < 20; i++) {
			const own = await store.search(new Float32Array(vectors[i < 15 ? 20 + i : i]), 1);
			expect(own.map((h) => h.path)).toEqual([`n${i}.md`]);
		}
		await store.close();
	});

	it("rebuilds the graph from the live vectors once the dead nodes outnumber them past the threshold", async () => {
		const statics = HNSWVectorStore as unknown as { COMPACT_DEAD_MIN: number };
		const original = statics.COMPACT_DEAD_MIN;
		statics.COMPACT_DEAD_MIN = 4;
		try {
			const store = await openStore();
			for (let i = 0; i < 5; i++) await store.putNote([chunk(`n${i}.md`, oneHot(i, 5))]);
			for (let i = 0; i < 4; i++) await store.putNote([chunk(`n${i}.md`, oneHot(i, 5), 0, 2_000)]);
			// Four dead against five live: not yet.
			expect(internals(store).deadNodes).toBe(4);
			expect(internals(store).hnswIndex?.nodes.size).toBe(9);

			await store.putNote([chunk("n4.md", oneHot(4, 5), 0, 2_000)]);
			// Five dead, five live: compacted, and the whole topology is saved next.
			expect(internals(store).deadNodes).toBe(0);
			expect(internals(store).hnswIndex?.nodes.size).toBe(5);
			await store.flush();
			expect(internals(store).lastGraphSaveNodeCount).toBe(5);
			await store.close();

			const second = new HNSWVectorStore("vault-1", "index-1");
			await second.open();
			const hits = await second.search(new Float32Array(oneHot(2, 5)), 1);
			expect(hits.map((h) => h.path)).toEqual(["n2.md"]);
			expect(internals(second).hnswIndex?.nodes.size).toBe(5);
			await second.close();
		} finally {
			statics.COMPACT_DEAD_MIN = original;
		}
	});
});

describe("HNSWVectorStore — graph saves", () => {
	it("a flush after one note writes only the nodes that changed, and the persisted topology round-trips", async () => {
		const vectors = randomVectors(61, 8);
		const store = await openStore();
		for (let i = 0; i < 60; i++) await store.putNote([chunk(`n${i}.md`, vectors[i])]);
		await store.flush();
		expect(internals(store).lastGraphSaveNodeCount).toBe(60);

		await store.putNote([chunk("n60.md", vectors[60])]);
		await store.flush();
		// The new node, the nodes it linked to, and any that lost a back-link —
		// not the whole graph. (M = 16 per level bounds the neighbour count.)
		expect(internals(store).lastGraphSaveNodeCount).toBeLessThan(60);
		expect(internals(store).lastGraphSaveNodeCount).toBeGreaterThan(0);
		await store.close();

		// Disk describes memory exactly: nothing to prune or re-link on load.
		const second = new HNSWVectorStore("vault-1", "index-1");
		await second.open();
		const hits = await second.search(new Float32Array(vectors[60]), 1);
		expect(hits.map((h) => h.path)).toEqual(["n60.md"]);
		expect(internals(second).hnswIndex?.nodes.size).toBe(61);
		expect(internals(second).graphNeedsFullSave).toBe(false);
		await second.close();
	});
});

describe("HNSWVectorStore.renameNote", () => {
	it("re-keys rows and mappings, leaves the graph alone, and persists", async () => {
		const store = await openStore();
		await store.putNote([chunk("a.md", [1, 0, 0], 0, 5_000), chunk("a.md", [0, 1, 0], 1, 5_000)]);
		await store.putNote([chunk("b.md", [0, 0, 1])]);
		expect(internals(store).hnswIndex?.nodes.size).toBe(3);

		await store.renameNote("a.md", "dir/a2.md");
		expect(await store.count()).toBe(3);
		expect(await store.getAllByPath("a.md")).toEqual([]);
		expect((await store.getAllByPath("dir/a2.md")).map((d) => d.id).sort()).toEqual(["dir/a2.md#0", "dir/a2.md#1"]);
		expect(await store.listNoteMeta()).toEqual([
			{ path: "b.md", mtime: 1_000 },
			{ path: "dir/a2.md", mtime: 5_000 },
		]);
		// No re-embedding, no new nodes, nothing dead.
		expect(internals(store).hnswIndex?.nodes.size).toBe(3);
		expect(internals(store).deadNodes).toBe(0);
		expect((await store.search(new Float32Array([0, 1, 0]), 1)).map((h) => h.id)).toEqual(["dir/a2.md#1"]);
		await store.close();

		const second = new HNSWVectorStore("vault-1", "index-1");
		await second.open();
		expect(await second.count()).toBe(3);
		expect((await second.search(new Float32Array([1, 0, 0]), 1)).map((h) => h.id)).toEqual(["dir/a2.md#0"]);
		expect(await second.getDocumentMtime("a.md")).toBeUndefined();
		await second.close();
	});

	it("replaces whatever the destination held, and ignores an unknown source", async () => {
		const store = await openStore();
		await store.putNote([chunk("a.md", [1, 0])]);
		await store.putNote([chunk("b.md", [0, 1])]);

		await store.renameNote("a.md", "b.md");
		expect(await store.count()).toBe(1);
		expect(Array.from((await store.getAllByPath("b.md"))[0].vector)).toEqual([1, 0]);
		expect(internals(store).deadNodes).toBe(1);

		await store.renameNote("nope.md", "x.md");
		expect(await store.count()).toBe(1);

		// A stale rename whose source is gone must not erase what sits at the destination.
		await store.putNote([chunk("c.md", [1, 1])]);
		await store.renameNote("nope.md", "c.md");
		expect((await store.getAllByPath("c.md")).length).toBe(1);
		expect(await store.count()).toBe(2);
		await store.close();
	});
});
