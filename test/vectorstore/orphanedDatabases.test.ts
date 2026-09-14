import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

/*
 * #432 step 5: vector databases survive index/provider deletion by design, so a
 * cleanup surface needs to find this vault's leftovers without touching a
 * neighbouring vault whose slug extends ours ("vault-1" vs "vault-1-archive").
 * Runs against a real in-memory IndexedDB so `databases()`, the metadata probe
 * and the deletions are exercised for real.
 */

import { HNSWVectorStore } from "../../src/vectorstore/HNSWVectorStore";
import {
	databaseNamesForIndex,
	deleteOrphanedDatabases,
	formatBytes,
	listOrphanedVectorDatabases,
} from "../../src/vectorstore/orphanedDatabases";
import type { DocumentVector } from "../../src/vectorstore/types";

function doc(path: string, vector: number[]): DocumentVector {
	return { id: `${path}#0`, path, mtime: 1, chunkIndex: 0, vector: new Float32Array(vector) };
}

async function writeIndex(vaultId: string, indexId: string, docs: DocumentVector[]): Promise<void> {
	const store = new HNSWVectorStore(vaultId, indexId);
	await store.open();
	const [provider, ...rest] = indexId.split(":");
	await store.setMetadata(provider, rest.join(":"), 2);
	for (const d of docs) await store.upsert(d);
	await store.close();
}

/** A pre-v3 graph sidecar: a database with an unrelated schema. */
function createSidecar(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name, 1);
		request.onupgradeneeded = () => request.result.createObjectStore("graph");
		request.onsuccess = () => {
			request.result.close();
			resolve();
		};
		request.onerror = () => reject(request.error);
	});
}

async function databaseNames(): Promise<string[]> {
	return ((await indexedDB.databases()) ?? []).map((info) => info.name ?? "").sort();
}

const VAULT = "vault-1";
const CONFIGURED = "openai:text-embedding-3-small";
const ORPHAN = "ollama:nomic-embed-text";

beforeEach(() => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("listOrphanedVectorDatabases", () => {
	it("reports databases of unconfigured models and legacy sidecars, leaving other vaults alone", async () => {
		await writeIndex(VAULT, CONFIGURED, [doc("a.md", [1, 0, 0, 0])]);
		await writeIndex(VAULT, ORPHAN, [
			doc("a.md", [1, 0, 0, 0]),
			doc("b.md", [0, 1, 0, 0]),
			doc("c.md", [0, 0, 1, 0]),
		]);
		// A vault whose slug extends ours: its database shares our name prefix but
		// the provider/model inside it does not reproduce the name under our slug.
		await writeIndex("vault-1-archive", "openai:x", [doc("z.md", [1, 0])]);
		const [orphanMain, orphanSidecar] = databaseNamesForIndex(VAULT, ORPHAN);
		await createSidecar(orphanSidecar);
		await createSidecar(`${databaseNamesForIndex("vault-1-archive", "openai:x")[0]}-hnsw-index`);
		// A sidecar whose main database is gone: it could be ours (a half-blocked
		// deletion) or a neighbouring vault's — nothing inside it says which, so
		// it must not be offered for deletion.
		await createSidecar(`${databaseNamesForIndex("vault-1-archive", "openai:gone")[0]}-hnsw-index`);
		await createSidecar(`${databaseNamesForIndex(VAULT, "ollama:gone")[0]}-hnsw-index`);
		// A shell that was opened but never written: no metadata record, so it
		// cannot be attributed and is left alone.
		const shell = new HNSWVectorStore(VAULT, "custom:never-built");
		await shell.open();
		await shell.close();

		const orphans = await listOrphanedVectorDatabases(VAULT, [CONFIGURED]);
		expect(orphans).not.toBeNull();
		expect(orphans?.map((o) => o.name)).toEqual([orphanMain, orphanSidecar]);
		const index = orphans?.find((o) => o.kind === "index");
		expect(index).toMatchObject({
			indexId: ORPHAN,
			label: "ollama_nomic-embed-text",
			chunkCount: 3,
			dimensions: 4,
			estimatedBytes: 3 * 4 * 4,
		});
		expect(orphans?.find((o) => o.kind === "legacy-sidecar")?.label).toBe("ollama_nomic-embed-text");
	});

	it("reports nothing when every database is configured", async () => {
		await writeIndex(VAULT, CONFIGURED, [doc("a.md", [1, 0])]);
		expect(await listOrphanedVectorDatabases(VAULT, [CONFIGURED])).toEqual([]);
	});

	it("resolves null when the runtime cannot enumerate databases", async () => {
		vi.stubGlobal("indexedDB", { open: vi.fn(), deleteDatabase: vi.fn() });
		expect(await listOrphanedVectorDatabases(VAULT, [CONFIGURED])).toBeNull();
	});
});

describe("deleteOrphanedDatabases", () => {
	it("removes the listed databases and nothing else", async () => {
		await writeIndex(VAULT, CONFIGURED, [doc("a.md", [1, 0])]);
		await writeIndex(VAULT, ORPHAN, [doc("a.md", [1, 0])]);
		const [orphanMain, orphanSidecar] = databaseNamesForIndex(VAULT, ORPHAN);
		await createSidecar(orphanSidecar);

		const orphans = (await listOrphanedVectorDatabases(VAULT, [CONFIGURED])) ?? [];
		const outcome = await deleteOrphanedDatabases(orphans.map((o) => o.name));
		expect(outcome.failed).toEqual([]);
		expect(outcome.deleted.sort()).toEqual([orphanMain, orphanSidecar].sort());
		expect(await databaseNames()).toEqual([databaseNamesForIndex(VAULT, CONFIGURED)[0]]);
		expect(await listOrphanedVectorDatabases(VAULT, [CONFIGURED])).toEqual([]);
	});
});

describe("formatBytes", () => {
	it("picks a readable unit", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(120 * 1024 * 1024)).toBe("120 MB");
		expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
	});
});
