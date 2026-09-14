/**
 * HNSW Vector Store
 *
 * IndexedDB-backed vector storage with HNSW (Hierarchical Navigable Small World) index.
 * Provides O(log n) approximate nearest neighbor search instead of O(n) brute-force.
 *
 * Uses the `hnsw` npm package which is pure TypeScript (no native bindings) for the
 * in-memory graph. Persistence is ours: the document rows (with their vectors) and the
 * graph *topology* live in one IndexedDB database per index (see {@link DB_VERSION}).
 *
 * Note: The HNSW library uses numeric IDs internally, so we maintain a mapping
 * between string document IDs and numeric HNSW IDs.
 *
 * Memory model (#432): vectors are `Float32Array` end-to-end. Each vector is resident
 * exactly once, inside its graph node in this worker; the IndexedDB rows are the only
 * other copy and they are never materialised as a whole. Nothing in this file builds a
 * `number[]` from a vector.
 */

import { HNSW } from "hnsw";
import {
	type DocumentVector,
	type IndexMetadata,
	type NoteMeta,
	type NoteNeighbor,
	type SearchHit,
	type SemanticPairOptions,
	type SerializedDocument,
	type VectorStore,
} from "./types";
import { cosineSimilarity } from "./similarity";
import { ChunkBatchBuilder, computeSemanticPairs, type SemanticPair } from "../utils/semanticEdges";
import { toError } from "../utils/toError";

import { deleteDatabase, getDbName, parseChunkId } from "./types";
import { Logger } from "../utils/logging";

const LOG_PREFIX = "[VectorStore] [HNSW]";

const DB_NAME_PREFIX = "s2b-hnsw";
const DOCUMENTS_STORE = "documents";
const METADATA_STORE = "metadata";
const ID_MAPPING_STORE = "id_mapping";
const GRAPH_STORE = "hnsw_graph";
/** Compound index over `documents` so per-note mtimes can be read without touching a vector. */
const PATH_MTIME_INDEX = "path_mtime";
/** Chunk id suffix of a note's first chunk (`makeChunkId(path, 0)`), the row that marks a note complete. */
const FIRST_CHUNK_SUFFIX = "#0";

/**
 * Schema version of the per-index database.
 *
 * v3: vectors are stored as `Float32Array` (they were `number[]`), and the HNSW graph
 * topology moved from the `hnsw` library's own sidecar database (`<name>-hnsw-index`,
 * a single JSON blob that duplicated every vector as doubles) into {@link GRAPH_STORE}
 * here. There is no in-place migration: an upgrade from an older version drops every
 * store and the index is rebuilt from the vault on next use. That is deliberate —
 * rewriting a multi-GB vector database inside a phone's WebContent process is the
 * memory spike this version exists to remove.
 */
const DB_VERSION = 3;

/**
 * How long to wait on a blocked `indexedDB.open` before failing with a real error.
 * A blocked open fires neither `success` nor `error`, so without a bound it hangs
 * forever. Generous enough that the normal case — the other connection yielding via
 * its `versionchange` handler — always wins the race.
 */
const OPEN_BLOCKED_TIMEOUT_MS = 10_000;

/**
 * Document row as stored in IndexedDB. Structured clone preserves typed arrays, so
 * the vector round-trips as a `Float32Array` with no conversion on either side.
 */
interface StoredDocument {
	id: string;
	path: string;
	mtime: number;
	vector: Float32Array;
	chunkIndex?: number;
	/** Numeric ID for HNSW index */
	hnswId: number;
}

/**
 * Metadata stored in IndexedDB to track index state.
 */
interface StoredMetadata {
	key: "metadata";
	version: number;
	providerId: string;
	modelId: string;
	lastUpdated: number;
	dimensions: number;
	nextHnswId: number;
}

/**
 * The graph's scalar state, stored next to {@link StoredMetadata} in the metadata store.
 * Everything else about a node is derivable: its vector is the document row that
 * carries the same `hnswId`, so the graph store holds topology only.
 */
interface StoredGraphHeader {
	key: "hnsw-graph";
	levelMax: number;
	entryPointId: number;
}

/** One HNSW node's topology — its level and per-level neighbour lists, no vector. */
interface StoredGraphNode {
	id: number;
	level: number;
	neighbors: number[][];
}

/**
 * ID mapping entry for HNSW numeric IDs.
 */
interface IdMapping {
	numericId: number;
	stringId: string;
}

/** The library's node shape, without reaching into its internal module path. */
type HnswNode = HNSW["nodes"] extends Map<number, infer N> ? N : never;

/**
 * Runs a single read request inside `tx` and settles a promise on it, covering the
 * transaction-level failures a bare `request.onerror` misses.
 *
 * An IndexedDB transaction can abort without ever firing `error` on its request —
 * the connection being force-closed (which our `versionchange` handler now does),
 * storage eviction, or the browser tearing the tx down. In those cases only
 * `tx.onabort` fires, so a promise wired solely to `request.onerror`/`onsuccess`
 * never settles and its caller hangs indefinitely with no error surfaced.
 *
 * For the read paths only; the write paths already settle on `tx.oncomplete` /
 * `tx.onerror`, which covers them. `map` turns the raw request result into the
 * caller's shape, and may be called more than once for cursor-driven reads —
 * return a value only when the read is complete (see `awaitCursor`).
 */
function awaitRequest<T>(tx: IDBTransaction, request: IDBRequest, map: (result: never) => T): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const fail = (reason: unknown) => {
			if (settled) return;
			settled = true;
			reject(toError(reason, "IndexedDB request failed."));
		};

		request.onerror = () => fail(request.error);
		tx.onerror = () => fail(tx.error);
		tx.onabort = () => fail(tx.error ?? new Error("IndexedDB transaction aborted before the request completed."));
		request.onsuccess = () => {
			if (settled) return;
			settled = true;
			try {
				resolve(map(request.result as never));
			} catch (error) {
				reject(toError(error));
			}
		};
	});
}

/**
 * Cursor variant of {@link awaitRequest}: `step` runs on every `onsuccess` and
 * resolves the promise by returning a value once the cursor is exhausted
 * (returning `undefined` keeps iterating). Same transaction-abort guards.
 */
function awaitCursor<T>(
	tx: IDBTransaction,
	request: IDBRequest,
	step: (cursor: IDBCursor | null) => { done: true; value: T } | undefined,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const fail = (reason: unknown) => {
			if (settled) return;
			settled = true;
			reject(toError(reason, "IndexedDB request failed."));
		};

		request.onerror = () => fail(request.error);
		tx.onerror = () => fail(tx.error);
		tx.onabort = () => fail(tx.error ?? new Error("IndexedDB transaction aborted before the cursor completed."));
		request.onsuccess = () => {
			if (settled) return;
			try {
				const outcome = step((request.result as IDBCursor | null) ?? null);
				if (outcome) {
					settled = true;
					resolve(outcome.value);
				}
			} catch (error) {
				fail(error);
			}
		};
	});
}

/**
 * Settles on a write transaction's completion. The caller issues its requests on
 * `tx` synchronously (inside `run`) so they all belong to this one transaction.
 */
function awaitTransaction(tx: IDBTransaction, run: () => void): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(toError(tx.error, "IndexedDB transaction failed."));
		tx.onabort = () => reject(toError(tx.error, "IndexedDB transaction aborted."));
		try {
			run();
		} catch (error) {
			reject(toError(error));
		}
	});
}

/**
 * HNSW-backed vector store with O(log n) search complexity.
 * Uses pure TypeScript HNSW implementation with IndexedDB persistence.
 */
export class HNSWVectorStore implements VectorStore {
	private db: IDBDatabase | null = null;
	private hnswIndex: HNSW | null = null;
	private _providerId: string | null = null;
	private _modelId: string | null = null;
	private dimensions: number | null = null;
	private nextHnswId = 0;
	private readonly dbName: string;

	/**
	 * Debounced HNSW graph flush for the incremental path. `upsert` mutates the
	 * in-memory graph but, without this, only `close()`/`bulkPut` ever persisted
	 * it — so a force-quit between full rebuilds lost every incrementally-added
	 * point from the persisted graph (their doc rows/id-mappings survived in IDB,
	 * so search silently returned stale results with no error). Coalesce rapid
	 * edits into one save; `close()` cancels this and does a final synchronous
	 * flush.
	 *
	 * A plain timer (not obsidian's `debounce`) because this module also runs
	 * inside the HNSW Web Worker, where the `obsidian` package can't be resolved.
	 */
	private static readonly SAVE_DEBOUNCE_MS = 2000;
	private hasPendingIndexSave = false;
	// Timers go through `self`, not `window`: this class runs inside the HNSW Web
	// Worker (hnswWorker.ts), where `window` is undefined. On the main thread the
	// two are the same object, so this stays popout-window safe there as well.
	private saveIndexTimer: number | null = null;

	private scheduleIndexSave(): void {
		if (this.saveIndexTimer !== null) self.clearTimeout(this.saveIndexTimer);
		this.saveIndexTimer = self.setTimeout(() => {
			this.saveIndexTimer = null;
			void this.flushIndex();
		}, HNSWVectorStore.SAVE_DEBOUNCE_MS);
	}

	// ID mappings (string ID <-> numeric HNSW ID)
	private idToNumeric: Map<string, number> = new Map();
	private numericToId: Map<number, string> = new Map();

	// HNSW parameters
	private readonly M = 16; // Number of connections per node
	private readonly efConstruction = 100; // Construction time accuracy (100 is sufficient for <10k docs)
	private readonly efSearch = 100; // Search time accuracy

	constructor(vaultId: string, indexId?: string) {
		this.dbName = getDbName(DB_NAME_PREFIX, vaultId, indexId);
	}

	/**
	 * Open the database connection and initialize HNSW index.
	 */
	async open(): Promise<void> {
		const upgradedFrom = await this.openIndexedDB();
		if (upgradedFrom !== null) await this.discardLegacySidecar(upgradedFrom);

		// Load ID mappings
		await this.loadIdMappings();

		// Load metadata to get dimensions
		const meta = await this.getMetadataInternal();
		if (meta?.dimensions) {
			this.dimensions = meta.dimensions;
			this._providerId = meta.providerId;
			this._modelId = meta.modelId;
		}

		// The id counter must clear every numeric id that is or was in use, and the
		// metadata record is not a safe sole source for it: a store can hold rows and
		// a persisted graph without that record at all (a bulk run that never called
		// `setMetadata` — `updateLastUpdated` then has nothing to write the counter
		// into). Restoring 0 in that state reassigned live ids: `addPoint` threw
		// "Node with id N already exists" for every new chunk, and each attempt had
		// already overwritten the id mapping of the note that owned N. Observed on a
		// resumed build: 450 graph nodes, no metadata record, 87 rows written over
		// live ids.
		//
		// So take the high-water mark of everything that can hold an id. The
		// mappings alone are not enough: `remove()` deletes a note's mappings before
		// its rows, in separate transactions, so an interrupted removal leaves a row
		// and a persisted graph node with no mapping — and `loadGraph` keeps a node
		// whose row exists. Each read is one reverse key-cursor step.
		const [maxMapped, maxGraphNode] = await Promise.all([this.maxKey(ID_MAPPING_STORE), this.maxKey(GRAPH_STORE)]);
		this.nextHnswId = Math.max(meta?.nextHnswId ?? 0, maxMapped + 1, maxGraphNode + 1);
	}

	/** Largest numeric primary key in a store, or -1 when it is empty. */
	private async maxKey(storeName: string): Promise<number> {
		const db = this.requireDb();
		const tx = db.transaction(storeName, "readonly");
		const request = tx.objectStore(storeName).openKeyCursor(null, "prev");
		return awaitCursor(tx, request, (cursor) => ({
			done: true,
			value: cursor && typeof cursor.key === "number" ? cursor.key : -1,
		}));
	}

	/** Vector width of the first stored row, or null for an empty store. */
	private async probeDimensions(): Promise<number | null> {
		const db = this.requireDb();
		const tx = db.transaction(DOCUMENTS_STORE, "readonly");
		const request = tx.objectStore(DOCUMENTS_STORE).openCursor();
		return awaitCursor(tx, request, (cursor) => ({
			done: true,
			value: cursor ? ((cursor as IDBCursorWithValue).value as StoredDocument).vector.length : null,
		}));
	}

	/**
	 * Opens the database, creating or upgrading its schema. Resolves with the
	 * previous schema version when an existing database was upgraded (its stores
	 * were dropped, see {@link DB_VERSION}), or `null` for a fresh or current one.
	 */
	private async openIndexedDB(): Promise<number | null> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, DB_VERSION);
			let settled = false;
			let blockedTimer: number | null = null;
			let upgradedFrom: number | null = null;

			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				if (blockedTimer !== null) self.clearTimeout(blockedTimer);
				fn();
			};

			request.onerror = () =>
				finish(() => reject(toError(request.error, "Failed to open the vector index database.")));

			// The DB name is per-vault, so a second Obsidian window on the same vault
			// opens the *same* database. When this open needs a version upgrade and
			// that other connection is still open, IndexedDB fires `blocked` and then
			// fires NEITHER `success` NOR `error` — the promise would hang forever, and
			// with it the whole VectorStoreService init, with no error surfaced anywhere.
			//
			// The other window normally yields via the `versionchange` handler installed
			// below (added in the same change), so `blocked` should resolve on its own
			// within a moment. Time-bounded rather than rejecting immediately so that
			// normal case still succeeds; if the wait elapses, fail loudly with an
			// actionable message instead of hanging.
			request.onblocked = () => {
				Logger.warn(
					`${LOG_PREFIX} open blocked on "${this.dbName}" — another connection is still open (a second Obsidian window on this vault?). Waiting ${OPEN_BLOCKED_TIMEOUT_MS}ms for it to close.`,
				);
				if (blockedTimer !== null) self.clearTimeout(blockedTimer);
				blockedTimer = self.setTimeout(() => {
					finish(() =>
						reject(
							new Error(
								`Timed out opening the vector index database "${this.dbName}": another Obsidian window has it open with an older version. Close the other window and reload.`,
							),
						),
					);
				}, OPEN_BLOCKED_TIMEOUT_MS);
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;

				// An older schema is not migrated, it is discarded (see DB_VERSION).
				// Drop every store so the index reads as empty and gets rebuilt.
				if (event.oldVersion > 0 && event.oldVersion < DB_VERSION) {
					upgradedFrom = event.oldVersion;
					const names: string[] = [];
					for (let i = 0; i < db.objectStoreNames.length; i++) {
						const name = db.objectStoreNames[i];
						if (name) names.push(name);
					}
					for (const name of names) db.deleteObjectStore(name);
				}

				const docStore = db.createObjectStore(DOCUMENTS_STORE, { keyPath: "id" });
				docStore.createIndex("path", "path", { unique: false });
				docStore.createIndex("mtime", "mtime", { unique: false });
				docStore.createIndex(PATH_MTIME_INDEX, ["path", "mtime"], { unique: false });

				db.createObjectStore(METADATA_STORE, { keyPath: "key" });
				db.createObjectStore(ID_MAPPING_STORE, { keyPath: "numericId" });
				db.createObjectStore(GRAPH_STORE, { keyPath: "id" });
			};

			request.onsuccess = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;
				// The other half of the deadlock: if a *future* connection (another
				// window, or this plugin after an update) needs a version upgrade, it
				// blocks until every existing connection closes. Without this handler
				// we would be the connection that never yields, hanging the other side
				// exactly the way `onblocked` above guards against.
				db.onversionchange = () => {
					Logger.warn(
						`${LOG_PREFIX} another connection requested a version upgrade of "${this.dbName}" — closing ours to let it proceed.`,
					);
					db.close();
					if (this.db === db) this.db = null;
				};
				finish(() => {
					this.db = db;
					resolve(upgradedFrom);
				});
			};
		});
	}

	/**
	 * Schema versions before 3 kept the HNSW graph in a separate database owned by
	 * the `hnsw` library (`<dbName>-hnsw-index`). Nothing reads it any more, and it
	 * is the largest single object on disk (every vector, as doubles), so it goes
	 * the moment the main database has been upgraded past it.
	 */
	private async discardLegacySidecar(fromVersion: number): Promise<void> {
		Logger.log(
			`${LOG_PREFIX} "${this.dbName}" upgraded from schema v${fromVersion} to v${DB_VERSION}: stored vectors discarded, the index will be rebuilt from the vault.`,
		);
		const sidecar = `${this.dbName}-hnsw-index`;
		const result = await deleteDatabase(sidecar);
		if (result.status === "error") {
			Logger.error(`${LOG_PREFIX} Failed to delete legacy graph database "${sidecar}":`, result.error);
		} else if (result.status === "blocked") {
			Logger.warn(
				`${LOG_PREFIX} Legacy graph database "${sidecar}" is held open elsewhere; it will be deleted once that connection closes.`,
			);
		}
	}

	private async loadIdMappings(): Promise<void> {
		if (!this.db) return;
		const db = this.db;

		const tx = db.transaction(ID_MAPPING_STORE, "readonly");
		const request = tx.objectStore(ID_MAPPING_STORE).getAll();
		return awaitRequest<void>(tx, request, (mappings: IdMapping[]) => {
			this.idToNumeric.clear();
			this.numericToId.clear();
			for (const mapping of mappings) {
				this.idToNumeric.set(mapping.stringId, mapping.numericId);
				this.numericToId.set(mapping.numericId, mapping.stringId);
			}
		});
	}

	private async saveIdMapping(stringId: string, numericId: number): Promise<void> {
		if (!this.db) return;

		const mapping: IdMapping = { numericId, stringId };
		await this.putInStore(ID_MAPPING_STORE, mapping);
		this.idToNumeric.set(stringId, numericId);
		this.numericToId.set(numericId, stringId);
	}

	private async removeIdMapping(stringId: string): Promise<void> {
		if (!this.db) return;
		const db = this.db;

		const numericId = this.idToNumeric.get(stringId);
		if (numericId === undefined) return;

		const tx = db.transaction(ID_MAPPING_STORE, "readwrite");
		await awaitTransaction(tx, () => {
			tx.objectStore(ID_MAPPING_STORE).delete(numericId);
		});
		this.idToNumeric.delete(stringId);
		this.numericToId.delete(numericId);
	}

	private createEmptyGraph(): HNSW {
		return new HNSW(this.M, this.efConstruction, null, "cosine", this.efSearch);
	}

	/**
	 * The graph load in flight, so concurrent callers share one. The worker
	 * handles messages concurrently, and the guard on `hnswIndex` alone is not
	 * enough: a search arriving while the first `upsert` was still loading the
	 * graph started a second load, and whichever finished last replaced the
	 * graph — dropping every point the other had `addPoint`ed in between, for
	 * the rest of the session.
	 */
	private graphLoad: Promise<void> | null = null;

	private initHNSWIndex(): Promise<void> {
		if (!this.dimensions || this.hnswIndex) return Promise.resolve();
		if (this.graphLoad) return this.graphLoad;

		this.graphLoad = (async () => {
			const index = this.createEmptyGraph();
			try {
				await this.loadGraph(index);
			} catch (error) {
				// A graph that fails to load is not fatal: the rows are intact, and the
				// next full rebuild (or incremental upserts) repopulate it.
				Logger.error(`${LOG_PREFIX} Failed to load persisted HNSW graph; starting from an empty one:`, error);
			}
			this.hnswIndex = index;
		})().finally(() => {
			this.graphLoad = null;
		});
		return this.graphLoad;
	}

	private async ensureHNSWIndex(): Promise<void> {
		if (!this.dimensions) return;
		await this.initHNSWIndex();
	}

	// =========================================================================
	// Graph persistence
	// =========================================================================

	/**
	 * Rehydrate the in-memory graph: topology rows from {@link GRAPH_STORE}, vectors
	 * from the document rows that share each node's `hnswId`.
	 *
	 * Both reads are cursor walks, so at no point does a second copy of the whole
	 * vector set exist. Each document row is deserialised once, and the
	 * `Float32Array` structured-clone hands us becomes the node's vector as-is.
	 *
	 * A node whose document row is gone (removed after the last graph save) is
	 * dropped, and every neighbour list is pruned of such ids so the library never
	 * dereferences a missing node mid-search.
	 *
	 * The mirror case matters just as much: a document row with no topology node.
	 * Rows are written durably on every `upsert`, but the graph is saved on a
	 * debounce and at bulk checkpoints, so a process kill mid-build (the mobile
	 * failure mode of #432) leaves the rows written since the last save with no
	 * links. Before, such rows were silently unsearchable while still counting as
	 * indexed — the completeness validation saw their `mtime` and skipped them, so
	 * nothing ever repaired them. Now they are re-inserted into the graph here,
	 * which makes the row the unit of durability; the checkpoint interval only
	 * bounds how much re-linking a reopen has to do.
	 */
	private async loadGraph(index: HNSW): Promise<void> {
		const db = this.requireDb();

		const header = await this.getGraphHeader();

		const topology = new Map<number, StoredGraphNode>();
		if (header) {
			const tx = db.transaction(GRAPH_STORE, "readonly");
			const request = tx.objectStore(GRAPH_STORE).openCursor();
			await awaitCursor<void>(tx, request, (cursor) => {
				if (!cursor) return { done: true, value: undefined };
				const node = (cursor as IDBCursorWithValue).value as StoredGraphNode;
				topology.set(node.id, node);
				cursor.continue();
				return undefined;
			});
		}

		const nodes = new Map<number, HnswNode>();
		/** Rows the persisted graph does not know about — see the doc comment. */
		const unlinked: Array<{ id: number; vector: Float32Array }> = [];
		let dim: number | null = null;
		{
			const tx = db.transaction(DOCUMENTS_STORE, "readonly");
			const request = tx.objectStore(DOCUMENTS_STORE).openCursor();
			await awaitCursor<void>(tx, request, (cursor) => {
				if (!cursor) return { done: true, value: undefined };
				const stored = (cursor as IDBCursorWithValue).value as StoredDocument;
				const node = topology.get(stored.hnswId);
				if (node) {
					dim ??= stored.vector.length;
					nodes.set(node.id, {
						id: node.id,
						vector: stored.vector,
						level: node.level,
						neighbors: node.neighbors,
					});
				} else if (this.numericToId.has(stored.hnswId)) {
					// Only rows that still have an id mapping are live; a row whose
					// mapping is gone is mid-removal and must not come back.
					unlinked.push({ id: stored.hnswId, vector: stored.vector });
				}
				cursor.continue();
				return undefined;
			});
		}
		topology.clear();
		if (nodes.size === 0 && unlinked.length === 0) return;

		let pruned = 0;
		let levelMax = -1;
		for (const node of nodes.values()) {
			if (node.level > levelMax) levelMax = node.level;
			for (let level = 0; level < node.neighbors.length; level++) {
				const ids = node.neighbors[level];
				if (ids.every((id) => nodes.has(id))) continue;
				node.neighbors[level] = ids.filter((id) => nodes.has(id));
				pruned++;
			}
		}

		let entryPointId = header?.entryPointId ?? -1;
		if (!nodes.has(entryPointId)) {
			// Any node on the top level is a valid entry point; take the smallest id
			// so the choice is stable across loads.
			entryPointId = -1;
			for (const node of nodes.values()) {
				if (node.level === levelMax && (entryPointId === -1 || node.id < entryPointId)) entryPointId = node.id;
			}
		}

		index.nodes = nodes;
		index.d = dim ?? (unlinked.length > 0 ? unlinked[0].vector.length : null);
		index.levelMax = nodes.size > 0 ? levelMax : -1;
		index.entryPointId = entryPointId;

		if (pruned > 0) {
			Logger.debug(`${LOG_PREFIX} Loaded graph (${nodes.size} nodes); pruned ${pruned} stale neighbour lists.`);
		}

		if (unlinked.length > 0) {
			for (const row of unlinked) await index.addPoint(row.id, row.vector);
			// The re-linked graph is only in memory; schedule the save so the next
			// open does not have to redo this.
			this.hasPendingIndexSave = true;
			this.scheduleIndexSave();
			Logger.log(
				`${LOG_PREFIX} Re-linked ${unlinked.length} vectors that were written after the last graph save (interrupted build).`,
			);
		}
	}

	/**
	 * Persist the in-memory graph's topology (levels, neighbour lists, entry point).
	 * Vectors are deliberately not written here — the document rows already hold
	 * them. One transaction replaces the whole store: the library rewires other
	 * nodes' neighbour lists on every insert, so there is no cheap dirty set.
	 */
	private async saveGraph(): Promise<void> {
		const db = this.requireDb();
		const index = this.hnswIndex;
		if (!index) return;

		const tx = db.transaction([GRAPH_STORE, METADATA_STORE], "readwrite");
		await awaitTransaction(tx, () => {
			const graphStore = tx.objectStore(GRAPH_STORE);
			graphStore.clear();
			for (const node of index.nodes.values()) {
				const stored: StoredGraphNode = { id: node.id, level: node.level, neighbors: node.neighbors };
				graphStore.put(stored);
			}
			const header: StoredGraphHeader = {
				key: "hnsw-graph",
				levelMax: index.levelMax,
				entryPointId: index.entryPointId,
			};
			tx.objectStore(METADATA_STORE).put(header);
		});
	}

	private async getGraphHeader(): Promise<StoredGraphHeader | null> {
		const db = this.requireDb();
		const tx = db.transaction(METADATA_STORE, "readonly");
		const request = tx.objectStore(METADATA_STORE).get("hnsw-graph");
		return awaitRequest(tx, request, (header: StoredGraphHeader | undefined) => header ?? null);
	}

	/** Drop the persisted graph (topology + header) without touching document rows. */
	private async deleteGraph(): Promise<void> {
		const db = this.requireDb();
		const tx = db.transaction([GRAPH_STORE, METADATA_STORE], "readwrite");
		await awaitTransaction(tx, () => {
			tx.objectStore(GRAPH_STORE).clear();
			tx.objectStore(METADATA_STORE).delete("hnsw-graph");
		});
	}

	/**
	 * Close the database connection.
	 */
	async close(): Promise<void> {
		// Cancel the pending debounced save so it can't fire after we null `db`,
		// then flush synchronously so no incremental changes are lost on close.
		if (this.saveIndexTimer !== null) {
			self.clearTimeout(this.saveIndexTimer);
			this.saveIndexTimer = null;
		}
		if (this.hnswIndex && this.db && this.hasPendingIndexSave) {
			try {
				await this.saveGraph();
				this.hasPendingIndexSave = false;
			} catch {
				// Ignore save errors on close
			}
		}

		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	/**
	 * Get the current provider ID.
	 */
	get providerId(): string | null {
		return this._providerId;
	}

	/**
	 * Get the current model ID.
	 */
	get modelId(): string | null {
		return this._modelId;
	}

	/**
	 * Set the metadata for this index.
	 */
	async setMetadata(providerId: string, modelId: string, version: number): Promise<void> {
		this._providerId = providerId;
		this._modelId = modelId;

		// A record written to repair a store that already holds rows must carry
		// their width, or the next open leaves `dimensions` unset and the graph is
		// never loaded until something is written. An empty store stays at 0.
		if (!this.dimensions) this.dimensions = await this.probeDimensions();

		const meta: StoredMetadata = {
			key: "metadata",
			version,
			providerId,
			modelId,
			lastUpdated: Date.now(),
			dimensions: this.dimensions ?? 0,
			nextHnswId: this.nextHnswId,
		};

		await this.putInStore(METADATA_STORE, meta);
	}

	/**
	 * Get the current index metadata.
	 */
	async getMetadata(): Promise<IndexMetadata | null> {
		const meta = await this.getMetadataInternal();
		if (!meta) return null;

		const count = await this.count();
		return {
			version: meta.version,
			providerId: meta.providerId,
			modelId: meta.modelId,
			documentCount: count,
			lastUpdated: meta.lastUpdated,
			dimensions: meta.dimensions ?? 0,
		};
	}

	/**
	 * Add or update a document in the store.
	 */
	async upsert(doc: DocumentVector): Promise<void> {
		// Initialize dimensions from first document
		if (!this.dimensions) {
			this.dimensions = doc.vector.length;
		}
		await this.ensureHNSWIndex();

		// Remove the prior version of *this chunk* if updating.
		//
		// Must be keyed on the chunk id, not the path: `getByPath` returns only the
		// first chunk of a note, so on a multi-chunk note re-upserting chunk #2 would
		// drop chunk #0's mapping while #2's own stale mapping survived. Each such
		// upsert then assigned a fresh numeric id and orphaned a graph node, leaving
		// nodes with no `numericToId` entry — which `search()` silently skips,
		// truncating results. (Observed after section-aware chunking turned
		// single-chunk notes into multi-chunk ones: 2611 graph nodes vs 2281
		// mappings, and a 50-result query returning 4.)
		if (this.idToNumeric.has(doc.id)) {
			await this.removeIdMapping(doc.id);
		}

		// Assign numeric ID for HNSW
		const hnswId = this.nextHnswId++;
		await this.saveIdMapping(doc.id, hnswId);

		// Store in IndexedDB
		const stored: StoredDocument = {
			id: doc.id,
			path: doc.path,
			mtime: doc.mtime,
			vector: doc.vector,
			chunkIndex: doc.chunkIndex,
			hnswId,
		};
		await this.putInStore(DOCUMENTS_STORE, stored);

		// Add to HNSW index with numeric ID. The library keeps a reference to the
		// array it is given, so this Float32Array becomes the resident copy.
		if (this.hnswIndex) {
			await this.hnswIndex.addPoint(hnswId, doc.vector);
		}

		await this.updateLastUpdated();

		// Persist the in-memory graph. Debounced so a burst of edits collapses
		// into one save; a clean close() flushes anything still pending.
		this.hasPendingIndexSave = true;
		this.scheduleIndexSave();
	}

	/** Checkpoint for bulk runs: persist the graph now rather than on the debounce. */
	async flush(): Promise<void> {
		if (this.saveIndexTimer !== null) {
			self.clearTimeout(this.saveIndexTimer);
			this.saveIndexTimer = null;
		}
		await this.flushIndex();
	}

	/**
	 * Persist the HNSW graph to IndexedDB if there are unsaved incremental
	 * changes. Safe to call repeatedly (no-op when nothing is pending).
	 */
	private async flushIndex(): Promise<void> {
		if (!this.hasPendingIndexSave || !this.hnswIndex || !this.db) return;
		this.hasPendingIndexSave = false;
		try {
			await this.saveGraph();
		} catch (e) {
			// Re-arm so a later flush (or close) retries the save.
			this.hasPendingIndexSave = true;
			Logger.error(`${LOG_PREFIX} Failed to persist HNSW graph:`, e);
		}
	}

	/**
	 * Remove a document by path.
	 * A note may be stored as multiple chunk rows sharing the same `path`; this
	 * deletes every one of them and drops each chunk's id-mapping.
	 *
	 * The hnsw package doesn't support deletion, so the graph nodes stay until
	 * the next full rebuild (`bulkPut`) or reload (`loadGraph` drops nodes whose
	 * row is gone). Search tolerates them: numeric ids with no string mapping
	 * are skipped.
	 */
	async remove(path: string): Promise<void> {
		const db = this.requireDb();

		// Drop id-mappings for ALL chunks of this note (getByPath returns only one).
		const ids = await this.getIdsForPath(path);
		for (const id of ids) {
			await this.removeIdMapping(id);
		}

		const tx = db.transaction(DOCUMENTS_STORE, "readwrite");
		await awaitTransaction(tx, () => {
			const request = tx.objectStore(DOCUMENTS_STORE).index("path").openCursor(IDBKeyRange.only(path));
			request.onsuccess = () => {
				const cursor = request.result;
				if (cursor) {
					cursor.delete();
					cursor.continue();
				}
			};
		});
		await this.updateLastUpdated();
	}

	/**
	 * Get a document by path.
	 */
	async getByPath(path: string): Promise<DocumentVector | undefined> {
		const db = this.requireDb();

		const tx = db.transaction(DOCUMENTS_STORE, "readonly");
		const request = tx.objectStore(DOCUMENTS_STORE).index("path").get(path);
		return awaitRequest(tx, request, (stored: StoredDocument | undefined) =>
			stored ? this.toDocumentVector(stored) : undefined,
		);
	}

	/**
	 * Get every chunk vector of a note. `getByPath` returns only one chunk;
	 * per-note operations (e.g. the graph's incremental semantic re-query)
	 * need all of them.
	 */
	async getAllByPath(path: string): Promise<DocumentVector[]> {
		const stored = await this.getAllStoredForPath(path);
		return stored.map((s) => this.toDocumentVector(s));
	}

	/**
	 * Check if a document exists and get its mtime. Reads the `[path, mtime]`
	 * index key only, so no vector is deserialised.
	 */
	async getDocumentMtime(path: string): Promise<number | undefined> {
		const db = this.requireDb();

		const tx = db.transaction(DOCUMENTS_STORE, "readonly");
		const range = IDBKeyRange.bound([path, Number.NEGATIVE_INFINITY], [path, Number.POSITIVE_INFINITY]);
		const request = tx.objectStore(DOCUMENTS_STORE).index(PATH_MTIME_INDEX).openKeyCursor(range);
		return awaitCursor<number | undefined>(tx, request, (cursor) => {
			if (!cursor) return { done: true, value: undefined };
			const [, mtime] = cursor.key as [string, number];
			return { done: true, value: mtime };
		});
	}

	/**
	 * Per-note `{ path, mtime }` for every indexed note, read from the
	 * `[path, mtime]` index with a unique *key* cursor: the walk never touches a
	 * row value, so the vectors stay on disk. All chunks of a note share one
	 * mtime, so this yields one entry per note.
	 */
	async listNoteMeta(): Promise<NoteMeta[]> {
		const db = this.requireDb();

		const tx = db.transaction(DOCUMENTS_STORE, "readonly");
		const request = tx.objectStore(DOCUMENTS_STORE).index(PATH_MTIME_INDEX).openKeyCursor();

		// A note is listed only through its chunk-0 row. Bulk writers store a
		// note's chunk 0 *last* (`VectorStoreService.embedFilesInBatches`), so a
		// process killed between the chunks of a multi-chunk note leaves rows
		// that carry the note's current mtime but no `#0` — and this read then
		// reports the note as absent, which makes the next validation re-index
		// it. Without that, the surviving chunks made the note look complete and
		// its missing sections never came back. Key cursor only: `primaryKey`
		// is the chunk id, so no row value (no vector) is ever deserialised.
		const notes: NoteMeta[] = [];
		return awaitCursor(tx, request, (cursor) => {
			if (!cursor) return { done: true, value: notes };
			if (typeof cursor.primaryKey === "string" && cursor.primaryKey.endsWith(FIRST_CHUNK_SUFFIX)) {
				const [path, mtime] = cursor.key as [string, number];
				notes.push({ path, mtime });
			}
			cursor.continue();
			return undefined;
		});
	}

	/**
	 * Get all documents as serialized format (for MessagePack).
	 *
	 * The only whole-set read left. It backs the explicit "export index" action,
	 * which is a desktop file dialog; nothing on the startup or graph path calls it.
	 */
	async getAllSerialized(): Promise<SerializedDocument[]> {
		const docs: SerializedDocument[] = [];
		await this.forEachStored((s) => {
			docs.push({
				id: s.id,
				path: s.path,
				mtime: s.mtime,
				vector: Array.from(s.vector),
				chunkIndex: s.chunkIndex,
			});
		});
		return docs;
	}

	/**
	 * Semantic neighbour pairs among `paths`, computed here where the vectors live.
	 *
	 * The graph view used to pull every vector to the main thread and ship it to
	 * a second worker; now only the note list crosses in and only scored index
	 * pairs cross out. The chunk rows of the requested notes are read once (one
	 * transaction, one `getAll` per path) straight into the flat batch the scan
	 * kernels consume, so the transient footprint is the included subset, not the
	 * whole index. Note indices in the result refer to positions in `paths`.
	 */
	async semanticPairs(paths: string[], options: SemanticPairOptions = {}): Promise<SemanticPair[]> {
		const db = this.requireDb();
		if (paths.length < 2) return [];

		const batch = new ChunkBatchBuilder();
		const tx = db.transaction(DOCUMENTS_STORE, "readonly");
		await new Promise<void>((resolve, reject) => {
			const index = tx.objectStore(DOCUMENTS_STORE).index("path");
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(toError(tx.error, "IndexedDB transaction failed."));
			tx.onabort = () => reject(toError(tx.error, "IndexedDB transaction aborted."));
			paths.forEach((path, noteIndex) => {
				const request = index.getAll(IDBKeyRange.only(path));
				request.onsuccess = () => {
					for (const stored of request.result as StoredDocument[]) batch.add(noteIndex, stored.vector);
				};
			});
		});

		const { data, count, dim, chunkOwners } = batch.finish();
		return computeSemanticPairs(data, count, dim, chunkOwners, paths.length, {
			neighborCount: options.neighborCount,
			threshold: options.threshold,
			excludePairs: options.excludePairs ? new Set(options.excludePairs) : undefined,
		});
	}

	/**
	 * Every other note scoring at least `threshold` against any chunk of `path`,
	 * best chunk pair per note, sorted by score descending. An exhaustive cursor
	 * walk (not the HNSW graph), so the result is exact and needs no index to be
	 * loaded; each row is scored as it streams past and never retained.
	 */
	async noteNeighbors(path: string, threshold: number): Promise<NoteNeighbor[]> {
		const active = await this.getAllStoredForPath(path);
		if (active.length === 0) return [];
		const activeVectors = active.map((s) => s.vector);

		const bestByPath = new Map<string, number>();
		await this.forEachStored((stored) => {
			if (stored.path === path || stored.vector.length !== activeVectors[0].length) return;
			let best = Number.NEGATIVE_INFINITY;
			for (const activeVector of activeVectors) {
				const score = cosineSimilarity(activeVector, stored.vector);
				if (score > best) best = score;
			}
			if (best < threshold) return;
			const previous = bestByPath.get(stored.path);
			if (previous === undefined || best > previous) bestByPath.set(stored.path, best);
		});

		return [...bestByPath.entries()]
			.map(([neighborPath, score]) => ({ path: neighborPath, score }))
			.sort((left, right) => right.score - left.score || (left.path < right.path ? -1 : 1));
	}

	/**
	 * Bulk insert documents (for loading from file).
	 * Rebuilds the HNSW index from scratch for efficiency.
	 */
	async bulkPut(docs: DocumentVector[]): Promise<void> {
		const totalStart = performance.now();
		const db = this.requireDb();

		// Initialize dimensions from first document
		if (docs.length > 0 && !this.dimensions) {
			this.dimensions = docs[0].vector.length;
		}
		await this.ensureHNSWIndex();

		// Clear existing mappings
		await this.clearStore(ID_MAPPING_STORE);
		this.idToNumeric.clear();
		this.numericToId.clear();
		this.nextHnswId = 0;

		// Prepare vectors with numeric IDs for HNSW. These are the callers' own
		// Float32Arrays — the graph adopts them, no copy is made.
		const hnswVectors: Array<{ id: number; vector: Float32Array }> = [];

		// Store all documents in IndexedDB in a single transaction
		const tx = db.transaction([DOCUMENTS_STORE, ID_MAPPING_STORE], "readwrite");
		await awaitTransaction(tx, () => {
			const docStore = tx.objectStore(DOCUMENTS_STORE);
			const mappingStore = tx.objectStore(ID_MAPPING_STORE);

			for (const doc of docs) {
				const hnswId = this.nextHnswId++;

				// Save mapping
				const mapping: IdMapping = { numericId: hnswId, stringId: doc.id };
				mappingStore.put(mapping);
				this.idToNumeric.set(doc.id, hnswId);
				this.numericToId.set(hnswId, doc.id);

				// Store document with hnswId
				const stored: StoredDocument = {
					id: doc.id,
					path: doc.path,
					mtime: doc.mtime,
					vector: doc.vector,
					chunkIndex: doc.chunkIndex,
					hnswId,
				};
				docStore.put(stored);

				hnswVectors.push({ id: hnswId, vector: doc.vector });
			}
		});

		// Rebuild HNSW index from all documents with numeric IDs
		if (this.hnswIndex && hnswVectors.length > 0) {
			await this.hnswIndex.buildIndex(hnswVectors);
			await this.saveGraph();
			this.hasPendingIndexSave = false;
		}
		Logger.debug(`${LOG_PREFIX} bulkPut (${docs.length} docs): ${(performance.now() - totalStart).toFixed(1)}ms`);
	}

	/**
	 * Clear all documents from the store.
	 */
	async clear(): Promise<void> {
		if (!this.db) throw new Error("Database not open");
		// A load still in flight would install the old graph over the cleared state.
		if (this.graphLoad) await this.graphLoad.catch(() => {});

		await this.clearStore(DOCUMENTS_STORE);
		await this.clearStore(METADATA_STORE);
		await this.clearStore(ID_MAPPING_STORE);

		// Clear in-memory mappings
		this.idToNumeric.clear();
		this.numericToId.clear();
		this.nextHnswId = 0;

		// Drop the *persisted* graph, not just the in-memory handle. Otherwise the
		// next open() → loadGraph() resurrects every node from previous indexing
		// runs. Because clear() also resets `nextHnswId` to 0, those stale nodes
		// then collide with freshly assigned numeric ids: search resolves a hit
		// through `numericToId`, misses, and silently drops the result — which
		// manifests as semantic search returning too few results, or none at all,
		// for perfectly valid queries.
		try {
			await this.deleteGraph();
		} catch (e) {
			Logger.error(`${LOG_PREFIX} Failed to delete persisted HNSW graph:`, e);
		}
		this.hasPendingIndexSave = false;

		// A fresh graph; `upsert`/`bulkPut` re-derive the dimensions from the
		// first vector they see, which is what lets a model change land cleanly.
		this.hnswIndex = null;
		this.dimensions = null;

		this._providerId = null;
		this._modelId = null;
	}

	/**
	 * Get the number of documents in the store.
	 */
	async count(): Promise<number> {
		const db = this.requireDb();

		const tx = db.transaction(DOCUMENTS_STORE, "readonly");
		const request = tx.objectStore(DOCUMENTS_STORE).count();
		return awaitRequest(tx, request, (n: number) => n);
	}

	/**
	 * Count distinct notes (unique paths). Walks the `path` index with a
	 * unique-key cursor so it never deserializes vectors.
	 */
	async countNotes(): Promise<number> {
		const db = this.requireDb();

		const tx = db.transaction(DOCUMENTS_STORE, "readonly");
		const request = tx.objectStore(DOCUMENTS_STORE).index("path").openKeyCursor(null, "nextunique");

		let notes = 0;
		return awaitCursor(tx, request, (cursor) => {
			if (!cursor) return { done: true, value: notes };
			notes++;
			cursor.continue();
			return undefined;
		});
	}

	/**
	 * Search for similar vectors using HNSW approximate nearest neighbor.
	 * O(log n) complexity - much faster than brute-force for large datasets.
	 *
	 * Hits are resolved from the id mapping alone: the chunk id encodes the
	 * note path, and the score comes from the graph, so no document row is
	 * read. (It used to fetch every hit's row — vector included — to return a
	 * `path` the caller could have had for free.) A mapped id always has a row:
	 * `upsert` writes the row before the graph node, and `remove` drops the
	 * mapping first.
	 */
	async search(queryVector: Float32Array, topK: number, threshold?: number): Promise<SearchHit[]> {
		await this.ensureHNSWIndex();
		if (!this.hnswIndex) {
			// Fall back to brute-force if HNSW not initialized
			return this.bruteForceSearch(queryVector, topK, threshold);
		}

		try {
			// Use HNSW to get nearest neighbors (returns numeric IDs)
			const hnswResults = this.hnswIndex.searchKNN(queryVector, topK);
			const effectiveThreshold = threshold ?? 0;

			const results: SearchHit[] = [];
			for (const result of hnswResults) {
				// The hnsw package returns score (higher = more similar), not distance
				if (result.score < effectiveThreshold) continue;
				const stringId = this.numericToId.get(result.id);
				// A node with no mapping was removed; the library cannot delete it.
				if (!stringId) continue;
				const { path, chunkIndex } = parseChunkId(stringId);
				results.push({ id: stringId, path, chunkIndex, score: result.score });
			}
			return results;
		} catch {
			// Fallback to brute-force if HNSW fails
			return this.bruteForceSearch(queryVector, topK, threshold);
		}
	}

	/**
	 * Fallback brute-force search if HNSW is not available. Streams the rows
	 * past a bounded top-K list rather than materialising the whole store.
	 */
	private async bruteForceSearch(queryVector: Float32Array, topK: number, threshold?: number): Promise<SearchHit[]> {
		const effectiveThreshold = threshold ?? 0;
		const results: SearchHit[] = [];
		const trim = () => {
			results.sort((a, b) => b.score - a.score);
			results.length = Math.min(results.length, topK);
		};

		await this.forEachStored((stored) => {
			if (stored.vector.length !== queryVector.length) return;
			const score = cosineSimilarity(queryVector, stored.vector);
			if (score < effectiveThreshold) return;
			results.push({ id: stored.id, path: stored.path, chunkIndex: stored.chunkIndex ?? 0, score });
			if (results.length >= topK * 2) trim();
		});

		trim();
		return results;
	}

	// =========================================================================
	// Private helpers
	// =========================================================================

	private requireDb(): IDBDatabase {
		if (!this.db) throw new Error("Database not open");
		return this.db;
	}

	private async getMetadataInternal(): Promise<StoredMetadata | null> {
		const db = this.requireDb();

		const tx = db.transaction(METADATA_STORE, "readonly");
		const request = tx.objectStore(METADATA_STORE).get("metadata");
		return awaitRequest(tx, request, (meta: StoredMetadata | undefined) => meta ?? null);
	}

	private async putInStore<T>(storeName: string, value: T): Promise<void> {
		const db = this.requireDb();
		const tx = db.transaction(storeName, "readwrite");
		await awaitTransaction(tx, () => {
			tx.objectStore(storeName).put(value);
		});
	}

	/**
	 * Visit every document row once, in primary-key order. Rows are handed to
	 * `visit` as the cursor streams them and are not retained, so this is the
	 * building block for whole-store reads that must not hold the vector set.
	 */
	private async forEachStored(visit: (stored: StoredDocument) => void): Promise<void> {
		const db = this.requireDb();

		const tx = db.transaction(DOCUMENTS_STORE, "readonly");
		const request = tx.objectStore(DOCUMENTS_STORE).openCursor();
		return awaitCursor<void>(tx, request, (cursor) => {
			if (!cursor) return { done: true, value: undefined };
			visit((cursor as IDBCursorWithValue).value as StoredDocument);
			cursor.continue();
			return undefined;
		});
	}

	/** Get every stored chunk row for a given note path. */
	private async getAllStoredForPath(path: string): Promise<StoredDocument[]> {
		const db = this.requireDb();

		const tx = db.transaction(DOCUMENTS_STORE, "readonly");
		const request = tx.objectStore(DOCUMENTS_STORE).index("path").getAll(IDBKeyRange.only(path));
		return awaitRequest(tx, request, (docs: StoredDocument[]) => docs);
	}

	/** Chunk ids of a note, from the `path` index keys alone (no row values). */
	private async getIdsForPath(path: string): Promise<string[]> {
		const db = this.requireDb();

		const tx = db.transaction(DOCUMENTS_STORE, "readonly");
		const request = tx.objectStore(DOCUMENTS_STORE).index("path").openKeyCursor(IDBKeyRange.only(path));
		const ids: string[] = [];
		return awaitCursor(tx, request, (cursor) => {
			if (!cursor) return { done: true, value: ids };
			ids.push(cursor.primaryKey as string);
			cursor.continue();
			return undefined;
		});
	}

	private async clearStore(storeName: string): Promise<void> {
		const db = this.requireDb();
		const tx = db.transaction(storeName, "readwrite");
		await awaitTransaction(tx, () => {
			tx.objectStore(storeName).clear();
		});
	}

	private async updateLastUpdated(): Promise<void> {
		const meta = await this.getMetadataInternal();
		if (meta) {
			meta.lastUpdated = Date.now();
			// Persist the id high-water mark and dimensions on the incremental
			// path too. `upsert` bumps `nextHnswId` in memory; if only
			// `setMetadata` (full-rebuild path) persisted it, a reload would
			// restore a stale counter and reassign an in-use id → `addPoint`
			// throws "Node with id N already exists" and the note silently fails
			// to index. Keep the persisted counter in lockstep with memory.
			meta.nextHnswId = this.nextHnswId;
			if (this.dimensions) meta.dimensions = this.dimensions;
			await this.putInStore(METADATA_STORE, meta);
		}
	}

	/**
	 * Convert stored format to runtime DocumentVector. The vector is passed
	 * through: structured clone already produced a fresh Float32Array.
	 */
	private toDocumentVector(stored: StoredDocument): DocumentVector {
		return {
			id: stored.id,
			path: stored.path,
			mtime: stored.mtime,
			vector: stored.vector,
			chunkIndex: stored.chunkIndex,
		};
	}
}
