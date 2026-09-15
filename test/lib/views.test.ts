import { describe, expect, it, vi } from "vitest";
import {
	compilePrivacyMembershipDraft,
	createEmptyPrivacyFilter,
	describeViewFilter,
	getAllMarkdownPaths,
	matchesPrivacyMembershipDraftPath,
	parsePrivacyMembershipFilter,
	resolvePrivacyMembershipDraft,
	resolveViewFilter,
	rewriteViewFilterForRename,
} from "../../src/lib/views";
import type { ViewFilter, ViewFilterGroup } from "../../src/types/viewFilter";
import { type App, type CachedMetadata, TFile } from "obsidian";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock Obsidian App with the given file paths and optional tag map.
 */
function createMockApp(
	files: string[],
	fileTags: Record<string, string[]> = {},
	fileFrontmatter: Record<string, Record<string, unknown>> = {},
): App {
	// Real TFile instances, not object literals: the tag rules narrow with
	// `instanceof TFile` (rather than a duck-typed "extension" in file), so a plain
	// object would silently fail every tag match.
	const mockFiles = files.map((path) => {
		const file = new TFile();
		file.path = path;
		file.basename =
			path
				.replace(/\.[^.]+$/, "")
				.split("/")
				.pop() ?? "";
		file.extension = path.split(".").pop() ?? "md";
		file.name = path.split("/").pop() ?? "";
		return file;
	});

	const getFileCache = vi.fn((file: TFile): CachedMetadata | null => {
		const tags = fileTags[file.path];
		const frontmatter = fileFrontmatter[file.path];
		if (!tags && !frontmatter) return null;
		return {
			...(tags
				? {
						tags: tags.map((tag) => ({
							tag,
							position: {
								start: { line: 0, col: 0, offset: 0 },
								end: { line: 0, col: 0, offset: 0 },
							},
						})),
					}
				: {}),
			...(frontmatter ? { frontmatter: frontmatter as CachedMetadata["frontmatter"] } : {}),
		};
	});

	return {
		metadataCache: { getFileCache },
		vault: {
			getMarkdownFiles: () => mockFiles.filter((f) => f.extension === "md"),
			getFiles: () => mockFiles,
			getAbstractFileByPath: (path: string) => mockFiles.find((f) => f.path === path) ?? null,
		},
	} as unknown as App;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveViewFilter", () => {
	const FILES = [
		"Work/project-a.md",
		"Work/project-b.md",
		"Personal/journal.md",
		"Personal/recipes.md",
		"Root.md",
		"Research/ml-paper.md",
		"Research/deep-learning.md",
		"Research/notes.pdf",
	];

	const TAGS: Record<string, string[]> = {
		"Work/project-a.md": ["#work", "#urgent"],
		"Work/project-b.md": ["#work"],
		"Personal/journal.md": ["#personal", "#daily"],
		"Research/ml-paper.md": ["#ml", "#research"],
		"Research/deep-learning.md": ["#ml", "#ml/transformers", "#research"],
	};

	// ── Leaf: folder ────────────────────────────────────────────────────

	describe("folder leaf", () => {
		it("matches files in a top-level folder", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilter = { type: "folder", value: "Work" };
			const result = resolveViewFilter(app, filter);

			expect(result.paths).toEqual(new Set(["Work/project-a.md", "Work/project-b.md"]));
			expect(result.stalePaths).toEqual([]);
		});

		it("returns empty set for non-existent folder", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilter = { type: "folder", value: "NonExistent" };
			const result = resolveViewFilter(app, filter);

			expect(result.paths.size).toBe(0);
		});

		it("matches root-level files when path prefix matches", () => {
			const app = createMockApp(FILES, TAGS);
			// "Root.md" should match prefix "Root" (exact path match)
			const filter: ViewFilter = { type: "folder", value: "Root.md" };
			const result = resolveViewFilter(app, filter);

			expect(result.paths).toEqual(new Set(["Root.md"]));
		});
	});

	// ── Leaf: tag ───────────────────────────────────────────────────────

	describe("tag leaf", () => {
		it("matches files with a given tag", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilter = { type: "tag", value: "#work" };
			const result = resolveViewFilter(app, filter);

			expect(result.paths).toEqual(new Set(["Work/project-a.md", "Work/project-b.md"]));
		});

		it("matches hierarchical tags", () => {
			const app = createMockApp(FILES, TAGS);
			// #ml should match both #ml and #ml/transformers
			const filter: ViewFilter = { type: "tag", value: "#ml" };
			const result = resolveViewFilter(app, filter);

			expect(result.paths).toEqual(new Set(["Research/ml-paper.md", "Research/deep-learning.md"]));
		});

		it("works with or without # prefix", () => {
			const app = createMockApp(FILES, TAGS);
			const withHash = resolveViewFilter(app, { type: "tag", value: "#research" });
			const withoutHash = resolveViewFilter(app, { type: "tag", value: "research" });

			expect(withHash.paths).toEqual(withoutHash.paths);
			expect(withHash.paths.size).toBe(2);
		});

		it("returns empty for unmatched tag", () => {
			const app = createMockApp(FILES, TAGS);
			const result = resolveViewFilter(app, { type: "tag", value: "#nonexistent" });

			expect(result.paths.size).toBe(0);
		});
	});

	// ── Leaf: extension ─────────────────────────────────────────────────

	describe("extension leaf", () => {
		it("matches files by extension with custom universe", () => {
			const app = createMockApp(FILES, TAGS);
			// Default universe is markdown-only; pass full universe to include pdf
			const universe = new Set(FILES);
			const filter: ViewFilter = { type: "extension", value: "pdf" };
			const result = resolveViewFilter(app, filter, universe);

			expect(result.paths).toEqual(new Set(["Research/notes.pdf"]));
		});

		it("handles dot prefix", () => {
			const app = createMockApp(FILES, TAGS);
			const universe = new Set(FILES);
			const filter: ViewFilter = { type: "extension", value: ".pdf" };
			const result = resolveViewFilter(app, filter, universe);

			expect(result.paths).toEqual(new Set(["Research/notes.pdf"]));
		});

		it("matches all markdown files", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilter = { type: "extension", value: "md" };
			const result = resolveViewFilter(app, filter);

			// Default universe = getMarkdownFiles() = all .md files
			expect(result.paths.size).toBe(7);
		});
	});

	// ── Leaf: paths (frozen) ────────────────────────────────────────────

	describe("paths leaf", () => {
		it("returns existing paths and reports stale ones", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilter = {
				type: "paths",
				value: ["Work/project-a.md", "deleted-file.md", "Research/ml-paper.md"],
			};
			const result = resolveViewFilter(app, filter);

			expect(result.paths).toEqual(new Set(["Work/project-a.md", "Research/ml-paper.md"]));
			expect(result.stalePaths).toEqual(["deleted-file.md"]);
		});

		it("all paths stale", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilter = {
				type: "paths",
				value: ["gone1.md", "gone2.md"],
			};
			const result = resolveViewFilter(app, filter);

			expect(result.paths.size).toBe(0);
			expect(result.stalePaths).toEqual(["gone1.md", "gone2.md"]);
		});

		it("empty paths array", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilter = { type: "paths", value: [] };
			const result = resolveViewFilter(app, filter);

			expect(result.paths.size).toBe(0);
			expect(result.stalePaths).toEqual([]);
		});
	});

	// ── Group: all (AND / intersection) ─────────────────────────────────

	describe("all (AND) group", () => {
		it("intersects folder + tag", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilterGroup = {
				type: "all",
				conditions: [
					{ type: "folder", value: "Research" },
					{ type: "tag", value: "#ml" },
				],
			};
			const result = resolveViewFilter(app, filter);

			// Research/ml-paper.md has #ml, Research/deep-learning.md has #ml
			// Research/notes.pdf does NOT have #ml
			expect(result.paths).toEqual(new Set(["Research/ml-paper.md", "Research/deep-learning.md"]));
		});

		it("intersects three conditions", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilterGroup = {
				type: "all",
				conditions: [
					{ type: "folder", value: "Work" },
					{ type: "tag", value: "#work" },
					{ type: "tag", value: "#urgent" },
				],
			};
			const result = resolveViewFilter(app, filter);

			// Only project-a has both #work and #urgent
			expect(result.paths).toEqual(new Set(["Work/project-a.md"]));
		});

		it("empty conditions = everything", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilterGroup = { type: "all", conditions: [] };
			const result = resolveViewFilter(app, filter);

			// All markdown files (universe = getMarkdownFiles)
			expect(result.paths.size).toBe(7);
		});

		it("disjoint conditions = empty result", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilterGroup = {
				type: "all",
				conditions: [
					{ type: "folder", value: "Work" },
					{ type: "folder", value: "Personal" },
				],
			};
			const result = resolveViewFilter(app, filter);

			expect(result.paths.size).toBe(0);
		});
	});

	// ── Group: any (OR / union) ─────────────────────────────────────────

	describe("any (OR) group", () => {
		it("unions folder + tag", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilterGroup = {
				type: "any",
				conditions: [
					{ type: "folder", value: "Personal" },
					{ type: "tag", value: "#ml" },
				],
			};
			const result = resolveViewFilter(app, filter);

			expect(result.paths).toEqual(
				new Set([
					"Personal/journal.md",
					"Personal/recipes.md",
					"Research/ml-paper.md",
					"Research/deep-learning.md",
				]),
			);
		});

		it("empty conditions = nothing", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilterGroup = { type: "any", conditions: [] };
			const result = resolveViewFilter(app, filter);

			expect(result.paths.size).toBe(0);
		});
	});

	// ── Group: none (NOT-ANY / complement) ──────────────────────────────

	describe("none (NOT) group", () => {
		it("excludes matching files", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilterGroup = {
				type: "none",
				conditions: [{ type: "folder", value: "Work" }],
			};
			const result = resolveViewFilter(app, filter);

			// Everything except Work/ files
			expect(result.paths.has("Work/project-a.md")).toBe(false);
			expect(result.paths.has("Work/project-b.md")).toBe(false);
			expect(result.paths.has("Personal/journal.md")).toBe(true);
			expect(result.paths.has("Root.md")).toBe(true);
		});

		it("empty conditions = everything (complement of nothing)", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilterGroup = { type: "none", conditions: [] };
			const result = resolveViewFilter(app, filter);

			// none of nothing = complement of empty set = universe
			expect(result.paths.size).toBe(7);
		});
	});

	// ── Nested (composite) ──────────────────────────────────────────────

	describe("nested composite filters", () => {
		it("all(folder:Research, any(tag:#ml, tag:#research))", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilter = {
				type: "all",
				conditions: [
					{ type: "folder", value: "Research" },
					{
						type: "any",
						conditions: [
							{ type: "tag", value: "#ml" },
							{ type: "tag", value: "#research" },
						],
					},
				],
			};
			const result = resolveViewFilter(app, filter);

			// Research files with #ml or #research: ml-paper.md, deep-learning.md
			// Research/notes.pdf is not in universe (pdf, not md... wait it IS in files but may not have tags)
			expect(result.paths).toEqual(new Set(["Research/ml-paper.md", "Research/deep-learning.md"]));
		});

		it("any(all(folder:Work, tag:#urgent), folder:Personal)", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilter = {
				type: "any",
				conditions: [
					{
						type: "all",
						conditions: [
							{ type: "folder", value: "Work" },
							{ type: "tag", value: "#urgent" },
						],
					},
					{ type: "folder", value: "Personal" },
				],
			};
			const result = resolveViewFilter(app, filter);

			expect(result.paths).toEqual(new Set(["Work/project-a.md", "Personal/journal.md", "Personal/recipes.md"]));
		});

		it("collects stale paths from nested frozen leaves", () => {
			const app = createMockApp(FILES, TAGS);
			const filter: ViewFilter = {
				type: "any",
				conditions: [
					{ type: "paths", value: ["Work/project-a.md", "gone1.md"] },
					{ type: "paths", value: ["Personal/journal.md", "gone2.md"] },
				],
			};
			const result = resolveViewFilter(app, filter);

			expect(result.paths).toEqual(new Set(["Work/project-a.md", "Personal/journal.md"]));
			expect(result.stalePaths).toEqual(expect.arrayContaining(["gone1.md", "gone2.md"]));
			expect(result.stalePaths).toHaveLength(2);
		});
	});

	// ── Universe parameter ──────────────────────────────────────────────

	describe("custom universe", () => {
		it("restricts resolution to provided universe", () => {
			const app = createMockApp(FILES, TAGS);
			const universe = new Set(["Work/project-a.md", "Work/project-b.md"]);
			const filter: ViewFilter = { type: "tag", value: "#urgent" };
			const result = resolveViewFilter(app, filter, universe);

			// Only project-a has #urgent, and both are in universe
			expect(result.paths).toEqual(new Set(["Work/project-a.md"]));
		});
	});
});

// ---------------------------------------------------------------------------
// describeViewFilter
// ---------------------------------------------------------------------------

describe("describeViewFilter", () => {
	it("describes a folder leaf", () => {
		expect(describeViewFilter({ type: "folder", value: "Work" })).toBe("folder:Work");
	});

	it("describes a tag leaf", () => {
		expect(describeViewFilter({ type: "tag", value: "#ml" })).toBe("tag:#ml");
	});

	it("describes an extension leaf", () => {
		expect(describeViewFilter({ type: "extension", value: "pdf" })).toBe("ext:.pdf");
	});

	it("describes a paths leaf", () => {
		expect(describeViewFilter({ type: "paths", value: ["a.md", "b.md", "c.md"] })).toBe("3 notes");
	});

	it("describes a paths leaf with 1 note", () => {
		expect(describeViewFilter({ type: "paths", value: ["a.md"] })).toBe("1 note");
	});

	it("describes a composite filter", () => {
		const filter: ViewFilter = {
			type: "all",
			conditions: [
				{ type: "folder", value: "Work" },
				{ type: "tag", value: "#ml" },
			],
		};
		expect(describeViewFilter(filter)).toBe("all(folder:Work, tag:#ml)");
	});

	it("describes nested composites", () => {
		const filter: ViewFilter = {
			type: "any",
			conditions: [
				{
					type: "all",
					conditions: [
						{ type: "folder", value: "A" },
						{ type: "tag", value: "#x" },
					],
				},
				{ type: "extension", value: "pdf" },
			],
		};
		expect(describeViewFilter(filter)).toBe("any(all(folder:A, tag:#x), ext:.pdf)");
	});
});

// ---------------------------------------------------------------------------
// getAllMarkdownPaths
// ---------------------------------------------------------------------------

describe("getAllMarkdownPaths", () => {
	it("returns only markdown file paths", () => {
		const app = createMockApp(["notes/a.md", "notes/b.md", "assets/image.png", "data.pdf"]);
		const paths = getAllMarkdownPaths(app);

		expect(paths).toEqual(new Set(["notes/a.md", "notes/b.md"]));
	});
});

describe("space membership draft helpers", () => {
	it("compiles an empty draft to an empty paths filter", () => {
		expect(
			compilePrivacyMembershipDraft({
				manualPaths: [],
				autoIncludeRules: [],
				excludedPaths: [],
			}),
		).toEqual(createEmptyPrivacyFilter());
	});

	it("compiles manual paths, auto rules, and exclusions into the existing filter shape", () => {
		expect(
			compilePrivacyMembershipDraft({
				manualPaths: ["Manual/a.md"],
				autoIncludeRules: [{ type: "folder", value: "Research" }],
				excludedPaths: ["Research/old.md"],
			}),
		).toEqual({
			type: "all",
			conditions: [
				{
					type: "any",
					conditions: [
						{ type: "paths", value: ["Manual/a.md"] },
						{ type: "folder", value: "Research" },
					],
				},
				{ type: "none", conditions: [{ type: "paths", value: ["Research/old.md"] }] },
			],
		});
	});

	it("parses a simple compiled filter back into a file-first draft", () => {
		const parsed = parsePrivacyMembershipFilter({
			type: "all",
			conditions: [
				{
					type: "any",
					conditions: [
						{ type: "paths", value: ["Manual/a.md"] },
						{ type: "tag", value: "#ml" },
					],
				},
				{ type: "none", conditions: [{ type: "paths", value: ["Manual/old.md"] }] },
			],
		});

		expect(parsed.isAdvanced).toBe(false);
		expect(parsed.draft).toEqual({
			manualPaths: ["Manual/a.md"],
			autoIncludeRules: [{ type: "tag", value: "#ml" }],
			excludedPaths: ["Manual/old.md"],
		});
	});

	it("marks non-simple all-groups as advanced", () => {
		const parsed = parsePrivacyMembershipFilter({
			type: "all",
			conditions: [
				{ type: "folder", value: "Work" },
				{ type: "tag", value: "#urgent" },
			],
		});

		expect(parsed.isAdvanced).toBe(true);
		expect(parsed.draft).toEqual({
			manualPaths: [],
			autoIncludeRules: [],
			excludedPaths: [],
		});
	});

	it("resolves draft membership with provenance and exclusions", () => {
		const app = createMockApp(
			["Manual/a.md", "Research/ml-paper.md", "Research/deep-learning.md", "Research/skip.md"],
			{
				"Research/ml-paper.md": ["#ml"],
				"Research/deep-learning.md": ["#ml"],
			},
		);

		const result = resolvePrivacyMembershipDraft(app, {
			manualPaths: ["Manual/a.md", "missing.md"],
			autoIncludeRules: [
				{ type: "folder", value: "Research" },
				{ type: "tag", value: "#ml" },
			],
			excludedPaths: ["Research/skip.md"],
		});

		expect(result.paths).toEqual(new Set(["Manual/a.md", "Research/ml-paper.md", "Research/deep-learning.md"]));
		expect(result.stalePaths).toEqual(["missing.md"]);
		expect(result.excludedPaths).toEqual(new Set(["Research/skip.md"]));
		expect(result.provenance.get("Manual/a.md")).toEqual(["Manual"]);
		expect(result.provenance.get("Research/ml-paper.md")).toEqual(["Folder: Research", "Tag: #ml"]);
		expect(result.provenance.has("Research/skip.md")).toBe(false);
	});

	it("matches a single path against simple membership rules", () => {
		const app = createMockApp(
			["Work/manual.md", "Research/ml-paper.md", "Research/skip.md", "Assets/diagram.pdf"],
			{
				"Research/ml-paper.md": ["#ml"],
				"Research/skip.md": ["#ml"],
			},
		);

		const draft = {
			manualPaths: ["Work/manual.md"],
			autoIncludeRules: [{ type: "tag", value: "#ml" } as const, { type: "extension", value: "pdf" } as const],
			excludedPaths: ["Research/skip.md"],
		};

		expect(matchesPrivacyMembershipDraftPath(app, draft, "Work/manual.md")).toBe(true);
		expect(matchesPrivacyMembershipDraftPath(app, draft, "Research/ml-paper.md")).toBe(true);
		expect(matchesPrivacyMembershipDraftPath(app, draft, "Assets/diagram.pdf")).toBe(true);
		expect(matchesPrivacyMembershipDraftPath(app, draft, "Research/skip.md")).toBe(false);
		expect(matchesPrivacyMembershipDraftPath(app, draft, "Other/file.md")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Property leaf
// ---------------------------------------------------------------------------

describe("property leaf", () => {
	const FILES = [
		"Clients/acme.md",
		"Clients/globex.md",
		"Clients/untagged.md",
		"Work/listed.md",
		"Work/numeric.md",
		"Work/boolish.md",
		"Work/empty-value.md",
		"Personal/none.md",
	];

	const FRONTMATTER: Record<string, Record<string, unknown>> = {
		"Clients/acme.md": { client: "Acme" },
		"Clients/globex.md": { client: "Globex" },
		"Clients/untagged.md": { unrelated: "x" },
		// List-valued property — should behave exactly like a scalar per element.
		"Work/listed.md": { client: ["Acme", "Initech"] },
		"Work/numeric.md": { revision: 3 },
		"Work/boolish.md": { confidential: true },
		// Present key with an empty value must NOT count as "exists".
		"Work/empty-value.md": { client: null },
	};

	function app() {
		return createMockApp(FILES, {}, FRONTMATTER);
	}

	it("matches key existence when no values are given", () => {
		const filter: ViewFilter = { type: "property", value: "client" };
		const result = resolveViewFilter(app(), filter, new Set(FILES));

		expect(result.paths).toEqual(new Set(["Clients/acme.md", "Clients/globex.md", "Work/listed.md"]));
	});

	it("treats a present-but-empty value as absent", () => {
		const filter: ViewFilter = { type: "property", value: "client" };
		const result = resolveViewFilter(app(), filter, new Set(FILES));

		expect(result.paths.has("Work/empty-value.md")).toBe(false);
	});

	it("matches a single value exactly", () => {
		const filter: ViewFilter = { type: "property", value: "client", values: ["Acme"] };
		const result = resolveViewFilter(app(), filter, new Set(FILES));

		expect(result.paths).toEqual(new Set(["Clients/acme.md", "Work/listed.md"]));
	});

	it("matches any of several values (equals-any)", () => {
		const filter: ViewFilter = {
			type: "property",
			value: "client",
			values: ["Acme", "Globex"],
		};
		const result = resolveViewFilter(app(), filter, new Set(FILES));

		expect(result.paths).toEqual(new Set(["Clients/acme.md", "Clients/globex.md", "Work/listed.md"]));
	});

	it("matches list-valued properties per element", () => {
		const filter: ViewFilter = { type: "property", value: "client", values: ["Initech"] };
		const result = resolveViewFilter(app(), filter, new Set(FILES));

		expect(result.paths).toEqual(new Set(["Work/listed.md"]));
	});

	it("compares keys and values case-insensitively", () => {
		const filter: ViewFilter = { type: "property", value: "CLIENT", values: ["acme"] };
		const result = resolveViewFilter(app(), filter, new Set(FILES));

		expect(result.paths).toEqual(new Set(["Clients/acme.md", "Work/listed.md"]));
	});

	it("does not substring-match values", () => {
		const filter: ViewFilter = { type: "property", value: "client", values: ["Acm"] };
		const result = resolveViewFilter(app(), filter, new Set(FILES));

		expect(result.paths.size).toBe(0);
	});

	it("coerces non-string scalars for comparison", () => {
		const numeric = resolveViewFilter(
			app(),
			{ type: "property", value: "revision", values: ["3"] },
			new Set(FILES),
		);
		expect(numeric.paths).toEqual(new Set(["Work/numeric.md"]));

		const boolish = resolveViewFilter(
			app(),
			{ type: "property", value: "confidential", values: ["true"] },
			new Set(FILES),
		);
		expect(boolish.paths).toEqual(new Set(["Work/boolish.md"]));
	});

	it("matches nothing for a blank key", () => {
		const filter: ViewFilter = { type: "property", value: "   " };
		const result = resolveViewFilter(app(), filter, new Set(FILES));

		expect(result.paths.size).toBe(0);
	});

	it("composes with groups like any other leaf", () => {
		const filter: ViewFilter = {
			type: "all",
			conditions: [
				{ type: "folder", value: "Clients" },
				{ type: "property", value: "client", values: ["Acme"] },
			],
		};
		const result = resolveViewFilter(app(), filter, new Set(FILES));

		// Work/listed.md also has client: Acme but is outside the Clients folder.
		expect(result.paths).toEqual(new Set(["Clients/acme.md"]));
	});

	it("survives a compile → parse round-trip as a simple rule", () => {
		const draft = {
			manualPaths: [],
			autoIncludeRules: [{ type: "property", value: "client", values: ["Acme"] } satisfies ViewFilter],
			excludedPaths: [],
		};

		const parsed = parsePrivacyMembershipFilter(compilePrivacyMembershipDraft(draft));

		expect(parsed.isAdvanced).toBe(false);
		expect(parsed.draft.autoIncludeRules).toEqual([{ type: "property", value: "client", values: ["Acme"] }]);
	});

	it("agrees between the sync path matcher and the set resolver", () => {
		const rule = { type: "property", value: "client", values: ["Acme"] } satisfies ViewFilter;
		const draft = { manualPaths: [], autoIncludeRules: [rule], excludedPaths: [] };
		const resolved = resolveViewFilter(app(), rule, new Set(FILES));

		// isFilePrivate() uses the sync matcher in tool loops; it must not
		// disagree with the set-based resolver used to render the UI.
		for (const path of FILES) {
			expect(matchesPrivacyMembershipDraftPath(app(), draft, path)).toBe(resolved.paths.has(path));
		}
	});

	it("describes property leaves with and without values", () => {
		expect(describeViewFilter({ type: "property", value: "client" })).toBe("prop:client");
		expect(describeViewFilter({ type: "property", value: "client", values: ["Acme", "Globex"] })).toBe(
			"prop:client=Acme|Globex",
		);
	});
});

// ---------------------------------------------------------------------------
// Unfinished conditions must not select the whole vault
// ---------------------------------------------------------------------------

describe("empty leaf values", () => {
	const FILES = ["Work/a.md", "Work/b.md", "Personal/c.md", "Root.md"];

	it("matches nothing for a blank folder value", () => {
		const app = createMockApp(FILES);
		// `matchesPathPrefix` treats a blank prefix as matching everything, which
		// would expose the entire vault mid-typing. The leaf must not inherit that.
		for (const blank of ["", "   "]) {
			const result = resolveViewFilter(app, { type: "folder", value: blank }, new Set(FILES));
			expect(result.paths.size).toBe(0);
		}
	});

	it("matches nothing for a blank folder value via the sync matcher", () => {
		const app = createMockApp(FILES);
		const draft = {
			manualPaths: [],
			autoIncludeRules: [{ type: "folder", value: "" } as const],
			excludedPaths: [],
		};

		for (const path of FILES) {
			expect(matchesPrivacyMembershipDraftPath(app, draft, path)).toBe(false);
		}
	});

	it("still matches a real folder value", () => {
		const app = createMockApp(FILES);
		const result = resolveViewFilter(app, { type: "folder", value: "Work" }, new Set(FILES));

		expect(result.paths).toEqual(new Set(["Work/a.md", "Work/b.md"]));
	});

	it("matches nothing for blank extension and tag values", () => {
		const app = createMockApp(FILES, { "Work/a.md": ["#work"] });

		expect(resolveViewFilter(app, { type: "extension", value: "" }, new Set(FILES)).paths.size).toBe(0);
		expect(resolveViewFilter(app, { type: "tag", value: "" }, new Set(FILES)).paths.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// rewriteViewFilterForRename — keep the filter following moved files/folders
// ---------------------------------------------------------------------------

describe("rewriteViewFilterForRename", () => {
	it("rewrites a paths leaf entry that matches the old path", () => {
		const filter: ViewFilter = { type: "paths", value: ["Work/a.md", "Personal/b.md"] };
		const rewritten = rewriteViewFilterForRename(filter, "Work/a.md", "Archive/a.md");

		expect(rewritten).toEqual({ type: "paths", value: ["Archive/a.md", "Personal/b.md"] });
	});

	it("leaves a paths leaf untouched when no entry matches", () => {
		const filter: ViewFilter = { type: "paths", value: ["Work/a.md"] };
		const rewritten = rewriteViewFilterForRename(filter, "Other/x.md", "Other/y.md");

		// Identity preserved, not just structural equality — callers rely on this
		// to skip a write when nothing changed.
		expect(rewritten).toBe(filter);
	});

	it("rewrites a folder leaf that exactly names the renamed folder", () => {
		const filter: ViewFilter = { type: "folder", value: "Work" };
		const rewritten = rewriteViewFilterForRename(filter, "Work", "Projects");

		expect(rewritten).toEqual({ type: "folder", value: "Projects" });
	});

	it("rewrites a nested folder leaf via its own exact-match rename event", () => {
		// Obsidian fires a dedicated rename event for every descendant folder of a
		// renamed parent (verified against a live vault: renaming `A` containing
		// `A/Sub` fires both `A -> B` and `A/Sub -> B/Sub`), so a leaf naming a
		// nested folder is rewritten by its own event, not by prefix-matching the
		// parent's event.
		const filter: ViewFilter = { type: "folder", value: "Work/Q1" };
		const rewritten = rewriteViewFilterForRename(filter, "Work/Q1", "Projects/Q1");

		expect(rewritten).toEqual({ type: "folder", value: "Projects/Q1" });
	});

	it("leaves a folder leaf untouched when it names an unrelated folder", () => {
		const filter: ViewFilter = { type: "folder", value: "Personal" };
		const rewritten = rewriteViewFilterForRename(filter, "Work", "Projects");

		expect(rewritten).toBe(filter);
	});

	it("does not touch tag or extension leaves, or plain property values", () => {
		const tag: ViewFilter = { type: "tag", value: "#work" };
		const ext: ViewFilter = { type: "extension", value: "pdf" };
		// A non-link property value is just a string — a note rename must not
		// rewrite it even if the text happens to resemble the renamed note.
		const prop: ViewFilter = { type: "property", value: "client", values: ["Acme"] };

		expect(rewriteViewFilterForRename(tag, "Work", "Projects")).toBe(tag);
		expect(rewriteViewFilterForRename(ext, "Work", "Projects")).toBe(ext);
		expect(rewriteViewFilterForRename(prop, "Acme.md", "Acme Holdings.md")).toBe(prop);
	});

	describe("wikilink property values", () => {
		it("rewrites a basename wikilink to the renamed note", () => {
			const filter: ViewFilter = { type: "property", value: "client", values: ["[[Acme Corp]]"] };
			const rewritten = rewriteViewFilterForRename(filter, "Acme Corp.md", "Acme Holdings.md");

			expect(rewritten).toEqual({ type: "property", value: "client", values: ["[[Acme Holdings]]"] });
		});

		it("rewrites only the matching value in a multi-value leaf", () => {
			const filter: ViewFilter = {
				type: "property",
				value: "client",
				values: ["[[Acme Corp]]", "[[Globex]]", "Plain Text"],
			};
			const rewritten = rewriteViewFilterForRename(filter, "Acme Corp.md", "Acme Holdings.md");

			expect(rewritten).toEqual({
				type: "property",
				value: "client",
				values: ["[[Acme Holdings]]", "[[Globex]]", "Plain Text"],
			});
		});

		it("preserves an alias", () => {
			const filter: ViewFilter = { type: "property", value: "client", values: ["[[Acme Corp|The Client]]"] };
			const rewritten = rewriteViewFilterForRename(filter, "Acme Corp.md", "Acme Holdings.md");

			expect(rewritten).toEqual({
				type: "property",
				value: "client",
				values: ["[[Acme Holdings|The Client]]"],
			});
		});

		it("preserves a subpath", () => {
			const filter: ViewFilter = { type: "property", value: "client", values: ["[[Acme Corp#Billing]]"] };
			const rewritten = rewriteViewFilterForRename(filter, "Acme Corp.md", "Acme Holdings.md");

			expect(rewritten).toEqual({
				type: "property",
				value: "client",
				values: ["[[Acme Holdings#Billing]]"],
			});
		});

		it("keeps a full-path link written as a full path", () => {
			const filter: ViewFilter = { type: "property", value: "client", values: ["[[Work/Acme Corp]]"] };
			const rewritten = rewriteViewFilterForRename(filter, "Work/Acme Corp.md", "Archive/Acme Corp.md");

			expect(rewritten).toEqual({
				type: "property",
				value: "client",
				values: ["[[Archive/Acme Corp]]"],
			});
		});

		it("matches link text case-insensitively, as Obsidian resolves links", () => {
			const filter: ViewFilter = { type: "property", value: "client", values: ["[[acme corp]]"] };
			const rewritten = rewriteViewFilterForRename(filter, "Acme Corp.md", "Acme Holdings.md");

			expect(rewritten).toEqual({ type: "property", value: "client", values: ["[[Acme Holdings]]"] });
		});

		it("leaves a wikilink pointing at an unrelated note alone", () => {
			const filter: ViewFilter = { type: "property", value: "client", values: ["[[Globex]]"] };
			expect(rewriteViewFilterForRename(filter, "Acme Corp.md", "Acme Holdings.md")).toBe(filter);
		});

		it("leaves a values-less (existence-check) property leaf alone", () => {
			const filter: ViewFilter = { type: "property", value: "client" };
			expect(rewriteViewFilterForRename(filter, "Acme Corp.md", "Acme Holdings.md")).toBe(filter);
		});
	});

	it("recurses through groups and rewrites only the matching leaf", () => {
		const filter: ViewFilter = {
			type: "all",
			conditions: [
				{ type: "folder", value: "Work" },
				{
					type: "none",
					conditions: [{ type: "paths", value: ["Work/secret.md"] }],
				},
			],
		};

		const rewritten = rewriteViewFilterForRename(filter, "Work/secret.md", "Archive/secret.md");

		expect(rewritten).toEqual({
			type: "all",
			conditions: [
				{ type: "folder", value: "Work" },
				{
					type: "none",
					conditions: [{ type: "paths", value: ["Archive/secret.md"] }],
				},
			],
		});
	});

	it("preserves identity through a group when nothing inside changed", () => {
		const filter: ViewFilter = {
			type: "any",
			conditions: [
				{ type: "folder", value: "Personal" },
				{ type: "tag", value: "#work" },
			],
		};

		const rewritten = rewriteViewFilterForRename(filter, "Work", "Projects");
		expect(rewritten).toBe(filter);
	});

	it("closes the fail-open this guards: a private file kept private after rename", () => {
		// Under public-by-default, `privacyFilter` lists what's PRIVATE. If a
		// rename isn't followed, the moved file drops out of that list and
		// becomes readable by untrusted providers with no corresponding edit.
		const privacyFilter: ViewFilter = { type: "paths", value: ["Journal/secret.md"] };
		const app = createMockApp(["Archive/secret.md"]);

		const rewritten = rewriteViewFilterForRename(privacyFilter, "Journal/secret.md", "Archive/secret.md");
		const stillPrivate = resolveViewFilter(app, rewritten, new Set(["Archive/secret.md"])).paths.has(
			"Archive/secret.md",
		);

		expect(stillPrivate).toBe(true);
	});
});
