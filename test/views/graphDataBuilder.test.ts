import { describe, expect, it, vi } from "vitest";
import { buildSemanticEdges, buildWikiGraph } from "../../src/views/smart-graph/graphDataBuilder";
import { edgeKey } from "../../src/utils/graphUtils";
import type { App, CachedMetadata, TFile } from "obsidian";
import type { DocumentVector } from "../../src/vectorstore/types";
import { semanticPairsFromDocuments } from "../../src/utils/semanticEdges";
import type { SemanticPairSource } from "../../src/views/smart-graph/graphDataBuilder";

// Mock App with resolvedLinks
function createMockApp(
	resolvedLinks: Record<string, Record<string, number>>,
	files: string[],
	fileTags: Record<string, string[]> = {},
): App {
	const mockFiles = files.map((path) => ({
		path,
		basename: path
			.replace(/\.[^.]+$/, "")
			.split("/")
			.pop(),
		extension: path.split(".").pop() ?? "md",
		name: path.split("/").pop(),
		constructor: { name: "TFile" },
	}));

	const getFileCache = vi.fn((file: TFile): CachedMetadata | null => {
		const tags = fileTags[file.path];
		if (!tags) return null;
		return {
			tags: tags.map((tag) => ({
				tag,
				position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } },
			})),
		} as unknown as CachedMetadata;
	});

	return {
		metadataCache: {
			resolvedLinks,
			getFileCache,
		},
		vault: {
			getMarkdownFiles: () => mockFiles.filter((f) => f.extension === "md"),
			getFiles: () => mockFiles,
			getAbstractFileByPath: (path: string) => mockFiles.find((f) => f.path === path) ?? null,
		},
	} as unknown as App;
}

/**
 * Stand-in for the vector store's worker-side scan: the same kernel the store
 * runs over its IndexedDB rows, fed these in-memory documents instead.
 */
function sourceOf(docs: DocumentVector[]): SemanticPairSource {
	return {
		semanticPairs: (paths, options) =>
			semanticPairsFromDocuments(docs, paths, {
				neighborCount: options?.neighborCount,
				threshold: options?.threshold,
				excludePairs: options?.excludePairs ? new Set(options.excludePairs) : undefined,
			}),
	};
}

function createMockDocumentVector(path: string, vector: number[]): DocumentVector {
	return {
		id: path,
		path,
		mtime: Date.now(),
		checksum: "abc123",
		vector: new Float32Array(vector),
	};
}

describe("buildSemanticEdges", () => {
	/** Two tight topics that share no vocabulary — the shape a folder-organised vault has. */
	function createTwoTopicDocs(): DocumentVector[] {
		return [
			createMockDocumentVector("bio1.md", [1, 0, 0, 0]),
			createMockDocumentVector("bio2.md", [0.98, 0.02, 0, 0]),
			createMockDocumentVector("bio3.md", [0.96, 0.05, 0, 0]),
			createMockDocumentVector("type1.md", [0, 0, 1, 0]),
			createMockDocumentVector("type2.md", [0, 0, 0.98, 0.02]),
			createMockDocumentVector("type3.md", [0, 0.02, 0.96, 0]),
		];
	}
	const allPaths = (docs: DocumentVector[]) => new Set(docs.map((d) => d.path));

	it("connects notes within a topic and not across topics", async () => {
		const docs = createTwoTopicDocs();
		const edges = await buildSemanticEdges(sourceOf(docs), allPaths(docs), { threshold: 0.5 });

		expect(edges.length).toBeGreaterThan(0);
		for (const edge of edges) {
			expect(edge.type).toBe("semantic");
			// Every edge should stay inside one topic ("bio" or "type").
			expect(edge.source.slice(0, 3)).toBe(edge.target.slice(0, 3));
		}
	});

	it("emits each pair only once", async () => {
		const docs = createTwoTopicDocs();
		const edges = await buildSemanticEdges(sourceOf(docs), allPaths(docs), { threshold: 0.5 });

		const keys = edges.map((e) => edgeKey(e.source, e.target));
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("skips pairs that already have a wiki link", async () => {
		const docs = createTwoTopicDocs();
		const excluded = edgeKey("bio1.md", "bio2.md");
		const edges = await buildSemanticEdges(sourceOf(docs), allPaths(docs), {
			threshold: 0.5,
			excludeEdgeKeys: new Set([excluded]),
		});

		expect(edges.map((e) => edgeKey(e.source, e.target))).not.toContain(excluded);
	});

	it("respects the similarity threshold", async () => {
		// Deliberately graded similarities so a mid threshold discriminates:
		// a↔b are near-identical, c is loosely related, d is unrelated.
		const docs = [
			createMockDocumentVector("a.md", [1, 0, 0, 0]),
			createMockDocumentVector("b.md", [0.99, 0.14, 0, 0]),
			createMockDocumentVector("c.md", [0.7, 0.7, 0, 0]),
			createMockDocumentVector("d.md", [0, 0, 1, 0]),
		];
		const paths = allPaths(docs);

		const permissive = await buildSemanticEdges(sourceOf(docs), paths, { threshold: 0.5 });
		const strict = await buildSemanticEdges(sourceOf(docs), paths, { threshold: 0.95 });

		expect(strict.length).toBeLessThan(permissive.length);
		// Every surviving edge must clear the bar it was given.
		for (const edge of strict) {
			expect(edge.weight).toBeGreaterThanOrEqual(0.95);
		}
		// The unrelated note is never connected at a sane threshold.
		expect(strict.some((e) => e.source === "d.md" || e.target === "d.md")).toBe(false);
	});

	it("caps how many neighbours each note contributes", async () => {
		const docs = createTwoTopicDocs();
		const edges = await buildSemanticEdges(sourceOf(docs), allPaths(docs), { threshold: 0.0, neighborCount: 1 });

		// With k=1 each of the 6 notes proposes one partner; dedup collapses mutual picks.
		expect(edges.length).toBeLessThanOrEqual(6);
		expect(edges.length).toBeGreaterThan(0);
	});

	it("returns nothing when neighbourCount is zero", async () => {
		const docs = createTwoTopicDocs();
		expect(await buildSemanticEdges(sourceOf(docs), allPaths(docs), { neighborCount: 0 })).toHaveLength(0);
	});

	it("only connects notes in the include set", async () => {
		const docs = createTwoTopicDocs();
		const edges = await buildSemanticEdges(sourceOf(docs), new Set(["bio1.md", "bio2.md"]), { threshold: 0.5 });

		for (const edge of edges) {
			expect(["bio1.md", "bio2.md"]).toContain(edge.source);
			expect(["bio1.md", "bio2.md"]).toContain(edge.target);
		}
	});

	it("scores multi-chunk notes by their best matching chunk", async () => {
		// A note whose *second* chunk matches the target. A mean-vector approach would
		// dilute this below threshold; best-chunk keeps the pair connected.
		const docs: DocumentVector[] = [
			{ ...createMockDocumentVector("multi.md", [1, 0, 0, 0]), id: "multi.md#0", chunkIndex: 0 },
			{ ...createMockDocumentVector("multi.md", [0, 0, 1, 0]), id: "multi.md#1", chunkIndex: 1 },
			createMockDocumentVector("target.md", [0, 0, 1, 0]),
		];
		const edges = await buildSemanticEdges(sourceOf(docs), allPaths(docs), { threshold: 0.9 });

		expect(edges).toHaveLength(1);
		expect(edgeKey(edges[0].source, edges[0].target)).toBe(edgeKey("multi.md", "target.md"));
		expect(edges[0].weight).toBeCloseTo(1, 5);
	});

	it("returns nothing for fewer than two notes", async () => {
		const docs = [createMockDocumentVector("only.md", [1, 0, 0, 0])];
		expect(await buildSemanticEdges(sourceOf(docs), allPaths(docs), { threshold: 0 })).toHaveLength(0);
	});

	it("connects an unlinked note to its topic — the link-sparse vault case", async () => {
		const docs = createTwoTopicDocs();
		// bio3 has no wiki links at all; it must still reach its topic semantically.
		const edges = await buildSemanticEdges(sourceOf(docs), allPaths(docs), { threshold: 0.5 });
		const touchingBio3 = edges.filter((e) => e.source === "bio3.md" || e.target === "bio3.md");

		expect(touchingBio3.length).toBeGreaterThan(0);
	});
});

describe("buildWikiGraph", () => {
	it("should create wiki nodes from vault markdown files without vectors", () => {
		const app = createMockApp({ "a.md": { "b.md": 1 }, "b.md": { "c.md": 1 } }, ["a.md", "b.md", "c.md"]);

		const result = buildWikiGraph(app);

		expect(result.graphData.nodes).toHaveLength(3);
		expect(result.graphData.edges).toHaveLength(2);
		expect(result.filteredPaths).toEqual(["a.md", "b.md", "c.md"]);
	});

	it("should respect folder and tag filters for wiki mode", () => {
		const app = createMockApp(
			{ "Work/a.md": { "Work/b.md": 1 }, "Ideas/c.md": { "Work/a.md": 1 } },
			["Work/a.md", "Work/b.md", "Ideas/c.md"],
			{ "Work/a.md": ["#focus"], "Work/b.md": ["#focus"], "Ideas/c.md": ["#other"] },
		);

		const result = buildWikiGraph(app, { folders: ["Work"], tags: ["#focus"] });

		expect(result.graphData.nodes.map((n) => n.id).sort((a, b) => a.localeCompare(b))).toEqual([
			"Work/a.md",
			"Work/b.md",
		]);
		expect(result.graphData.edges).toHaveLength(1);
	});

	it("should not duplicate wiki edges", () => {
		// Both directions present in resolvedLinks — still one undirected edge.
		const app = createMockApp({ "a.md": { "b.md": 1 }, "b.md": { "a.md": 1 } }, ["a.md", "b.md"]);

		const result = buildWikiGraph(app);

		expect(result.graphData.edges).toHaveLength(1);
	});

	it("should not create self-loop wiki edges", () => {
		const app = createMockApp({ "a.md": { "a.md": 1 } }, ["a.md"]);

		const result = buildWikiGraph(app);

		expect(result.graphData.edges).toHaveLength(0);
	});

	it("should include unlinked notes as isolated nodes", () => {
		const app = createMockApp({ "a.md": { "b.md": 1 } }, ["a.md", "b.md", "orphan.md"]);

		const result = buildWikiGraph(app);

		const orphanNode = result.graphData.nodes.find((n) => n.id === "orphan.md");
		expect(orphanNode).toBeDefined();
		expect(orphanNode?.degree).toBe(0);
	});

	it("should set node labels from file basename", () => {
		const app = createMockApp({}, ["folder/My Note.md"]);

		const result = buildWikiGraph(app);

		expect(result.graphData.nodes[0].label).toBe("My Note");
	});
});

describe("buildWikiGraph — tags as nodes", () => {
	const tagged = () =>
		createMockApp({ "a.md": { "c.md": 1 } }, ["a.md", "b.md", "c.md"], {
			"a.md": ["#foo", "#bar"],
			"b.md": ["#foo"],
		});

	it("leaves tags out unless asked for", () => {
		const { graphData, filteredPaths } = buildWikiGraph(tagged());
		expect(graphData.nodes.every((node) => node.kind !== "tag")).toBe(true);
		expect(graphData.edges.every((edge) => edge.type !== "tag")).toBe(true);
		expect(filteredPaths.sort()).toEqual(["a.md", "b.md", "c.md"]);
	});

	it("draws each tag as a node linked to every note carrying it", () => {
		const { graphData, filteredPaths } = buildWikiGraph(tagged(), undefined, undefined, { includeTags: true });

		const tagNodes = graphData.nodes.filter((node) => node.kind === "tag");
		expect(tagNodes.map((node) => node.id).sort()).toEqual(["tag:#bar", "tag:#foo"]);
		expect(tagNodes.map((node) => node.label).sort()).toEqual(["#bar", "#foo"]);
		// A tag node's path is its synthetic id, never a vault file.
		expect(tagNodes.every((node) => node.path === node.id)).toBe(true);

		const tagEdges = graphData.edges.filter((edge) => edge.type === "tag");
		expect(tagEdges.map((edge) => `${edge.source}>${edge.target}`).sort()).toEqual([
			"a.md>tag:#bar",
			"a.md>tag:#foo",
			"b.md>tag:#foo",
		]);
		expect(tagEdges.every((edge) => edge.weight === 1)).toBe(true);

		// A tag's degree is how many notes carry it. A note's degree ignores its
		// tags: degree breaks ties for a topic's representative, so a display
		// toggle must not be able to move it.
		const byId = new Map(graphData.nodes.map((node) => [node.id, node]));
		expect(byId.get("tag:#foo")?.degree).toBe(2);
		expect(byId.get("tag:#bar")?.degree).toBe(1);
		expect(byId.get("a.md")?.degree).toBe(1);
		expect(byId.get("b.md")?.degree).toBe(0);

		// The note list handed back never includes tag ids.
		expect(filteredPaths.sort()).toEqual(["a.md", "b.md", "c.md"]);
	});

	it("treats tag casing and repeats the way Obsidian does: one tag, one link per note", () => {
		const app = createMockApp({}, ["a.md", "b.md"], {
			"a.md": ["#Foo", "#foo", "#Foo"],
			"b.md": ["#FOO"],
		});
		const { graphData } = buildWikiGraph(app, undefined, undefined, { includeTags: true });

		const tagNodes = graphData.nodes.filter((node) => node.kind === "tag");
		expect(tagNodes).toHaveLength(1);
		expect(tagNodes[0].id).toBe("tag:#foo");
		// First-seen casing is the label.
		expect(tagNodes[0].label).toBe("#Foo");
		expect(graphData.edges.filter((edge) => edge.type === "tag")).toHaveLength(2);
	});

	it("only shows tags of notes that are in the graph", () => {
		const app = createMockApp({}, ["Work/a.md", "Home/b.md"], {
			"Work/a.md": ["#work"],
			"Home/b.md": ["#home"],
		});
		const { graphData } = buildWikiGraph(app, { folders: ["Work"] }, undefined, { includeTags: true });

		expect(graphData.nodes.map((node) => node.id).sort()).toEqual(["Work/a.md", "tag:#work"]);
		expect(graphData.edges).toEqual([{ source: "Work/a.md", target: "tag:#work", weight: 1, type: "tag" }]);
	});
});
