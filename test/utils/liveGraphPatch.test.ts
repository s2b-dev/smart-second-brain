import { describe, expect, it } from "vitest";
import type { GraphData, GraphEdge, GraphNode } from "../../src/types/graph";
import {
	applyWikiPatch,
	queryNoteSemanticEdges,
	replaceSemanticEdgesForPaths,
	voteNodeCommunity,
	type SemanticQueryStore,
} from "../../src/utils/liveGraphPatch";
import type { DocumentVector, ScoredDocument } from "../../src/vectorstore/types";

function node(path: string, extra: Partial<GraphNode> = {}): GraphNode {
	return { id: path, path, label: path.replace(/\.md$/, ""), x: 0, y: 0, degree: 0, highlighted: false, ...extra };
}

function wiki(source: string, target: string, weight = 1): GraphEdge {
	return { source, target, weight, type: "wiki" };
}

function semantic(source: string, target: string, weight = 0.8): GraphEdge {
	return { source, target, weight, type: "semantic" };
}

function graph(nodes: GraphNode[], edges: GraphEdge[]): GraphData {
	return { nodes, edges };
}

describe("applyWikiPatch", () => {
	const current = () =>
		graph(
			[
				node("a.md", { cluster: 0, color: "red", degree: 2 }),
				node("b.md", { cluster: 0, color: "red", degree: 2 }),
				node("c.md", { cluster: 1, color: "blue", degree: 1 }),
			],
			[wiki("a.md", "b.md"), semantic("a.md", "c.md"), semantic("b.md", "a.md", 0.7)],
		);

	it("reports no change for an identical wiki structure", () => {
		const cur = current();
		const fresh = graph([node("a.md"), node("b.md"), node("c.md")], [wiki("a.md", "b.md")]);
		const patch = applyWikiPatch(cur, fresh);
		expect(patch.changed).toBe(false);
		// Same object back, so callers can no-op on identity.
		expect(patch.data).toBe(cur);
		expect(patch.addedPaths).toEqual([]);
		expect(patch.touchedPaths).toEqual([]);
	});

	it("adds new nodes and keeps surviving presentation state", () => {
		const fresh = graph(
			[node("a.md"), node("b.md"), node("c.md"), node("d.md")],
			[wiki("a.md", "b.md"), wiki("c.md", "d.md")],
		);
		const patch = applyWikiPatch(current(), fresh);
		expect(patch.changed).toBe(true);
		expect(patch.addedPaths).toEqual(["d.md"]);
		expect(patch.removedPaths).toEqual([]);
		const a = patch.data.nodes.find((n) => n.path === "a.md");
		expect(a?.cluster).toBe(0);
		expect(a?.color).toBe("red");
		// Semantic edges survive the wiki swap.
		expect(patch.data.edges.filter((e) => e.type === "semantic")).toHaveLength(2);
	});

	it("removes deleted nodes along with their semantic edges", () => {
		const fresh = graph([node("a.md"), node("b.md")], [wiki("a.md", "b.md")]);
		const patch = applyWikiPatch(current(), fresh);
		expect(patch.removedPaths).toEqual(["c.md"]);
		expect(patch.data.edges.filter((e) => e.type === "semantic")).toEqual([semantic("b.md", "a.md", 0.7)]);
	});

	it("drops a semantic edge superseded by a newly authored link", () => {
		const fresh = graph([node("a.md"), node("b.md"), node("c.md")], [wiki("a.md", "b.md"), wiki("c.md", "a.md")]);
		const patch = applyWikiPatch(current(), fresh);
		const keys = patch.data.edges.map((e) => `${e.type}:${[e.source, e.target].sort().join("|")}`);
		expect(keys).toContain("wiki:a.md|c.md");
		expect(keys).not.toContain("semantic:a.md|c.md");
	});

	it("marks endpoints of changed wiki edges as touched, excluding added/removed nodes", () => {
		const fresh = graph(
			[node("a.md"), node("b.md"), node("c.md"), node("d.md")],
			[wiki("a.md", "b.md", 3), wiki("c.md", "d.md")],
		);
		const patch = applyWikiPatch(current(), fresh);
		// a↔b changed weight, c gained an edge to the new node d.
		expect([...patch.touchedPaths].sort()).toEqual(["a.md", "b.md", "c.md"]);
	});

	it("recomputes degrees over the fused edge set", () => {
		const fresh = graph([node("a.md"), node("b.md"), node("c.md")], [wiki("a.md", "b.md")]);
		const withNewLink = graph(
			[node("a.md"), node("b.md"), node("c.md")],
			[wiki("a.md", "b.md"), wiki("b.md", "c.md")],
		);
		const patch = applyWikiPatch(applyWikiPatch(current(), fresh).data, withNewLink);
		const b = patch.data.nodes.find((n) => n.path === "b.md");
		// b: wiki a–b, wiki b–c, semantic b–a → 3
		expect(b?.degree).toBe(3);
	});
});

describe("replaceSemanticEdgesForPaths", () => {
	const base = () =>
		graph(
			[node("a.md"), node("b.md"), node("c.md")],
			[wiki("a.md", "b.md"), semantic("a.md", "c.md", 0.8), semantic("b.md", "c.md", 0.7)],
		);

	it("replaces only the edges incident to the given paths", () => {
		const { data, changed } = replaceSemanticEdgesForPaths(base(), new Set(["a.md"]), [
			semantic("a.md", "b.md", 0.9),
		]);
		expect(changed).toBe(true);
		const semantics = data.edges.filter((e) => e.type === "semantic");
		expect(semantics).toHaveLength(2);
		expect(semantics.map((e) => `${e.source}->${e.target}`).sort()).toEqual(["a.md->b.md", "b.md->c.md"]);
	});

	it("reports no change when the re-query reproduces the same edges", () => {
		const { changed } = replaceSemanticEdgesForPaths(base(), new Set(["a.md"]), [semantic("a.md", "c.md", 0.8)]);
		expect(changed).toBe(false);
	});

	it("ignores new edges whose endpoint is off-graph, and self-loops", () => {
		const { data } = replaceSemanticEdgesForPaths(base(), new Set(["a.md"]), [
			semantic("a.md", "missing.md", 0.9),
			semantic("a.md", "a.md", 0.9),
		]);
		expect(data.edges.filter((e) => e.type === "semantic")).toHaveLength(1);
	});

	it("never emits two semantic edges for the same pair", () => {
		// Both orderings of the same pair — only one edge may survive.
		const { data } = replaceSemanticEdgesForPaths(base(), new Set(["a.md"]), [
			semantic("a.md", "c.md", 0.9),
			semantic("c.md", "a.md", 0.85),
		]);
		const semantics = data.edges.filter((e) => e.type === "semantic");
		expect(semantics.filter((e) => [e.source, e.target].sort().join("|") === "a.md|c.md")).toHaveLength(1);
	});

	it("keeps a semantic edge for a pair that also has a wiki link", () => {
		// Suppressing wiki-linked pairs is the query's job (`excludeEdgeKeys`);
		// re-applying it here would erode the edge set on every patch, since a
		// pair can legitimately carry both types.
		const { data } = replaceSemanticEdgesForPaths(base(), new Set(["a.md"]), [semantic("b.md", "a.md", 0.9)]);
		const keys = data.edges.map((e) => `${e.type}:${[e.source, e.target].sort().join("|")}`);
		expect(keys).toContain("wiki:a.md|b.md");
		expect(keys).toContain("semantic:a.md|b.md");
	});
});

describe("voteNodeCommunity", () => {
	const communities = { "a.md": 0, "b.md": 0, "c.md": 1 };
	const weightOf = (edge: GraphEdge) => edge.weight;

	it("picks the community with the largest summed edge weight", () => {
		const edges = [wiki("x.md", "a.md", 1), wiki("x.md", "b.md", 1), wiki("x.md", "c.md", 1)];
		expect(voteNodeCommunity("x.md", edges, communities, weightOf)).toBe(0);
	});

	it("lets one heavy edge outvote several light ones", () => {
		const edges = [wiki("x.md", "a.md", 1), wiki("x.md", "b.md", 1), wiki("x.md", "c.md", 5)];
		expect(voteNodeCommunity("x.md", edges, communities, weightOf)).toBe(1);
	});

	it("returns undefined when no neighbour carries a community", () => {
		const edges = [wiki("x.md", "unassigned.md", 1)];
		expect(voteNodeCommunity("x.md", edges, communities, weightOf)).toBeUndefined();
		expect(voteNodeCommunity("x.md", [], communities, weightOf)).toBeUndefined();
	});

	it("ignores edges not incident to the node", () => {
		const edges = [wiki("a.md", "b.md", 10), wiki("x.md", "c.md", 1)];
		expect(voteNodeCommunity("x.md", edges, communities, weightOf)).toBe(1);
	});
});

describe("queryNoteSemanticEdges", () => {
	const chunk = (path: string, chunkIndex = 0): DocumentVector => ({
		id: `${path}#${chunkIndex}`,
		path,
		mtime: 0,
		checksum: "",
		vector: new Float32Array([1, 0]),
		chunkIndex,
	});

	function fakeStore(chunks: DocumentVector[], hitsByChunkId: Record<string, ScoredDocument[]>): SemanticQueryStore {
		return {
			getAllByPath: async (path) => chunks.filter((c) => c.path === path),
			search: async () => Object.values(hitsByChunkId).flat(),
		};
	}

	const hit = (path: string, score: number): ScoredDocument => ({ doc: chunk(path), score });

	it("emits the best hit per neighbour, capped at neighborCount", async () => {
		const store = fakeStore([chunk("x.md")], {
			all: [hit("a.md", 0.9), hit("a.md", 0.7), hit("b.md", 0.8), hit("c.md", 0.6)],
		});
		const edges = await queryNoteSemanticEdges(store, "x.md", new Set(["x.md", "a.md", "b.md", "c.md"]), {
			neighborCount: 2,
			threshold: 0.55,
		});
		expect(edges).toEqual([
			{ source: "x.md", target: "a.md", weight: 0.9, type: "semantic" },
			{ source: "x.md", target: "b.md", weight: 0.8, type: "semantic" },
		]);
	});

	it("filters self hits, off-graph notes, sub-threshold scores and wiki pairs", async () => {
		const store = fakeStore([chunk("x.md")], {
			all: [hit("x.md", 1), hit("off.md", 0.9), hit("a.md", 0.4), hit("b.md", 0.8)],
		});
		const edges = await queryNoteSemanticEdges(store, "x.md", new Set(["x.md", "a.md", "b.md"]), {
			neighborCount: 5,
			threshold: 0.55,
			excludeEdgeKeys: new Set(["b.md\0x.md"]),
		});
		expect(edges).toEqual([]);
	});

	it("returns nothing when the note has no stored chunks", async () => {
		const store = fakeStore([], { all: [hit("a.md", 0.9)] });
		const edges = await queryNoteSemanticEdges(store, "x.md", new Set(["x.md", "a.md"]), {
			neighborCount: 5,
			threshold: 0.55,
		});
		expect(edges).toEqual([]);
	});
});

describe("applyWikiPatch — tag layer", () => {
	const tagNode = (tag: string): GraphNode => ({
		id: `tag:${tag}`,
		path: `tag:${tag}`,
		label: tag,
		x: 5,
		y: 5,
		degree: 1,
		highlighted: false,
		kind: "tag",
	});
	const tagEdge = (source: string, tag: string): GraphEdge => ({
		source,
		target: `tag:${tag}`,
		weight: 1,
		type: "tag",
	});

	it("reports no change when the tag layer is identical", () => {
		const cur = graph(
			[node("a.md", { cluster: 0 }), node("b.md", { cluster: 0 }), tagNode("#foo")],
			[wiki("a.md", "b.md"), tagEdge("a.md", "#foo"), semantic("a.md", "b.md")],
		);
		const fresh = graph(
			[node("a.md"), node("b.md"), tagNode("#foo")],
			[wiki("a.md", "b.md"), tagEdge("a.md", "#foo")],
		);

		const result = applyWikiPatch(cur, fresh);
		expect(result.changed).toBe(false);
		expect(result.data).toBe(cur);
	});

	it("counts a tag change as structural but never reports tag nodes as note paths", () => {
		const cur = graph([node("a.md", { cluster: 0 }), node("b.md", { cluster: 0 })], [wiki("a.md", "b.md")]);
		const fresh = graph(
			[node("a.md"), node("b.md"), tagNode("#foo")],
			[wiki("a.md", "b.md"), tagEdge("a.md", "#foo")],
		);

		const result = applyWikiPatch(cur, fresh);
		expect(result.changed).toBe(true);
		expect(result.addedPaths).toEqual([]);
		expect(result.removedPaths).toEqual([]);
		// The note whose tags changed is worth a re-vote; the tag itself is not.
		expect(result.touchedPaths).toEqual(["a.md"]);
		expect(result.data.nodes.map((n) => n.id).sort()).toEqual(["a.md", "b.md", "tag:#foo"]);
		// The note's degree ignores the new tag edge; the tag's counts it.
		expect(result.data.nodes.find((n) => n.id === "a.md")?.degree).toBe(1);
		expect(result.data.nodes.find((n) => n.id === "tag:#foo")?.degree).toBe(1);
		// Presentation state survives on the notes as usual.
		expect(result.data.nodes.find((n) => n.id === "a.md")?.cluster).toBe(0);
	});

	it("drops a tag node with its last note and keeps the surviving tag in place", () => {
		const cur = graph(
			[node("a.md"), node("b.md"), tagNode("#foo"), tagNode("#bar")],
			[tagEdge("a.md", "#foo"), tagEdge("b.md", "#bar")],
		);
		const fresh = graph([node("a.md"), { ...tagNode("#foo"), x: 0, y: 0 }], [tagEdge("a.md", "#foo")]);

		const result = applyWikiPatch(cur, fresh);
		expect(result.changed).toBe(true);
		expect(result.removedPaths).toEqual(["b.md"]);
		expect(result.touchedPaths).toEqual([]);
		const foo = result.data.nodes.find((n) => n.id === "tag:#foo");
		expect(result.data.nodes.map((n) => n.id).sort()).toEqual(["a.md", "tag:#foo"]);
		// The tag keeps its layout position across the patch like any other node.
		expect(foo).toMatchObject({ x: 5, y: 5, kind: "tag" });
	});
});
