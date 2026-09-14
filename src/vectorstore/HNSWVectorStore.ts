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

import { deleteDatabase, getDbName, makeChunkId, parseChunkId } from "./types";
import { Logger } from "../utils/logging";

const LOG_PREFIX = "[VectorStore] [HNSW]";

const DB_NAME_PREFIX = "s2b-hnsw";
const DOCUMENTS_STORE = "documents";
const METADATA_STORE = "metadata";
const ID_MAPPING_STORE = "id_mapping";
const GRAPH_STORE = "hnsw_graph";
/** Compound index over `documents` so per-note mtimes can be read without touching a vector. */
const PATH_MTIME_INDEX = "path_mtime";
/**
 * Chunk id suffix of a note's first chunk (`makeChunkId(path, 0)`). `putNote` writes a
 * note atomically, so every note it stored has this row; the test is kept for rows
 * written chunk by chunk by older versions, where a missing chunk 0 means the write
 * was interrupted (see `listNoteMeta`).
 */
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

/**
 * Written to the metadata store while `adoptDatabase` copies another index's
 * database in, and removed when the copy is complete. A store that still
 * carries it on `open()` holds a partial copy — the process stopped mid-way —
 * and is either completed from the source (still there: it is deleted only
 * after the marker) or emptied when the source is gone.
 */
interface StoredAdoptionMarker {
	key: "adopting";
	/** IndexedDB name of the database being copied from. */
	from: string;
}
const ADOPTION_MARKER_KEY = "adopting";

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

/** The object stores `adoptDatabase` copies, in copy order. */
const ADOPTED_STORES = [DOCUMENTS_STORE, ID_MAPPING_STORE, GRAPH_STORE, METADATA_STORE] as const;

/**
 * Open a database to copy from: it must exist, be at the current schema (one
 * behind would be dropped by the upgrade anyway, so it is left for the orphan
 * cleanup), and not itself hold an interrupted copy — a source still carrying
 * the adoption marker was never opened since its own adoption stopped, so its
 * rows are partial and copying them would launder that into a complete-looking
 * index. Resolves null otherwise, with nothing left behind.
 */
async function openAdoptableDatabase(name: string): Promise<IDBDatabase | null> {
	const db = await openExistingDatabase(name);
	if (!db) return null;
	if (db.version !== DB_VERSION || ADOPTED_STORES.some((store) => !db.objectStoreNames.contains(store))) {
		Logger.warn(`${LOG_PREFIX} Not adopting "${name}": schema v${db.version} ≠ v${DB_VERSION}.`);
		db.close();
		return null;
	}
	const tx = db.transaction(METADATA_STORE, "readonly");
	const marked = await awaitRequest(
		tx,
		tx.objectStore(METADATA_STORE).get(ADOPTION_MARKER_KEY),
		(marker: StoredAdoptionMarker | undefined) => marker !== undefined,
	);
	if (marked) {
		Logger.warn(`${LOG_PREFIX} Not adopting "${name}": it holds an interrupted copy itself.`);
		db.close();
		return null;
	}
	return db;
}

/**
 * Open a database only if it already exists. `indexedDB.open` without a version
 * creates a missing database as an empty v1 shell, which is detectable through
 * `upgradeneeded`; the shell is deleted again and `null` returned.
 */
function openExistingDatabase(name: string): Promise<IDBDatabase | null> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name);
		let created = false;
		request.onupgradeneeded = () => {
			created = true;
		};
		request.onerror = () => reject(toError(request.error, `Failed to open "${name}".`));
		request.onblocked = () => resolve(null);
		request.onsuccess = () => {
			const db = request.result;
			if (!created) {
				resolve(db);
				return;
			}
			db.close();
			void deleteDatabase(name);
			resolve(null);
		};
	});
}

/**
 * Copy every record of `name` from `source` to `target`, `batchSize` records
 * per read cursor and write transaction. Resolves with the number copied.
 */
async function copyObjectStore(
	source: IDBDatabase,
	target: IDBDatabase,
	name: string,
	batchSize: number,
): Promise<number> {
	let lastKey: IDBValidKey | null = null;
	let copied = 0;
	for (;;) {
		const readTx = source.transaction(name, "readonly");
		const range = lastKey === null ? null : IDBKeyRange.lowerBound(lastKey, true);
		const request = readTx.objectStore(name).openCursor(range);
		const batch: unknown[] = [];
		await awaitCursor<void>(readTx, request, (cursor) => {
			if (!cursor || batch.length >= batchSize) return { done: true, value: undefined };
			batch.push((cursor as IDBCursorWithValue).value);
			lastKey = cursor.key;
			cursor.continue();
			return undefined;
		});
		if (batch.length === 0) return copied;

		const writeTx = target.transaction(name, "readwrite");
		await awaitTransaction(writeTx, () => {
			const store = writeTx.objectStore(name);
			for (const value of batch) store.put(value);
		});
		copied += batch.length;
		if (batch.length < batchSize) return copied;
	}
}

/** The graph nodes behind a set of ids, skipping ids the graph no longer has. */
function* idsToNodes(index: HNSW, ids: Set<number>): IterableIterator<HnswNode> {
	for (const id of ids) {
		const node = index.nodes.get(id);
		if (node) yield node;
	}
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
	private readonly vaultId: string;
	private readonly indexId: string | undefined;
	/**
	 * The metadata record as last read or written, so a note write can put the
	 * updated record (the id counter, the timestamp) inside its own transaction
	 * instead of a get-then-put in two more. Null until `setMetadata` writes one.
	 */
	private meta: StoredMetadata | null = null;

	/**
	 * Graph nodes whose topology changed since the last save, by numeric id.
	 * The library rewires only the new node, the nodes it linked to, and the
	 * nodes that lost a reciprocal link on an insert — all of which pass
	 * through its `insertNeighbor` / `removeReciprocalLinks`, wrapped in
	 * `trackGraph` — so a save puts these rows and nothing else. Rewriting the
	 * whole store on every flush made a build's write volume quadratic in the
	 * index size, and a single note edit a full rewrite.
	 */
	private dirtyNodes = new Set<number>();
	/** The persisted topology no longer matches memory as a whole; the next save rewrites it. */
	private graphNeedsFullSave = false;
	/** How many nodes were last written by `saveGraph` (tests read it to prove the dirty set is used). */
	private lastGraphSaveNodeCount = 0;

	/**
	 * Graph nodes with no id mapping — chunks removed or replaced this session.
	 * The library cannot delete a node, so they stay in the graph until the next
	 * open prunes them (`loadGraph` keeps only nodes whose row exists). Search
	 * skips them, which used to shrink the effective k after a session of
	 * edits: it asks for `k + deadNodes` instead, and past `COMPACT_DEAD_MIN`
	 * dead nodes that also outnumber the live ones the graph is rebuilt in
	 * place from the live vectors (`compactGraphIfNeeded`).
	 */
	private deadNodes = 0;
	private static readonly COMPACT_DEAD_MIN = 1000;

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
		this.vaultId = vaultId;
		this.indexId = indexId;
		this.dbName = getDbName(DB_NAME_PREFIX, vaultId, indexId);
	}

	/** Rows copied per transaction by `adoptDatabase`, bounding what is resident at once. */
	private static readonly ADOPT_BATCH_SIZE = 250;

	/**
	 * See `VectorStore.adoptDatabase`. The old database is opened at whatever
	 * version it has: one behind the current schema would be dropped by the
	 * upgrade anyway, so it is left for the orphan cleanup instead of copied.
	 * The copy itself (`copyFrom`) runs under an adoption marker, so a target
	 * left partial by an interruption is retried here rather than refused, and
	 * completed or emptied by the next `open()` (`settleInterruptedAdoption`).
	 */
	async adoptDatabase(fromIndexId: string): Promise<boolean> {
		if (this.db) throw new Error("adoptDatabase must run before open()");
		const fromName = getDbName(DB_NAME_PREFIX, this.vaultId, fromIndexId);
		if (fromName === this.dbName) return false;

		const source = await openAdoptableDatabase(fromName);
		if (!source) return false;

		await this.openIndexedDB();
		try {
			const marker = await this.getAdoptionMarker();
			const existing = await this.count();
			if (existing > 0 && !marker) {
				Logger.warn(
					`${LOG_PREFIX} Not adopting "${fromName}": "${this.dbName}" already holds ${existing} rows.`,
				);
				return false;
			}
			await this.copyFrom(source, fromName);
		} finally {
			source.close();
			this.requireDb().close();
			this.db = null;
		}
		await this.deleteAdopted(fromName);
		return true;
	}

	/**
	 * Copy every record of `source` into this (open) database under the
	 * adoption marker: the marker is put first, the four stores are emptied
	 * (a retry may find a partial copy) and streamed in — each object store in
	 * batches, since a cursor cannot outlive an `await`, one write transaction
	 * per batch — the metadata record is restamped with this index's provider
	 * and model (the service clears an index whose record names another), and
	 * the marker goes last. Only then is it safe to delete the source.
	 */
	private async copyFrom(source: IDBDatabase, fromName: string): Promise<void> {
		const target = this.requireDb();
		await this.putInStore(METADATA_STORE, {
			key: ADOPTION_MARKER_KEY,
			from: fromName,
		} satisfies StoredAdoptionMarker);
		await this.clearAllStores({ keepAdoptionMarker: true });
		let copied = 0;
		for (const name of ADOPTED_STORES) {
			copied += await copyObjectStore(source, target, name, HNSWVectorStore.ADOPT_BATCH_SIZE);
		}
		const meta = await this.getMetadataInternal();
		if (meta && this.indexId) {
			const [provider = "", ...modelParts] = this.indexId.split(":");
			meta.providerId = provider;
			meta.modelId = modelParts.join(":");
			await this.putInStore(METADATA_STORE, meta);
		}
		await this.deleteFromStore(METADATA_STORE, ADOPTION_MARKER_KEY);
		Logger.log(`${LOG_PREFIX} Adopted "${fromName}" as "${this.dbName}" (${copied} records).`);
	}

	private async deleteAdopted(fromName: string): Promise<void> {
		const deleted = await deleteDatabase(fromName);
		if (deleted.status === "error") {
			Logger.error(`${LOG_PREFIX} Adopted "${fromName}" but could not delete it:`, deleted.error);
		} else if (deleted.status === "blocked") {
			Logger.warn(`${LOG_PREFIX} Adopted "${fromName}"; it is held open elsewhere and goes once that closes.`);
		}
	}

	/**
	 * A store still carrying the adoption marker on open holds a partial copy.
	 * The source is deleted only after the marker, so it is normally still
	 * there and the copy is finished now; if it is gone, the partial rows are
	 * unusable (mappings or graph may be missing) and the store is emptied so
	 * the index rebuilds from the vault.
	 */
	private async settleInterruptedAdoption(): Promise<void> {
		const marker = await this.getAdoptionMarker();
		if (!marker) return;
		Logger.warn(`${LOG_PREFIX} "${this.dbName}" holds an interrupted copy of "${marker.from}"; finishing it.`);
		const source = await openAdoptableDatabase(marker.from);
		if (source) {
			try {
				await this.copyFrom(source, marker.from);
			} finally {
				source.close();
			}
			await this.deleteAdopted(marker.from);
			return;
		}
		Logger.warn(`${LOG_PREFIX} Source "${marker.from}" is gone; emptying "${this.dbName}" so the index rebuilds.`);
		await this.clearAllStores({ keepAdoptionMarker: false });
	}

	private async getAdoptionMarker(): Promise<StoredAdoptionMarker | null> {
		const db = this.requireDb();
		const tx = db.transaction(METADATA_STORE, "readonly");
		const request = tx.objectStore(METADATA_STORE).get(ADOPTION_MARKER_KEY);
		return awaitRequest(tx, request, (marker: StoredAdoptionMarker | undefined) => marker ?? null);
	}

	/** Empty all four stores in one transaction, optionally leaving the adoption marker in place. */
	private async clearAllStores(options: { keepAdoptionMarker: boolean }): Promise<void> {
		const db = this.requireDb();
		const tx = db.transaction(ADOPTED_STORES, "readwrite");
		await awaitTransaction(tx, () => {
			for (const name of ADOPTED_STORES) {
				if (name === METADATA_STORE && options.keepAdoptionMarker) {
					const store = tx.objectStore(name);
					const request = store.openKeyCursor();
					request.onsuccess = () => {
						const cursor = request.result;
						if (!cursor) return;
						if (cursor.primaryKey !== ADOPTION_MARKER_KEY) store.delete(cursor.primaryKey);
						cursor.continue();
					};
					continue;
				}
				tx.objectStore(name).clear();
			}
		});
	}

	private async deleteFromStore(storeName: string, key: IDBValidKey): Promise<void> {
		const db = this.requireDb();
		const tx = db.transaction(storeName, "readwrite");
		await awaitTransaction(tx, () => {
			tx.objectStore(storeName).delete(key);
		});
	}

	/**
	 * Open the database connection and initialize HNSW index.
	 */
	async open(): Promise<void> {
		const upgradedFrom = await this.openIndexedDB();
		if (upgradedFrom !== null) await this.discardLegacySidecar(upgradedFrom);
		await this.settleInterruptedAdoption();

		// Load ID mappings
		await this.loadIdMappings();

		// Load metadata to get dimensions
		const meta = await this.getMetadataInternal();
		this.meta = meta;
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

	private createEmptyGraph(): HNSW {
		const index = new HNSW(this.M, this.efConstruction, null, "cosine", this.efSearch);
		this.trackGraph(index);
		return index;
	}

	/**
	 * Wrap the two library methods through which every neighbour-list change
	 * passes, so `saveGraph` knows which nodes to write. `insertNeighbor` is
	 * called for the inserted node and for each neighbour it links to;
	 * `removeReciprocalLinks` names the nodes that lost a back-link. Instance
	 * properties shadow the prototype, so the library's own call sites pick
	 * the wrappers up; the methods are `private` in its typings, hence the cast.
	 */
	private trackGraph(index: HNSW): void {
		const tracked = index as unknown as {
			insertNeighbor(node: HnswNode, neighborId: number, level: number): number[];
			removeReciprocalLinks(node: HnswNode, removedIds: number[], level: number): void;
		};
		const insertNeighbor = tracked.insertNeighbor;
		const removeReciprocalLinks = tracked.removeReciprocalLinks;
		tracked.insertNeighbor = (node, neighborId, level) => {
			const removed = insertNeighbor.call(index, node, neighborId, level);
			this.dirtyNodes.add(node.id);
			return removed;
		};
		tracked.removeReciprocalLinks = (node, removedIds, level) => {
			removeReciprocalLinks.call(index, node, removedIds, level);
			for (const id of removedIds) this.dirtyNodes.add(id);
		};
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

		const persistedNodeCount = topology.size;
		const nodes = new Map<number, HnswNode>();
		/** Rows the persisted graph does not know about — see the doc comment. */
		const unlinked: Array<{ id: number; vector: Float32Array }> = [];
		let dim: number | null = null;
		let dead = 0;
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
					// A row whose mapping is gone is mid-removal: its node is kept
					// (its links are still in place) but it is unreachable by search.
					if (!this.numericToId.has(stored.hnswId)) dead++;
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
		this.deadNodes = dead;
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
			Logger.log(
				`${LOG_PREFIX} Re-linked ${unlinked.length} vectors that were written after the last graph save (interrupted build).`,
			);
		}

		// Memory now differs from disk when nodes were dropped (their rows are
		// gone), neighbour lists were pruned, or rows were re-linked. A partial
		// save cannot express a dropped node, so the next save rewrites the store
		// in full; schedule it so the next open does not have to redo this.
		if (nodes.size !== persistedNodeCount || pruned > 0 || unlinked.length > 0) {
			this.graphNeedsFullSave = true;
			this.dirtyNodes.clear();
			this.hasPendingIndexSave = true;
			this.scheduleIndexSave();
		}
	}

	/**
	 * Persist the in-memory graph's topology (levels, neighbour lists, entry point).
	 * Vectors are deliberately not written here — the document rows already hold
	 * them. Normally one transaction puts only the nodes in `dirtyNodes`; after a
	 * full rebuild, or a load that diverged from disk, it replaces the whole store.
	 * The header (entry point, top level) is small and always rewritten.
	 */
	private async saveGraph(): Promise<void> {
		const db = this.requireDb();
		const index = this.hnswIndex;
		if (!index) return;

		// Snapshot the dirty set: a note written while this transaction runs
		// dirties nodes the transaction cannot see, and they must survive it.
		const full = this.graphNeedsFullSave;
		const dirty = this.dirtyNodes;
		this.dirtyNodes = new Set();
		this.graphNeedsFullSave = false;

		const tx = db.transaction([GRAPH_STORE, METADATA_STORE], "readwrite");
		try {
			await awaitTransaction(tx, () => {
				const graphStore = tx.objectStore(GRAPH_STORE);
				const nodes = full ? index.nodes.values() : idsToNodes(index, dirty);
				let written = 0;
				if (full) graphStore.clear();
				for (const node of nodes) {
					const stored: StoredGraphNode = { id: node.id, level: node.level, neighbors: node.neighbors };
					graphStore.put(stored);
					written++;
				}
				this.lastGraphSaveNodeCount = written;
				const header: StoredGraphHeader = {
					key: "hnsw-graph",
					levelMax: index.levelMax,
					entryPointId: index.entryPointId,
				};
				tx.objectStore(METADATA_STORE).put(header);
			});
		} catch (error) {
			// Nothing landed; the next save must cover the same nodes again.
			for (const id of dirty) this.dirtyNodes.add(id);
			this.graphNeedsFullSave ||= full;
			throw error;
		}
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
		this.meta = meta;
	}

	/**
	 * Get the current index metadata.
	 */
	async getMetadata(): Promise<IndexMetadata | null> {
		const meta = this.meta;
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
	 * Write a note: all of its chunks, replacing whatever the path held, in one
	 * transaction over the rows, the id mappings and the metadata record. The
	 * old rows are deleted and the new ones put inside that transaction, so the
	 * store never holds a note in part. (Chunk by chunk, each in three to four
	 * transactions, is what this replaces — and with it the "chunk 0 written
	 * last" convention that stood in for atomicity.)
	 *
	 * The graph is updated in memory afterwards: the new chunks are inserted and
	 * the replaced chunks' nodes become dead (the library cannot delete). The
	 * topology save is debounced; a clean `close()` flushes anything pending.
	 */
	async putNote(chunks: DocumentVector[]): Promise<void> {
		if (chunks.length === 0) throw new Error("putNote: a note has at least one chunk");
		const path = chunks[0].path;
		for (const chunk of chunks) {
			if (chunk.path !== path) throw new Error(`putNote: chunk ${chunk.id} does not belong to ${path}`);
		}
		const db = this.requireDb();

		if (!this.dimensions) this.dimensions = chunks[0].vector.length;
		await this.ensureHNSWIndex();

		// Numeric ids are assigned up front so the metadata record put in the
		// same transaction carries the counter past them.
		const rows: StoredDocument[] = chunks.map((chunk) => ({
			id: chunk.id,
			path: chunk.path,
			mtime: chunk.mtime,
			vector: chunk.vector,
			chunkIndex: chunk.chunkIndex,
			hnswId: this.nextHnswId++,
		}));

		const replaced = await this.writeNote(db, path, rows);
		this.retireIds(replaced);
		for (const row of rows) {
			this.idToNumeric.set(row.id, row.hnswId);
			this.numericToId.set(row.hnswId, row.id);
		}

		// The library keeps a reference to the array it is given, so each
		// Float32Array becomes the resident copy.
		if (this.hnswIndex) {
			for (const row of rows) {
				await this.hnswIndex.addPoint(row.hnswId, row.vector);
				// The first node of a graph gets no neighbour insertions; mark it by hand.
				this.dirtyNodes.add(row.hnswId);
			}
		}

		this.hasPendingIndexSave = true;
		this.scheduleIndexSave();
		await this.compactGraphIfNeeded();
	}

	/**
	 * One readwrite transaction: delete every row and mapping stored under
	 * `path`, put `rows` and their mappings, and refresh the metadata record.
	 * Resolves with the numeric ids the deleted rows held.
	 */
	private writeNote(db: IDBDatabase, path: string, rows: StoredDocument[]): Promise<number[]> {
		const replaced: number[] = [];
		const tx = db.transaction([DOCUMENTS_STORE, ID_MAPPING_STORE, METADATA_STORE], "readwrite");
		return awaitTransaction(tx, () => {
			const docStore = tx.objectStore(DOCUMENTS_STORE);
			const mappingStore = tx.objectStore(ID_MAPPING_STORE);
			const request = docStore.index("path").openCursor(IDBKeyRange.only(path));
			request.onsuccess = () => {
				const cursor = request.result;
				if (cursor) {
					const stored = cursor.value as StoredDocument;
					replaced.push(stored.hnswId);
					mappingStore.delete(stored.hnswId);
					cursor.delete();
					cursor.continue();
					return;
				}
				for (const row of rows) {
					mappingStore.put({ numericId: row.hnswId, stringId: row.id } satisfies IdMapping);
					docStore.put(row);
				}
				const meta = this.touchedMetadata();
				if (meta) tx.objectStore(METADATA_STORE).put(meta);
			};
		}).then(() => replaced);
	}

	/**
	 * The metadata record with the id counter, dimensions and timestamp brought
	 * up to date, for a write transaction to put; null when no record exists yet
	 * (a store written before its `setMetadata`, which validation repairs).
	 * Persisting the counter on every write is what keeps a reload from reusing
	 * a live id ("Node with id N already exists").
	 */
	private touchedMetadata(): StoredMetadata | null {
		if (!this.meta) return null;
		this.meta.lastUpdated = Date.now();
		this.meta.nextHnswId = this.nextHnswId;
		if (this.dimensions) this.meta.dimensions = this.dimensions;
		return this.meta;
	}

	/** Forget the mappings of removed chunks; their graph nodes, if any, are now dead. */
	private retireIds(numericIds: number[]): void {
		for (const numericId of numericIds) {
			const stringId = this.numericToId.get(numericId);
			if (stringId !== undefined) this.idToNumeric.delete(stringId);
			this.numericToId.delete(numericId);
			if (this.hnswIndex?.nodes.has(numericId)) this.deadNodes++;
		}
	}

	/**
	 * Rebuild the graph from its live vectors once the dead nodes both exceed
	 * {@link COMPACT_DEAD_MIN} and outnumber the live ones. Dead nodes cost
	 * every search `k + dead` candidates; a session of heavy editing on a
	 * long-lived window is the only way to reach this, and the next open would
	 * prune them anyway. The vectors are already resident in the nodes, so no
	 * row is read; the rebuilt topology is saved in full.
	 */
	private async compactGraphIfNeeded(): Promise<void> {
		const index = this.hnswIndex;
		if (!index || this.deadNodes < HNSWVectorStore.COMPACT_DEAD_MIN) return;
		const live = index.nodes.size - this.deadNodes;
		if (this.deadNodes < live) return;

		const points: Array<{ id: number; vector: Float32Array }> = [];
		for (const node of index.nodes.values()) {
			if (this.numericToId.has(node.id)) points.push({ id: node.id, vector: node.vector as Float32Array });
		}
		Logger.log(`${LOG_PREFIX} Compacting graph: ${this.deadNodes} dead nodes, ${points.length} live.`);
		await index.buildIndex(points);
		this.deadNodes = 0;
		this.dirtyNodes.clear();
		this.graphNeedsFullSave = true;
		this.hasPendingIndexSave = true;
		this.scheduleIndexSave();
	}

	/**
	 * Re-key a note's rows and mappings from `oldPath` to `newPath` in one
	 * transaction. The numeric ids — and with them the graph — are untouched:
	 * a rename moves nothing but the string ids, so no provider call and no
	 * graph save is needed. Rows already under `newPath` are replaced — but
	 * only when there is something to move: a rename whose source is gone (a
	 * stale event, a race with a removal) leaves the destination alone.
	 */
	async renameNote(oldPath: string, newPath: string): Promise<void> {
		if (oldPath === newPath) return;
		const db = this.requireDb();

		const moved: Array<{ from: string; to: string; hnswId: number }> = [];
		const replaced: number[] = [];
		const tx = db.transaction([DOCUMENTS_STORE, ID_MAPPING_STORE, METADATA_STORE], "readwrite");
		await awaitTransaction(tx, () => {
			const docStore = tx.objectStore(DOCUMENTS_STORE);
			const mappingStore = tx.objectStore(ID_MAPPING_STORE);
			const pathIndex = docStore.index("path");

			// The source rows come out first (a note's worth, held in memory);
			// nothing else happens when there are none. Then the destination is
			// cleared, and finally the rows go back in under the new key.
			const rows: StoredDocument[] = [];
			const taking = pathIndex.openCursor(IDBKeyRange.only(oldPath));
			taking.onsuccess = () => {
				const cursor = taking.result;
				if (cursor) {
					rows.push(cursor.value as StoredDocument);
					cursor.delete();
					cursor.continue();
					return;
				}
				if (rows.length === 0) return;

				const clearing = pathIndex.openCursor(IDBKeyRange.only(newPath));
				clearing.onsuccess = () => {
					const cursor = clearing.result;
					if (cursor) {
						const stored = cursor.value as StoredDocument;
						replaced.push(stored.hnswId);
						mappingStore.delete(stored.hnswId);
						cursor.delete();
						cursor.continue();
						return;
					}
					for (const stored of rows) {
						const id = makeChunkId(newPath, stored.chunkIndex ?? 0);
						moved.push({ from: stored.id, to: id, hnswId: stored.hnswId });
						docStore.put({ ...stored, id, path: newPath } satisfies StoredDocument);
						mappingStore.put({ numericId: stored.hnswId, stringId: id } satisfies IdMapping);
					}
					const meta = this.touchedMetadata();
					if (meta) tx.objectStore(METADATA_STORE).put(meta);
				};
			};
		});

		this.retireIds(replaced);
		for (const { from, to, hnswId } of moved) {
			this.idToNumeric.delete(from);
			this.idToNumeric.set(to, hnswId);
			this.numericToId.set(hnswId, to);
		}
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
	 * Remove a note: every chunk row under `path` and each chunk's id mapping,
	 * in one transaction (`writeNote` with nothing to put).
	 *
	 * The hnsw package doesn't support deletion, so the graph nodes stay until
	 * the next full rebuild or reload (`loadGraph` drops nodes whose row is
	 * gone); they count as dead meanwhile — see `deadNodes`.
	 */
	async remove(path: string): Promise<void> {
		const db = this.requireDb();
		const replaced = await this.writeNote(db, path, []);
		this.retireIds(replaced);
		await this.compactGraphIfNeeded();
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

		// A note is listed only through its chunk-0 row. `putNote` stores a note
		// whole, so every note it wrote has one; the test remains for rows
		// written chunk by chunk by older versions, where a process killed
		// between the chunks left rows that carry the note's current mtime but
		// no `#0` — and this read then reports the note as absent, which makes
		// the next validation re-index (and so replace) it. Key cursor only:
		// `primaryKey` is the chunk id, so no row value (no vector) is ever
		// deserialised.
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
			this.deadNodes = 0;
			this.dirtyNodes.clear();
			this.graphNeedsFullSave = true;
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
		this.dirtyNodes.clear();
		this.graphNeedsFullSave = false;
		this.deadNodes = 0;
		this.meta = null;

		// A fresh graph; `putNote`/`bulkPut` re-derive the dimensions from the
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
	 * `putNote` writes row and mapping in one transaction, before the graph node.
	 *
	 * Dead nodes (removed or replaced this session) are still in the graph and
	 * are skipped below; asking for `topK + deadNodes` keeps the number of live
	 * hits from shrinking with every edit.
	 */
	async search(queryVector: Float32Array, topK: number, threshold?: number): Promise<SearchHit[]> {
		await this.ensureHNSWIndex();
		if (!this.hnswIndex) {
			// Fall back to brute-force if HNSW not initialized
			return this.bruteForceSearch(queryVector, topK, threshold);
		}

		try {
			// Use HNSW to get nearest neighbors (returns numeric IDs)
			const hnswResults = this.hnswIndex.searchKNN(queryVector, topK + this.deadNodes);
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
				if (results.length >= topK) break;
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

	private async clearStore(storeName: string): Promise<void> {
		const db = this.requireDb();
		const tx = db.transaction(storeName, "readwrite");
		await awaitTransaction(tx, () => {
			tx.objectStore(storeName).clear();
		});
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
