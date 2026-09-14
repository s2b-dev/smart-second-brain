/**
 * Vector Store Types
 *
 * Types for the local embedding-based vector store.
 * Supports both runtime (Dexie/IndexedDB) and serialized (MessagePack file) storage.
 */

// Re-export DefaultEmbedModel and EmbeddingIndexConfig from canonical location
export type { DefaultEmbedModel, EmbeddingIndexConfig } from "../types/plugin";
import type { LexicalRankingFeatures } from "../search/lexicalScoring";
import type { SemanticPair } from "../utils/semanticEdges";

/**
 * A document with its embedding vector stored in IndexedDB.
 * The vector is a `Float32Array` everywhere — in memory, across the worker
 * boundary, and in the IndexedDB row (structured clone keeps typed arrays).
 */
export interface DocumentVector {
	/** Unique identifier - uses file path as ID */
	id: string;
	/** Path to the markdown file in the vault */
	path: string;
	/** File modification time (Unix timestamp ms) for change detection */
	mtime: number;
	/** MD5 hash of content for change detection */
	checksum: string;
	/** Embedding vector as Float32Array for efficient computation */
	vector: Float32Array;
	/**
	 * Chunk index within the document (0-based).
	 * Large notes are split into multiple chunks, each embedded as its own
	 * vector; a note that fits in one embedding has a single chunk at index 0.
	 * The record `id` is `${path}#${chunkIndex}` (see `makeChunkId`).
	 */
	chunkIndex?: number;
}

/**
 * Serialized version of DocumentVector for MessagePack storage.
 * Uses number[] instead of Float32Array for JSON/MessagePack compatibility.
 */
export interface SerializedDocument {
	id: string;
	path: string;
	mtime: number;
	checksum: string;
	/** Vector as number array for serialization */
	vector: number[];
	chunkIndex?: number;
}

/**
 * The complete serialized vector store index.
 * Written to disk as MessagePack binary.
 */
export interface SerializedIndex {
	/** Schema version for persisted index data */
	version: number;
	/** Provider ID that generated these embeddings */
	providerId: string;
	/** Model ID that generated these embeddings */
	modelId: string;
	/** All indexed documents with their vectors */
	documents: SerializedDocument[];
	/** Last time the index was updated (Unix timestamp ms) */
	lastUpdated: number;
}

/**
 * Metadata about the current index state (without the full document list).
 * Used for quick checks without loading all vectors.
 */
export interface IndexMetadata {
	version: number;
	providerId: string;
	modelId: string;
	documentCount: number;
	lastUpdated: number;
	/** Vector width of the stored embeddings; 0 until the first vector is written. */
	dimensions: number;
}

/**
 * Result from a vector similarity search.
 */
export interface VectorSearchResult {
	path: string;
	name: string;
	frontmatter?: Record<string, unknown>;
	/** Tags from the document (frontmatter + inline) */
	tags?: string[];
	/** Match explanation metadata for UI rendering */
	matchExplanation?: SearchMatchExplanation;
	/** Ranked match signals shown as reason badges in the UI */
	matchBadges?: SearchMatchBadge[];
	/** Cosine similarity score (0-1, higher is more similar) */
	score: number;
	rankingDebug?: SearchRankingDebug;
}

/**
 * Canonical search result consumed by the modal and agent tool layer.
 * Structurally identical to `VectorSearchResult` except `score` is optional.
 */
export interface SearchResult {
	path: string;
	name: string;
	frontmatter?: Record<string, unknown>;
	tags?: string[];
	matchExplanation?: SearchMatchExplanation;
	matchBadges?: SearchMatchBadge[];
	score?: number;
	rankingDebug?: SearchRankingDebug;
}

export interface SearchRankingDebug {
	originalRank?: number;
	finalRank?: number;
	rerankScore?: number;
	finalScore?: number;
	recentBoost?: number;
	recentRank?: number;
	baseScore?: number;
	lexicalRank?: number;
	semanticRank?: number;
	semanticScore?: number;
	lexicalRrfScore?: number;
	semanticRrfScore?: number;
	finalTitleBoost?: number;
	finalAliasBoost?: number;
	recentAliasBonus?: number;
	lexicalFeatures?: LexicalRankingFeatures;
	/** Score of the note's single best-matching chunk, before support aggregation. */
	bestChunkScore?: number;
	/** How many of the note's chunks were among the retrieved semantic hits. */
	matchingChunks?: number;
	/** Normalized (0-1) lexical score within the result set, after fusion rework. */
	normalizedLexical?: number;
	/** Normalized (0-1) semantic score within the result set, after fusion rework. */
	normalizedSemantic?: number;
	/** Relevance relative to the top result, used to gate the recency boost. */
	relativeRelevance?: number;
	/** True when recency was gated away because the note was not a strong enough match. */
	recentGated?: boolean;
	/** Adaptive recency-lift ceiling for this query, derived from result-set spread. */
	adaptiveRecentLift?: number;
}

export interface SearchMatchExplanation {
	source: "title" | "alias" | "tag" | "heading" | "content";
	text: string;
	heading?: string;
	headingLevel?: number;
}

export type SearchMatchBadge = "title" | "alias" | "tag" | "path" | "heading" | "content" | "semantic" | "recent";

/**
 * Filter options for vector search.
 * All filters are optional and combined with AND logic.
 */
export interface SearchFilter {
	/**
	 * Filter by path prefix(es).
	 * Documents must match at least one of the provided path prefixes with
	 * folder-boundary-safe matching.
	 * Example: ["folder/subfolder", "another/path"] matches docs in either location.
	 */
	pathPrefixes?: string[];

	/**
	 * Filter by tag(s).
	 * Documents must have at least one of the provided tags.
	 * Tags should include the # prefix (e.g., "#project", "#todo").
	 */
	tags?: string[];

	/**
	 * Require ALL tags instead of ANY tag.
	 * When true, documents must have all specified tags.
	 * Default: false (match any tag).
	 */
	requireAllTags?: boolean;
}

/**
 * Progress state for indexing operations.
 * Used for UI feedback.
 */
export interface IndexingProgress {
	/** Whether indexing is currently in progress */
	isIndexing: boolean;
	/** Total number of files to index */
	total: number;
	/** Number of files indexed so far */
	indexed: number;
	/** Number of files skipped (too large, errors) */
	skipped: number;
	/** Current file being indexed (for display) */
	currentFile: string | null;
	/** Progress percentage (0-100) */
	percentage: number;
	/** Estimated milliseconds remaining, or null when not yet known */
	etaMs: number | null;
}

/** Reasons a file can be skipped during indexing */
export type SkipReason = "excluded" | "privacy" | "too-large" | "not-indexed" | "read-error" | "embed-error";

/** A file that was skipped during indexing, with its reason */
export interface SkippedFile {
	path: string;
	reason: SkipReason;
}

/**
 * Report generated after an indexing run, showing what was indexed
 * and what was skipped (with reasons).
 */
export interface IndexingReport {
	/** Paths of successfully indexed files */
	indexedFiles: string[];
	/** Files that were skipped, grouped by reason */
	skippedFiles: SkippedFile[];
	/** When this report was generated */
	timestamp: number;
}

/** Current schema version for the serialized index.
 * v2: notes are split into multiple chunks (`${path}#${chunkIndex}` ids) instead
 * of one vector per note. Bumping this forces a rebuild of pre-chunking indexes. */
export const INDEX_VERSION = 2;

/**
 * Sanitize a provider:model string into a filesystem/IndexedDB-safe identifier.
 * Replaces special characters with underscores while preserving readability.
 */
export function sanitizeIndexId(provider: string, model: string): string {
	return `${provider}_${model}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Build the unique record id for a note chunk.
 * A note is identified by its `path`; each chunk within it gets a distinct id
 * so multiple chunks of one note can coexist in the path-indexed store.
 */
export function makeChunkId(path: string, chunkIndex: number): string {
	return `${path}#${chunkIndex}`;
}

/**
 * Inverse of {@link makeChunkId}. `#` is legal in a vault path, so the split
 * is on the *last* `#`: the chunk index is numeric and always comes last.
 */
export function parseChunkId(id: string): { path: string; chunkIndex: number } {
	const hash = id.lastIndexOf("#");
	if (hash === -1) return { path: id, chunkIndex: 0 };
	const chunkIndex = Number(id.slice(hash + 1));
	if (!Number.isInteger(chunkIndex) || chunkIndex < 0) return { path: id, chunkIndex: 0 };
	return { path: id.slice(0, hash), chunkIndex };
}

/**
 * Get the database name for a specific index ID and vault.
 * @param vaultId The vault identifier
 * @param indexId Optional "provider:model" composite key. If omitted, returns the base vault-scoped name.
 * @returns IndexedDB database name
 */
export function getDbName(prefix: string, vaultId: string, indexId?: string): string {
	if (!indexId) return `${prefix}-${vaultId}`;
	const colonIdx = indexId.indexOf(":");
	const provider = colonIdx >= 0 ? indexId.slice(0, colonIdx) : indexId;
	const model = colonIdx >= 0 ? indexId.slice(colonIdx + 1) : "";
	const sanitized = sanitizeIndexId(provider, model);
	return `${prefix}-${vaultId}-${sanitized}`;
}

/** Outcome of a {@link deleteDatabase} call. */
export type DeleteDatabaseResult =
	/** The database was deleted (or did not exist). */
	| { status: "deleted" }
	/**
	 * Another open connection is holding the database. The request stays queued and the
	 * browser completes it once that connection closes — this is a "not yet", not a
	 * failure, and the request cannot be cancelled.
	 */
	| { status: "blocked" }
	/** The deletion genuinely failed. */
	| { status: "error"; error: Error };

/**
 * Promisified `indexedDB.deleteDatabase`.
 *
 * The raw API returns a request and reports outcomes through events, so a bare call
 * tells the caller nothing: `onerror` and `onblocked` are invisible to a surrounding
 * try/catch (which only sees synchronous throws), and the deletion silently doesn't
 * happen while the code proceeds as though it had. Deleting a database that does not
 * exist succeeds, which is what we want for idempotent cleanup.
 *
 * Blocked deletions resolve as `"blocked"` rather than waiting on a timeout. An
 * IndexedDB delete request cannot be cancelled: it stays queued and the browser runs it
 * as soon as the blocking connection closes. Waiting on a timeout would report a failure
 * for something that usually completes moments later, and there is nothing to undo.
 *
 * `"blocked"` is deliberately distinct from `"deleted"`: the request is still pending
 * against that database name, so callers must not treat the name as free to reuse — a
 * recreated database can be destroyed by the queued request when it eventually fires.
 *
 * Never rejects; every outcome is described by the resolved value.
 */
export function deleteDatabase(name: string): Promise<DeleteDatabaseResult> {
	return new Promise<DeleteDatabaseResult>((resolve) => {
		let request: IDBOpenDBRequest;
		try {
			request = indexedDB.deleteDatabase(name);
		} catch (error) {
			resolve({ status: "error", error: error instanceof Error ? error : new Error(String(error)) });
			return;
		}

		request.onsuccess = () => resolve({ status: "deleted" });
		request.onerror = () =>
			resolve({
				status: "error",
				error: request.error ?? new Error(`Failed to delete IndexedDB database "${name}"`),
			});
		// Resolve immediately: the request stays live and will complete on its own once the
		// blocking connection closes, so there is nothing to wait for or to undo.
		request.onblocked = () => resolve({ status: "blocked" });
	});
}

/**
 * One chunk hit from a vector similarity search.
 *
 * Identity and score only, never the vector: the service aggregates hits to
 * notes by `path` and the graph's live patch reads `path` too, so returning
 * the row would deserialise and clone one vector per hit for nothing. With
 * the tool's `topK` of 100 and the chunk over-fetch that was a thousand
 * IndexedDB reads and several megabytes crossing the worker boundary per query.
 */
export interface SearchHit {
	/** Chunk row id (`makeChunkId`). */
	id: string;
	path: string;
	chunkIndex: number;
	score: number;
}

/** An indexed note's identity and change stamp — the projection reads that never load a vector return. */
export interface NoteMeta {
	path: string;
	mtime: number;
}

/** Another note scored against one note's chunks (see `VectorStore.noteNeighbors`). */
export interface NoteNeighbor {
	path: string;
	score: number;
}

/**
 * Options for `VectorStore.semanticPairs`. Mirrors `SemanticScanOptions`, with the
 * exclusion set as an array because it crosses the worker boundary.
 */
export interface SemanticPairOptions {
	neighborCount?: number;
	threshold?: number;
	/** Note-index pairs (`${min}:${max}`, indices into the `paths` argument) to skip. */
	excludePairs?: string[];
}

/**
 * Abstract interface for vector store backends.
 * HNSW implementation conforms to this interface.
 */
export interface VectorStore {
	/**
	 * Open the database connection.
	 */
	open(): Promise<void>;

	/**
	 * Close the database connection.
	 */
	close(): Promise<void>;

	/**
	 * Get the current provider ID.
	 */
	readonly providerId: string | null;

	/**
	 * Get the current model ID.
	 */
	readonly modelId: string | null;

	/**
	 * Set the metadata for this index.
	 */
	setMetadata(providerId: string, modelId: string, version: number): Promise<void>;

	/**
	 * Get the current index metadata.
	 */
	getMetadata(): Promise<IndexMetadata | null>;

	/**
	 * Add or update a document in the store.
	 *
	 * The store takes ownership of `doc.vector`: the worker-backed implementation
	 * transfers its buffer rather than copying it, so the caller's array is
	 * detached (length 0) once this resolves. Build a fresh `Float32Array` per call.
	 */
	upsert(doc: DocumentVector): Promise<void>;

	/**
	 * Remove a document by path.
	 */
	remove(path: string): Promise<void>;

	/**
	 * Get a document by path.
	 */
	getByPath(path: string): Promise<DocumentVector | undefined>;

	/**
	 * Get every chunk vector of a note (a large note is stored as several
	 * chunk rows; `getByPath` returns only one of them).
	 */
	getAllByPath(path: string): Promise<DocumentVector[]>;

	/**
	 * Check if a document exists and get its mtime.
	 */
	getDocumentMtime(path: string): Promise<number | undefined>;

	/**
	 * `{ path, mtime }` of every *completely* indexed note, one entry per note,
	 * read without deserialising a single vector. A note counts as indexed only
	 * once its chunk-0 row exists; bulk writers store that row last, so a note
	 * whose write was interrupted is reported as absent and gets re-indexed.
	 * This is the read to use for "what is indexed, and is it stale" questions —
	 * there is deliberately no whole-set `getAll()`: materialising every vector
	 * on the main thread is the memory spike #432 removes.
	 */
	listNoteMeta(): Promise<NoteMeta[]>;

	/**
	 * Semantic neighbour pairs among the given notes, computed inside the store
	 * (where the vectors already live) and returned as scored index pairs into
	 * `paths`. Notes with no indexed chunks simply contribute nothing.
	 */
	semanticPairs(paths: string[], options?: SemanticPairOptions): Promise<SemanticPair[]>;

	/**
	 * Every other note whose best chunk scores at least `threshold` against any
	 * chunk of `path`, sorted by score descending. Exhaustive, not approximate.
	 */
	noteNeighbors(path: string, threshold: number): Promise<NoteNeighbor[]>;

	/**
	 * Get all documents as serialized format (for MessagePack). Whole-set read;
	 * only the explicit export action may call it.
	 */
	getAllSerialized(): Promise<SerializedDocument[]>;

	/**
	 * Bulk insert documents (for loading from file). Takes ownership of every
	 * `doc.vector` the same way `upsert` does.
	 */
	bulkPut(docs: DocumentVector[]): Promise<void>;

	/**
	 * Persist any in-memory index state that is still pending (the HNSW graph
	 * topology, which `upsert` saves on a debounce). A bulk run calls this as
	 * its checkpoint so a process kill loses at most one interval's worth of
	 * graph links; no-op when nothing is pending.
	 */
	flush(): Promise<void>;

	/**
	 * Clear all documents from the store.
	 */
	clear(): Promise<void>;

	/**
	 * Get the number of documents (chunks) in the store.
	 */
	count(): Promise<number>;

	/**
	 * Get the number of distinct notes (unique paths) in the store. A note is
	 * split into multiple chunk documents, so this is <= count() and is the
	 * user-facing "notes indexed" figure.
	 */
	countNotes(): Promise<number>;

	/**
	 * Search for similar vectors.
	 * @param queryVector The query vector to search for
	 * @param topK Maximum number of results to return
	 * @param threshold Minimum similarity score (0-1)
	 * @returns Chunk hits (identity + score, no vectors), best first
	 */
	search(queryVector: Float32Array, topK: number, threshold?: number): Promise<SearchHit[]>;
}
