/**
 * HNSW Worker
 *
 * Hosts the full HNSWVectorStore inside a Web Worker so all IndexedDB I/O
 * and CPU-intensive HNSW operations (build, search, add) run off the main thread.
 *
 * Communication uses a generic request/response protocol: each message is
 * { id, method, args } and the response is { id, result? , error? }.
 *
 * Vectors cross this boundary as `Float32Array` in both directions (structured
 * clone preserves typed arrays; the proxy transfers buffers on the write path).
 * There is no whole-set read in the protocol: the analytics that need every
 * vector (`semanticPairs`, `noteNeighbors`) run here and return their results.
 */

import { HNSWVectorStore } from "./HNSWVectorStore";
import type { DocumentVector, SemanticPairOptions } from "./types";

export interface HNSWWorkerRequest {
	id: number;
	method: string;
	args: unknown[];
}

export interface HNSWWorkerResponse {
	id: number;
	result?: unknown;
	error?: string;
}

let store: HNSWVectorStore | null = null;

self.onmessage = async (e: MessageEvent<HNSWWorkerRequest>) => {
	const { id, method, args } = e.data;
	try {
		let result: unknown;

		switch (method) {
			case "init": {
				const [vaultId, indexId] = args as [string, string | undefined];
				store = new HNSWVectorStore(vaultId, indexId);
				result = undefined;
				break;
			}
			case "open": {
				result = await requireStore().open();
				break;
			}
			case "adoptDatabase": {
				result = await requireStore().adoptDatabase(args[0] as string);
				break;
			}
			case "close": {
				result = await requireStore().close();
				break;
			}
			case "getProviderId": {
				result = requireStore().providerId;
				break;
			}
			case "getModelId": {
				result = requireStore().modelId;
				break;
			}
			case "setMetadata": {
				const [providerId, modelId, version] = args as [string, string, number];
				result = await requireStore().setMetadata(providerId, modelId, version);
				break;
			}
			case "getMetadata": {
				result = await requireStore().getMetadata();
				break;
			}
			case "putNote": {
				result = await requireStore().putNote(args[0] as DocumentVector[]);
				break;
			}
			case "remove": {
				result = await requireStore().remove(args[0] as string);
				break;
			}
			case "renameNote": {
				const [oldPath, newPath] = args as [string, string];
				result = await requireStore().renameNote(oldPath, newPath);
				break;
			}
			case "getByPath": {
				const doc = await requireStore().getByPath(args[0] as string);
				result = doc ?? null;
				break;
			}
			case "getAllByPath": {
				result = await requireStore().getAllByPath(args[0] as string);
				break;
			}
			case "getDocumentMtime": {
				result = (await requireStore().getDocumentMtime(args[0] as string)) ?? null;
				break;
			}
			case "listNoteMeta": {
				result = await requireStore().listNoteMeta();
				break;
			}
			case "semanticPairs": {
				const [paths, options] = args as [string[], SemanticPairOptions | undefined];
				result = await requireStore().semanticPairs(paths, options);
				break;
			}
			case "noteNeighbors": {
				const [path, threshold] = args as [string, number];
				result = await requireStore().noteNeighbors(path, threshold);
				break;
			}
			case "getAllSerialized": {
				result = await requireStore().getAllSerialized();
				break;
			}
			case "bulkPut": {
				result = await requireStore().bulkPut(args[0] as DocumentVector[]);
				break;
			}
			case "flush": {
				result = await requireStore().flush();
				break;
			}
			case "clear": {
				result = await requireStore().clear();
				break;
			}
			case "count": {
				result = await requireStore().count();
				break;
			}
			case "countNotes": {
				result = await requireStore().countNotes();
				break;
			}
			case "search": {
				const [queryVector, topK, threshold] = args as [Float32Array, number, number | undefined];
				result = await requireStore().search(queryVector, topK, threshold);
				break;
			}
			case "getGraphStats": {
				// Graph health, for diagnosing recall problems. `nodeCount` far
				// exceeding `mappedIdCount` means the persisted graph has retained
				// nodes from earlier indexing runs, whose numeric ids now collide
				// with freshly assigned ones — search then silently drops results.
				const s = requireStore() as unknown as {
					dimensions: number | null;
					hnswIndex: { nodes?: Map<number, unknown> } | null;
					numericToId: Map<number, string>;
				};
				result = {
					dimensions: s.dimensions,
					hasIndex: !!s.hnswIndex,
					nodeCount: s.hnswIndex?.nodes?.size ?? null,
					mappedIdCount: s.numericToId.size,
				};
				break;
			}
			default:
				throw new Error(`Unknown method: ${method}`);
		}

		const response: HNSWWorkerResponse = { id, result };
		self.postMessage(response);
	} catch (err: unknown) {
		const response: HNSWWorkerResponse = {
			id,
			error: err instanceof Error ? err.message : String(err),
		};
		self.postMessage(response);
	}
};

function requireStore(): HNSWVectorStore {
	if (!store) throw new Error("Worker not initialized. Call init first.");
	return store;
}
