import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

/*
 * Renaming a provider renames its indexes, and the IndexedDB name follows the
 * index id. `adoptDatabase` moves the old database's contents under the new
 * name so the index does not silently rebuild from scratch.
 */

import { HNSWVectorStore } from "../../src/vectorstore/HNSWVectorStore";
import { getDbName } from "../../src/vectorstore/types";
import type { DocumentVector } from "../../src/vectorstore/types";

function chunk(path: string, vector: number[]): DocumentVector {
	return { id: `${path}#0`, path, mtime: 1_000, chunkIndex: 0, vector: new Float32Array(vector) };
}

const SOURCE = "openai:small";
const TARGET = "openai-work:small";
const sourceName = getDbName("s2b-hnsw", "vault-1", SOURCE);

async function writeSource(): Promise<void> {
	const old = new HNSWVectorStore("vault-1", SOURCE);
	await old.open();
	await old.setMetadata("openai", "small", 2);
	await old.putNote([chunk("a.md", [1, 0, 0])]);
	await old.putNote([chunk("b.md", [0, 1, 0])]);
	await old.putNote([chunk("c.md", [0, 0, 1])]);
	await old.close();
}

/**
 * The state a copy killed after its first document batch leaves behind: the
 * adoption marker plus one row, no mappings, no graph, no metadata record.
 */
async function leavePartialCopy(from: string, at = TARGET): Promise<void> {
	const shell = new HNSWVectorStore("vault-1", at);
	await shell.open();
	await shell.close();
	await new Promise<void>((resolve, reject) => {
		const open = indexedDB.open(getDbName("s2b-hnsw", "vault-1", at));
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const db = open.result;
			const tx = db.transaction(["metadata", "documents"], "readwrite");
			tx.objectStore("metadata").put({ key: "adopting", from });
			tx.objectStore("documents").put({
				id: "a.md#0",
				path: "a.md",
				mtime: 1_000,
				chunkIndex: 0,
				vector: new Float32Array([1, 0, 0]),
				hnswId: 0,
			});
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onerror = () => reject(tx.error);
		};
	});
}

/** Whether a database exists: opening a missing one creates an empty shell, which `upgradeneeded` reveals. */
function databaseExists(name: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name);
		let created = false;
		request.onupgradeneeded = () => {
			created = true;
		};
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			request.result.close();
			if (created) indexedDB.deleteDatabase(name);
			resolve(!created);
		};
	});
}

beforeEach(() => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	vi.stubGlobal("IDBKeyRange", IDBKeyRange);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("HNSWVectorStore.adoptDatabase", () => {
	it("copies rows, mappings, graph and metadata under the new name and deletes the old database", async () => {
		await writeSource();

		const renamed = new HNSWVectorStore("vault-1", TARGET);
		expect(await renamed.adoptDatabase(SOURCE)).toBe(true);
		await renamed.open();
		expect(await renamed.count()).toBe(3);
		// Restamped for the new id: the service clears an index whose record names another provider.
		expect(await renamed.getMetadata()).toMatchObject({ providerId: "openai-work", modelId: "small" });
		expect((await renamed.search(new Float32Array([0, 1, 0]), 1)).map((h) => h.path)).toEqual(["b.md"]);
		// The persisted graph came along: nothing had to be re-linked.
		expect((renamed as unknown as { graphNeedsFullSave: boolean }).graphNeedsFullSave).toBe(false);
		// And the counter too: a new note gets a fresh id.
		await renamed.putNote([chunk("d.md", [1, 1, 0])]);
		expect((await renamed.search(new Float32Array([1, 1, 0]), 1)).map((h) => h.path)).toEqual(["d.md"]);
		await renamed.close();

		expect(await databaseExists(sourceName)).toBe(false);
	});

	it("retries a copy that was interrupted instead of refusing the partial target", async () => {
		await writeSource();
		await leavePartialCopy(sourceName);

		const renamed = new HNSWVectorStore("vault-1", TARGET);
		expect(await renamed.adoptDatabase(SOURCE)).toBe(true);
		await renamed.open();
		expect(await renamed.count()).toBe(3);
		expect((renamed as unknown as { idToNumeric: Map<string, number> }).idToNumeric.size).toBe(3);
		expect((await renamed.search(new Float32Array([0, 0, 1]), 1)).map((h) => h.path)).toEqual(["c.md"]);
		await renamed.close();
		expect(await databaseExists(sourceName)).toBe(false);
	});

	it("finishes an interrupted copy on the next open while the source is still there", async () => {
		await writeSource();
		await leavePartialCopy(sourceName);

		const renamed = new HNSWVectorStore("vault-1", TARGET);
		await renamed.open();
		expect(await renamed.count()).toBe(3);
		expect((await renamed.search(new Float32Array([0, 1, 0]), 1)).map((h) => h.path)).toEqual(["b.md"]);
		expect(await renamed.getMetadata()).toMatchObject({ providerId: "openai-work", modelId: "small" });
		await renamed.close();
		expect(await databaseExists(sourceName)).toBe(false);

		// The marker is gone: a further open is an ordinary one.
		const again = new HNSWVectorStore("vault-1", TARGET);
		await again.open();
		expect(await again.count()).toBe(3);
		await again.close();
	});

	it("empties a partial copy whose source is gone, so the index rebuilds", async () => {
		await leavePartialCopy(sourceName); // no source database

		const renamed = new HNSWVectorStore("vault-1", TARGET);
		await renamed.open();
		expect(await renamed.count()).toBe(0);
		await expect(renamed.putNote([chunk("z.md", [1, 1, 1])])).resolves.toBeUndefined();
		expect(await renamed.count()).toBe(1);
		await renamed.close();
		expect(await databaseExists(sourceName)).toBe(false);
	});

	it("refuses a source that itself holds an interrupted copy", async () => {
		// A → B was interrupted and B never opened since; now B → C.
		await leavePartialCopy(getDbName("s2b-hnsw", "vault-1", "openai-older:small"), SOURCE);

		const renamed = new HNSWVectorStore("vault-1", TARGET);
		expect(await renamed.adoptDatabase(SOURCE)).toBe(false);
		await renamed.open();
		expect(await renamed.count()).toBe(0);
		await renamed.close();
		// The partial source is left for its own open (or the orphan cleanup).
		expect(await databaseExists(sourceName)).toBe(true);
	});

	it("adopts nothing when there is no old database, and leaves no shell behind", async () => {
		const store = new HNSWVectorStore("vault-1", "openai-work:small");
		expect(await store.adoptDatabase("openai:small")).toBe(false);
		expect(await databaseExists(getDbName("s2b-hnsw", "vault-1", "openai:small"))).toBe(false);
		await store.open();
		expect(await store.count()).toBe(0);
		await store.close();
	});

	it("leaves a target that already holds rows alone", async () => {
		const old = new HNSWVectorStore("vault-1", "openai:small");
		await old.open();
		await old.putNote([chunk("a.md", [1, 0])]);
		await old.close();
		const target = new HNSWVectorStore("vault-1", "openai-work:small");
		await target.open();
		await target.putNote([chunk("z.md", [0, 1])]);
		await target.close();

		const again = new HNSWVectorStore("vault-1", "openai-work:small");
		expect(await again.adoptDatabase("openai:small")).toBe(false);
		await again.open();
		expect(await again.count()).toBe(1);
		expect((await again.getAllByPath("z.md")).length).toBe(1);
		await again.close();
		expect(await databaseExists(getDbName("s2b-hnsw", "vault-1", "openai:small"))).toBe(true);
	});
});
