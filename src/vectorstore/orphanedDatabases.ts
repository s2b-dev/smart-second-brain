/**
 * Orphaned vector databases (#432, step 5).
 *
 * Vector databases are keyed by `provider:model` (`getDbName`) and deliberately
 * survive provider/config deletion — only an explicit "delete index" destroys
 * them. Every abandoned model therefore leaves its whole vector set behind; the
 * reference device carried ~3 GB of IndexedDB, largely such leftovers. This
 * module enumerates this vault's vector databases, diffs them against the
 * configured indexes, and deletes the orphans on request.
 *
 * Ownership is not decided by name prefix alone. Database names are
 * `s2b-hnsw-<vaultSlug>-<provider_model>` and a slug may be a prefix of another
 * vault's slug on the same origin ("notes" / "notes-archive"), so a candidate is
 * only attributed to this vault when the provider/model recorded *inside* it
 * reproduces the candidate's exact name. A database that cannot be attributed is
 * left alone: deleting a neighbouring vault's live index would be far worse
 * than leaving a stray shell behind.
 */

import { Logger } from "../utils/logging";
import { toError } from "../utils/toError";
import { type DeleteDatabaseResult, deleteDatabase, getDbName } from "./types";

/** Prefix shared by every HNSW vector database (`HNSWVectorStore`'s `DB_NAME_PREFIX`). */
const HNSW_DB_PREFIX = "s2b-hnsw";

/**
 * Suffix of the pre-schema-v3 sidecar database the `hnsw` library owned. Since
 * v3 the graph lives in the main database and the sidecar is deleted on
 * upgrade, but an index that was never reopened since still carries one — and
 * it is the largest single object on disk (every vector, as doubles).
 */
const LEGACY_SIDECAR_SUFFIX = "-hnsw-index";

export interface OrphanedDatabase {
	name: string;
	/** `name` without the vault prefix and sidecar suffix — the `provider_model` part, for display. */
	label: string;
	/** A whole index for a model no longer configured, or a legacy graph sidecar. */
	kind: "index" | "legacy-sidecar";
	/** `provider:model` recorded inside the database (indexes only). */
	indexId?: string;
	/** Stored chunk rows (indexes only). */
	chunkCount?: number;
	/** Vector width (indexes only; 0 when the index was never written to). */
	dimensions?: number;
	/**
	 * Raw vector payload, `chunkCount × dimensions × 4` bytes. A lower bound:
	 * row keys, indexes and IndexedDB's own overhead come on top, and per-database
	 * sizes are not exposed by any browser API.
	 */
	estimatedBytes?: number;
}

/** The names `deleteIndex` would remove for a configured index: the database and its legacy sidecar. */
export function databaseNamesForIndex(vaultId: string, indexId: string): [main: string, sidecar: string] {
	const main = getDbName(HNSW_DB_PREFIX, vaultId, indexId);
	return [main, `${main}${LEGACY_SIDECAR_SUFFIX}`];
}

/** Whether this runtime can enumerate databases at all (`indexedDB.databases()` is optional). */
function canEnumerateDatabases(): boolean {
	return typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function";
}

/** Metadata record as both the v2 and v3 stores wrote it; only these keys are read. */
interface ProbedMetadata {
	providerId?: unknown;
	modelId?: unknown;
	dimensions?: unknown;
}

interface ProbeResult {
	indexId: string | null;
	chunkCount: number;
	dimensions: number;
}

/**
 * Open an existing database read-only and read what identifies it: the
 * metadata record and the document count. Resolves `null` when the database
 * has no readable metadata (a shell that was created but never written, or a
 * layout this code does not know).
 *
 * Opening without a version never triggers an upgrade on an existing database.
 * The name comes from `databases()`, so it exists — but if it were deleted in
 * the meantime the open would *create* it; the `upgradeneeded` handler aborts
 * that so nothing new is ever written here.
 */
async function probeDatabase(name: string): Promise<ProbeResult | null> {
	const db = await new Promise<IDBDatabase | null>((resolve) => {
		let request: IDBOpenDBRequest;
		try {
			request = indexedDB.open(name);
		} catch {
			resolve(null);
			return;
		}
		request.onupgradeneeded = (event) => {
			(event.target as IDBOpenDBRequest).transaction?.abort();
		};
		request.onerror = () => resolve(null);
		request.onblocked = () => resolve(null);
		request.onsuccess = () => {
			const opened = request.result;
			// Never be the connection that blocks another window's upgrade.
			opened.onversionchange = () => opened.close();
			resolve(opened);
		};
	});
	if (!db) return null;

	try {
		if (!db.objectStoreNames.contains("metadata") || !db.objectStoreNames.contains("documents")) return null;
		return await new Promise<ProbeResult | null>((resolve, reject) => {
			const tx = db.transaction(["metadata", "documents"], "readonly");
			let meta: ProbedMetadata | undefined;
			let chunkCount = 0;
			tx.onerror = () => reject(toError(tx.error, "IndexedDB transaction failed."));
			tx.onabort = () => reject(toError(tx.error, "IndexedDB transaction aborted."));
			tx.oncomplete = () => {
				if (!meta) {
					resolve(null);
					return;
				}
				const providerId = typeof meta.providerId === "string" ? meta.providerId : null;
				const modelId = typeof meta.modelId === "string" ? meta.modelId : null;
				resolve({
					indexId: providerId && modelId ? `${providerId}:${modelId}` : null,
					chunkCount,
					dimensions: typeof meta.dimensions === "number" && meta.dimensions > 0 ? meta.dimensions : 0,
				});
			};
			const metaRequest = tx.objectStore("metadata").get("metadata");
			metaRequest.onsuccess = () => {
				meta = (metaRequest.result as ProbedMetadata | undefined) ?? undefined;
			};
			const countRequest = tx.objectStore("documents").count();
			countRequest.onsuccess = () => {
				chunkCount = countRequest.result;
			};
		});
	} catch (error) {
		Logger.warn(`[VectorStore] Could not read vector database "${name}":`, error);
		return null;
	} finally {
		db.close();
	}
}

/**
 * This vault's vector databases that no configured index accounts for.
 *
 * Resolves `null` when the runtime cannot enumerate databases. Candidates are
 * every database under this vault's name prefix; each is attributed to this
 * vault by the provider/model stored inside it (see the module comment), and
 * legacy sidecars are attributed through their main database (a sidecar with no
 * main database cannot be attributed and stays). Configured indexes and
 * unattributable databases are excluded.
 */
export async function listOrphanedVectorDatabases(
	vaultId: string,
	configuredIndexIds: Iterable<string>,
): Promise<OrphanedDatabase[] | null> {
	if (!canEnumerateDatabases()) return null;

	let infos: IDBDatabaseInfo[];
	try {
		infos = (await indexedDB.databases()) ?? [];
	} catch (error) {
		Logger.warn("[VectorStore] indexedDB.databases() failed:", error);
		return null;
	}

	const configured = new Set<string>();
	for (const indexId of configuredIndexIds) configured.add(getDbName(HNSW_DB_PREFIX, vaultId, indexId));

	const prefix = `${getDbName(HNSW_DB_PREFIX, vaultId)}-`;
	const candidates = new Set<string>();
	for (const info of infos) {
		if (info.name?.startsWith(prefix)) candidates.add(info.name);
	}

	/** name → belongs to this vault (attributed), for main databases. */
	const ownership = new Map<string, { owned: boolean; probe: ProbeResult | null }>();
	const mains = [...candidates].filter((name) => !name.endsWith(LEGACY_SIDECAR_SUFFIX));
	for (const name of mains) {
		const probe = await probeDatabase(name);
		const owned =
			probe?.indexId !== null && probe !== null && getDbName(HNSW_DB_PREFIX, vaultId, probe.indexId) === name;
		ownership.set(name, { owned, probe });
	}

	const orphans: OrphanedDatabase[] = [];
	for (const name of [...candidates].sort()) {
		if (name.endsWith(LEGACY_SIDECAR_SUFFIX)) {
			// Attributed through the main database. A sidecar holds only the graph
			// blob — nothing inside it says which vault it belongs to — so one whose
			// main database is gone (a deletion that was blocked half-way) cannot
			// be told apart from a neighbouring vault's and is left alone, like any
			// other unattributable database.
			const main = name.slice(0, -LEGACY_SIDECAR_SUFFIX.length);
			if (!ownership.get(main)?.owned) continue;
			orphans.push({ name, label: main.slice(prefix.length), kind: "legacy-sidecar" });
			continue;
		}
		if (configured.has(name)) continue;
		const entry = ownership.get(name);
		if (!entry?.owned || !entry.probe?.indexId) continue;
		const { indexId, chunkCount, dimensions } = entry.probe;
		orphans.push({
			name,
			label: name.slice(prefix.length),
			kind: "index",
			indexId,
			chunkCount,
			dimensions,
			estimatedBytes: chunkCount * dimensions * 4,
		});
	}
	return orphans;
}

export interface DeleteOrphansOutcome {
	deleted: string[];
	/** Name → why it is still there. */
	failed: Array<{ name: string; reason: string }>;
}

/** Delete the given databases, reporting per-database outcomes; never throws. */
export async function deleteOrphanedDatabases(names: string[]): Promise<DeleteOrphansOutcome> {
	const outcome: DeleteOrphansOutcome = { deleted: [], failed: [] };
	for (const name of names) {
		const result: DeleteDatabaseResult = await deleteDatabase(name);
		if (result.status === "deleted") {
			outcome.deleted.push(name);
		} else if (result.status === "blocked") {
			outcome.failed.push({
				name,
				reason: "blocked by another open connection (close other Obsidian windows for this vault and try again)",
			});
		} else {
			outcome.failed.push({ name, reason: result.error.message });
		}
	}
	return outcome;
}

/**
 * Storage used by this origin (all of Obsidian's IndexedDB for every vault on
 * this device, not just ours), when the runtime reports it. Per-database
 * figures are not available anywhere.
 */
export async function estimateOriginStorage(): Promise<{ usage: number; quota: number } | null> {
	const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
	if (!storage || typeof storage.estimate !== "function") return null;
	try {
		const { usage, quota } = await storage.estimate();
		if (typeof usage !== "number") return null;
		return { usage, quota: typeof quota === "number" ? quota : 0 };
	} catch {
		return null;
	}
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
