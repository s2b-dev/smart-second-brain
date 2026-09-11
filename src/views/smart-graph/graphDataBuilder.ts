/**
 * Graph Data Builder
 *
 * Builds the node/edge structure behind the smart graph.
 *
 * Edges come from two sources that are fused into one graph:
 * - **wiki** — authored `[[links]]` from Obsidian's `resolvedLinks`.
 * - **semantic** — inferred top-K embedding neighbours ({@link buildSemanticEdges}).
 *
 * A third, optional layer draws each tag as a node linked to the notes that
 * carry it ({@link buildTagLayer}). Tag edges are authored structure and join
 * the Leiden input alongside wiki links (damped by tag breadth, see the view's
 * `leidenWeightFor`); the semantic scan never sees them.
 *
 * The fusion matters because most vaults are link-sparse: with wiki links alone
 * the great majority of notes have degree 0, so community detection cannot place
 * them and they render as an unstructured cloud. Semantic edges give every
 * indexed note a way into a topic without the user linking anything by hand.
 *
 * Topics come from Leiden community detection over that fused graph
 * ({@link resolveSegments}); node positions come from d3-force. Neither reads the
 * embedding vectors directly — they only feed the semantic edge scan.
 */

import type { App, TFile } from "obsidian";
import { getAllTags } from "obsidian";

import type { SemanticPairOptions } from "../../vectorstore/types";
import { getIndexableVaultFiles } from "../../utils/fileFiltering";
import {
	DEFAULT_SEMANTIC_NEIGHBOR_COUNT,
	DEFAULT_SEMANTIC_THRESHOLD,
	pairKey,
	type SemanticPair,
} from "../../utils/semanticEdges";
import {
	type GraphData,
	type GraphEdge,
	type GraphNode,
	generateClusterColors,
	type SegmentBy,
	type SpaceSegment,
} from "../../types/graph";
import { computeNodeDegrees, edgeKey, isTagNode, splitEdgeKey, tagNodeId } from "../../utils/graphUtils";
import { MIN_TOPIC_SIZE } from "../../utils/topicHierarchy";

// ============================================================================
// Filters
// ============================================================================

export interface GraphFilter {
	/** Only include files under these folder paths */
	folders?: string[];
	/** Only include files with these tags (any match) */
	tags?: string[];
	/** Only include files with these extensions (e.g. "md", "pdf") */
	extensions?: string[];
}

/**
 * Check whether a file passes the given folder/tag filters.
 */
function passesFilter(app: App, file: TFile, filter?: GraphFilter): boolean {
	if (!filter) return true;

	// Extension filter
	if (filter.extensions && filter.extensions.length > 0) {
		if (!filter.extensions.includes(file.extension.toLowerCase())) return false;
	}

	// Folder filter (append "/" so "Work" doesn't match "Workshop/")
	if (filter.folders && filter.folders.length > 0) {
		const inFolder = filter.folders.some((f) => file.path.startsWith(f.endsWith("/") ? f : `${f}/`));
		if (!inFolder) return false;
	}

	// Tag filter (supports hierarchical tags: #WIN matches #WIN/2016)
	if (filter.tags && filter.tags.length > 0) {
		const cache = app.metadataCache.getFileCache(file);
		const fileTags = cache ? (getAllTags(cache) ?? []) : [];
		const hasTag = filter.tags.some((filterTag) =>
			fileTags.some((docTag) => docTag === filterTag || docTag.startsWith(`${filterTag}/`)),
		);
		if (!hasTag) return false;
	}

	return true;
}

// ============================================================================
// Helper functions (extracted to reduce cognitive complexity)
// ============================================================================

function buildWikiEdges(app: App, filteredPathSet: Set<string>): GraphEdge[] {
	const edges: GraphEdge[] = [];
	const wikiEdgeSet = new Set<string>();

	for (const [sourcePath, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
		if (!filteredPathSet.has(sourcePath)) continue;
		for (const [targetPath, count] of Object.entries(targets)) {
			if (!filteredPathSet.has(targetPath) || sourcePath === targetPath) continue;
			const ek = edgeKey(sourcePath, targetPath);
			if (wikiEdgeSet.has(ek)) continue;
			wikiEdgeSet.add(ek);
			edges.push({ source: sourcePath, target: targetPath, weight: count, type: "wiki" });
		}
	}

	return edges;
}

// ============================================================================
// Tag layer
// ============================================================================

/**
 * Tags as nodes: one node per distinct tag across the given notes, and one
 * `tag` edge from each note to every tag it carries — the same picture as
 * Obsidian's own graph with its "Tags" filter on.
 *
 * Tags are matched case-insensitively (as Obsidian treats them) with the
 * first-seen casing kept for the label. Nested tags stay whole: `#a/b` is its
 * own node, not a child of `#a`. Only the notes passed in contribute, so every
 * folder/tag/extension filter and the private-note exclusion already applied
 * to them carries over to the tags shown.
 *
 * Tags shape topics but are never topic *members*: {@link resolveSegments}
 * keeps them out of every segment's `paths`, so they carry no `cluster`, no
 * topic colour, and never fold into a collapsed bubble. A tag can still name
 * a topic — see the representative rule in `resolveSegmentsByLeiden`.
 */
function buildTagLayer(app: App, files: TFile[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
	const labelById = new Map<string, string>();
	const edges: GraphEdge[] = [];
	for (const file of files) {
		if (file.extension !== "md") continue;
		const cache = app.metadataCache.getFileCache(file);
		if (!cache) continue;
		const seen = new Set<string>();
		for (const tag of getAllTags(cache) ?? []) {
			const id = tagNodeId(tag);
			// A note that mentions a tag twice still links to it once.
			if (seen.has(id)) continue;
			seen.add(id);
			if (!labelById.has(id)) labelById.set(id, tag);
			edges.push({ source: file.path, target: id, weight: 1, type: "tag" });
		}
	}
	const nodes: GraphNode[] = [...labelById.entries()].map(([id, label]) => ({
		id,
		path: id,
		label,
		x: 0,
		y: 0,
		degree: 0,
		highlighted: false,
		kind: "tag",
	}));
	return { nodes, edges };
}

// ============================================================================
// Semantic edges
// ============================================================================

export interface SemanticEdgeOptions {
	/** Max semantic neighbours contributed per note. */
	neighborCount?: number;
	/** Minimum cosine similarity for an edge to be emitted. */
	threshold?: number;
	/** Edge keys (from `edgeKey`) that already exist as wiki links and must not be duplicated. */
	excludeEdgeKeys?: Set<string>;
}

/**
 * The slice of the vector store the semantic edge build needs: the store runs
 * the neighbour search itself (see `VectorStore.semanticPairs`), so the vectors
 * never leave the worker that owns them.
 */
export interface SemanticPairSource {
	semanticPairs(paths: string[], options?: SemanticPairOptions): Promise<SemanticPair[]>;
}

/**
 * Build semantic similarity edges between notes from their embeddings.
 *
 * Each note proposes its top-`neighborCount` most similar notes above
 * `threshold`; the result is the union of those proposals, deduped so a pair
 * appears once. Pairs already joined by a wiki link are skipped — an authored
 * link is the stronger statement and rendering both would double-count the pair
 * in community detection.
 *
 * The search runs inside the vector store's worker, next to the vectors, so a
 * large vault neither stalls the UI nor copies its whole embedding set to the
 * main thread while the graph builds. Only the note list goes in and scored
 * index pairs come out. Small batches take an exact pairwise scan; large ones
 * an approximate HNSW index — see `computeSemanticPairs`.
 */
export async function buildSemanticEdges(
	source: SemanticPairSource,
	includePaths: Set<string>,
	options: SemanticEdgeOptions = {},
): Promise<GraphEdge[]> {
	const neighborCount = options.neighborCount ?? DEFAULT_SEMANTIC_NEIGHBOR_COUNT;
	if (neighborCount <= 0) return [];

	// Note indices are positions in this list, on both sides of the call.
	const paths = [...includePaths];
	if (paths.length < 2) return [];

	// The store speaks note indices; translate the caller's path-keyed exclusions
	// into that space by walking the exclusion set itself (not every pair), and
	// drop any whose notes aren't both in this graph.
	let excludePairs: string[] | undefined;
	if (options.excludeEdgeKeys?.size) {
		const indexByPath = new Map(paths.map((path, index) => [path, index]));
		const excluded = new Set<string>();
		for (const key of options.excludeEdgeKeys) {
			const [left, right] = splitEdgeKey(key);
			const a = indexByPath.get(left);
			const b = indexByPath.get(right);
			if (a === undefined || b === undefined || a === b) continue;
			excluded.add(pairKey(a, b));
		}
		excludePairs = [...excluded];
	}

	const pairs = await source.semanticPairs(paths, {
		neighborCount,
		threshold: options.threshold ?? DEFAULT_SEMANTIC_THRESHOLD,
		excludePairs,
	});

	return pairs.map((pair) => ({
		source: paths[pair.source],
		target: paths[pair.target],
		weight: pair.score,
		type: "semantic" as const,
	}));
}

function createWikiNodes(filteredFiles: TFile[], degreeMap: Map<string, number>): GraphNode[] {
	const nodes: GraphNode[] = [];
	for (const file of filteredFiles) {
		const degree = degreeMap.get(file.path) ?? 0;
		const label = file.basename;
		nodes.push({
			id: file.path,
			path: file.path,
			label,
			x: 0,
			y: 0,
			degree,
			highlighted: false,
		});
	}
	return nodes;
}

// ============================================================================
// Topics
// ============================================================================

export type ClusterRepresentativeMap = Map<number, GraphNode>;

/**
 * Fixed number of palette slots topics hash into.
 *
 * Keeping this constant is what lets a topic hold its colour across granularity levels:
 * if the palette were sized to the current topic count, the same hash would land
 * on a different slot at every level.
 */
const TOPIC_COLOR_SLOTS = 24;
/**
 * Derive cluster labels from the best-connected note inside each cluster.
 * Internal cluster degree is preferred; total wiki degree is used as a fallback.
 */
export function deriveClusterRepresentativesFromGraph(graphData: GraphData): ClusterRepresentativeMap {
	const nodeById = new Map(graphData.nodes.map((node) => [node.id, node]));
	const clusterNodes = new Map<number, GraphNode[]>();
	for (const node of graphData.nodes) {
		if (node.cluster == null) continue;
		const group = clusterNodes.get(node.cluster) ?? [];
		group.push(node);
		clusterNodes.set(node.cluster, group);
	}

	const internalDegrees = new Map<string, number>();
	for (const edge of graphData.edges) {
		const source = nodeById.get(edge.source);
		const target = nodeById.get(edge.target);
		if (!source || !target || source.cluster == null || source.cluster !== target.cluster) continue;

		internalDegrees.set(source.id, (internalDegrees.get(source.id) ?? 0) + 1);
		internalDegrees.set(target.id, (internalDegrees.get(target.id) ?? 0) + 1);
	}

	const representatives: ClusterRepresentativeMap = new Map();
	for (const [clusterId, nodes] of clusterNodes) {
		const hubNode = [...nodes].sort((left, right) => {
			const internalDiff = (internalDegrees.get(right.id) ?? 0) - (internalDegrees.get(left.id) ?? 0);
			if (internalDiff !== 0) return internalDiff;

			const degreeDiff = (right.degree ?? 0) - (left.degree ?? 0);
			if (degreeDiff !== 0) return degreeDiff;

			const labelDiff = left.label.localeCompare(right.label);
			if (labelDiff !== 0) return labelDiff;

			return left.id.localeCompare(right.id);
		})[0];

		if (hubNode) {
			representatives.set(clusterId, hubNode);
		}
	}

	return representatives;
}

// ============================================================================
// Wiki-only graph (initial Obsidian-like view)
// ============================================================================

/** Result of building a wiki-link-only graph (no semantic edges). */
export interface WikiGraphResult {
	graphData: GraphData;
	/** The note paths in the graph — never tag node ids. */
	filteredPaths: string[];
}

export interface WikiGraphOptions {
	/** Draw each tag as a node linked to the notes carrying it ({@link buildTagLayer}). */
	includeTags?: boolean;
}

/**
 * Build a graph using only Obsidian wiki-link edges (plus the tag layer when
 * asked for). Nodes start at (0,0) and are positioned by d3-force.
 *
 * @param constrainToPaths — When provided, only include files whose path is in
 *   this set. Used to keep the wiki graph's node set identical to the smart
 *   graph's so mode transitions don't add/remove nodes.
 */
export function buildWikiGraph(
	app: App,
	filter?: GraphFilter,
	constrainToPaths?: Set<string>,
	options: WikiGraphOptions = {},
): WikiGraphResult {
	let filteredFiles = getIndexableVaultFiles(app.vault);
	if (constrainToPaths) {
		filteredFiles = filteredFiles.filter((file) => constrainToPaths.has(file.path));
	}
	if (filter?.folders?.length || filter?.tags?.length || filter?.extensions?.length) {
		filteredFiles = filteredFiles.filter((file) => passesFilter(app, file, filter));
	}

	if (filteredFiles.length === 0) {
		return { graphData: { nodes: [], edges: [] }, filteredPaths: [] };
	}

	const filteredPaths = filteredFiles.map((file) => file.path);
	const filteredPathSet = new Set(filteredPaths);
	const tagLayer = options.includeTags ? buildTagLayer(app, filteredFiles) : { nodes: [], edges: [] };
	const edges = [...buildWikiEdges(app, filteredPathSet), ...tagLayer.edges];
	// A tag's degree is how many notes carry it; a note's degree ignores its
	// tags (see computeNodeDegrees for why).
	const degreeMap = computeNodeDegrees(edges);
	const nodes = [
		...createWikiNodes(filteredFiles, degreeMap),
		...tagLayer.nodes.map((node) => ({ ...node, degree: degreeMap.get(node.id) ?? 0 })),
	];

	const nodeIds = new Set(nodes.map((n) => n.id));
	const filteredEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

	return { graphData: { nodes, edges: filteredEdges }, filteredPaths };
}

// ============================================================================
// Unified Groups
// ============================================================================

/**
 * Partition the graph's nodes into colored {@link SpaceSegment}s.
 *
 * - **leiden**: one segment per detected community (see {@link resolveSegmentsByLeiden})
 * - **none**: returns an empty array, which is how the topics toggle clears
 *   every node's colour without discarding the computed communities
 */
export function resolveSegments(
	graphData: GraphData,
	source: SegmentBy,
	options?: {
		themeColors?: string[];
		leidenCommunities?: Record<string, number>;
	},
): SpaceSegment[] {
	if (source === "none") return [];

	const { themeColors = [], leidenCommunities } = options ?? {};
	return resolveSegmentsByLeiden(graphData, leidenCommunities ?? {}, themeColors);
}

/**
 * Resolve segments using Leiden community detection on the wiki link graph.
 * Communities are derived purely from link topology — notes that heavily
 * interlink end up in the same community regardless of content similarity.
 * Nodes with no wiki links are not assigned to any community and keep the
 * default node color. Tag nodes may appear in `communities` (they take part in
 * detection) but never in a segment's `paths`.
 *
 * `communities` is a pre-computed node-id → community-id map produced by
 * `leidenAsync` in the compute worker.
 */
function resolveSegmentsByLeiden(
	graphData: GraphData,
	communities: Record<string, number>,
	themeColors: string[],
): SpaceSegment[] {
	if (Object.keys(communities).length === 0) return [];

	const nodeById = new Map(graphData.nodes.map((n) => [n.id, n]));
	const communityNodes = new Map<number, string[]>();

	for (const [nodeId, communityId] of Object.entries(communities)) {
		if (!nodeById.has(nodeId)) continue;
		if (!communityNodes.has(communityId)) communityNodes.set(communityId, []);
		communityNodes.get(communityId)?.push(nodeId);
	}

	if (communityNodes.size === 0) return [];

	// Compute internal degree: count edges whose both endpoints share the same community
	const internalDegree = new Map<string, number>();
	for (const edge of graphData.edges) {
		const sourceCommunity = communities[edge.source];
		const targetCommunity = communities[edge.target];
		if (sourceCommunity == null || targetCommunity == null || sourceCommunity !== targetCommunity) continue;
		internalDegree.set(edge.source, (internalDegree.get(edge.source) ?? 0) + 1);
		internalDegree.set(edge.target, (internalDegree.get(edge.target) ?? 0) + 1);
	}

	// Tags sit in the community map (they took part in detection) but a topic
	// is its notes: tags don't count toward its size and don't become members.
	const isNoteId = (id: string) => {
		const node = nodeById.get(id);
		return node !== undefined && !isTagNode(node);
	};
	const noteCount = new Map<number, number>();
	for (const [communityId, nodeIds] of communityNodes) {
		noteCount.set(communityId, nodeIds.filter(isNoteId).length);
	}

	// Sort communities by size descending so the largest get the most prominent colors.
	// Groups below MIN_TOPIC_SIZE are dropped: a lone note isn't a topic, it's a note
	// that failed to join one, and listing hundreds of them buries the real topics.
	// Those notes still render — they simply keep the default colour and no label.
	const sizeOf = (communityId: number) => noteCount.get(communityId) ?? 0;
	const sorted = [...communityNodes.entries()]
		.filter(([communityId]) => sizeOf(communityId) >= MIN_TOPIC_SIZE)
		.sort((a, b) => sizeOf(b[0]) - sizeOf(a[0]) || a[0] - b[0]);
	if (sorted.length === 0) return [];
	// Palette size is fixed rather than sized to the current topic count: a hashed
	// slot must land the same way at every granularity level, and `colors.length` would
	// otherwise change with the number of topics and remap every colour.
	const colors = generateClusterColors(Math.max(TOPIC_COLOR_SLOTS, sorted.length), themeColors);

	// Representative first (it anchors both label and colour), then build segments.
	//
	// A tag may represent a topic — for a vault organised by tags, `#cooking` is
	// the best name that topic can have — but only when the topic is where the
	// tag *lives*: at least half of the notes carrying it are inside. A broad tag
	// spread across many topics would otherwise win the internal-degree contest
	// in whichever one it happened to land, and label a group it doesn't describe.
	const withRepresentative = sorted.map(([communityId, nodeIds], i) => {
		let bestId = nodeIds.find(isNoteId) ?? nodeIds[0];
		let bestInternal = Number.NEGATIVE_INFINITY;
		let bestTotal = Number.NEGATIVE_INFINITY;
		for (const id of nodeIds) {
			const internal = internalDegree.get(id) ?? 0;
			const total = nodeById.get(id)?.degree ?? 0;
			if (!isNoteId(id) && internal * 2 < total) continue;
			if (internal > bestInternal || (internal === bestInternal && total > bestTotal)) {
				bestInternal = internal;
				bestTotal = total;
				bestId = id;
			}
		}
		return { communityId, nodeIds, bestId, index: i };
	});

	// Colour is keyed to each topic's *representative note*, not its rank in this
	// list. Rank shifts whenever granularity changes topic sizes, which would repaint the
	// whole graph on every granularity step; anchoring to a note means a topic keeps its
	// colour for as long as it keeps its core, so the eye can follow a group from
	// one level to the next.
	//
	// Allocation walks the anchors in sorted order rather than in rank order:
	// palette slots are finite, so two topics can hash to the same one, and
	// resolving that by insertion order would let a single collision reshuffle
	// every colour after it — exactly the instability this is meant to remove.
	const anchorOf = (bestId: string, communityId: number) => nodeById.get(bestId)?.path ?? String(communityId);
	const colorByAnchor = new Map<string, string>();
	const takenSlots = new Set<number>();
	for (const { bestId, communityId } of [...withRepresentative].sort((a, b) =>
		anchorOf(a.bestId, a.communityId).localeCompare(anchorOf(b.bestId, b.communityId)),
	)) {
		const anchor = anchorOf(bestId, communityId);
		let hash = 5381;
		for (let i = 0; i < anchor.length; i++) hash = ((hash * 33) ^ anchor.charCodeAt(i)) >>> 0;
		for (let probe = 0; probe < colors.length; probe++) {
			const slot = (hash + probe) % colors.length;
			if (takenSlots.has(slot)) continue;
			takenSlots.add(slot);
			colorByAnchor.set(anchor, colors[slot]);
			break;
		}
	}

	return withRepresentative.map(({ communityId, nodeIds, bestId, index }) => {
		const label = nodeById.get(bestId)?.label ?? nodeById.get(bestId)?.path ?? `Community ${index + 1}`;
		const paths = new Set(
			nodeIds
				.filter(isNoteId)
				.map((id) => nodeById.get(id)?.path)
				.filter((p): p is string => p != null),
		);

		return {
			id: `leiden:${index}`,
			label,
			color: colorByAnchor.get(anchorOf(bestId, communityId)) ?? colors[index],
			source: "leiden",
			paths,
			communityId,
		};
	});
}
