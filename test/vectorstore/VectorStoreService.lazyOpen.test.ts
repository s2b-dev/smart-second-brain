import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

/*
 * #432 part 2, steps 3 and 4, at the service level:
 *
 * - Mobile opens no index at boot; the first use (search / `ensureIndex` /
 *   `getOrCreateInstance`) opens it exactly once, also under concurrent callers.
 *   Desktop still opens configured indexes at init.
 * - A bulk run resumes from what is stored: the completeness validation embeds
 *   only notes that are missing or stale, never the ones already indexed.
 * - The crash marker is set while a bulk run is in flight, cleared when it
 *   completes, and lengthens the next scheduled start on mobile.
 *
 * The worker-backed store is replaced by an in-memory fake (the worker cannot
 * run under jsdom), and the provider layer by a fake embeddings instance.
 */

import { MOBILE_BULK_BASE_DELAY_MS, resetBulkRunQueue } from "../../src/search/bulkPacing";
import type { DocumentVector, IndexMetadata, NoteMeta, VectorStore } from "../../src/vectorstore/types";

// ---- fakes ------------------------------------------------------------------

interface FakeFile {
	path: string;
	basename: string;
	extension: string;
	stat: { mtime: number; size: number };
}

function file(path: string, mtime = 1_000): FakeFile {
	return { path, basename: path.replace(/\.md$/, ""), extension: "md", stat: { mtime, size: 10 } };
}

class FakeStore implements VectorStore {
	docs = new Map<string, DocumentVector>();
	meta: { providerId: string; modelId: string; version: number; dimensions: number } | null = null;
	open = vi.fn(async () => {});
	close = vi.fn(async () => {});
	flush = vi.fn(async () => {});
	providerId: string | null = null;
	modelId: string | null = null;

	async setMetadata(providerId: string, modelId: string, version: number): Promise<void> {
		this.meta = { providerId, modelId, version, dimensions: this.meta?.dimensions ?? 0 };
	}
	async getMetadata(): Promise<IndexMetadata | null> {
		if (!this.meta) return null;
		return { ...this.meta, documentCount: this.docs.size, lastUpdated: 0 };
	}
	async upsert(doc: DocumentVector): Promise<void> {
		this.docs.set(doc.id, doc);
		if (this.meta) this.meta.dimensions = doc.vector.length;
	}
	async remove(path: string): Promise<void> {
		for (const [id, doc] of this.docs) if (doc.path === path) this.docs.delete(id);
	}
	async getByPath(path: string): Promise<DocumentVector | undefined> {
		return [...this.docs.values()].find((d) => d.path === path);
	}
	async getAllByPath(path: string): Promise<DocumentVector[]> {
		return [...this.docs.values()].filter((d) => d.path === path);
	}
	async getDocumentMtime(path: string): Promise<number | undefined> {
		return (await this.getByPath(path))?.mtime;
	}
	/** Mirrors the real store: a note is listed only through its chunk-0 row. */
	async listNoteMeta(): Promise<NoteMeta[]> {
		return [...this.docs.values()]
			.filter((doc) => doc.chunkIndex === 0)
			.map(({ path, mtime }) => ({ path, mtime }));
	}
	async semanticPairs() {
		return [];
	}
	async noteNeighbors() {
		return [];
	}
	async getAllSerialized() {
		return [];
	}
	async bulkPut(docs: DocumentVector[]): Promise<void> {
		for (const doc of docs) await this.upsert(doc);
	}
	async clear(): Promise<void> {
		this.docs.clear();
		this.meta = null;
	}
	async count(): Promise<number> {
		return this.docs.size;
	}
	async countNotes(): Promise<number> {
		return (await this.listNoteMeta()).length;
	}
	async search() {
		return [];
	}
}

const INDEX = "fake:embed-model";
const stores = new Map<string, FakeStore>();
let vaultFiles: FakeFile[] = [];
/** Paths whose `readIndexableContent` throws. */
let readFailures = new Set<string>();
const embedDocuments = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
const embedQuery = vi.fn(async () => [1, 0, 0]);
const indexStats: Record<string, unknown> = {};
/** The privacy rules the fake data store answers with; tests flip them mid-run. */
let providerTrusted = true;
let privatePaths = new Set<string>();
const privacyListeners = new Set<() => void>();

const fakeData = {
	vaultSlug: "vault-1",
	searchEmbedIndex: INDEX as string | null,
	graphEmbedIndex: null as string | null,
	getEmbeddingIndex: (id: string) =>
		id === INDEX
			? {
					id,
					provider: "fake",
					model: "embed-model",
					batchSize: 2,
					// Mirror the stats the service wrote, as the real config would.
					lastBuiltAt: (indexStats.lastBuiltAt as number | undefined) ?? null,
					failedNotes: indexStats.failedNotes as Record<string, number> | undefined,
				}
			: undefined,
	updateEmbeddingIndexStats: vi.fn((_id: string, stats: Record<string, unknown>) => Object.assign(indexStats, stats)),
	removeEmbeddingIndex: vi.fn(),
	isProviderTrusted: () => providerTrusted,
	isFilePrivate: (path: string) => privatePaths.has(path),
	onPrivacyRulesChange: (listener: () => void) => {
		privacyListeners.add(listener);
		return () => privacyListeners.delete(listener);
	},
	getResolvedProviderAuth: () => null,
};

vi.mock("../../src/stores/dataStore.svelte", () => ({ getData: () => fakeData }));
vi.mock("../../src/vectorstore/storeFactory", () => ({
	createVectorStore: (_vaultId: string, indexId: string) => {
		// Same index within a test → same store, so a service restarted mid-test
		// reopens what the previous one wrote, like IndexedDB does.
		const existing = stores.get(indexId);
		if (existing) return existing;
		const store = new FakeStore();
		stores.set(indexId, store);
		return store;
	},
}));
vi.mock("../../src/providers/registrySync", () => ({ ensureProviderRegistered: () => true }));
// The notices render into Obsidian's extended DOM (`createEl`, `appendText`), which jsdom lacks.
const showActionNotice = vi.fn();
vi.mock("../../src/utils/actionNotice", () => ({
	showActionNotice: (...args: unknown[]) => showActionNotice(...args),
	showSettingsLinkNotice: vi.fn(),
	settingsAction: vi.fn(() => ({ label: "", run: async () => {} })),
	configureEmbedIndexAction: vi.fn(() => ({ label: "", run: async () => {} })),
}));
vi.mock("../../src/providers/registry", () => ({
	getRegistry: () => ({
		getAuthGeneration: () => 1,
		createEmbeddingInstance: () => ({ embedDocuments, embedQuery }),
	}),
}));
vi.mock("../../src/providers/modelsDevApi", () => ({ fetchModelsDevData: async () => null }));
vi.mock("../../src/providers/openrouterModels", () => ({ fetchOpenRouterModels: async () => null }));
vi.mock("../../src/providers/ollamaModels", () => ({ getOllamaModelsCache: () => null }));
vi.mock("../../src/lib/modelMetadataNormalizer", () => ({
	hydrateEmbeddingModel: () => ({ maxInputTokens: 8191 }),
}));
vi.mock("../../src/utils/fileFiltering", () => ({
	getEmbeddableVaultFiles: () => vaultFiles,
	isEmbeddableFile: () => true,
	isBinaryTextFile: (f: FakeFile) => f.extension === "pdf",
	readIndexableContent: async (_vault: unknown, f: FakeFile) => {
		if (readFailures.has(f.path)) throw new Error(`cannot read ${f.path}`);
		return `content of ${f.path}`;
	},
}));

import { VectorStoreService, waitForVectorStore } from "../../src/vectorstore/VectorStoreService";

function fakePlugin() {
	return {
		app: {
			workspace: { onLayoutReady: (cb: () => void) => cb() },
			vault: { getFiles: () => vaultFiles, on: () => ({}), getAbstractFileByPath: () => null },
			metadataCache: { getFileCache: () => null },
			// Obsidian's vault-scoped local storage, which the crash marker persists through.
			loadLocalStorage: (key: string) => vaultStorage.get(key) ?? null,
			saveLocalStorage: (key: string, data: unknown | null) => {
				if (data === null) vaultStorage.delete(key);
				else vaultStorage.set(key, data);
			},
		},
		registerEvent: () => {},
	} as never;
}

/** Backing map for the fake app's `loadLocalStorage` / `saveLocalStorage`. */
const vaultStorage = new Map<string, unknown>();

const platform = Platform as { isMobile: boolean };
const MARKER_KEY = "s2b-embedding-bulk-attempts";
let service: VectorStoreService | null = null;

async function startService(): Promise<VectorStoreService> {
	// The progress notice renders into Obsidian's extended DOM (`createDiv`),
	// which jsdom lacks; the notice is not what these tests assert on.
	vi.spyOn(
		VectorStoreService.prototype as unknown as { updateNotice: () => void },
		"updateNotice",
	).mockImplementation(() => {});
	service = VectorStoreService.startInitialize(fakePlugin());
	expect(await waitForVectorStore()).toBe(true);
	return service;
}

beforeEach(() => {
	vi.useFakeTimers();
	resetBulkRunQueue();
	vaultStorage.clear();
	stores.clear();
	vaultFiles = [];
	readFailures = new Set();
	providerTrusted = true;
	privatePaths = new Set();
	privacyListeners.clear();
	showActionNotice.mockClear();
	embedDocuments.mockClear();
	embedQuery.mockClear();
	for (const key of Object.keys(indexStats)) delete indexStats[key];
});

afterEach(async () => {
	await service?.cleanup();
	service = null;
	platform.isMobile = false;
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("lazy open on mobile", () => {
	it("opens nothing at boot, then exactly once on first use — even with concurrent callers", async () => {
		platform.isMobile = true;
		const svc = await startService();
		expect(stores.size).toBe(0);

		const [a, b] = await Promise.all([svc.getOrCreateInstance(INDEX), svc.getOrCreateInstance(INDEX)]);
		expect(a).toBe(b);
		expect(stores.size).toBe(1);
		expect(stores.get(INDEX)?.open).toHaveBeenCalledTimes(1);

		await svc.getStats(INDEX);
		expect(stores.get(INDEX)?.open).toHaveBeenCalledTimes(1);
	});

	it("opens the configured index at boot on desktop", async () => {
		platform.isMobile = false;
		await startService();
		expect(stores.get(INDEX)?.open).toHaveBeenCalledTimes(1);
	});

	it("catches up after the boot delay on mobile, and a crashed attempt lengthens that delay", async () => {
		platform.isMobile = true;
		vaultStorage.set(MARKER_KEY, "1"); // the previous run died
		vaultFiles = [file("a.md")];
		await startService();

		await vi.advanceTimersByTimeAsync(MOBILE_BULK_BASE_DELAY_MS * 2 - 1);
		expect(stores.size).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		// Opened by the catch-up, which found the index empty and left it to the
		// first explicit use (an empty index is a build, not a validation).
		expect(stores.get(INDEX)?.open).toHaveBeenCalledTimes(1);
	});
});

describe("bulk embed run", () => {
	it("resumes from the stored index: validation embeds only missing and stale notes", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md", 1_000), file("b.md", 1_000), file("c.md", 5_000)];
		const svc = await startService();
		const store = stores.get(INDEX);
		if (!store) throw new Error("store not opened");
		// a.md is current, c.md is stale (indexed at an older mtime), b.md is missing,
		// and d.md was killed mid-write: a chunk-1 row with the current mtime but no chunk 0.
		vaultFiles.push(file("d.md", 1_000));
		await store.setMetadata("fake", "embed-model", 2);
		await store.upsert({
			id: "d.md#1",
			path: "d.md",
			mtime: 1_000,
			chunkIndex: 1,
			vector: new Float32Array(3),
		});
		await store.upsert({
			id: "a.md#0",
			path: "a.md",
			mtime: 1_000,
			chunkIndex: 0,
			vector: new Float32Array(3),
		});
		await store.upsert({
			id: "c.md#0",
			path: "c.md",
			mtime: 1_000,
			chunkIndex: 0,
			vector: new Float32Array(3),
		});
		await store.upsert({
			id: "gone.md#0",
			path: "gone.md",
			mtime: 1_000,
			chunkIndex: 0,
			vector: new Float32Array(3),
		});

		expect(await svc.ensureIndex(INDEX)).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);

		// Chunking prefixes each chunk with the note title; the body is what matters.
		const embedded = embedDocuments.mock.calls.flatMap(([texts]) => texts).sort();
		expect(embedded).toHaveLength(3);
		expect(embedded[0]).toContain("content of b.md");
		expect(embedded[1]).toContain("content of c.md");
		expect(embedded[2]).toContain("content of d.md");
		expect((await store.listNoteMeta()).map((n) => n.path).sort()).toEqual(["a.md", "b.md", "c.md", "d.md"]);
		// The stale chunk-1 row of d.md was purged before the rewrite.
		expect([...store.docs.keys()].filter((id) => id.startsWith("d.md"))).toEqual(["d.md#0"]);
		expect(store.flush).toHaveBeenCalled();
		expect(indexStats.dimensions).toBe(3);
	});

	it("sets the crash marker while running and clears it on completion", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md"), file("b.md"), file("c.md")];
		let release: (() => void) | null = null;
		embedDocuments.mockImplementationOnce(
			(texts: string[]) =>
				new Promise<number[][]>((resolve) => {
					release = () => resolve(texts.map(() => [1, 0, 0]));
				}),
		);
		const svc = await startService();

		const run = svc.ensureIndex(INDEX); // empty index → full build
		await vi.waitFor(() => expect(vaultStorage.get(MARKER_KEY) ?? null).toBe("1"));
		if (!release) throw new Error("embedding call never started");
		(release as () => void)();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await run).toBe(true);
		expect(vaultStorage.get(MARKER_KEY) ?? null).toBeNull();
		expect(await stores.get(INDEX)?.countNotes()).toBe(3);
	});

	it("a cancelled run reports the notes it did write, not 0 (#466)", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md"), file("b.md"), file("c.md"), file("d.md")];
		// batchSize is 2 (see fakeData): the first batch lands, the second hangs
		// until the run is cancelled out from under it.
		embedDocuments
			.mockImplementationOnce(async (texts: string[]) => texts.map(() => [1, 0, 0]))
			.mockImplementationOnce(() => new Promise<number[][]>(() => {}));
		const svc = await startService();

		const run = svc.ensureIndex(INDEX); // empty index → full build
		await vi.waitFor(() => expect(embedDocuments).toHaveBeenCalledTimes(2));
		svc.cancelIndexing(INDEX);
		await vi.advanceTimersByTimeAsync(1_000);
		await run;

		expect(await stores.get(INDEX)?.countNotes()).toBe(2);
		// The cached count the settings row renders matches the store, and the
		// run does not count as a completed build.
		expect(indexStats.documentCount).toBe(2);
		expect(indexStats.lastBuiltAt).toBeUndefined();
	});

	it("a cancelled rebuild drops the previous build date, so the row reads incomplete (#466)", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md"), file("b.md"), file("c.md"), file("d.md")];
		const svc = await startService();
		const build = svc.ensureIndex(INDEX);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await build).toBe(true);
		expect(indexStats.lastBuiltAt).toEqual(expect.any(Number));

		// Rebuild — the model behind the index changed, so `ensureIndex` clears the
		// store and builds again: the first batch lands, the second hangs until cancelled.
		await stores.get(INDEX)?.setMetadata("fake", "previous-model", 2);
		embedDocuments
			.mockImplementationOnce(async (texts: string[]) => texts.map(() => [1, 0, 0]))
			.mockImplementationOnce(() => new Promise<number[][]>(() => {}));
		const rebuild = svc.ensureIndex(INDEX);
		await vi.waitFor(() => expect(embedDocuments).toHaveBeenCalledTimes(4));
		svc.cancelIndexing(INDEX);
		await vi.advanceTimersByTimeAsync(1_000);
		await rebuild;

		expect(indexStats.lastBuiltAt).toBeNull();
		expect(indexStats.documentCount).toBe(2);
	});

	it("validation that only removes orphans still syncs the count (#466)", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md", 1_000)];
		const svc = await startService();
		const store = stores.get(INDEX);
		if (!store) throw new Error("store not opened");
		await store.setMetadata("fake", "embed-model", 2);
		for (const path of ["a.md", "gone.md"]) {
			await store.upsert({
				id: `${path}#0`,
				path,
				mtime: 1_000,
				chunkIndex: 0,
				vector: new Float32Array(3),
			});
		}
		// The cache still counts the note that has since left the vault.
		indexStats.documentCount = 2;

		expect(await svc.ensureIndex(INDEX)).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(embedDocuments).not.toHaveBeenCalled();
		expect((await store.listNoteMeta()).map((n) => n.path)).toEqual(["a.md"]);
		expect(indexStats.documentCount).toBe(1);
	});

	it("a build finished by the next launch's validation gets its build date (#466)", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md"), file("b.md"), file("c.md"), file("d.md")];
		embedDocuments
			.mockImplementationOnce(async (texts: string[]) => texts.map(() => [1, 0, 0]))
			.mockImplementationOnce(() => new Promise<number[][]>(() => {}));
		const svc = await startService();
		const run = svc.ensureIndex(INDEX);
		await vi.waitFor(() => expect(embedDocuments).toHaveBeenCalledTimes(2));
		svc.cancelIndexing(INDEX);
		await vi.advanceTimersByTimeAsync(1_000);
		await run;
		expect(indexStats.lastBuiltAt).toBeUndefined();

		// "Reload": the startup validation embeds what the build missed.
		await svc.cleanup();
		service = null;
		await startService();
		await vi.advanceTimersByTimeAsync(2_000);

		expect(await stores.get(INDEX)?.countNotes()).toBe(4);
		expect(indexStats.documentCount).toBe(4);
		expect(indexStats.lastBuiltAt).toEqual(expect.any(Number));
	});

	it("a routine catch-up leaves an existing build date alone", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md"), file("b.md")];
		const svc = await startService();
		const build = svc.ensureIndex(INDEX);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await build).toBe(true);
		const builtAt = indexStats.lastBuiltAt;
		expect(builtAt).toEqual(expect.any(Number));

		vaultFiles.push(file("c.md"));
		await svc.cleanup();
		service = null;
		await vi.advanceTimersByTimeAsync(60_000); // a later launch
		await startService();
		await vi.advanceTimersByTimeAsync(2_000);

		expect(await stores.get(INDEX)?.countNotes()).toBe(3);
		expect(indexStats.lastBuiltAt).toBe(builtAt);
	});

	it("re-syncs the cached count from the store when an index is opened", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md")];
		// An index whose build was interrupted by a quit: rows on disk, no count
		// ever cached. The count must be right before validation gets around to it.
		const svc = await startService();
		const store = stores.get(INDEX);
		if (!store) throw new Error("store not opened");
		expect(indexStats.documentCount).toBe(0);
		await store.setMetadata("fake", "embed-model", 2);
		await store.upsert({
			id: "a.md#0",
			path: "a.md",
			mtime: 1_000,
			chunkIndex: 0,
			vector: new Float32Array(3),
		});
		await svc.cleanup();
		service = null;

		await startService();
		expect(indexStats.documentCount).toBe(1);
	});

	it("a fresh index gets exactly one full build when startup validation fires before ensureIndex", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md"), file("b.md"), file("c.md")];
		const svc = await startService();
		const store = stores.get(INDEX);
		if (!store) throw new Error("store not opened");
		// The real store answers over a worker round-trip, so `ensureIndex`'s reads
		// land after the zero-delay validation timer registered at open. Model that
		// by parking the two reads on a (fake) macrotask.
		for (const method of ["getMetadata", "count"] as const) {
			const original = store[method].bind(store);
			(store as unknown as Record<string, unknown>)[method] = async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
				return original();
			};
		}

		const run = svc.ensureIndex(INDEX);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(await run).toBe(true);

		// Every note embedded once — one build, not a validation run racing a build.
		const embedded = embedDocuments.mock.calls.flatMap(([texts]) => texts);
		expect(embedded).toHaveLength(3);
		expect(await store.countNotes()).toBe(3);
		// And it was the *full build*: the metadata record and the build date exist.
		expect(store.meta).not.toBeNull();
		expect(indexStats.lastBuiltAt).toEqual(expect.any(Number));
	});

	it("writes the missing metadata record of a store that has rows, even with nothing to embed", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md", 1_000)];
		const svc = await startService();
		const store = stores.get(INDEX);
		if (!store) throw new Error("store not opened");
		// Built through the old validation path: a row, no record.
		await store.upsert({
			id: "a.md#0",
			path: "a.md",
			mtime: 1_000,
			chunkIndex: 0,
			vector: new Float32Array(3),
		});
		expect(store.meta).toBeNull();

		expect(await svc.ensureIndex(INDEX)).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(embedDocuments).not.toHaveBeenCalled();
		expect(store.meta).toMatchObject({ providerId: "fake", modelId: "embed-model" });
	});
});

/** The service's private per-file hooks, reached directly: the fake vault registers no events. */
type EventHooks = {
	handleFileModify(file: FakeFile): void;
	handleFileCreate(file: FakeFile): Promise<void>;
};

function seeded(path: string, mtime: number, chunkIndex = 0): DocumentVector {
	return { id: `${path}#${chunkIndex}`, path, mtime, chunkIndex, vector: new Float32Array(3) };
}

describe("vault events during a bulk run", () => {
	it("stores the mtime the note was read at, not the one it has when the row is written", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md", 1_000)];
		let release: (() => void) | null = null;
		embedDocuments.mockImplementationOnce(
			(texts: string[]) =>
				new Promise<number[][]>((resolve) => {
					release = () => resolve(texts.map(() => [1, 0, 0]));
				}),
		);
		const svc = await startService();

		const run = svc.ensureIndex(INDEX); // empty index → full build
		await vi.waitFor(() => expect(embedDocuments).toHaveBeenCalledTimes(1));
		// The note is edited while its embedding call is in flight: Obsidian
		// updates the TFile's stat in place.
		vaultFiles[0].stat.mtime = 2_000;
		if (!release) throw new Error("embedding call never started");
		(release as () => void)();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await run).toBe(true);

		// The row carries the read-time stamp, so it reads as stale against the file …
		expect(stores.get(INDEX)?.docs.get("a.md#0")?.mtime).toBe(1_000);

		// … and the next launch's validation re-indexes it. (Stamping at write
		// time stored 2_000 here, and the edit was never picked up.)
		await svc.cleanup();
		service = null;
		await startService();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(embedDocuments).toHaveBeenCalledTimes(2);
		expect(embedDocuments.mock.calls[1][0][0]).toContain("content of a.md");
		expect(stores.get(INDEX)?.docs.get("a.md#0")?.mtime).toBe(2_000);
	});

	it("an edit dropped during a full build is applied by a catch-up validation once the build ends", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md", 1_000), file("b.md", 1_000), file("c.md", 1_000), file("d.md", 1_000)];
		// batchSize is 2: the first batch (a, b) lands, the second hangs until released.
		let release: (() => void) | null = null;
		embedDocuments
			.mockImplementationOnce(async (texts: string[]) => texts.map(() => [1, 0, 0]))
			.mockImplementationOnce(
				(texts: string[]) =>
					new Promise<number[][]>((resolve) => {
						release = () => resolve(texts.map(() => [1, 0, 0]));
					}),
			);
		const svc = await startService();

		const run = svc.ensureIndex(INDEX); // empty index → full build
		await vi.waitFor(() => expect(embedDocuments).toHaveBeenCalledTimes(2));
		expect(stores.get(INDEX)?.docs.get("a.md#0")?.mtime).toBe(1_000);

		// a.md — already written by the build — is edited while the build runs.
		vaultFiles[0].stat.mtime = 2_000;
		(svc as unknown as EventHooks).handleFileModify(vaultFiles[0]);
		await vi.advanceTimersByTimeAsync(5_000); // the modify debounce
		// The event was not applied to a store a bulk run is writing …
		expect(embedDocuments).toHaveBeenCalledTimes(2);
		expect(stores.get(INDEX)?.docs.get("a.md#0")?.mtime).toBe(1_000);

		if (!release) throw new Error("embedding call never started");
		(release as () => void)();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await run).toBe(true);
		expect(indexStats.lastBuiltAt).toEqual(expect.any(Number));

		// … but the build, once complete, scheduled a validation that repairs exactly that note.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(embedDocuments).toHaveBeenCalledTimes(3);
		expect(embedDocuments.mock.calls[2][0]).toHaveLength(1);
		expect(embedDocuments.mock.calls[2][0][0]).toContain("content of a.md");
		expect(stores.get(INDEX)?.docs.get("a.md#0")?.mtime).toBe(2_000);
		expect(await stores.get(INDEX)?.countNotes()).toBe(4);
	});

	it("a cancelled build schedules no catch-up, but leaves the partial index unvalidated so a retry finishes it", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md", 1_000), file("b.md", 1_000), file("c.md", 1_000), file("d.md", 1_000)];
		embedDocuments
			.mockImplementationOnce(async (texts: string[]) => texts.map(() => [1, 0, 0]))
			.mockImplementationOnce(() => new Promise<number[][]>(() => {}));
		const svc = await startService();

		const run = svc.ensureIndex(INDEX);
		await vi.waitFor(() => expect(embedDocuments).toHaveBeenCalledTimes(2));
		vaultFiles[0].stat.mtime = 2_000;
		(svc as unknown as EventHooks).handleFileModify(vaultFiles[0]);
		await vi.advanceTimersByTimeAsync(5_000);
		svc.cancelIndexing(INDEX);
		await vi.advanceTimersByTimeAsync(1_000);
		await run;

		// The user asked for the writes to stop: nothing resumes on its own.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(embedDocuments).toHaveBeenCalledTimes(2);
		expect(stores.get(INDEX)?.docs.get("a.md#0")?.mtime).toBe(1_000);

		// But a and b are not a validated index. The next `ensureIndex` — a
		// search, or the settings row's re-index — schedules the validation that
		// finishes the build: c and d are missing, a is stale.
		expect(await svc.ensureIndex(INDEX)).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		const resumed = embedDocuments.mock.calls.slice(2).flatMap(([texts]) => texts);
		expect(resumed.map((text) => text.match(/content of (\S+)/)?.[1]).sort()).toEqual(["a.md", "c.md", "d.md"]);
		expect(stores.get(INDEX)?.docs.get("a.md#0")?.mtime).toBe(2_000);
		expect(await stores.get(INDEX)?.countNotes()).toBe(4);
	});
});

describe("unreachable provider", () => {
	it("a refused connection stops the run after the first batch, with no per-entry retries", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md"), file("b.md"), file("c.md"), file("d.md")];
		// What reaches the indexer through the OpenAI client when the local
		// server is not running: the SDK's wrapper, Electron's error on `cause`.
		embedDocuments.mockImplementation(async () => {
			throw Object.assign(new Error("Connection error."), { cause: new Error("net::ERR_CONNECTION_REFUSED") });
		});
		// Desktop start: the open schedules the startup validation, which finds
		// an empty store and runs the full build itself.
		await startService();
		await vi.advanceTimersByTimeAsync(1_000);

		// One batch, then stop: no second batch, no entry-by-entry fallback.
		expect(embedDocuments).toHaveBeenCalledTimes(1);
		expect(embedQuery).not.toHaveBeenCalled();
		expect(showActionNotice).toHaveBeenCalledWith(
			expect.stringMatching(/not reachable/),
			expect.anything(),
			expect.anything(),
		);
		// Nothing was written, and the run does not count as a build.
		expect(await stores.get(INDEX)?.countNotes()).toBe(0);
		expect(indexStats.lastBuiltAt).toBeUndefined();
		embedDocuments.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]));
	});

	it("a timeout gets the same batch retried once before the run stops", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md"), file("b.md"), file("c.md"), file("d.md"), file("e.md"), file("f.md")];
		embedDocuments.mockImplementation(async () => {
			throw new DOMException("Request timed out after 60000ms", "TimeoutError");
		});
		await startService();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(embedDocuments).toHaveBeenCalledTimes(2);
		// The retry is of the batch that failed, not the next one.
		expect(embedDocuments.mock.calls[1][0]).toEqual(embedDocuments.mock.calls[0][0]);
		expect(embedQuery).not.toHaveBeenCalled();
		expect(showActionNotice).toHaveBeenCalledTimes(1);
		expect(await stores.get(INDEX)?.countNotes()).toBe(0);
		embedDocuments.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]));
	});

	it("a single blip drops no notes: the batch is retried and the build completes whole", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md"), file("b.md"), file("c.md"), file("d.md")];
		embedDocuments.mockImplementationOnce(async () => {
			throw new DOMException("Request timed out after 60000ms", "TimeoutError");
		});
		await startService();
		await vi.advanceTimersByTimeAsync(10_000);

		// Batch 1 failed once and was retried; batch 2 went through first time.
		expect(embedDocuments).toHaveBeenCalledTimes(3);
		expect(embedDocuments.mock.calls[1][0]).toEqual(embedDocuments.mock.calls[0][0]);
		expect(showActionNotice).not.toHaveBeenCalled();
		expect(await stores.get(INDEX)?.countNotes()).toBe(4);
		expect(indexStats.lastBuiltAt).toEqual(expect.any(Number));
		const report = await service?.getReport(INDEX);
		expect(report?.skippedFiles).toEqual([]);
	});
});

describe("indexing review follow-ups", () => {
	it("re-indexes a note whose stored mtime is newer than the file's (restored from a backup)", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md", 1_000)];
		await startService();
		const store = stores.get(INDEX);
		if (!store) throw new Error("store not opened");
		await store.setMetadata("fake", "embed-model", 2);
		// Indexed at 5_000, then the note was put back from a backup dated 1_000.
		await store.upsert(seeded("a.md", 5_000));

		await vi.advanceTimersByTimeAsync(1_000);
		expect(embedDocuments).toHaveBeenCalledTimes(1);
		expect(store.docs.get("a.md#0")?.mtime).toBe(1_000);
	});

	it("a note the provider rejects is left alone on later launches until it changes", async () => {
		platform.isMobile = false;
		vaultFiles = [file("ok.md", 1_000), file("bad.md", 1_000)];
		const rejectBad = async (texts: string[]) => {
			if (texts.some((text) => text.includes("content of bad.md")))
				throw Object.assign(new Error("400 content policy"), { status: 400 });
			return texts.map(() => [1, 0, 0]);
		};
		embedDocuments.mockImplementation(rejectBad);
		const svc = await startService();
		await vi.advanceTimersByTimeAsync(1_000);

		// The batch failed, the per-entry fallback wrote ok.md and gave up on bad.md.
		const store = stores.get(INDEX);
		expect(store?.docs.has("ok.md#0")).toBe(true);
		expect(store?.docs.has("bad.md#0")).toBe(false);
		expect(indexStats.failedNotes).toEqual({ "bad.md": 1_000 });
		// The bar reaches 100 %: the failed note left the total.
		expect(svc.getProgress(INDEX)).toMatchObject({ total: 1, indexed: 1, skipped: 1, percentage: 100 });
		expect((await svc.getReport(INDEX))?.skippedFiles).toEqual([{ path: "bad.md", reason: "embed-error" }]);
		const attempts = embedDocuments.mock.calls.length;

		// Next launch: the note is missing from the index, but not retried.
		await svc.cleanup();
		service = null;
		const relaunched = await startService();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(embedDocuments).toHaveBeenCalledTimes(attempts);
		expect((await relaunched.getReport(INDEX))?.skippedFiles).toEqual([{ path: "bad.md", reason: "embed-error" }]);

		// An edit puts it back in play; it succeeds now and the entry is gone.
		embedDocuments.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]));
		vaultFiles[1].stat.mtime = 2_000;
		await relaunched.cleanup();
		service = null;
		await startService();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(stores.get(INDEX)?.docs.get("bad.md#0")?.mtime).toBe(2_000);
		expect(indexStats.failedNotes).toEqual({});
	});

	it("a rejected re-embed of an edited note drops its stale vectors and is not retried", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md", 1_000)];
		const svc = await startService();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(stores.get(INDEX)?.docs.get("a.md#0")?.mtime).toBe(1_000);

		// The edit is rejected: the pre-edit vectors must not keep the note
		// searchable, nor make validation see a stale note to retry.
		embedDocuments.mockImplementation(async () => {
			throw Object.assign(new Error("400 content policy"), { status: 400 });
		});
		vaultFiles[0].stat.mtime = 2_000;
		(svc as unknown as EventHooks).handleFileModify(vaultFiles[0]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(stores.get(INDEX)?.docs.size).toBe(0);
		expect(indexStats.failedNotes).toEqual({ "a.md": 2_000 });
		const attempts = embedDocuments.mock.calls.length;

		await svc.cleanup();
		service = null;
		await startService();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(embedDocuments).toHaveBeenCalledTimes(attempts);
		embedDocuments.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]));
	});

	it("a provider-wide failure is not remembered against the note", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md", 1_000), file("b.md", 1_000)];
		// An expired key: every request fails, none of them says anything about a note.
		embedDocuments.mockImplementation(async () => {
			throw Object.assign(new Error("401 Incorrect API key provided"), { status: 401 });
		});
		const svc = await startService();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(stores.get(INDEX)?.docs.size).toBe(0);
		expect(indexStats.failedNotes).toBeUndefined();

		// Same on the incremental path.
		const created = file("c.md");
		vaultFiles.push(created);
		await (svc as unknown as EventHooks).handleFileCreate(created);
		expect(indexStats.failedNotes).toBeUndefined();

		// The key is fixed: the next launch indexes every note.
		embedDocuments.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0, 0]));
		await svc.cleanup();
		service = null;
		await startService();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await stores.get(INDEX)?.countNotes()).toBe(3);
	});

	it("a failed read or store write on the incremental path is not recorded as a rejection", async () => {
		platform.isMobile = false;
		const svc = await startService();
		await vi.advanceTimersByTimeAsync(1_000);
		const unreadable = file("a.md");
		vaultFiles.push(unreadable);
		readFailures.add("a.md");
		await (svc as unknown as EventHooks).handleFileCreate(unreadable);
		expect(embedDocuments).not.toHaveBeenCalled();
		expect(indexStats.failedNotes).toBeUndefined();

		// Readable now; the write fails instead.
		readFailures.clear();
		const store = stores.get(INDEX);
		if (!store) throw new Error("store not opened");
		const upsert = store.upsert.bind(store);
		store.upsert = async () => {
			throw new Error("QuotaExceededError");
		};
		await (svc as unknown as EventHooks).handleFileCreate(unreadable);
		expect(embedDocuments).toHaveBeenCalledTimes(1);
		expect(indexStats.failedNotes).toBeUndefined();
		store.upsert = upsert;
	});

	it("a privacy-rule change re-validates: notes now private go, notes now allowed come in", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md"), file("secret.md")];
		providerTrusted = false;
		privatePaths = new Set(["secret.md"]);
		await startService();
		await vi.advanceTimersByTimeAsync(1_000);
		const store = stores.get(INDEX);
		expect([...(store?.docs.keys() ?? [])]).toEqual(["a.md#0"]);

		// The user swaps which note is private.
		privatePaths = new Set(["a.md"]);
		for (const listener of privacyListeners) listener();
		await vi.advanceTimersByTimeAsync(1_000);
		expect([...(store?.docs.keys() ?? [])]).toEqual(["secret.md#0"]);
	});

	it("a note that stopped being indexable is dropped when its next event arrives", async () => {
		platform.isMobile = false;
		vaultFiles = [file("a.md", 1_000)];
		const svc = await startService();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(stores.get(INDEX)?.docs.size).toBe(1);

		providerTrusted = false;
		privatePaths = new Set(["a.md"]);
		vaultFiles[0].stat.mtime = 2_000;
		(svc as unknown as EventHooks).handleFileModify(vaultFiles[0]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(stores.get(INDEX)?.docs.size).toBe(0);
		expect(embedDocuments).toHaveBeenCalledTimes(1);
	});

	it("a full build over a store holding only an interrupted build's partial rows purges them first", async () => {
		platform.isMobile = false;
		vaultFiles = [file("big.md", 1_000)];
		await startService();
		const store = stores.get(INDEX);
		if (!store) throw new Error("store not opened");
		await store.setMetadata("fake", "embed-model", 2);
		// Killed after two of three chunks: rows exist, but no chunk 0 — so the
		// index reads as empty and the full build runs. The note is one chunk now.
		await store.upsert(seeded("big.md", 1_000, 1));
		await store.upsert(seeded("big.md", 1_000, 2));

		await vi.advanceTimersByTimeAsync(1_000);
		expect([...store.docs.keys()]).toEqual(["big.md#0"]);
		expect(indexStats.lastBuiltAt).toEqual(expect.any(Number));
	});

	it("deleteIndex stops the run in flight and waits for it before clearing the store", async () => {
		platform.isMobile = false;
		// `deleteIndex` ends by dropping the IndexedDB databases; the fake store
		// has none, so a request that succeeds at once stands in for the factory
		// (fake-indexeddb runs on `setImmediate`, which the fake timers hold).
		vi.stubGlobal("indexedDB", {
			deleteDatabase: () => {
				const request: { onsuccess?: () => void } = {};
				queueMicrotask(() => request.onsuccess?.());
				return request;
			},
		});
		vaultFiles = [file("a.md"), file("b.md"), file("c.md"), file("d.md")];
		embedDocuments
			.mockImplementationOnce(async (texts: string[]) => texts.map(() => [1, 0, 0]))
			.mockImplementationOnce(() => new Promise<number[][]>(() => {}));
		const svc = await startService();
		const build = svc.ensureIndex(INDEX);
		await vi.waitFor(() => expect(embedDocuments).toHaveBeenCalledTimes(2));
		const store = stores.get(INDEX);
		expect(store?.docs.size).toBe(2);

		await svc.deleteIndex(INDEX);
		// The run had settled before the store was cleared, so nothing lands after.
		expect(await build).toBe(true);
		expect(store?.docs.size).toBe(0);
		expect(store?.close).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(store?.docs.size).toBe(0);
		expect(svc.getProgress(INDEX).isIndexing).toBe(false);
	});

	it("embeds a note through embedDocuments on the incremental path too, never embedQuery", async () => {
		platform.isMobile = false;
		const svc = await startService();
		await vi.advanceTimersByTimeAsync(1_000); // nothing to validate
		const created = file("a.md");
		vaultFiles.push(created);
		await (svc as unknown as EventHooks).handleFileCreate(created);
		expect(embedQuery).not.toHaveBeenCalled();
		expect(embedDocuments).toHaveBeenCalledTimes(1);
		expect(stores.get(INDEX)?.docs.has("a.md#0")).toBe(true);
	});
});
