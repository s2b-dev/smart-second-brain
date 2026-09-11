/**
 * Smart Graph View Types
 *
 * Types for the graph visualization feature. Nodes are positioned by d3-force
 * over the fused wiki + semantic edge graph, and grouped into topics by Leiden
 * community detection over those same edges.
 */

/**
 * How segments (visual partitions) are derived for node coloring.
 * - "leiden": one segment per detected community
 * - "none": no segments, so every node keeps the default colour
 */
export type SegmentBy = "leiden" | "none";

/**
 * A resolved segment of graph nodes — a visual partition of the current scope.
 */
export interface SpaceSegment {
	/** Unique key, e.g. "folder:Work", "cluster:3" */
	id: string;
	/** Display label shown in the legend */
	label: string;
	/** CSS color for this segment's nodes */
	color: string;
	/** How this segment was created */
	source: SegmentBy;
	/** Resolved file paths that belong to this segment */
	paths: Set<string>;
	/**
	 * For `leiden` segments: the underlying community id.
	 *
	 * Segments are ordered by size, so a segment's position is NOT its community
	 * id. Anything that needs to join segments back to raw community data (e.g.
	 * the topic hierarchy) must go through this rather than the index.
	 */
	communityId?: number;
}

/**
 * The type of relationship an edge represents.
 * - "wiki": An explicit wiki link authored by the user in Obsidian
 * - "semantic": An inferred similarity link between notes whose embeddings are
 *   close. Weight is the cosine similarity rather than a link count.
 * - "tag": A note carrying a tag, joining the note to that tag's node. Only
 *   present while tags are shown as nodes (`showTags`); weight is always 1.
 *   Authored structure like a wiki link, so it informs topic detection (damped
 *   by how many notes share the tag) — but never the semantic scan, which is
 *   over note content.
 */
export type EdgeType = "wiki" | "semantic" | "tag";

/**
 * A node in the graph representing a vault note.
 */
export interface GraphNode {
	/**
	 * Unique identifier: the file path, `topic:<cluster>` for a collapsed topic,
	 * or `tag:<tag>` for a tag node (see `tagNodeId`).
	 */
	id: string;
	/**
	 * Vault-relative file path.
	 *
	 * For a `kind: "topic"` or `kind: "tag"` node this is a synthetic id, NOT a
	 * real file — every path that opens, reveals, or previews a file must check
	 * {@link kind} first.
	 */
	path: string;
	/** Display label (file basename without extension; the `#tag` for a tag node) */
	label: string;
	/** X position (set by the d3-force simulation) */
	x: number;
	/** Y position (set by the d3-force simulation) */
	y: number;
	/** Velocity X (used by d3-force) */
	vx?: number;
	/** Velocity Y (used by d3-force) */
	vy?: number;
	/** Topic assignment index */
	cluster?: number;
	/** Display color (derived from the topic) */
	color?: string;
	/** Whether this node matches the current search query */
	highlighted?: boolean;
	/** Number of connections (degree) for sizing */
	degree?: number;
	/**
	 * What this node stands for.
	 *
	 * `"note"` (the default when absent) is a real vault file. `"topic"` is a
	 * synthetic node standing in for a whole collapsed topic — it has no file
	 * behind it, so file-opening interactions must branch on this. `"tag"` is a
	 * vault tag drawn as a node (Scope → "Tags"), linked to every note carrying
	 * it; also fileless. Tags take part in community detection but are never
	 * *members* of the resulting topics (no `cluster`, no segment path), so they
	 * keep the tag colour, sit outside hulls and never fold into a bubble.
	 */
	kind?: "note" | "topic" | "tag";
	/** For `kind: "topic"` — the vault paths this node stands for. */
	memberPaths?: string[];
	/**
	 * For `kind: "topic"` — member count of the *largest* topic in the current
	 * segmentation, collapsed or not. The normalizer for the topic's draw radius
	 * (see `nodeDrawRadius`): bubble area is `memberPaths.length` as a share of
	 * this, so sizes are relative to the vault rather than to a fixed constant,
	 * and a topic keeps its size whether or not the biggest one is folded.
	 */
	largestTopicSize?: number;
}

/**
 * An edge in the graph representing a relationship between notes.
 */
export interface GraphEdge {
	/** Source node ID (file path) */
	source: string;
	/** Target node ID (file path) */
	target: string;
	/** Edge weight (link count for wiki, similarity for semantic) */
	weight: number;
	/** The type of relationship this edge represents */
	type: EdgeType;
}

/**
 * Complete graph data structure passed to the renderer.
 */
export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

/**
 * Settings for the graph view, persisted in plugin data.
 */
export interface SmartGraphSettings {
	/** Target link distance for force layout */
	linkDistance: number;
	/** Charge strength (negative = repulsive). Controls how far apart nodes spread. */
	chargeStrength: number;
	/** Center force strength (0–1). Pulls the graph toward the center. */
	centerStrength: number;
	/** Link force strength (0–1). How strongly edges pull connected nodes together. */
	linkStrength: number;
	/** Cluster cohesion force strength (0–1). Pulls nodes toward their cluster centroid. */
	clusterCohesionStrength: number;
	/** Whether to show wiki link edges overlaid on the semantic graph */
	showWikiLinks: boolean;
	/** Whether to draw inferred semantic similarity edges (they always inform topics) */
	showSemanticLinks: boolean;
	/**
	 * Whether inferred edges are drawn in the accent colour instead of sharing
	 * the authored links' `--graph-line`.
	 *
	 * The dash pattern alone answers "is this edge inferred?" for one edge under
	 * the cursor, but not "where did the inference add structure?" across the
	 * whole graph — at overview zoom the dashes are a few pixels apart and read
	 * as solid. Off by default: colouring the inferred layer permanently would
	 * make it the loudest thing on screen, and it is usually the larger half of
	 * the edges.
	 */
	highlightSemanticLinks: boolean;
	/**
	 * When true, topics are detected from authored wiki links alone, ignoring
	 * semantic edges. Shows how much structure the user's own linking provides —
	 * notes left without a topic are ones they never linked.
	 */
	linkOnlyTopics: boolean;
	/** Max semantic neighbours contributed per note when building semantic edges */
	semanticNeighborCount: number;
	/** Minimum cosine similarity for a semantic edge (0–1) */
	semanticThreshold: number;
	/** Whether to render arrows for directed wiki links */
	directedWikiEdges: boolean;
	/** Chat model used for LLM-powered graph features (e.g., cluster labeling) */
	graphChatModel: import("../stores/chatTimeline").ChatModel | null;
	/** Whether to automatically generate cluster labels after clustering */
	autoLabelClusters: boolean;
	/** When true, only include markdown files in the graph; otherwise all indexable files */
	markdownOnly: boolean;
	/**
	 * Whether tags are drawn as nodes, each linked to the notes that carry it —
	 * the same option as Obsidian's own graph. Tags are authored structure, so
	 * with this on they also inform topic detection (in link-only mode too): a
	 * vault organised by tags rather than links gets topics from them. The
	 * semantic scan is over note content and never sees tags.
	 */
	showTags: boolean;
	/** Leiden PRNG seed — controls community assignment reproducibility */
	leidenSeed: number;
	/** Leiden resolution γ (default 1.0). Lower → fewer larger communities; higher → more smaller ones */
	leidenResolution: number;
	/** Bridge node threshold: fraction of foreign-community neighbors required to show the bridge ring (0–1) */
	bridgeThreshold: number;
	/** Highlight isolated notes (degree 0) in the graph */
	highlightIsolated: boolean;
	/** Highlight bridge notes (nodes spanning multiple communities) in the graph */
	highlightBridges: boolean;
	/** Whether to draw the cluster/topic label pills over the graph */
	showClusterLabels: boolean;
	/** Whether to draw a tinted region behind each topic's notes */
	showTopicHulls: boolean;
	/**
	 * Whether detected topics are applied to the view at all.
	 *
	 * Display-only: Leiden still runs and `leidenCommunities` stays populated, so
	 * flipping this is instant and costs no recompute. Off, every note renders in
	 * the default node colour with no regions or labels — which is the point, it's
	 * the before/after that shows what the clustering actually contributed.
	 */
	showTopics: boolean;
}

/**
 * Default graph settings.
 */
export const DEFAULT_SMART_GRAPH_SETTINGS: SmartGraphSettings = {
	// Layout defaults are tuned for the *fused* graph (wiki + semantic edges),
	// which is far denser than a wikilink-only one — most notes now have ~8 edges
	// instead of none. Obsidian's own values (linkDistance 250, charge -1000)
	// blow that apart into a ring of nodes with no visible grouping. Short links,
	// mild repulsion and strong cluster cohesion keep topics as compact blobs.
	// This is also why the user's native graph.json physics is deliberately not
	// imported: it was tuned against a wikilink-only graph.
	linkDistance: 60,
	chargeStrength: -120,
	centerStrength: 0.07,
	linkStrength: 1,
	clusterCohesionStrength: 0.45,
	showWikiLinks: true,
	showSemanticLinks: true,
	highlightSemanticLinks: false,
	linkOnlyTopics: false,
	semanticNeighborCount: 5,
	semanticThreshold: 0.55,
	directedWikiEdges: true,
	graphChatModel: null,
	autoLabelClusters: false,
	markdownOnly: false,
	showTags: false,
	leidenSeed: 42,
	// Granularity level 3 on the ladder in topicHierarchy.ts. Kept exactly on a rung so
	// the slider doesn't silently shift γ the first time it's touched.
	leidenResolution: 1.0,
	bridgeThreshold: 0.4,
	highlightIsolated: false,
	highlightBridges: false,
	showClusterLabels: true,
	showTopicHulls: true,
	showTopics: true,
};

export const THEME_COLOR_VARS = [
	"--color-red",
	"--color-blue",
	"--color-green",
	"--color-orange",
	"--color-purple",
	"--color-cyan",
	"--color-yellow",
	"--color-pink",
	"--interactive-accent",
] as const;

/**
 * Parse HSL components (h 0-360, s 0-100, l 0-100) from a CSS color string.
 * Supports hex, rgb(), and hsl() formats. Returns [0, 70, 55] as fallback.
 */
function parseHSL(color: string): [number, number, number] {
	const s = color.trim();

	// hsl(H, S%, L%)
	const hslMatch = /^hsla?\(\s*([\d.]+)[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?/i.exec(s);
	if (hslMatch) {
		return [
			Math.round(Number(hslMatch[1])) % 360,
			Math.round(Number(hslMatch[2])),
			Math.round(Number(hslMatch[3])),
		];
	}

	let r = 0;
	let g = 0;
	let b = 0;

	const hexMatch = /^#([\da-f]{3,8})$/i.exec(s);
	if (hexMatch) {
		let hex = hexMatch[1];
		if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
		r = Number.parseInt(hex.slice(0, 2), 16) / 255;
		g = Number.parseInt(hex.slice(2, 4), 16) / 255;
		b = Number.parseInt(hex.slice(4, 6), 16) / 255;
	} else {
		const rgbMatch = /^rgba?\(\s*([\d.]+)\s*[,/\s]\s*([\d.]+)\s*[,/\s]\s*([\d.]+)/i.exec(s);
		if (rgbMatch) {
			r = Number(rgbMatch[1]) / 255;
			g = Number(rgbMatch[2]) / 255;
			b = Number(rgbMatch[3]) / 255;
		} else {
			return [0, 70, 55];
		}
	}

	// RGB → HSL
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	const l = (max + min) / 2;
	if (d === 0) return [0, 0, Math.round(l * 100)];
	const sat = d / (1 - Math.abs(2 * l - 1));
	let h = 0;
	if (max === r) h = ((g - b) / d) % 6;
	else if (max === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	h = Math.round(h * 60);
	return [((h % 360) + 360) % 360, Math.round(sat * 100), Math.round(l * 100)];
}

/**
 * Generate `k` cluster colors from a set of theme base colors.
 */
export function generateClusterColors(k: number, themeColors: string[] = []): string[] {
	const base: [number, number, number][] =
		themeColors.length > 0
			? themeColors.map((c) => parseHSL(c))
			: Array.from(
					{ length: Math.max(k, 1) },
					(_, i) => [Math.round((i * 360) / Math.max(k, 1)) % 360, 70, 55] as [number, number, number],
				);

	const colors: string[] = [];
	const paletteSize = base.length;
	const HUE_SHIFT_PER_ROUND = 30;

	for (let i = 0; i < k; i++) {
		const baseIndex = i % paletteSize;
		const round = Math.floor(i / paletteSize);
		const [h, s, l] = base[baseIndex];
		const shiftedHue = (h + round * HUE_SHIFT_PER_ROUND) % 360;
		colors.push(`hsl(${shiftedHue}, ${s}%, ${l}%)`);
	}
	return colors;
}
