/**
 * Vector Store Module
 *
 * Provides embedding-based semantic search over vault notes.
 * Uses IndexedDB for fast runtime access and MessagePack for file sync.
 * Uses HNSW (Hierarchical Navigable Small World) for O(log n) approximate nearest neighbor search.
 */

export {
	VectorStoreService,
	getVectorStoreService,
	isVectorStoreInitialized,
	waitForVectorStore,
	waitForVectorStoreIndex,
	formatEta,
	formatIndexBuildStatus,
} from "./VectorStoreService";

export type { IndexingProgress, NoteNeighbor, SearchFilter, SearchResult, VectorStore } from "./types";
