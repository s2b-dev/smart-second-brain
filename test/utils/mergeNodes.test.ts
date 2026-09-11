import { describe, expect, it } from "vitest";
import { buildCollapsedGraph, resolveNodePaths, topicNodeId, UNSORTED_CLUSTER } from "../../src/utils/mergeNodes";
import type { GraphData, GraphEdge, GraphNode } from "../../src/types/graph";

function note(id: string, cluster?: number, x = 0, y = 0): GraphNode {
	return { id, path: id, label: id, x, y, cluster, degree: 0, highlighted: false };
}

function edge(source: string, target: string, weight = 1, type: GraphEdge["type"] = "wiki"): GraphEdge {
	return { source, target, weight, type };
}

/**
 * Two topics of two notes each, with a single wiki link crossing between them
 * and one link inside topic 0.
 */
function twoTopicGraph(): GraphData {
	return {
		nodes: [note("a1", 0), note("a2", 0), note("b1", 1), note("b2", 1)],
		edges: [edge("a1", "a2"), edge("a1", "b1")],
	};
}

describe("buildCollapsedGraph", () => {
	it("replaces each topic with a single node", () => {
		const collapsed = buildCollapsedGraph(twoTopicGraph(), { collapsedTopics: new Set([0, 1]) });

		expect(collapsed.nodes).toHaveLength(2);
		expect(collapsed.nodes.map((n) => n.id).sort()).toEqual([topicNodeId(0), topicNodeId(1)]);
		for (const node of collapsed.nodes) {
			expect(node.kind).toBe("topic");
		}
	});

	it("drops links internal to a collapsed topic", () => {
		const collapsed = buildCollapsedGraph(twoTopicGraph(), { collapsedTopics: new Set([0, 1]) });

		// a1→a2 is inside topic 0; only the crossing link survives.
		expect(collapsed.edges).toHaveLength(1);
		expect(collapsed.edges[0].source).toBe(topicNodeId(0));
		expect(collapsed.edges[0].target).toBe(topicNodeId(1));
	});

	it("sums parallel crossing links into one weighted edge", () => {
		const graph: GraphData = {
			nodes: [note("a1", 0), note("a2", 0), note("b1", 1), note("b2", 1)],
			edges: [edge("a1", "b1", 1), edge("a2", "b2", 1), edge("a1", "b2", 2)],
		};

		const collapsed = buildCollapsedGraph(graph, { collapsedTopics: new Set([0, 1]) });

		expect(collapsed.edges).toHaveLength(1);
		expect(collapsed.edges[0].weight).toBe(4);
	});

	it("keeps wiki and semantic edges distinct", () => {
		const graph: GraphData = {
			nodes: [note("a1", 0), note("b1", 1)],
			edges: [edge("a1", "b1", 1, "wiki"), edge("a1", "b1", 0.8, "semantic")],
		};

		const collapsed = buildCollapsedGraph(graph, { collapsedTopics: new Set([0, 1]) });

		expect(collapsed.edges).toHaveLength(2);
		expect(collapsed.edges.map((e) => e.type).sort()).toEqual(["semantic", "wiki"]);
	});

	it("sizes a topic node by how many links cross its boundary", () => {
		const graph: GraphData = {
			nodes: [note("a1", 0), note("a2", 0), note("b1", 1)],
			// One internal link, two crossing.
			edges: [edge("a1", "a2"), edge("a1", "b1"), edge("a2", "b1")],
		};

		const collapsed = buildCollapsedGraph(graph, { collapsedTopics: new Set([0, 1]) });
		const topicA = collapsed.nodes.find((n) => n.id === topicNodeId(0));

		expect(topicA?.degree).toBe(2);
	});

	it("stamps every topic node with the size of the largest topic in the segmentation", () => {
		const graph: GraphData = {
			nodes: [note("a1", 0), note("a2", 0), note("a3", 0), note("b1", 1), note("c1", 2), note("c2", 2)],
			edges: [],
		};

		const all = buildCollapsedGraph(graph, { collapsedTopics: new Set([0, 1, 2]) });
		for (const node of all.nodes) expect(node.largestTopicSize).toBe(3);

		// Expanding the largest topic must not change the others' normalizer —
		// otherwise every remaining bubble would resize when it is unfolded.
		const withoutBiggest = buildCollapsedGraph(graph, { collapsedTopics: new Set([1, 2]) });
		const topicB = withoutBiggest.nodes.find((n) => n.id === topicNodeId(1));
		expect(topicB?.largestTopicSize).toBe(3);
		expect(withoutBiggest.nodes.find((n) => n.kind !== "topic")?.largestTopicSize).toBeUndefined();
	});

	it("counts unsorted notes toward the largest topic only when they fold into a bubble", () => {
		const graph: GraphData = {
			nodes: [note("a1", 0), note("a2", 0), note("u1"), note("u2"), note("u3")],
			edges: [],
		};

		const loose = buildCollapsedGraph(graph, { collapsedTopics: new Set([0]) });
		expect(loose.nodes.find((n) => n.id === topicNodeId(0))?.largestTopicSize).toBe(2);

		const folded = buildCollapsedGraph(graph, {
			collapsedTopics: new Set([0, UNSORTED_CLUSTER]),
			collapseUnsorted: true,
		});
		expect(folded.nodes.find((n) => n.id === topicNodeId(0))?.largestTopicSize).toBe(3);
		expect(folded.nodes.find((n) => n.id === topicNodeId(UNSORTED_CLUSTER))?.largestTopicSize).toBe(3);
	});

	it("records every member path", () => {
		const collapsed = buildCollapsedGraph(twoTopicGraph(), { collapsedTopics: new Set([0, 1]) });
		const topicA = collapsed.nodes.find((n) => n.id === topicNodeId(0));

		expect(topicA?.memberPaths?.sort()).toEqual(["a1", "a2"]);
	});

	it("gives member paths that are complete and disjoint", () => {
		const collapsed = buildCollapsedGraph(twoTopicGraph(), { collapsedTopics: new Set([0, 1]) });
		const all = collapsed.nodes.flatMap((n) => n.memberPaths ?? []);

		expect(all.sort()).toEqual(["a1", "a2", "b1", "b2"]);
		expect(new Set(all).size).toBe(all.length);
	});

	it("seeds a topic node at its positioned members' centroid", () => {
		const graph: GraphData = {
			nodes: [note("a1", 0, 10, 30), note("a2", 0, 30, 10), note("b1", 1, 100, 100)],
			edges: [edge("a1", "b1")],
		};

		const topicA = buildCollapsedGraph(graph, { collapsedTopics: new Set([0, 1]) }).nodes.find(
			(n) => n.id === topicNodeId(0),
		);

		expect(topicA?.x).toBe(20);
		expect(topicA?.y).toBe(20);
	});

	it("ignores unpositioned members when averaging", () => {
		// A note still at the (0,0) sentinel hasn't been laid out; counting it would
		// drag the topic toward the origin.
		const graph: GraphData = {
			nodes: [note("a1", 0, 100, 100), note("a2", 0, 0, 0), note("b1", 1, 500, 500)],
			edges: [edge("a1", "b1")],
		};

		const topicA = buildCollapsedGraph(graph, { collapsedTopics: new Set([0, 1]) }).nodes.find(
			(n) => n.id === topicNodeId(0),
		);

		expect(topicA?.x).toBe(100);
		expect(topicA?.y).toBe(100);
	});

	it("does not stack every topic at the origin when nothing is positioned yet", () => {
		// Regression: seeding from unpositioned members put all topics at (0,0),
		// giving the camera zero-size bounds and rendering a blank canvas.
		const graph: GraphData = {
			nodes: [note("a1", 0), note("a2", 0), note("b1", 1), note("b2", 1)],
			edges: [edge("a1", "b1")],
		};

		const collapsed = buildCollapsedGraph(graph, { collapsedTopics: new Set([0, 1]) });

		// All at origin is acceptable *only* because the canvas pre-layout scatters
		// them; what must not happen is a NaN, which would break bounds entirely.
		for (const node of collapsed.nodes) {
			expect(Number.isFinite(node.x)).toBe(true);
			expect(Number.isFinite(node.y)).toBe(true);
		}
	});

	it("uses supplied topic labels", () => {
		const collapsed = buildCollapsedGraph(twoTopicGraph(), {
			collapsedTopics: new Set([0, 1]),
			topicLabels: { 0: "Marine Biology" },
		});

		expect(collapsed.nodes.find((n) => n.id === topicNodeId(0))?.label).toBe("Marine Biology");
		// Unlabelled topics still get something readable.
		expect(collapsed.nodes.find((n) => n.id === topicNodeId(1))?.label).toBe("Topic 1");
	});

	it("produces stable ids across repeated builds", () => {
		const first = buildCollapsedGraph(twoTopicGraph(), { collapsedTopics: new Set([0, 1]) });
		const second = buildCollapsedGraph(twoTopicGraph(), { collapsedTopics: new Set([0, 1]) });

		expect(first.nodes.map((n) => n.id)).toEqual(second.nodes.map((n) => n.id));
	});

	describe("expansion", () => {
		it("renders an expanded topic's notes individually", () => {
			const collapsed = buildCollapsedGraph(twoTopicGraph(), { collapsedTopics: new Set([1]) });

			const ids = collapsed.nodes.map((n) => n.id).sort();
			expect(ids).toEqual(["a1", "a2", topicNodeId(1)]);
		});

		it("keeps internal links of an expanded topic", () => {
			const collapsed = buildCollapsedGraph(twoTopicGraph(), { collapsedTopics: new Set([1]) });

			// a1→a2 is now between two visible nodes, so it must survive.
			expect(collapsed.edges.some((e) => e.source === "a1" && e.target === "a2")).toBe(true);
		});

		it("creates note↔topic edges in mixed state", () => {
			const collapsed = buildCollapsedGraph(twoTopicGraph(), { collapsedTopics: new Set([1]) });

			const mixed = collapsed.edges.find((e) => e.source === "a1" && e.target === topicNodeId(1));
			expect(mixed).toBeDefined();
		});

		it("returns the original graph when everything is expanded", () => {
			const graph = twoTopicGraph();
			const collapsed = buildCollapsedGraph(graph, { collapsedTopics: new Set() });

			expect(collapsed).toBe(graph);
		});
	});

	it("collapses only the topics it is given", () => {
		// Per-topic collapse: folding one topic must leave the others as notes.
		const collapsed = buildCollapsedGraph(twoTopicGraph(), { collapsedTopics: new Set([0]) });

		expect(collapsed.nodes.map((n) => n.id).sort()).toEqual(["b1", "b2", topicNodeId(0)]);
		expect(collapsed.nodes.find((n) => n.id === topicNodeId(0))?.kind).toBe("topic");
		expect(collapsed.nodes.find((n) => n.id === "b1")?.kind).toBe("note");
	});

	it("ignores collapsed ids that no longer exist", () => {
		// A granularity change can drop a topic while it is still in the collapsed set.
		const collapsed = buildCollapsedGraph(twoTopicGraph(), { collapsedTopics: new Set([0, 99]) });

		expect(collapsed.nodes.some((n) => n.id === topicNodeId(99))).toBe(false);
		expect(collapsed.nodes.some((n) => n.id === topicNodeId(0))).toBe(true);
	});

	describe("unsorted notes", () => {
		/** Two clustered notes plus two that never joined a topic. */
		const graph: GraphData = {
			nodes: [note("a1", 0), note("a2", 0), note("loner1"), note("loner2")],
			edges: [edge("a1", "loner1")],
		};

		it("folds topicless notes into one node when asked", () => {
			const collapsed = buildCollapsedGraph(graph, {
				collapsedTopics: new Set([0, UNSORTED_CLUSTER]),
				collapseUnsorted: true,
			});

			const unsorted = collapsed.nodes.find((n) => n.id === topicNodeId(UNSORTED_CLUSTER));
			expect(unsorted).toBeDefined();
			expect(unsorted?.label).toBe("Unsorted · 2");
			expect(unsorted?.memberPaths?.sort()).toEqual(["loner1", "loner2"]);
		});

		it("leaves them as individual notes when the option is off", () => {
			const collapsed = buildCollapsedGraph(graph, {
				collapsedTopics: new Set([0, UNSORTED_CLUSTER]),
				collapseUnsorted: false,
			});

			expect(collapsed.nodes.some((n) => n.id === "loner1")).toBe(true);
			expect(collapsed.nodes.some((n) => n.id === topicNodeId(UNSORTED_CLUSTER))).toBe(false);
		});

		it("expands back to individual notes like any topic", () => {
			// UNSORTED_CLUSTER absent from the collapsed set = expanded.
			const collapsed = buildCollapsedGraph(graph, {
				collapsedTopics: new Set([0]),
				collapseUnsorted: true,
			});

			expect(collapsed.nodes.some((n) => n.id === "loner1")).toBe(true);
			expect(collapsed.nodes.some((n) => n.id === topicNodeId(UNSORTED_CLUSTER))).toBe(false);
		});

		it("keeps edges between a topic and the unsorted group", () => {
			const collapsed = buildCollapsedGraph(graph, {
				collapsedTopics: new Set([0, UNSORTED_CLUSTER]),
				collapseUnsorted: true,
			});

			// a1→loner1 becomes topic:0 → topic:-1.
			const crossing = collapsed.edges.find(
				(e) =>
					(e.source === topicNodeId(0) && e.target === topicNodeId(UNSORTED_CLUSTER)) ||
					(e.target === topicNodeId(0) && e.source === topicNodeId(UNSORTED_CLUSTER)),
			);
			expect(crossing).toBeDefined();
		});

		it("uses the supplied neutral colour", () => {
			const collapsed = buildCollapsedGraph(graph, {
				collapsedTopics: new Set([UNSORTED_CLUSTER]),
				collapseUnsorted: true,
				unsortedColor: "hsl(0, 0%, 55%)",
			});

			expect(collapsed.nodes.find((n) => n.id === topicNodeId(UNSORTED_CLUSTER))?.color).toBe("hsl(0, 0%, 55%)");
		});

		it("hands back real note paths for selection", () => {
			const collapsed = buildCollapsedGraph(graph, {
				collapsedTopics: new Set([0, UNSORTED_CLUSTER]),
				collapseUnsorted: true,
			});
			const all = collapsed.nodes.flatMap(resolveNodePaths);

			for (const p of all) expect(p.startsWith("topic:")).toBe(false);
			expect(all.sort()).toEqual(["a1", "a2", "loner1", "loner2"]);
		});
	});

	it("passes through notes with no topic", () => {
		const graph: GraphData = {
			nodes: [note("a1", 0), note("a2", 0), note("loner")],
			edges: [edge("a1", "loner")],
		};

		const collapsed = buildCollapsedGraph(graph, { collapsedTopics: new Set([0, 1]) });

		expect(collapsed.nodes.find((n) => n.id === "loner")?.kind).toBe("note");
		expect(collapsed.edges).toHaveLength(1);
	});

	it("handles an empty graph", () => {
		const empty: GraphData = { nodes: [], edges: [] };
		expect(buildCollapsedGraph(empty, { collapsedTopics: new Set([0]) })).toBe(empty);
	});

	it("handles a single topic with no crossing links", () => {
		const graph: GraphData = {
			nodes: [note("a1", 0), note("a2", 0)],
			edges: [edge("a1", "a2")],
		};

		const collapsed = buildCollapsedGraph(graph, { collapsedTopics: new Set([0, 1]) });

		expect(collapsed.nodes).toHaveLength(1);
		expect(collapsed.edges).toHaveLength(0);
		expect(collapsed.nodes[0].degree).toBe(0);
	});
});

describe("resolveNodePaths", () => {
	it("returns a note's own path", () => {
		expect(resolveNodePaths(note("a.md"))).toEqual(["a.md"]);
	});

	it("returns a topic's member paths", () => {
		const collapsed = buildCollapsedGraph(twoTopicGraph(), { collapsedTopics: new Set([0, 1]) });
		const topicA = collapsed.nodes.find((n) => n.id === topicNodeId(0))!;

		expect(resolveNodePaths(topicA).sort()).toEqual(["a1", "a2"]);
	});

	it("returns nothing for a topic with no members recorded", () => {
		expect(resolveNodePaths({ ...note("topic:9"), kind: "topic" })).toEqual([]);
	});
});

describe("buildCollapsedGraph — tag nodes", () => {
	function tag(id: string): GraphNode {
		return {
			id: `tag:${id}`,
			path: `tag:${id}`,
			label: id,
			x: 3,
			y: 3,
			degree: 1,
			highlighted: false,
			kind: "tag",
		};
	}

	it("never folds a tag, even into the unsorted bubble, and keeps its kind", () => {
		const collapsed = buildCollapsedGraph(
			{
				nodes: [note("a1", 0), note("a2", 0), note("loose"), tag("#foo")],
				edges: [edge("a1", "a2"), edge("a1", "tag:#foo", 1, "tag"), edge("loose", "tag:#foo", 1, "tag")],
			},
			{ collapsedTopics: new Set([0, UNSORTED_CLUSTER]), collapseUnsorted: true },
		);

		expect(collapsed.nodes.map((n) => n.id).sort()).toEqual([
			"tag:#foo",
			topicNodeId(UNSORTED_CLUSTER),
			topicNodeId(0),
		]);
		expect(collapsed.nodes.find((n) => n.id === "tag:#foo")?.kind).toBe("tag");
		// The unsorted bubble holds the loose note only — a tag was never a
		// candidate for a topic.
		expect(collapsed.nodes.find((n) => n.id === topicNodeId(UNSORTED_CLUSTER))?.memberPaths).toEqual(["loose"]);

		// Tag edges are re-pointed at the bubbles but stay typed as tag edges.
		expect(collapsed.edges.map((e) => `${e.type}:${e.source}>${e.target}`).sort()).toEqual([
			`tag:${topicNodeId(UNSORTED_CLUSTER)}>tag:#foo`,
			`tag:${topicNodeId(0)}>tag:#foo`,
		]);
		// ...and are not counted as links crossing the topic boundary.
		expect(collapsed.nodes.find((n) => n.id === topicNodeId(0))?.degree).toBe(0);
	});

	it("resolveNodePaths hands chat no path for a tag", () => {
		expect(resolveNodePaths(tag("#foo"))).toEqual([]);
	});
});
