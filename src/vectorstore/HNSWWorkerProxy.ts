/**
 * HNSW Worker Proxy
 *
 * Main-thread proxy that implements the VectorStore interface by forwarding
 * all calls to an HNSWVectorStore running inside a Web Worker.
 * Every CPU-intensive operation (build, search, add) runs off the main thread.
 *
 * Writes transfer their vector buffers to the worker instead of cloning them
 * (see `putNote`/`bulkPut`), so a vector is never resident on both sides.
 */

import type {
	DocumentVector,
	IndexMetadata,
	NoteMeta,
	NoteNeighbor,
	SearchHit,
	SemanticPairOptions,
	SerializedDocument,
	VectorStore,
} from "./types";
import type { SemanticPair } from "../utils/semanticEdges";
import type { HNSWWorkerRequest, HNSWWorkerResponse } from "./hnswWorker";
import HNSWWorkerConstructor from "./hnswWorker?worker&inline";
import { Logger } from "../utils/logging";

export class HNSWWorkerProxy implements VectorStore {
	private worker: Worker;
	private nextId = 0;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	/** Set by `close()`; every call from then on rejects instead of posting into a dead worker. */
	private closed = false;

	private _providerId: string | null = null;
	private _modelId: string | null = null;

	constructor(vaultId: string, indexId?: string) {
		this.worker = new HNSWWorkerConstructor({ name: "s2b-hnsw" });
		this.worker.onmessage = (e: MessageEvent<HNSWWorkerResponse>) => {
			const { id, result, error } = e.data;
			const entry = this.pending.get(id);
			if (!entry) return;
			this.pending.delete(id);
			if (error) {
				entry.reject(new Error(error));
			} else {
				entry.resolve(result);
			}
		};
		this.worker.onerror = (e) => {
			// A script error inside the worker means no request in flight will be
			// answered; settle them instead of leaving their callers hanging.
			Logger.error("[VectorStore] [HNSW] Worker error:", e.message);
			this.rejectPending(new Error(`Vector store worker failed: ${e.message}`));
		};

		// Initialize the store inside the worker (fire-and-forget, open() will
		// await). A failure here is reported, not surfaced: `open()` is the call
		// that fails visibly when the worker never came up.
		this.call("init", [vaultId, indexId]).catch((error: unknown) => {
			Logger.error("[VectorStore] [HNSW] Worker init failed:", error);
		});
	}

	/**
	 * Post one request. `transfer` lists ArrayBuffers to hand over rather than
	 * copy; they are detached on this thread once posted.
	 */
	private call(method: string, args: unknown[], transfer: Transferable[] = []): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error(`Vector store is closed (${method})`));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			const request: HNSWWorkerRequest = { id, method, args };
			this.worker.postMessage(request, transfer);
		});
	}

	async open(): Promise<void> {
		await this.call("open", []);
		// Sync cached getters
		this._providerId = (await this.call("getProviderId", [])) as string | null;
		this._modelId = (await this.call("getModelId", [])) as string | null;
	}

	/**
	 * How long `close()` waits for the worker to acknowledge the close request
	 * (which flushes the pending graph save) before terminating it regardless.
	 * A worker that has died or is wedged never answers; without a bound the
	 * close — and with it index deletion or plugin unload — would hang on it.
	 */
	private static readonly CLOSE_ACK_TIMEOUT_MS = 10_000;

	/**
	 * Close the store and terminate the worker.
	 *
	 * Every request still in flight is rejected, not dropped. `terminate()`
	 * discards the worker's reply queue, so a promise left in `pending` would
	 * never settle: a bulk run whose `putNote` was in flight when its index was
	 * deleted hung forever on that await — its `finally` never ran and the
	 * progress notice stayed on screen for the rest of the session.
	 *
	 * The close request itself is awaited only up to {@link CLOSE_ACK_TIMEOUT_MS};
	 * the worker is terminated and the pending requests rejected either way.
	 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		let timer: number | null = null;
		try {
			await Promise.race([
				this.callUnchecked("close", []),
				new Promise<void>((resolve) => {
					timer = self.setTimeout(() => {
						Logger.warn("[VectorStore] [HNSW] Worker did not acknowledge close; terminating it.");
						resolve();
					}, HNSWWorkerProxy.CLOSE_ACK_TIMEOUT_MS);
				}),
			]);
		} catch (error) {
			// The worker failed while closing (`onerror` rejected the request); it
			// is terminated below regardless.
			Logger.warn("[VectorStore] [HNSW] Close request failed:", error);
		} finally {
			if (timer !== null) self.clearTimeout(timer);
			this.worker.terminate();
			this.rejectPending(new Error("Vector store closed while the request was in flight"));
		}
	}

	/** `call` without the closed guard, for the close request itself. */
	private callUnchecked(method: string, args: unknown[]): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			const request: HNSWWorkerRequest = { id, method, args };
			this.worker.postMessage(request);
		});
	}

	private rejectPending(error: Error): void {
		const entries = [...this.pending.values()];
		this.pending.clear();
		for (const entry of entries) entry.reject(error);
	}

	get providerId(): string | null {
		return this._providerId;
	}

	get modelId(): string | null {
		return this._modelId;
	}

	async setMetadata(providerId: string, modelId: string, version: number): Promise<void> {
		await this.call("setMetadata", [providerId, modelId, version]);
		this._providerId = providerId;
		this._modelId = modelId;
	}

	async getMetadata(): Promise<IndexMetadata | null> {
		return (await this.call("getMetadata", [])) as IndexMetadata | null;
	}

	async putNote(chunks: DocumentVector[]): Promise<void> {
		await this.call("putNote", [chunks], vectorBuffers(chunks));
	}

	async remove(path: string): Promise<void> {
		await this.call("remove", [path]);
	}

	async renameNote(oldPath: string, newPath: string): Promise<void> {
		await this.call("renameNote", [oldPath, newPath]);
	}

	async getByPath(path: string): Promise<DocumentVector | undefined> {
		const result = await this.call("getByPath", [path]);
		return (result as DocumentVector) ?? undefined;
	}

	async getAllByPath(path: string): Promise<DocumentVector[]> {
		return (await this.call("getAllByPath", [path])) as DocumentVector[];
	}

	async getDocumentMtime(path: string): Promise<number | undefined> {
		const result = await this.call("getDocumentMtime", [path]);
		return (result as number) ?? undefined;
	}

	async listNoteMeta(): Promise<NoteMeta[]> {
		return (await this.call("listNoteMeta", [])) as NoteMeta[];
	}

	async semanticPairs(paths: string[], options?: SemanticPairOptions): Promise<SemanticPair[]> {
		return (await this.call("semanticPairs", [paths, options])) as SemanticPair[];
	}

	async noteNeighbors(path: string, threshold: number): Promise<NoteNeighbor[]> {
		return (await this.call("noteNeighbors", [path, threshold])) as NoteNeighbor[];
	}

	async getAllSerialized(): Promise<SerializedDocument[]> {
		return (await this.call("getAllSerialized", [])) as SerializedDocument[];
	}

	async bulkPut(docs: DocumentVector[]): Promise<void> {
		await this.call("bulkPut", [docs], vectorBuffers(docs));
	}

	async flush(): Promise<void> {
		await this.call("flush", []);
	}

	async clear(): Promise<void> {
		await this.call("clear", []);
	}

	async count(): Promise<number> {
		return (await this.call("count", [])) as number;
	}

	async countNotes(): Promise<number> {
		return (await this.call("countNotes", [])) as number;
	}

	async search(queryVector: Float32Array, topK: number, threshold?: number): Promise<SearchHit[]> {
		// The query is small and callers may reuse it (e.g. against a second
		// index), so it is cloned rather than transferred.
		return (await this.call("search", [queryVector, topK, threshold])) as SearchHit[];
	}

	/**
	 * Inspect HNSW graph health inside the worker.
	 *
	 * The graph lives in the worker realm, so reading `hnswIndex` from the main
	 * thread always shows `undefined` regardless of its true state. A `nodeCount`
	 * much larger than `mappedIdCount` indicates stale nodes left over from earlier
	 * indexing runs, which collide with reassigned numeric ids and cause search to
	 * silently return too few results.
	 */
	async getGraphStats(): Promise<{
		dimensions: number | null;
		hasIndex: boolean;
		nodeCount: number | null;
		mappedIdCount: number;
	}> {
		return (await this.call("getGraphStats", [])) as {
			dimensions: number | null;
			hasIndex: boolean;
			nodeCount: number | null;
			mappedIdCount: number;
		};
	}
}

/**
 * The distinct buffers behind a batch of vectors, for the transfer list. A
 * buffer appearing twice in a transfer list throws, so views sharing one
 * backing store (unusual, but legal) are deduplicated.
 */
function vectorBuffers(docs: DocumentVector[]): Transferable[] {
	const buffers = new Set<ArrayBufferLike>();
	for (const doc of docs) buffers.add(doc.vector.buffer);
	return [...buffers].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
}
