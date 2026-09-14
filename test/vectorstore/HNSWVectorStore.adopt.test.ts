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
		const old = new HNSWVectorStore("vault-1", "openai:small");
		await old.open();
		await old.setMetadata("openai", "small", 2);
		await old.putNote([chunk("a.md", [1, 0, 0])]);
		await old.putNote([chunk("b.md", [0, 1, 0])]);
		await old.putNote([chunk("c.md", [0, 0, 1])]);
		await old.close();

		const renamed = new HNSWVectorStore("vault-1", "openai-work:small");
		expect(await renamed.adoptDatabase("openai:small")).toBe(true);
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

		expect(await databaseExists(getDbName("s2b-hnsw", "vault-1", "openai:small"))).toBe(false);
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
