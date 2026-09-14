import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

/*
 * #432 part 1: vectors are Float32Array end-to-end and nothing reads the whole
 * vector set. These tests run the real store against an in-memory IndexedDB
 * (fake-indexeddb structured-clones values exactly like a browser does), so a
 * vector that came back as a plain array, a graph that failed to rehydrate, or
 * a schema upgrade that left old rows behind would all fail here.
 */

import { HNSWVectorStore } from "../../src/vectorstore/HNSWVectorStore";
import { getDbName } from "../../src/vectorstore/types";
import type { DocumentVector } from "../../src/vectorstore/types";
import { semanticPairsFromDocuments } from "../../src/utils/semanticEdges";

const VAULT = "vault-1";
const INDEX = "openai:text-embedding-3-small";

function doc(path: string, vector: number[], chunkIndex = 0, mtime = 1_000): DocumentVector {
	return {
		id: `${path}#${chunkIndex}`,
		path,
		mtime,
		checksum: "c",
		chunkIndex,
		vector: new Float32Array(vector),
	};
}

/**
 * `instanceof Float32Array` would be the natural assertion, but fake-indexeddb
 * clones through Node's `structuredClone` while the test file sees jsdom's
 * globals — two realms, two `Float32Array` constructors. The type tag is
 * realm-independent and asserts the same thing.
 */
function expectFloat32(value: unknown): void {
	expect(Object.prototype.toString.call(value)).toBe("[object Float32Array]");
}

/** Internal state the tests peek at; the graph lives in the worker realm in production. */
type Internals = {
	hnswIndex: { nodes: Map<number, { vector: unknown }>; entryPointId: number; levelMax: number } | null;
	numericToId: Map<number, string>;
	nextHnswId: number;
};
const internals = (store: HNSWVectorStore) => store as unknown as Internals;

async function openStore(): Promise<HNSWVectorStore> {
	const store = new HNSWVectorStore(VAULT, INDEX);
	await store.open();
	return store;
}

let factory: IDBFactory;

beforeEach(() => {
	// A fresh IndexedDB per test; the store reads both globals.
	factory = new IDBFactory();
	vi.stubGlobal("indexedDB", factory);
	vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("HNSWVectorStore — Float32Array round-trips", () => {
	it("stores and returns vectors as Float32Array with the same values", async () => {
		const store = await openStore();
		const values = [0.25, -0.5, 1, 0.125];
		await store.upsert(doc("a.md", values));

		const byPath = await store.getByPath("a.md");
		expectFloat32(byPath?.vector);
		expect(Array.from(byPath?.vector ?? [])).toEqual(values);

		const all = await store.getAllByPath("a.md");
		expect(all).toHaveLength(1);
		expectFloat32(all[0].vector);
		await store.close();
	});

	it("keeps the graph node's vector as the Float32Array it was given, not a double copy", async () => {
		const store = await openStore();
		await store.upsert(doc("a.md", [1, 0, 0]));

		const nodes = internals(store).hnswIndex?.nodes;
		expect(nodes?.size).toBe(1);
		for (const node of nodes?.values() ?? []) expectFloat32(node.vector);
		await store.close();
	});

	it("searches through the graph and returns chunk identity plus score, no vectors", async () => {
		const store = await openStore();
		await store.upsert(doc("x.md", [1, 0, 0]));
		await store.upsert(doc("y.md", [0, 1, 0]));
		await store.upsert(doc("z.md", [0, 0, 1]));

		const hits = await store.search(new Float32Array([0.9, 0.1, 0]), 2);
		expect(hits[0]).toEqual({ id: "x.md#0", path: "x.md", chunkIndex: 0, score: expect.any(Number) });
		expect(hits[0].score).toBeGreaterThan(hits[1].score);
		// No row read, no vector cloned: the hit carries nothing but identity and score.
		expect("vector" in hits[0]).toBe(false);
		expect("doc" in hits[0]).toBe(false);
		await store.close();
	});

	it("resolves a hit's path from its chunk id, even when the path itself contains '#'", async () => {
		const store = await openStore();
		await store.upsert(doc("notes/C# basics.md", [1, 0, 0], 3));
		await store.upsert(doc("other.md", [0, 1, 0]));

		const hits = await store.search(new Float32Array([1, 0, 0]), 1);
		expect(hits).toEqual([{ id: "notes/C# basics.md#3", path: "notes/C# basics.md", chunkIndex: 3, score: 1 }]);
		await store.close();
	});

	it("round-trips the graph through close() and open(): a reopened store searches without rebuilding", async () => {
		const first = await openStore();
		await first.upsert(doc("x.md", [1, 0, 0]));
		await first.upsert(doc("y.md", [0, 1, 0]));
		await first.setMetadata("openai", "text-embedding-3-small", 2);
		await first.close();

		const second = await openStore();
		const hits = await second.search(new Float32Array([0, 1, 0]), 1);
		expect(hits.map((h) => h.path)).toEqual(["y.md"]);

		// The graph was rehydrated, not rebuilt: same node ids, vectors typed.
		const graph = internals(second).hnswIndex;
		expect(graph?.nodes.size).toBe(2);
		expect(graph?.entryPointId).not.toBe(-1);
		for (const node of graph?.nodes.values() ?? []) expectFloat32(node.vector);
		await second.close();
	});

	it("bulkPut rebuilds the graph and persists it for the next open", async () => {
		const first = await openStore();
		await first.bulkPut([doc("a.md", [1, 0]), doc("b.md", [0, 1]), doc("c.md", [0.7, 0.7])]);
		await first.setMetadata("openai", "text-embedding-3-small", 2);
		expect(await first.count()).toBe(3);
		await first.close();

		const second = await openStore();
		// Cosine against [0.6, 0.8]: c ≈ 0.99, b = 0.8, a = 0.6.
		const hits = await second.search(new Float32Array([0.6, 0.8]), 3);
		expect(hits.map((h) => h.path)).toEqual(["c.md", "b.md", "a.md"]);
		expect(hits.map((h) => h.path).sort()).toEqual(["a.md", "b.md", "c.md"]);
		await second.close();
	});

	it("remove() drops every chunk of a note, and a reload prunes its nodes from the graph", async () => {
		const first = await openStore();
		await first.upsert(doc("multi.md", [1, 0, 0], 0));
		await first.upsert(doc("multi.md", [0, 1, 0], 1));
		await first.upsert(doc("other.md", [0, 0, 1]));
		await first.setMetadata("openai", "text-embedding-3-small", 2);
		await first.remove("multi.md");
		expect(await first.count()).toBe(1);
		expect(await first.getAllByPath("multi.md")).toEqual([]);
		await first.close();

		const second = await openStore();
		// The removed note's rows are gone, so loadGraph() cannot (and must not) resurrect its nodes.
		expect(internals(second).hnswIndex).toBeNull();
		const hits = await second.search(new Float32Array([1, 0, 0]), 3);
		expect(hits.map((h) => h.path)).toEqual(["other.md"]);
		expect(internals(second).hnswIndex?.nodes.size).toBe(1);
		await second.close();
	});
});

describe("HNSWVectorStore — reads that never touch a vector", () => {
	it("listNoteMeta yields one { path, mtime } per note, collapsing chunks", async () => {
		const store = await openStore();
		await store.upsert(doc("multi.md", [1, 0], 0, 5_000));
		await store.upsert(doc("multi.md", [0, 1], 1, 5_000));
		await store.upsert(doc("single.md", [1, 1], 0, 7_000));

		const notes = await store.listNoteMeta();
		expect(notes).toEqual([
			{ path: "multi.md", mtime: 5_000 },
			{ path: "single.md", mtime: 7_000 },
		]);
		// Nothing but the projection: no vector, no id, no checksum.
		for (const note of notes) expect(Object.keys(note).sort()).toEqual(["mtime", "path"]);
		await store.close();
	});

	it("getDocumentMtime answers from the index key and reports absent notes as undefined", async () => {
		const store = await openStore();
		await store.upsert(doc("a.md", [1, 0], 0, 4_200));

		expect(await store.getDocumentMtime("a.md")).toBe(4_200);
		expect(await store.getDocumentMtime("missing.md")).toBeUndefined();
		await store.close();
	});
});

describe("HNSWVectorStore — analytics computed inside the store", () => {
	const corpus = [
		doc("bio1.md", [1, 0, 0, 0]),
		doc("bio2.md", [0.98, 0.02, 0, 0]),
		doc("bio3.md", [0.96, 0.05, 0, 0]),
		doc("type1.md", [0, 0, 1, 0]),
		doc("type2.md", [0, 0, 0.98, 0.02]),
		doc("multi.md", [0, 1, 0, 0], 0),
		doc("multi.md", [0, 0, 0.97, 0.03], 1),
	];

	it("semanticPairs matches the pure kernel run over the same rows", async () => {
		const store = await openStore();
		for (const d of corpus) await store.upsert({ ...d, vector: new Float32Array(d.vector) });

		const paths = corpus.map((d) => d.path).filter((p, i, all) => all.indexOf(p) === i);
		const options = { threshold: 0.5, neighborCount: 2, excludePairs: ["0:1"] };

		const fromStore = await store.semanticPairs(paths, options);
		const expected = await semanticPairsFromDocuments(corpus, paths, {
			...options,
			excludePairs: new Set(options.excludePairs),
		});

		expect(fromStore).toEqual(expected);
		expect(fromStore.length).toBeGreaterThan(0);
		// The multi-chunk note reaches the "type" topic through its second chunk.
		const multi = paths.indexOf("multi.md");
		const type1 = paths.indexOf("type1.md");
		expect(fromStore.some((p) => p.source === Math.min(multi, type1) && p.target === Math.max(multi, type1))).toBe(
			true,
		);
		await store.close();
	});

	it("semanticPairs ignores notes outside the requested list and tolerates unknown paths", async () => {
		const store = await openStore();
		for (const d of corpus) await store.upsert({ ...d, vector: new Float32Array(d.vector) });

		const pairs = await store.semanticPairs(["bio1.md", "not-indexed.md", "bio2.md"], { threshold: 0.5 });
		expect(pairs).toEqual([{ source: 0, target: 2, score: expect.any(Number) }]);
		expect(await store.semanticPairs(["bio1.md"], { threshold: 0 })).toEqual([]);
		await store.close();
	});

	it("noteNeighbors ranks other notes by their best chunk against any chunk of the note", async () => {
		const store = await openStore();
		for (const d of corpus) await store.upsert({ ...d, vector: new Float32Array(d.vector) });

		// multi.md's second chunk [0, 0, 0.97, 0.03] sits closer to type2 than to type1.
		const neighbors = await store.noteNeighbors("multi.md", 0.5);
		expect(neighbors.map((n) => n.path)).toEqual(["type2.md", "type1.md"]);
		expect(neighbors[0].score).toBeGreaterThanOrEqual(neighbors[1].score);
		expect(neighbors.some((n) => n.path === "multi.md")).toBe(false);

		expect(await store.noteNeighbors("multi.md", 0.99999)).toEqual([]);
		expect(await store.noteNeighbors("not-indexed.md", 0)).toEqual([]);
		await store.close();
	});
});

describe("HNSWVectorStore — schema upgrade", () => {
	const dbName = getDbName("s2b-hnsw", VAULT, INDEX);
	const legacySidecar = `${dbName}-hnsw-index`;

	/** A schema-v2 database as the previous release wrote it: number[] vectors, plus the library's sidecar. */
	async function seedLegacyDatabases(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const request = factory.open(dbName, 2);
			request.onupgradeneeded = () => {
				const db = request.result;
				const docs = db.createObjectStore("documents", { keyPath: "id" });
				docs.createIndex("path", "path", { unique: false });
				docs.createIndex("mtime", "mtime", { unique: false });
				db.createObjectStore("metadata", { keyPath: "key" });
				db.createObjectStore("id_mapping", { keyPath: "numericId" });
			};
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction(["documents", "metadata", "id_mapping"], "readwrite");
				tx.objectStore("documents").put({
					id: "old.md#0",
					path: "old.md",
					mtime: 1,
					checksum: "c",
					vector: [1, 0, 0],
					chunkIndex: 0,
					hnswId: 0,
				});
				tx.objectStore("metadata").put({
					key: "metadata",
					version: 2,
					providerId: "openai",
					modelId: "text-embedding-3-small",
					lastUpdated: 1,
					dimensions: 3,
					nextHnswId: 1,
				});
				tx.objectStore("id_mapping").put({ numericId: 0, stringId: "old.md#0" });
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			request.onerror = () => reject(request.error);
		});
		await new Promise<void>((resolve, reject) => {
			const request = factory.open(legacySidecar, 1);
			request.onupgradeneeded = () => request.result.createObjectStore("hnsw-index");
			request.onsuccess = () => {
				request.result.close();
				resolve();
			};
			request.onerror = () => reject(request.error);
		});
	}

	it("drops every old store instead of migrating, leaving an empty index that reads as 'needs rebuilding'", async () => {
		await seedLegacyDatabases();

		const store = await openStore();
		// `VectorStoreService.initializeInstance` treats null metadata as "no index"
		// and `ensureIndex` builds from scratch when count() is 0 — no crash, no
		// silent half-index of number[] rows.
		expect(await store.getMetadata()).toBeNull();
		expect(await store.count()).toBe(0);
		expect(await store.listNoteMeta()).toEqual([]);
		expect(store.providerId).toBeNull();
		expect(internals(store).nextHnswId).toBe(0);
		expect(internals(store).numericToId.size).toBe(0);

		// The upgraded database is fully usable straight away.
		await store.upsert(doc("new.md", [0, 1, 0]));
		const hits = await store.search(new Float32Array([0, 1, 0]), 1);
		expect(hits.map((h) => h.path)).toEqual(["new.md"]);
		await store.close();
	});

	it("deletes the library's legacy sidecar graph database on upgrade", async () => {
		await seedLegacyDatabases();
		expect((await factory.databases()).map((d) => d.name)).toContain(legacySidecar);

		const store = await openStore();
		await store.close();

		const remaining = (await factory.databases()).map((d) => d.name);
		expect(remaining).toContain(dbName);
		expect(remaining).not.toContain(legacySidecar);
	});

	it("does not touch a database that is already at the current version", async () => {
		const first = await openStore();
		await first.upsert(doc("keep.md", [1, 0]));
		await first.setMetadata("openai", "text-embedding-3-small", 2);
		await first.close();

		const second = await openStore();
		expect(await second.count()).toBe(1);
		expect((await second.getMetadata())?.providerId).toBe("openai");
		await second.close();
	});
});
