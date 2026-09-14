import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

/*
 * The lexical index records each document's mtime as of the read that indexed
 * it, and persists it beside the paths, so the startup validation can tell a
 * note that changed while Obsidian was closed from one that is current.
 */

import { MiniSearchService } from "../../src/vectorstore/MiniSearchService";

beforeEach(() => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function openService(): Promise<MiniSearchService> {
	const service = new MiniSearchService("vault-1", "mtime");
	await service.open();
	return service;
}

describe("MiniSearchService document mtimes", () => {
	it("tracks the mtime a document was indexed at and forgets it on removal", () => {
		const service = new MiniSearchService("vault-1", "mtime-memory");
		service.addDocument("a.md", "a", "alpha", [], 1_000);
		service.addDocument("b.md", "b", "beta");
		expect(service.getDocumentMtime("a.md")).toBe(1_000);
		// Indexed without one: no known age.
		expect(service.getDocumentMtime("b.md")).toBeUndefined();

		service.addDocument("a.md", "a", "alpha again", [], 2_000);
		expect(service.getDocumentMtime("a.md")).toBe(2_000);
		// Re-added without a stamp: the old one must not linger and vouch for new content.
		service.addDocument("a.md", "a", "alpha once more");
		expect(service.getDocumentMtime("a.md")).toBeUndefined();

		service.addDocument("a.md", "a", "alpha", [], 3_000);
		service.removeDocument("a.md");
		expect(service.getDocumentMtime("a.md")).toBeUndefined();
		expect(service.hasDocument("a.md")).toBe(false);
	});

	it("persists the mtimes with the index and restores them on load", async () => {
		const first = await openService();
		first.addDocument("a.md", "a", "alpha", [], 1_000);
		first.addDocument("b.md", "b", "beta");
		await first.flush();
		first.close();

		const second = await openService();
		expect(await second.loadFromStorage()).toBe(true);
		expect(second.hasDocument("a.md")).toBe(true);
		expect(second.getDocumentMtime("a.md")).toBe(1_000);
		expect(second.hasDocument("b.md")).toBe(true);
		expect(second.getDocumentMtime("b.md")).toBeUndefined();
		second.close();
	});

	it("loads a record saved before mtimes were tracked, with every document of unknown age", async () => {
		const first = await openService();
		first.addDocument("a.md", "a", "alpha", [], 1_000);
		await first.flush();
		first.close();

		// Strip the `mtimes` field the way an older plugin version would have left it.
		await new Promise<void>((resolve, reject) => {
			const open = indexedDB.open("s2b-minisearch-vault-1-mtime_");
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const db = open.result;
				const tx = db.transaction("index", "readwrite");
				const store = tx.objectStore("index");
				const get = store.get("main");
				get.onsuccess = () => {
					const { mtimes: _dropped, ...legacy } = get.result as { mtimes: unknown };
					store.put(legacy, "main");
				};
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
		});

		const second = await openService();
		expect(await second.loadFromStorage()).toBe(true);
		expect(second.hasDocument("a.md")).toBe(true);
		expect(second.getDocumentMtime("a.md")).toBeUndefined();
		second.close();
	});
});
