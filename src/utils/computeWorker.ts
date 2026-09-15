/**
 * Compute Web Worker
 *
 * Runs Leiden community detection off the main thread. Messages follow a
 * request/response pattern with a shared `id` for correlation.
 *
 * (The semantic edge scan used to run here too, fed a copy of every chunk
 * vector from the main thread. It now runs inside the vector store's own
 * worker, next to the vectors — see `VectorStore.semanticPairs`.)
 */

import { Graph as LeidenGraph, leiden } from "leiden-ts";

export type ComputeWorkerRequest = {
	id: number;
	type: "leiden";
	sources: string[];
	targets: string[];
	weights: number[];
	/** PRNG seed for reproducibility (default 42) */
	seed?: number;
	/** Resolution γ — lower = fewer larger communities (default 1.0) */
	resolution?: number;
};

export type ComputeWorkerResponse =
	| {
			id: number;
			type: "leiden";
			result: { communities: Record<string, number> };
	  }
	| { id: number; type: "error"; error: string };

interface ComputeWorkerScope {
	postMessage: (message: ComputeWorkerResponse, transfer?: Transferable[]) => void;
	onmessage: ((event: MessageEvent<ComputeWorkerRequest>) => void | Promise<void>) | null;
}

// This module is a Web Worker entry: `self` is the DedicatedWorkerGlobalScope, whose
// `postMessage(message, transfer?)` differs from the Window overloads the DOM lib types give `self`.
const workerScope = self as unknown as ComputeWorkerScope;

workerScope.onmessage = async (e: MessageEvent<ComputeWorkerRequest>) => {
	const msg = e.data;
	try {
		switch (msg.type) {
			case "leiden": {
				// Build an integer-indexed graph for leiden-ts (string node ids → indices)
				const nodeIndex = new Map<string, number>();
				for (let i = 0; i < msg.sources.length; i++) {
					if (!nodeIndex.has(msg.sources[i])) nodeIndex.set(msg.sources[i], nodeIndex.size);
					if (!nodeIndex.has(msg.targets[i])) nodeIndex.set(msg.targets[i], nodeIndex.size);
				}
				const nodeCount = nodeIndex.size;
				const communities: Record<string, number> = {};

				if (nodeCount > 0) {
					// Deduplicate edges (leiden-ts rejects duplicate undirected edges)
					const seen = new Set<string>();
					const edges: [number, number, number][] = [];
					for (let i = 0; i < msg.sources.length; i++) {
						// nodeIndex was just built by walking these same two arrays, so every
						// endpoint is present by construction — the assertions cannot fail.
						// biome-ignore lint/style/noNonNullAssertion: see above
						const u = nodeIndex.get(msg.sources[i])!;
						// biome-ignore lint/style/noNonNullAssertion: see above
						const v = nodeIndex.get(msg.targets[i])!;
						if (u === v) continue;
						const key = u < v ? `${u}:${v}` : `${v}:${u}`;
						if (!seen.has(key)) {
							seen.add(key);
							edges.push([u, v, msg.weights[i]]);
						}
					}
					const lGraph = LeidenGraph.fromEdgeList(nodeCount, edges, { selfLoops: "collapse" });
					const result = leiden(lGraph, { seed: msg.seed ?? 42, resolution: msg.resolution ?? 1.0 });
					const assignments = result.partition.assignments;
					for (const [path, idx] of nodeIndex) {
						communities[path] = assignments[idx];
					}
				}

				workerScope.postMessage({
					id: msg.id,
					type: "leiden",
					result: { communities },
				} satisfies ComputeWorkerResponse);
				break;
			}
		}
	} catch (err) {
		const response: ComputeWorkerResponse = {
			id: msg.id,
			type: "error",
			error: err instanceof Error ? err.message : String(err),
		};
		workerScope.postMessage(response);
	}
};
