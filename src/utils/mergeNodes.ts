/**
 * Merge Nodes
 *
 * Collapses each topic into a single node so the graph can show how *topics*
 * relate to each other, not just how notes do.
 *
 * At note level a vault is hundreds of dots; the shape of the whole is hard to
 * read and topic-to-topic relationships aren't represented at all. Collapsing
 * replaces each topic with one node and rolls every note-level link between two
 * topics into one weighted edge, so "these two areas of my vault are tightly
 * coupled" becomes visible.
 *
 * Topics can be expanded individually, which is what makes the hierarchy
 * explorable: open the one you care about while the rest stay collapsed.
 *
 * Pure and free of Obsidian types so it can be unit tested.
 */

import type { GraphData, GraphEdge, GraphNode } from "../types/graph";
import { edgeKey, isTagNode } from "./graphUtils";

/** Stable id for a collapsed topic — must not collide with any vault path. */
export function topicNodeId(cluster: number): string {
	return `topic:${cluster}`;
}

/**
 * Sentinel cluster id for notes that belong to no topic.
 *
 * Negative so it can never collide with a real Leiden community id, which lets
 * unsorted notes travel through the same collapse/expand machinery as any topic
 * instead of needing a parallel code path.
 */
export const UNSORTED_CLUSTER = -1;

export interface CollapseOptions {
	/**
	 * Topic ids to fold into a single node. Anything absent renders as its notes.
	 *
	 * Expressed as the *collapsed* set (rather than the expanded one) because
	 * collapse is per-topic: the user folds individual topics, and "collapse all"
	 * is simply every id at once.
	 */
	collapsedTopics?: Set<number>;
	/** Topic id → display name, so a collapsed node can be labelled. */
	topicLabels?: Record<number, string>;
	/**
	 * Fold notes with no topic into a single "Unsorted" node.
	 *
	 * In the merged view an unclustered note is visually indistinguishable from a
	 * topic node, which breaks the view's premise that every circle is a group.
	 * Folding them keeps the overview to one object per group while preserving
	 * the signal — the node is expandable like any other.
	 */
	collapseUnsorted?: boolean;
	/** Colour for the unsorted node; falls back to whatever the notes carry. */
	unsortedColor?: string;
}

/**
 * Build a graph where each collapsed topic is a single node.
 *
 * Nodes with no topic assignment always pass through as themselves — an
 * unclustered note has no group to be folded into. Tag nodes pass through
 * too, even with `collapseUnsorted`: the unsorted bubble is "notes that found
 * no topic", and a tag was never a candidate for one.
 *
 * Edge remapping resolves each endpoint to either its own note (expanded, or
 * unclustered) or its topic node (collapsed), then:
 * - drops edges whose endpoints resolve to the *same* node (links inside one
 *   collapsed topic are internal detail, not a relationship between topics)
 * - merges parallel edges, summing weight — so a thick edge means many
 *   note-level links cross between those two topics
 *
 * The same pass naturally produces all three cases: topic↔topic, note↔note, and
 * note↔topic where an expanded topic sits beside collapsed ones.
 */
export function buildCollapsedGraph(graph: GraphData, options: CollapseOptions = {}): GraphData {
	const collapsedTopics = options.collapsedTopics ?? new Set<number>();
	const topicLabels = options.topicLabels ?? {};
	const collapseUnsorted = options.collapseUnsorted ?? false;

	// Group the notes that will be folded away, keyed by topic. Unsorted notes get
	// the UNSORTED_CLUSTER sentinel so they flow through the same machinery, and
	// are folded whenever `collapseUnsorted` is on and the caller hasn't expanded
	// that group — identical rules to any real topic.
	const membersByTopic = new Map<number, GraphNode[]>();
	for (const node of graph.nodes) {
		if (isTagNode(node)) continue;
		const group = node.cluster ?? UNSORTED_CLUSTER;
		const shouldFold =
			group === UNSORTED_CLUSTER
				? collapseUnsorted && collapsedTopics.has(UNSORTED_CLUSTER)
				: collapsedTopics.has(group);
		if (!shouldFold) continue;
		const list = membersByTopic.get(group);
		if (list) list.push(node);
		else membersByTopic.set(group, [node]);
	}

	// Nothing is collapsed — hand back the original graph untouched.
	if (membersByTopic.size === 0) return graph;

	// Normalizer for topic radii: the member count of the largest topic in the
	// whole segmentation, folded or not. Counting only the collapsed set would
	// make every remaining bubble jump in size the moment the biggest topic is
	// expanded. Unsorted notes count only when they can be folded into a bubble
	// of their own — otherwise they are loose notes, not a topic.
	const sizeByTopic = new Map<number, number>();
	for (const node of graph.nodes) {
		if (isTagNode(node)) continue;
		const group = node.cluster ?? UNSORTED_CLUSTER;
		if (group === UNSORTED_CLUSTER && !collapseUnsorted) continue;
		sizeByTopic.set(group, (sizeByTopic.get(group) ?? 0) + 1);
	}
	const largestTopicSize = Math.max(0, ...sizeByTopic.values());

	/** Resolve a node id to whatever represents it in the collapsed graph. */
	const representativeOf = new Map<string, string>();
	for (const [cluster, members] of membersByTopic) {
		const id = topicNodeId(cluster);
		for (const member of members) representativeOf.set(member.id, id);
	}

	// Surviving nodes: notes in expanded topics or with no topic at all, and
	// every tag node.
	const nodes: GraphNode[] = graph.nodes
		.filter((node) => !representativeOf.has(node.id))
		.map((node) => ({ ...node, kind: node.kind ?? ("note" as const) }));

	// Merge edges by their resolved endpoints.
	const merged = new Map<string, GraphEdge>();
	const crossingCount = new Map<string, number>();
	for (const edge of graph.edges) {
		const source = representativeOf.get(edge.source) ?? edge.source;
		const target = representativeOf.get(edge.target) ?? edge.target;
		// Internal to a single collapsed topic — not a relationship between nodes.
		if (source === target) continue;

		// Track how many note-level links each collapsed topic sends outward, so
		// the tooltip can report how connected it actually is. A tag edge is the
		// topic's notes carrying a tag, not a link to another note, so it's drawn
		// but not counted.
		if (edge.type !== "tag") {
			if (source.startsWith("topic:")) crossingCount.set(source, (crossingCount.get(source) ?? 0) + 1);
			if (target.startsWith("topic:")) crossingCount.set(target, (crossingCount.get(target) ?? 0) + 1);
		}

		// Keep wiki and semantic edges distinct so the renderer can still tell an
		// authored connection from an inferred one.
		const key = `${edge.type}:${edgeKey(source, target)}`;
		const existing = merged.get(key);
		if (existing) {
			existing.weight += edge.weight;
		} else {
			merged.set(key, { source, target, weight: edge.weight, type: edge.type });
		}
	}

	// Build the synthetic nodes, seeded at their members' centroid so the layout
	// starts where the topic already was rather than jumping across the canvas.
	//
	// Members that were never positioned (a graph that hasn't laid out yet) are
	// excluded from the average — counting them would drag every topic toward
	// (0,0), collapsing the whole graph onto a single point and leaving the
	// camera with zero-size bounds to fit.
	for (const [cluster, members] of [...membersByTopic.entries()].sort((a, b) => a[0] - b[0])) {
		const id = topicNodeId(cluster);
		let x = 0;
		let y = 0;
		let positioned = 0;
		for (const member of members) {
			if (!Number.isFinite(member.x) || !Number.isFinite(member.y)) continue;
			if (member.x === 0 && member.y === 0) continue;
			x += member.x;
			y += member.y;
			positioned++;
		}

		const isUnsorted = cluster === UNSORTED_CLUSTER;
		nodes.push({
			id,
			path: id,
			// The unsorted node states its size, since "how many notes never found a
			// topic" is the finding it exists to surface.
			label: isUnsorted ? `Unsorted · ${members.length}` : (topicLabels[cluster] ?? `Topic ${cluster}`),
			// Leave unpositioned topics at the origin sentinel so the canvas's own
			// circle pre-layout scatters them instead.
			x: positioned > 0 ? x / positioned : 0,
			y: positioned > 0 ? y / positioned : 0,
			cluster,
			color: isUnsorted ? (options.unsortedColor ?? members[0]?.color) : members[0]?.color,
			// `degree` stays the crossing-link count — it feeds the tooltip's
			// "N links" line. Radius comes from `memberPaths` instead (see
			// nodeDrawRadius): size says how many notes the topic holds, while
			// connectivity is carried by the rolled-up edge widths.
			degree: crossingCount.get(id) ?? 0,
			highlighted: false,
			kind: "topic",
			memberPaths: members.map((member) => member.path),
			largestTopicSize,
		});
	}

	return { nodes, edges: [...merged.values()] };
}

/**
 * Note paths a node stands for — itself for a note, its members for a topic,
 * none for a tag. Lets selection hand real vault paths to chat even when
 * topics are collapsed.
 */
export function resolveNodePaths(node: GraphNode): string[] {
	if (node.kind === "topic") return node.memberPaths ?? [];
	if (isTagNode(node)) return [];
	return [node.path];
}
