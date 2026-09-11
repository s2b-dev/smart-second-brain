/**
 * Live Graph Patching
 *
 * Incremental updates for an open smart graph (issue #404). While the graph
 * view is open, vault changes are folded into the existing `GraphData` in
 * place instead of rebuilding everything — the expensive derivations (full
 * semantic scan, Leiden) are replaced by targeted equivalents:
 *
 * - {@link applyWikiPatch} swaps in a freshly built wiki structure while
 *   preserving surviving semantic edges and per-node presentation state.
 * - {@link queryNoteSemanticEdges} re-queries the live vault index for just
 *   one note's chunks instead of re-running the batch neighbour search.
 * - {@link voteNodeCommunity} assigns a note to the community that dominates
 *   its neighbours (the same vote as the bridge heuristic) instead of
 *   re-running Leiden.
 *
 * Everything here is pure over its inputs (the store interface is injected)
 * so it unit-tests without Obsidian. The view layer owns event debouncing,
 * drift counting, and when to fall back to a full Leiden run.
 */

import type { GraphData, GraphEdge, GraphNode } from "../types/graph";
import type { DocumentVector, ScoredDocument } from "../vectorstore/types";
import { computeNodeDegrees, edgeKey, isTagNode } from "./graphUtils";

export interface WikiPatchResult {
	data: GraphData;
	/** Note paths present in the fresh wiki graph but not in the current one (never tag nodes). */
	addedPaths: string[];
	/** Note paths that left the graph (deleted, renamed away, filtered out; never tag nodes). */
	removedPaths: string[];
	/**
	 * Surviving note paths whose incident authored edges (wiki or tag) changed —
	 * candidates for a community re-vote, since their neighbourhood is no longer
	 * what Leiden saw. (A tag change can't move a note's vote, since tag edges
	 * are not topic edges, but the vote is cheap and the filter stays simple.)
	 */
	touchedPaths: string[];
	/** False when the fresh wiki structure is identical — callers should no-op. */
	changed: boolean;
}

/** Recompute per-node degree over the fused edge set, by the shared rule in `computeNodeDegrees`. */
function withRecomputedDegrees(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
	const degrees = computeNodeDegrees(edges);
	return nodes.map((node) => {
		const degree = degrees.get(node.path) ?? 0;
		return node.degree === degree ? node : { ...node, degree };
	});
}

/**
 * Fold a freshly built wiki graph into the current (fused) graph data.
 *
 * The wiki structure — node set (notes and, when shown, tags) and authored
 * edges (wiki and tag) — is taken wholesale from `freshWiki`; it's cheap to
 * build and diffing per-event edge cases (renames, links resolving against a
 * newly created note) out of vault events would be far more fragile than
 * rebuilding it. What's preserved from `current` is everything the wiki
 * rebuild can't produce:
 *
 * - semantic edges whose endpoints both survive (a pair the user has since
 *   linked by hand loses its inferred edge — the authored link supersedes it),
 * - per-node presentation state (colour, cluster, highlight) so topics don't
 *   flash away while the incremental re-vote runs.
 *
 * Degrees are recomputed over the fused edge set, matching the full build.
 */
export function applyWikiPatch(current: GraphData, freshWiki: GraphData): WikiPatchResult {
	const currentByPath = new Map(current.nodes.map((node) => [node.path, node]));
	const freshPaths = new Set(freshWiki.nodes.map((node) => node.path));
	// Tag nodes come and go with the notes that carry them; they have no
	// community to vote on and no selection to prune, so the caller only hears
	// about notes. They still count as a structural change below.
	const addedPaths = freshWiki.nodes
		.filter((node) => !isTagNode(node) && !currentByPath.has(node.path))
		.map((node) => node.path);
	const removedPaths = current.nodes
		.filter((node) => !isTagNode(node) && !freshPaths.has(node.path))
		.map((node) => node.path);
	const tagNodesChanged =
		freshWiki.nodes.some((node) => isTagNode(node) && !currentByPath.has(node.path)) ||
		current.nodes.some((node) => isTagNode(node) && !freshPaths.has(node.path));

	// Diff the authored edge sets (wiki and tag) by canonical key + weight,
	// collecting the endpoints of every difference — those notes' neighbourhoods
	// changed. A wiki and a tag edge can never share a pair (one joins two
	// notes, the other a note and a tag), so one key space serves both.
	const currentWikiWeights = new Map<string, number>();
	for (const edge of current.edges) {
		if (edge.type !== "semantic") currentWikiWeights.set(edgeKey(edge.source, edge.target), edge.weight);
	}
	const freshWikiKeys = new Set<string>();
	const touched = new Set<string>();
	for (const edge of freshWiki.edges) {
		const key = edgeKey(edge.source, edge.target);
		freshWikiKeys.add(key);
		if (currentWikiWeights.get(key) !== edge.weight) {
			touched.add(edge.source);
			touched.add(edge.target);
		}
	}
	for (const edge of current.edges) {
		if (edge.type === "semantic") continue;
		if (!freshWikiKeys.has(edgeKey(edge.source, edge.target))) {
			touched.add(edge.source);
			touched.add(edge.target);
		}
	}

	const wikiChanged = currentWikiWeights.size !== freshWikiKeys.size || touched.size > 0;
	if (addedPaths.length === 0 && removedPaths.length === 0 && !tagNodesChanged && !wikiChanged) {
		return { data: current, addedPaths, removedPaths, touchedPaths: [], changed: false };
	}

	const nodes = freshWiki.nodes.map((node) => {
		const previous = currentByPath.get(node.path);
		if (!previous) return node;
		return {
			...node,
			x: previous.x,
			y: previous.y,
			color: previous.color,
			cluster: previous.cluster,
			highlighted: previous.highlighted,
		};
	});

	// A semantic edge survives unless one of its notes left the graph, or the
	// user has *newly* linked the pair by hand — an authored link is the
	// stronger statement, and the full build excludes such pairs from the scan.
	// Only newly-authored links supersede: a pair that already carried both edge
	// types (the scan excluded pairs against the wiki links existing at scan
	// time, so later-arriving ones coexist) must keep its inferred edge, or
	// every patch would silently erode the semantic edge set.
	const semanticEdges = current.edges.filter((edge) => {
		if (edge.type !== "semantic") return false;
		if (!freshPaths.has(edge.source) || !freshPaths.has(edge.target)) return false;
		const key = edgeKey(edge.source, edge.target);
		return !freshWikiKeys.has(key) || currentWikiWeights.has(key);
	});
	const edges = [...freshWiki.edges, ...semanticEdges];

	// Added/removed nodes get dedicated handling by the caller (vote / cleanup);
	// only surviving notes count as "touched" — a tag endpoint has no vote.
	const touchedPaths = [...touched].filter((path) => {
		const previous = currentByPath.get(path);
		return previous !== undefined && !isTagNode(previous) && freshPaths.has(path);
	});

	return {
		data: { nodes: withRecomputedDegrees(nodes, edges), edges },
		addedPaths,
		removedPaths,
		touchedPaths,
		changed: true,
	};
}

/**
 * Replace the semantic edges incident to a set of notes with freshly queried
 * ones, leaving every other edge untouched.
 *
 * Dropping all incident edges first is deliberate: an edge some *other* note
 * proposed against this note's old content is exactly as stale as this note's
 * own proposals. The incremental query can't reproduce foreign proposals (only
 * a full scan sees them), so the live edge set under-approximates until the
 * next full rebuild — the documented trade-off of the incremental path.
 */
export function replaceSemanticEdgesForPaths(
	current: GraphData,
	paths: Set<string>,
	newEdges: GraphEdge[],
): { data: GraphData; changed: boolean } {
	const nodePaths = new Set(current.nodes.map((node) => node.path));
	const kept: GraphEdge[] = [];
	const removedWeights = new Map<string, number>();
	for (const edge of current.edges) {
		if (edge.type === "semantic" && (paths.has(edge.source) || paths.has(edge.target))) {
			removedWeights.set(edgeKey(edge.source, edge.target), edge.weight);
		} else {
			kept.push(edge);
		}
	}

	// Dedupe against surviving *semantic* edges only. A kept wiki edge on the
	// same pair must not block its semantic edge here: whether an authored link
	// suppresses an inferred one is decided at query time via `excludeEdgeKeys`,
	// and blocking on it again would drop edges for every linked pair.
	const existingKeys = new Set(
		kept.filter((edge) => edge.type === "semantic").map((edge) => edgeKey(edge.source, edge.target)),
	);
	const additions: GraphEdge[] = [];
	let identicalReplacements = 0;
	for (const edge of newEdges) {
		if (edge.source === edge.target) continue;
		if (!nodePaths.has(edge.source) || !nodePaths.has(edge.target)) continue;
		const key = edgeKey(edge.source, edge.target);
		if (existingKeys.has(key)) continue;
		existingKeys.add(key);
		additions.push(edge);
		if (removedWeights.get(key) === edge.weight) identicalReplacements++;
	}

	const changed = removedWeights.size !== additions.length || identicalReplacements !== additions.length;
	if (!changed) return { data: current, changed: false };

	const edges = [...kept, ...additions];
	return { data: { nodes: withRecomputedDegrees(current.nodes, edges), edges }, changed: true };
}

/**
 * Assign a note to the community that dominates its neighbours.
 *
 * The same vote the bridge heuristic runs, reused as an incremental stand-in
 * for Leiden: a note's community is overwhelmingly determined by who it
 * connects to, so summing edge weight per neighbouring community and taking
 * the maximum lands on Leiden's answer in the common case. Ties break on the
 * smaller community id so repeated votes are stable.
 *
 * Returns `undefined` when no neighbour carries a community — the note stays
 * unsorted, exactly as Leiden would leave a disconnected node.
 */
export function voteNodeCommunity(
	path: string,
	edges: GraphEdge[],
	communities: Record<string, number>,
	weightOf: (edge: GraphEdge) => number,
): number | undefined {
	const votes = new Map<number, number>();
	for (const edge of edges) {
		const other = edge.source === path ? edge.target : edge.target === path ? edge.source : null;
		if (other === null) continue;
		const community = communities[other];
		if (community === undefined) continue;
		votes.set(community, (votes.get(community) ?? 0) + weightOf(edge));
	}

	let best: number | undefined;
	let bestWeight = Number.NEGATIVE_INFINITY;
	for (const [community, weight] of votes) {
		if (weight > bestWeight || (weight === bestWeight && best !== undefined && community < best)) {
			best = community;
			bestWeight = weight;
		}
	}
	return best;
}

/** The slice of the vector store the incremental semantic query needs. */
export interface SemanticQueryStore {
	getAllByPath(path: string): Promise<DocumentVector[]>;
	search(queryVector: Float32Array, topK: number, threshold?: number): Promise<ScoredDocument[]>;
}

export interface NoteSemanticQueryOptions {
	/** Max semantic neighbours this note may propose. */
	neighborCount: number;
	/** Minimum cosine similarity for an edge to be emitted. */
	threshold: number;
	/** Edge keys (from `edgeKey`) that exist as wiki links and must not be duplicated. */
	excludeEdgeKeys?: Set<string>;
}

/**
 * Semantic edges for a single note, queried against the live vault index.
 *
 * The batch scan ({@link buildSemanticEdges}) rebuilds a transient index over
 * every on-screen chunk; for one changed note that's all waste. Instead each
 * of the note's chunks queries the store's existing HNSW index and the best
 * hit per neighbouring note wins — the same best-chunk semantics as the batch
 * kernels. The live index also contains notes outside the current graph, so
 * hits are filtered to `includePaths` and the per-chunk fetch over-fetches to
 * compensate (own chunks, duplicate chunks of one neighbour, and off-screen
 * notes all occupy raw result slots).
 */
export async function queryNoteSemanticEdges(
	store: SemanticQueryStore,
	path: string,
	includePaths: Set<string>,
	options: NoteSemanticQueryOptions,
): Promise<GraphEdge[]> {
	const { neighborCount, threshold } = options;
	if (neighborCount <= 0) return [];

	const chunks = await store.getAllByPath(path);
	if (chunks.length === 0) return [];

	const topK = neighborCount * 3 + chunks.length;
	const bestByNeighbor = new Map<string, number>();
	for (const chunk of chunks) {
		const hits = await store.search(chunk.vector, topK, threshold);
		for (const hit of hits) {
			const neighbor = hit.doc.path;
			if (neighbor === path || !includePaths.has(neighbor)) continue;
			if (options.excludeEdgeKeys?.has(edgeKey(path, neighbor))) continue;
			if (!Number.isFinite(hit.score) || hit.score < threshold) continue;
			const existing = bestByNeighbor.get(neighbor);
			if (existing === undefined || hit.score > existing) bestByNeighbor.set(neighbor, hit.score);
		}
	}

	return [...bestByNeighbor.entries()]
		.sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
		.slice(0, neighborCount)
		.map(([target, score]) => ({ source: path, target, weight: score, type: "semantic" as const }));
}
