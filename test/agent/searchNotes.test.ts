import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWarn = vi.fn();
const mockLexicalSearch = vi.fn();
const mockBrowse = vi.fn();
const mockGetVectorStoreService = vi.fn();
const mockGetLexicalSearchService = vi.fn();
const mockWaitForLexicalSearch = vi.fn();
const mockWaitForVectorStore = vi.fn();
const mockShouldBlockFile = vi.fn();
const mockRecentNotes: Array<{ path: string; lastOpenedAt: number }> = [];

/**
 * Recency is now scored by a note's age against a 7-day window, not by its
 * position in the history list. These fixtures only ever encoded *ordering*
 * (5_000 is "more recent than" 4_000), and as literal epoch timestamps they
 * would all read as decades stale and score zero boost.
 *
 * `recentAt` keeps the ordering the cases were written around while placing
 * every fixture inside the window: a larger value is more recent, and the
 * spacing (minutes) is small enough that all of them sit in the full-strength
 * plateau, which is what the pre-existing assertions assumed.
 */
function recentAt(order: number): number {
	// Anchored a minute back and spaced by seconds: a higher `order` is more
	// recent, and the whole spread stays well inside the full-strength plateau
	// so these cases keep exercising ranking rather than recency decay.
	return Date.now() - 60_000 + order;
}
const mockToolSettings: {
	showPath?: boolean;
	showTags?: boolean;
	showMatchBadges?: boolean;
	showMatchContext?: boolean;
} = {};

vi.mock("../../src/vectorstore", () => ({
	getVectorStoreService: () => mockGetVectorStoreService(),
	waitForVectorStore: () => mockWaitForVectorStore(),
}));

vi.mock("../../src/search/LexicalSearchService", () => ({
	getLexicalSearchService: () => mockGetLexicalSearchService(),
	waitForLexicalSearch: () => mockWaitForLexicalSearch(),
}));

vi.mock("../../src/utils/logging", () => ({
	Logger: {
		warn: (...args: unknown[]) => mockWarn(...args),
		debug: vi.fn(),
		log: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

/**
 * Whether the vault has an embedding index, as the tool sees it.
 *
 * Mutable so a test can drive the "semantic requested but unavailable" path, which is
 * the regression guard for a real bug: `waitForVectorStore()` returns true whenever the
 * *service* exists, regardless of whether any index is configured, so a semantic search
 * used to run, retrieve nothing, and report "No notes found matching …" — blaming the
 * query for a missing capability.
 *
 * Read through a getter in the mock factory rather than captured by value: `vi.mock`
 * factories are hoisted above this declaration, so a direct reference would be in the
 * temporal dead zone at factory-evaluation time.
 */
let mockSearchEmbedIndex: string | null = "openai:text-embedding-3-small";

/**
 * The description persisted in `toolsConfig`, as `normalizeAgent` would leave it. The tool
 * ignores it entirely and derives the live text instead — it's kept here so the tests can
 * assert that a stored value has no influence.
 */
let mockStoredDescription = "default description (embeddings available)";

// The two description strings are inlined rather than pulled from constants: the factory
// is hoisted above any `const` declaration, so it cannot reference one.
vi.mock("../../src/agent/tools/builtInToolDefaults", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/agent/tools/builtInToolDefaults")>()),
	getSearchNotesDescription: (hasIndex: boolean) =>
		hasIndex ? "default description (embeddings available)" : "default description (lexical only)",
}));
vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => ({
		getSearchEmbedModel: vi.fn().mockReturnValue(null),
		getEmbedModels: vi.fn().mockReturnValue({}),
		get searchEmbedIndex() {
			return mockSearchEmbedIndex;
		},
		searchShowPath: true,
		searchShowTags: true,
		searchShowMatchBadges: true,
		searchShowMatchContext: true,
		recentNotes: mockRecentNotes,
		targetFolder: "smart-second-brain",
		getSelectedAgent: () => ({
			chatModel: { provider: "openai" },
			toolsConfig: {
				search_notes: {
					name: "search_notes",
					get description() {
						return mockStoredDescription;
					},
					settings: mockToolSettings,
				},
			},
		}),
	}),
}));

vi.mock("../../src/stores/pendingChangesStore.svelte", () => ({
	getPendingChangesStore: () => ({
		shouldBlockFile: mockShouldBlockFile,
	}),
}));

import { type App, TFile } from "obsidian";
// The payload type is imported rather than re-declared here: this file used to keep its own
// copy, which drifted from the real interface (it was missing `requestedAlgorithm` and typed
// `algorithm` as a required string) and so quietly type-checked assertions against a shape
// the tool never returns.
import { createSearchNotesTool, performSearch, type SearchToolResultPayload } from "../../src/agent/tools/searchNotes";

function createLexicalService() {
	return {
		search: mockLexicalSearch,
		browse: mockBrowse,
	};
}

describe("performSearch lexical startup behavior", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockToolSettings.showPath = undefined;
		mockToolSettings.showTags = undefined;
		mockToolSettings.showMatchBadges = undefined;
		mockToolSettings.showMatchContext = undefined;
		mockRecentNotes.length = 0;
		mockSearchEmbedIndex = "openai:text-embedding-3-small";
		mockStoredDescription = "default description (embeddings available)";
		mockWaitForVectorStore.mockResolvedValue(false);
		mockWaitForLexicalSearch.mockResolvedValue(true);
		mockShouldBlockFile.mockReturnValue(false);
		mockLexicalSearch.mockResolvedValue([
			{
				path: "Notes/alpha.md",
				name: "alpha",
				tags: ["#alpha"],
				score: 12,
			},
		]);
		mockBrowse.mockResolvedValue([
			{
				path: "Notes/beta.md",
				name: "beta",
				tags: ["#beta"],
				score: 8,
			},
		]);
		mockGetLexicalSearchService.mockReturnValue(createLexicalService());
	});

	it("uses the standalone lexical index before full vector-store readiness", async () => {
		const results = await performSearch({} as App, "alpha", "lexical");

		expect(mockWaitForLexicalSearch).toHaveBeenCalledTimes(1);
		expect(mockGetLexicalSearchService).toHaveBeenCalledTimes(1);
		expect(mockLexicalSearch).toHaveBeenCalledWith("alpha", 100, undefined);
		expect(mockWaitForVectorStore).not.toHaveBeenCalled();
		// Scores are now normalized within the result set rather than passed through
		// as raw BM25 magnitudes, and rankingDebug is emitted whenever an identity
		// boost applied — so assert identity and ordering, not the exact numbers.
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			path: "Notes/alpha.md",
			name: "alpha",
			tags: ["#alpha"],
		});
	});

	it("boosts recently opened notes higher in typed search results", async () => {
		mockRecentNotes.push({ path: "Notes/recent.md", lastOpenedAt: recentAt(2000) });
		mockLexicalSearch.mockResolvedValue([
			{
				path: "Notes/older.md",
				name: "older",
				tags: ["#old"],
				matchBadges: ["title"],
				score: 10,
			},
			{
				path: "Notes/recent.md",
				name: "recent",
				tags: ["#fresh"],
				matchBadges: ["tag"],
				score: 9,
			},
		]);

		const app = {
			vault: {
				getAbstractFileByPath(path: string) {
					const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
					return Object.assign(new TFile(), { path, extension: "md", basename });
				},
			},
			metadataCache: {
				getFileCache() {
					return undefined;
				},
			},
		} as unknown as App;

		const tool = createSearchNotesTool(app);
		const result = await tool.invoke({ query: "note" });
		const parsed: SearchToolResultPayload = JSON.parse(String(result));

		expect(parsed.results[0]?.name).toBe("recent");
		expect(parsed.results[0]?.matchBadges).toEqual(["tag", "recent"]);
		expect(parsed.results[1]?.name).toBe("older");
		expect(parsed.results[1]?.matchBadges).toEqual(["title"]);
	});

	// Behaviour change (deliberate): when several results are *all* recently opened,
	// recency no longer identifies any one of them, so its influence is divided
	// among the contenders instead of applied at full strength to each. This test
	// previously asserted the weakest of three recent notes (lexical score 9 of 13)
	// should climb over a non-recent neighbour; that is the mechanism by which a
	// cluster of recently-opened near-duplicates took over the top of the results.
	// A *lone* recent note still gets full lift — see "gives the fifth recent result
	// enough lift to overtake the lexical leader", which still passes.
	it("does not let one of several equally-recent results climb on recency alone", async () => {
		mockRecentNotes.push(
			{ path: "Notes/top-recent.md", lastOpenedAt: recentAt(3000) },
			{ path: "Notes/mid-recent.md", lastOpenedAt: recentAt(2000) },
			{ path: "Notes/edge-recent.md", lastOpenedAt: recentAt(1000) },
		);
		mockLexicalSearch.mockResolvedValue([
			{
				path: "Notes/control-one.md",
				name: "control-one",
				tags: ["#one"],
				score: 13,
			},
			{
				path: "Notes/control-two.md",
				name: "control-two",
				tags: ["#two"],
				score: 11,
			},
			{
				path: "Notes/control-three.md",
				name: "control-three",
				tags: ["#three"],
				score: 10,
			},
			{
				path: "Notes/edge-recent.md",
				name: "edge-recent",
				tags: ["#edge"],
				score: 9,
			},
		]);

		const app = {
			vault: {
				getAbstractFileByPath(path: string) {
					const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
					return Object.assign(new TFile(), { path, extension: "md", basename });
				},
			},
			metadataCache: {
				getFileCache() {
					return undefined;
				},
			},
		} as unknown as App;

		const tool = createSearchNotesTool(app);
		const result = await tool.invoke({ query: "note" });
		const parsed: SearchToolResultPayload = JSON.parse(String(result));

		// Relevance order is preserved; edge-recent keeps its badge but not a lift
		// that would jump it past two better lexical matches.
		expect(parsed.results.map((entry) => entry.name)).toEqual([
			"control-one",
			"control-two",
			"control-three",
			"edge-recent",
		]);
		expect(parsed.results.find((entry) => entry.name === "edge-recent")?.matchBadges).toContain("recent");
	});

	it("keeps a much stronger lexical leader ahead of a recent note", async () => {
		mockRecentNotes.push(
			{ path: "Notes/r1.md", lastOpenedAt: recentAt(5000) },
			{ path: "Notes/r2.md", lastOpenedAt: recentAt(4000) },
			{ path: "Notes/recent-lower.md", lastOpenedAt: recentAt(3000) },
		);
		mockLexicalSearch.mockResolvedValue([
			{
				path: "Notes/lexical-top.md",
				name: "lexical-top",
				tags: ["#top"],
				score: 400,
			},
			{
				path: "Notes/runner-up.md",
				name: "runner-up",
				tags: ["#runner"],
				score: 250,
			},
			{
				path: "Notes/recent-lower.md",
				name: "recent-lower",
				tags: ["#recent"],
				score: 6,
			},
		]);

		const app = {
			vault: {
				getAbstractFileByPath(path: string) {
					const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
					return Object.assign(new TFile(), { path, extension: "md", basename });
				},
			},
			metadataCache: {
				getFileCache() {
					return undefined;
				},
			},
		} as unknown as App;

		const tool = createSearchNotesTool(app);
		const result = await tool.invoke({ query: "note" });
		const parsed: SearchToolResultPayload = JSON.parse(String(result));

		expect(parsed.results.map((entry) => entry.name)).toEqual(["lexical-top", "runner-up", "recent-lower"]);
	});

	it("gives the fifth recent result enough lift to overtake the lexical leader", async () => {
		mockRecentNotes.push(
			{ path: "Notes/r1.md", lastOpenedAt: recentAt(5000) },
			{ path: "Notes/r2.md", lastOpenedAt: recentAt(4000) },
			{ path: "Notes/r3.md", lastOpenedAt: recentAt(3000) },
			{ path: "Notes/r4.md", lastOpenedAt: recentAt(2000) },
			{ path: "Notes/recent-five.md", lastOpenedAt: recentAt(1000) },
		);
		mockLexicalSearch.mockResolvedValue([
			{
				path: "Notes/lexical-top.md",
				name: "lexical-top",
				tags: ["#top"],
				score: 10,
			},
			{
				path: "Notes/recent-five.md",
				name: "recent-five",
				tags: ["#recent"],
				score: 9,
			},
		]);

		const app = {
			vault: {
				getAbstractFileByPath(path: string) {
					const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
					return Object.assign(new TFile(), { path, extension: "md", basename });
				},
			},
			metadataCache: {
				getFileCache() {
					return undefined;
				},
			},
		} as unknown as App;

		const tool = createSearchNotesTool(app);
		const result = await tool.invoke({ query: "note" });
		const parsed: SearchToolResultPayload = JSON.parse(String(result));

		expect(parsed.results[0]?.name).toBe("recent-five");
		expect(parsed.results[0]?.matchBadges).toEqual(["recent"]);
		expect(parsed.results[1]?.name).toBe("lexical-top");
	});

	it("returns recently opened notes when recentOnly is true", async () => {
		// Spread across days rather than seconds: the boost is a function of age, so
		// two notes opened moments apart now score identically. Separating them is
		// what makes the second note's lower score meaningful.
		mockRecentNotes.push(
			{ path: "Notes/recent-one.md", lastOpenedAt: Date.now() - 60_000 },
			{ path: "Notes/recent-two.md", lastOpenedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 },
		);
		const app = {
			vault: {
				getAbstractFileByPath(path: string) {
					const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
					return Object.assign(new TFile(), { path, extension: "md", basename });
				},
			},
			metadataCache: {
				getFileCache(file: { path: string }) {
					if (file.path === "Notes/recent-one.md") {
						return { frontmatter: { aliases: ["One"] }, tags: [{ tag: "#one" }] };
					}
					return { frontmatter: undefined, tags: [{ tag: "#two" }] };
				},
			},
		} as unknown as App;

		const tool = createSearchNotesTool(app);
		const result = await tool.invoke({ recentOnly: true });
		const parsed: SearchToolResultPayload = JSON.parse(String(result));

		expect(parsed.recentOnly).toBe(true);
		expect(parsed.query).toBe("");
		expect(parsed.totalResults).toBe(2);
		expect(parsed.results).toMatchObject([
			{
				rank: 1,
				name: "recent-one",
				path: "Notes/recent-one.md",
				score: 4.5,
				frontmatter: { aliases: ["One"] },
				tags: ["#one"],
				matchBadges: ["recent"],
			},
			{
				rank: 2,
				name: "recent-two",
				path: "Notes/recent-two.md",
				tags: ["#two"],
				matchBadges: ["recent"],
			},
		]);
		// Three days old: still recent, but measurably weaker than the fresh note.
		// Asserted as a range because the value is a continuous function of age.
		const olderScore = parsed.results[1]?.score ?? 0;
		expect(olderScore).toBeGreaterThan(0);
		expect(olderScore).toBeLessThan(4.5);
		expect(parsed.results[1]).not.toHaveProperty("frontmatter");
	});

	it("returns recently opened non-markdown vault files when recentOnly is true", async () => {
		mockRecentNotes.push({ path: "Assets/recent-diagram.canvas", lastOpenedAt: recentAt(3000) });
		const app = {
			vault: {
				getAbstractFileByPath(path: string) {
					return Object.assign(new TFile(), { path, extension: "canvas", basename: "recent-diagram" });
				},
			},
			metadataCache: {
				getFileCache() {
					return undefined;
				},
			},
		} as unknown as App;

		const tool = createSearchNotesTool(app);
		const result = await tool.invoke({ recentOnly: true });
		const parsed: SearchToolResultPayload = JSON.parse(String(result));

		expect(parsed.totalResults).toBe(1);
		expect(parsed.results).toEqual([
			{
				rank: 1,
				name: "recent-diagram",
				path: "Assets/recent-diagram.canvas",
				score: 4.5,
				matchBadges: ["recent"],
			},
		]);
	});

	it("includes frontmatter tags on recent results", async () => {
		mockRecentNotes.push({ path: "Notes/frontmatter-tags.md", lastOpenedAt: recentAt(3000) });
		const app = {
			vault: {
				getAbstractFileByPath(path: string) {
					const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
					return Object.assign(new TFile(), { path, extension: "md", basename });
				},
			},
			metadataCache: {
				getFileCache() {
					return {
						frontmatter: { tags: ["project", "active"] },
						tags: [{ tag: "#inline" }],
					};
				},
			},
		} as unknown as App;

		const tool = createSearchNotesTool(app);
		const result = await tool.invoke({ recentOnly: true });
		const parsed: SearchToolResultPayload = JSON.parse(String(result));

		expect(new Set(parsed.results[0]?.tags ?? [])).toEqual(new Set(["#project", "#active", "#inline"]));
	});

	it("does not include notes that were never opened", async () => {
		const app = {
			vault: {
				getAbstractFileByPath(path: string) {
					const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
					return {
						path,
						extension: "md",
						basename,
						stat: {
							ctime: path.includes("brand-new") ? 5_000 : 1_000,
							mtime: 5_000,
							size: 0,
						},
					};
				},
				getFiles() {
					return [
						this.getAbstractFileByPath("Notes/older.md"),
						this.getAbstractFileByPath("Notes/brand-new.md"),
					];
				},
			},
			metadataCache: {
				getFileCache(file: { path: string }) {
					if (file.path === "Notes/brand-new.md") {
						return { frontmatter: { aliases: ["Fresh"] }, tags: [{ tag: "#new" }] };
					}
					return { frontmatter: undefined, tags: [{ tag: "#old" }] };
				},
			},
		} as unknown as App;

		const tool = createSearchNotesTool(app);
		const result = await tool.invoke({ recentOnly: true });
		const parsed: SearchToolResultPayload = JSON.parse(String(result));

		expect(parsed.totalResults).toBe(0);
		expect(parsed.results).toEqual([]);
	});

	it("uses the standalone lexical index for filter-only browse queries", async () => {
		const results = await performSearch({} as App, "", "lexical", { tags: ["#beta"] });

		expect(mockWaitForLexicalSearch).toHaveBeenCalledTimes(1);
		expect(mockBrowse).toHaveBeenCalledWith(100, { tags: ["#beta"] });
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			path: "Notes/beta.md",
			name: "beta",
			tags: ["#beta"],
		});
	});

	it("returns no lexical results when the search service has not started", async () => {
		mockWaitForLexicalSearch.mockResolvedValue(false);

		const results = await performSearch({} as App, "alpha", "lexical");

		expect(results).toEqual([]);
		expect(mockWarn).toHaveBeenCalledWith(
			"Lexical search is unavailable because the lexical search service is not ready",
		);
		expect(mockLexicalSearch).not.toHaveBeenCalled();
	});

	it("prefers numeric-leading title matches in hybrid ranking", async () => {
		mockWaitForVectorStore.mockResolvedValue(true);
		mockGetVectorStoreService.mockReturnValue({
			semanticSearch: vi.fn().mockResolvedValue([
				{ path: "Notes/semester-steering.md", name: "Semester Steering", score: 0.9 },
				{ path: "Notes/9-semester.md", name: "9. Semester", score: 0.85 },
			]),
		});
		mockLexicalSearch.mockResolvedValue([
			{ path: "Notes/semester-steering.md", name: "Semester Steering", score: 14 },
			{ path: "Notes/9-semester.md", name: "9. Semester", score: 13 },
		]);

		const results = await performSearch({} as App, "9 seme", "hybrid");

		expect(results[0]?.name).toBe("9. Semester");
		expect(results[1]?.name).toBe("Semester Steering");
	});

	it("prefers exact alias matches in hybrid ranking", async () => {
		mockWaitForVectorStore.mockResolvedValue(true);
		mockGetVectorStoreService.mockReturnValue({
			semanticSearch: vi.fn().mockResolvedValue([
				{ path: "Notes/launch.md", name: "Launch Overview", score: 0.92 },
				{
					path: "Notes/alias-fixture.md",
					name: "Alias Fixture",
					frontmatter: { aliases: ["Rocket Science"] },
					score: 0.84,
				},
			]),
		});
		mockLexicalSearch.mockResolvedValue([
			{ path: "Notes/launch.md", name: "Launch Overview", score: 18, matchBadges: ["content"] },
			{
				path: "Notes/alias-fixture.md",
				name: "Alias Fixture",
				frontmatter: { aliases: ["Rocket Science"] },
				matchBadges: ["alias"],
				matchExplanation: { source: "alias", text: "Alias: Rocket Science" },
				score: 14,
			},
		]);

		const results = await performSearch({} as App, "Rocket Science", "hybrid");

		expect(results[0]?.name).toBe("Alias Fixture");
		expect(results[0]?.matchBadges).toContain("alias");
	});

	it("keeps alias rescue active in hybrid ranking when lexical results are unavailable", async () => {
		mockWaitForVectorStore.mockResolvedValue(true);
		mockWaitForLexicalSearch.mockResolvedValue(false);
		mockGetVectorStoreService.mockReturnValue({
			semanticSearch: vi.fn().mockResolvedValue([
				{ path: "Notes/launch.md", name: "Launch Overview", score: 0.92 },
				{
					path: "Notes/alias-fixture.md",
					name: "Alias Fixture",
					frontmatter: { aliases: ["Rocket Science"] },
					score: 0.84,
				},
			]),
		});

		const results = await performSearch({} as App, "Rocket Science", "hybrid");

		expect(results[0]?.name).toBe("Alias Fixture");
		expect(results[0]?.rankingDebug?.finalAliasBoost).toBeGreaterThan(0);
	});

	/** A flat semantic field — the shape a meaningless query produces. */
	const flatSemanticResults = Array.from({ length: 20 }, (_, i) => ({
		path: `Notes/n${i}.md`,
		name: `N${i}`,
		score: 0.58 - i * 0.002,
	}));

	/** A peaked semantic field — one clear winner above the pack. */
	const peakedSemanticResults = [
		{ path: "Notes/answer.md", name: "Answer", score: 0.78 },
		...Array.from({ length: 19 }, (_, i) => ({
			path: `Notes/n${i}.md`,
			name: `N${i}`,
			score: 0.57 - i * 0.002,
		})),
	];

	it("keeps semantic results when lexical matched nothing", async () => {
		// A query with no literal overlap anywhere — the shape of a cross-lingual
		// or synonym-only search — must not be suppressed. Gating on lexical
		// emptiness was implemented and reverted: it silently discarded real
		// answers (see the note in `hybridSearch`).
		mockWaitForVectorStore.mockResolvedValue(true);
		mockWaitForLexicalSearch.mockResolvedValue(true);
		mockGetVectorStoreService.mockReturnValue({
			semanticSearch: vi.fn().mockResolvedValue(peakedSemanticResults),
		});
		mockLexicalSearch.mockResolvedValue([]);

		const results = await performSearch({} as App, "Zwiebelkuchen", "hybrid");

		expect(results.length).toBeGreaterThan(0);
		expect(results[0]?.name).toBe("Answer");
	});

	it("keeps semantic results even when the semantic field is flat", async () => {
		// The other half of the same decision: a flat distribution is what a
		// meaningless query produces, but it is *also* what some real queries
		// produce on some embedding models, so it cannot be used to suppress.
		mockWaitForVectorStore.mockResolvedValue(true);
		mockWaitForLexicalSearch.mockResolvedValue(true);
		mockGetVectorStoreService.mockReturnValue({
			semanticSearch: vi.fn().mockResolvedValue(flatSemanticResults),
		});
		mockLexicalSearch.mockResolvedValue([]);

		const results = await performSearch({} as App, "zzzznotarealword", "hybrid");

		expect(results.length).toBeGreaterThan(0);
	});

	it("keeps semantic results when lexical is unavailable rather than empty", async () => {
		// The guard that makes the rule above safe: a lexical service that never
		// initialised also returns nothing, but that says nothing about the query.
		// Suppressing here would break hybrid search whenever the index is not
		// ready yet.
		mockWaitForVectorStore.mockResolvedValue(true);
		mockWaitForLexicalSearch.mockResolvedValue(false);
		mockGetVectorStoreService.mockReturnValue({
			semanticSearch: vi.fn().mockResolvedValue([{ path: "Notes/real.md", name: "Real Answer", score: 0.81 }]),
		});

		const results = await performSearch({} as App, "anything", "hybrid");

		expect(results.map((r) => r.name)).toContain("Real Answer");
	});

	it("keeps results when lexical matched even a single note", async () => {
		// The gate is "lexical found nothing at all", not a score threshold — a
		// single weak lexical hit is enough corroboration to trust the semantic leg.
		mockWaitForVectorStore.mockResolvedValue(true);
		mockWaitForLexicalSearch.mockResolvedValue(true);
		mockGetVectorStoreService.mockReturnValue({
			semanticSearch: vi
				.fn()
				.mockResolvedValue([{ path: "Notes/semantic.md", name: "Semantic Hit", score: 0.7 }]),
		});
		mockLexicalSearch.mockResolvedValue([{ path: "Notes/weak.md", name: "Weak Hit", score: 0.4 }]);

		const results = await performSearch({} as App, "borderline", "hybrid");

		expect(results.length).toBeGreaterThan(0);
	});

	it("prefers recent alias-token matches over plain title-prefix matches in lexical ranking", async () => {
		mockRecentNotes.push({ path: "Notes/sap-ekx.md", lastOpenedAt: recentAt(3000) });
		mockLexicalSearch.mockResolvedValue([
			{
				path: "Notes/ekx-one.md",
				name: "EKX Steering Sync",
				matchBadges: ["title"],
				score: 308.77,
			},
			{
				path: "Notes/sap-ekx.md",
				name: "SAP Workstream",
				frontmatter: { aliases: ["SAP EKX"] },
				matchBadges: ["alias"],
				matchExplanation: { source: "alias", text: "Alias: SAP EKX" },
				score: 277.55,
			},
		]);

		const app = {
			vault: {
				getAbstractFileByPath(path: string) {
					const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
					return Object.assign(new TFile(), { path, extension: "md", basename });
				},
			},
			metadataCache: {
				getFileCache() {
					return undefined;
				},
			},
		} as unknown as App;

		const results = await performSearch(app, "ekx", "lexical");

		expect(results[0]?.name).toBe("SAP Workstream");
		expect(results[0]?.matchBadges).toContain("recent");
		expect(results[0]?.matchBadges).toContain("alias");
	});

	it("returns structured JSON with tags, match badges, and match snippets", async () => {
		mockLexicalSearch.mockResolvedValue([
			{
				path: "Notes/orbital-index.md",
				name: "orbital-index",
				frontmatter: { aliases: ["Rocket Science"] },
				tags: ["#space", "orbital-index"],
				matchBadges: ["tag", "content"],
				matchExplanation: {
					source: "content",
					heading: "Launch Checklist",
					text: "Propulsion systems need thermal checks before ignition.",
				},
				score: 12.345,
			},
		]);

		const tool = createSearchNotesTool({} as App);
		const result = await tool.invoke({ query: "propulsion" });
		const parsed: SearchToolResultPayload = JSON.parse(String(result));

		expect(parsed.query).toBe("propulsion");
		expect(parsed.recentOnly).toBe(false);
		expect(parsed.algorithm).toBe("lexical");
		expect(parsed.totalResults).toBe(1);
		expect(parsed.returnedResults).toBe(1);
		expect(parsed.results).toHaveLength(1);
		expect(parsed.results[0]).toMatchObject({
			rank: 1,
			name: "orbital-index",
			path: "Notes/orbital-index.md",
			frontmatter: { aliases: ["Rocket Science"] },
			tags: ["#space", "#orbital-index"],
			matchBadges: ["tag", "content"],
			matchExplanation: {
				source: "content",
				heading: "Launch Checklist",
				text: "Propulsion systems need thermal checks before ignition.",
			},
		});
	});

	it("drops privacy-restricted results entirely instead of exposing their path/name", async () => {
		mockLexicalSearch.mockResolvedValue([
			{
				path: "Private/launch-plan.md",
				name: "launch-plan",
				frontmatter: { owner: "red-team" },
				tags: ["#secret"],
				matchBadges: ["title", "content", "semantic"],
				matchExplanation: {
					source: "content",
					text: "Highly sensitive launch timing details.",
				},
				score: 30,
			},
			{
				path: "Notes/public-plan.md",
				name: "public-plan",
				tags: ["#public"],
				score: 20,
			},
		]);
		mockShouldBlockFile.mockImplementation((path: string) => path.startsWith("Private/"));

		const tool = createSearchNotesTool({} as App);
		const result = await tool.invoke({ query: "plan" });
		const parsed: SearchToolResultPayload = JSON.parse(String(result));

		expect(parsed.totalResults).toBe(1);
		expect(parsed.returnedResults).toBe(1);
		expect(parsed.skippedPrivateFiles).toBe(1);
		expect(parsed.results).toHaveLength(1);
		expect(parsed.results[0]).toMatchObject({
			rank: 1,
			name: "public-plan",
			path: "Notes/public-plan.md",
			tags: ["#public"],
		});
		expect(parsed.results.some((entry) => entry.name === "launch-plan" || entry.path?.includes("Private"))).toBe(
			false,
		);
	});

	it("fills the result page from beyond the raw limit when leading results are privacy-restricted", async () => {
		mockToolSettings.showPath = undefined;
		mockLexicalSearch.mockResolvedValue([
			{ path: "Private/one.md", name: "private-one", score: 30 },
			{ path: "Private/two.md", name: "private-two", score: 29 },
			{ path: "Notes/visible-one.md", name: "visible-one", score: 28 },
			{ path: "Notes/visible-two.md", name: "visible-two", score: 27 },
		]);
		mockShouldBlockFile.mockImplementation((path: string) => path.startsWith("Private/"));

		const tool = createSearchNotesTool({} as App);
		const result = await tool.invoke({ query: "plan" });
		const parsed: SearchToolResultPayload = JSON.parse(String(result));

		expect(parsed.skippedPrivateFiles).toBe(2);
		expect(parsed.results.map((entry) => entry.name)).toEqual(["visible-one", "visible-two"]);
	});

	/*
	 * Result detail is no longer per-agent configurable.
	 *
	 * The four flags still exist for the search *modal* (Settings → Search → Display),
	 * but the agent always gets all of them: it needs match context to decide what to
	 * open, and the volume is bounded by `maxResults`. Existing vaults can still have
	 * `showPath: false` persisted from before the change — `normalizeAgent` merges rather
	 * than replaces stored settings — so this pins that such a leftover cannot silently
	 * strip the agent's results down.
	 */
	it("ignores stale per-tool visibility settings and always returns full result detail", async () => {
		mockToolSettings.showPath = false;
		mockToolSettings.showTags = false;
		mockToolSettings.showMatchBadges = false;
		mockToolSettings.showMatchContext = false;

		mockLexicalSearch.mockResolvedValue([
			{
				path: "Notes/orbital-index.md",
				name: "orbital-index",
				frontmatter: { aliases: ["Rocket Science"] },
				tags: ["#space"],
				matchBadges: ["tag", "content"],
				matchExplanation: {
					source: "content",
					heading: "Launch Checklist",
					text: "Propulsion systems need thermal checks before ignition.",
				},
				score: 12.345,
			},
		]);

		const tool = createSearchNotesTool({} as App);
		const result = await tool.invoke({ query: "propulsion" });
		const parsed: SearchToolResultPayload = JSON.parse(String(result));

		// The point of this test is which fields are *present*; the score value is
		// incidental and is now a normalized fusion score rather than raw BM25.
		expect(parsed.results[0]).toMatchObject({
			rank: 1,
			name: "orbital-index",
			frontmatter: { aliases: ["Rocket Science"] },
		});
		expect(parsed.results[0]?.path).toBe("Notes/orbital-index.md");
		expect(parsed.results[0]?.tags).toEqual(["#space"]);
		expect(parsed.results[0]?.matchBadges).toEqual(["tag", "content"]);
		expect(parsed.results[0]?.matchExplanation).toMatchObject({ heading: "Launch Checklist" });
	});
});

/*
 * The `algorithm` parameter and its availability handling.
 *
 * Retrieval strategy moved from a per-agent setting to a per-call parameter because
 * there is no globally right answer — on the graded benchmark semantic wins the core
 * tier while hybrid wins the hard tier, neither significantly. The caller holds the
 * query context that decides it.
 *
 * The availability half fixes a real bug rather than guarding a new feature: see the
 * comment on `mockSearchEmbedIndex`.
 */
describe("search_notes algorithm parameter", () => {
	/**
	 * A vector store that is configured, initialized and populated — the only state in
	 * which a semantic request runs as asked.
	 *
	 * `getStats` is part of the contract because a configured index id is necessary but
	 * not sufficient: `semanticSearch` returns a bare `[]` for six different failure
	 * conditions, and `[]` is indistinguishable from "no matches".
	 */
	function semanticStore(
		results: Array<{ path: string; name: string; score: number }>,
		stats: { isReady?: boolean; documentCount?: number } = {},
	) {
		mockWaitForVectorStore.mockResolvedValue(true);
		const semanticSearch = vi.fn().mockResolvedValue(results);
		const getStats = vi.fn().mockResolvedValue({
			isReady: stats.isReady ?? true,
			documentCount: stats.documentCount ?? 42,
			providerId: "openai",
			modelId: "text-embedding-3-small",
		});
		mockGetVectorStoreService.mockReturnValue({ semanticSearch, getStats });
		return semanticSearch;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mockToolSettings.showPath = undefined;
		mockToolSettings.showTags = undefined;
		mockToolSettings.showMatchBadges = undefined;
		mockToolSettings.showMatchContext = undefined;
		mockRecentNotes.length = 0;
		mockSearchEmbedIndex = "openai:text-embedding-3-small";
		mockStoredDescription = "default description (embeddings available)";
		mockWaitForVectorStore.mockResolvedValue(false);
		mockWaitForLexicalSearch.mockResolvedValue(true);
		mockShouldBlockFile.mockReturnValue(false);
		mockGetLexicalSearchService.mockReturnValue({ search: mockLexicalSearch, browse: mockBrowse });
		mockLexicalSearch.mockResolvedValue([{ path: "Notes/alpha.md", name: "alpha", score: 12 }]);
	});

	it("defaults to lexical when the caller passes no algorithm", async () => {
		const semanticSearch = semanticStore([{ path: "Notes/sem.md", name: "sem", score: 0.9 }]);

		const tool = createSearchNotesTool({} as App);
		const parsed: SearchToolResultPayload = JSON.parse(String(await tool.invoke({ query: "alpha" })));

		expect(parsed.algorithm).toBe("lexical");
		expect(semanticSearch).not.toHaveBeenCalled();
		expect(mockLexicalSearch).toHaveBeenCalled();
	});

	it("runs the requested algorithm when an embedding index exists", async () => {
		const semanticSearch = semanticStore([{ path: "Notes/sem.md", name: "sem", score: 0.9 }]);

		const tool = createSearchNotesTool({} as App);
		const parsed: SearchToolResultPayload = JSON.parse(
			String(await tool.invoke({ query: "alpha", algorithm: "semantic" })),
		);

		expect(parsed.algorithm).toBe("semantic");
		expect(parsed.requestedAlgorithm).toBeUndefined();
		expect(parsed.message).toBeUndefined();
		expect(semanticSearch).toHaveBeenCalled();
		// Semantic mode is single-source: no lexical leg at all.
		expect(mockLexicalSearch).not.toHaveBeenCalled();
	});

	it("downgrades semantic to lexical and explains why when no index is configured", async () => {
		mockSearchEmbedIndex = null;
		const semanticSearch = semanticStore([{ path: "Notes/sem.md", name: "sem", score: 0.9 }]);

		const tool = createSearchNotesTool({} as App);
		const parsed: SearchToolResultPayload = JSON.parse(
			String(await tool.invoke({ query: "alpha", algorithm: "semantic" })),
		);

		expect(parsed.algorithm).toBe("lexical");
		expect(parsed.requestedAlgorithm).toBe("semantic");
		expect(parsed.message).toMatch(/no embedding index is configured/i);
		// The agent must be told not to keep retrying a capability that cannot appear.
		expect(parsed.message).toMatch(/do not retry/i);
		expect(semanticSearch).not.toHaveBeenCalled();
		// Crucially it still returns results, rather than an empty set blamed on the query.
		expect(parsed.results.length).toBeGreaterThan(0);
	});

	it("downgrades hybrid the same way", async () => {
		mockSearchEmbedIndex = null;

		const tool = createSearchNotesTool({} as App);
		const parsed: SearchToolResultPayload = JSON.parse(
			String(await tool.invoke({ query: "alpha", algorithm: "hybrid" })),
		);

		expect(parsed.algorithm).toBe("lexical");
		expect(parsed.requestedAlgorithm).toBe("hybrid");
	});

	it("does not claim a downgrade for an explicit lexical request", async () => {
		mockSearchEmbedIndex = null;

		const tool = createSearchNotesTool({} as App);
		const parsed: SearchToolResultPayload = JSON.parse(
			String(await tool.invoke({ query: "alpha", algorithm: "lexical" })),
		);

		expect(parsed.algorithm).toBe("lexical");
		expect(parsed.requestedAlgorithm).toBeUndefined();
		expect(parsed.message).toBeUndefined();
	});

	it("reports the downgrade even when the fallback finds nothing", async () => {
		// The failure this exists to prevent: an empty semantic result set being reported
		// as "no notes found", which reads as a fact about the query rather than about a
		// missing capability, and sends the agent off reformulating for no reason.
		mockSearchEmbedIndex = null;
		mockLexicalSearch.mockResolvedValue([]);

		const tool = createSearchNotesTool({} as App);
		const parsed: SearchToolResultPayload = JSON.parse(
			String(await tool.invoke({ query: "nothing matches this", algorithm: "semantic" })),
		);

		expect(parsed.results).toHaveLength(0);
		expect(parsed.requestedAlgorithm).toBe("semantic");
		expect(parsed.message).toMatch(/no embedding index is configured/i);
		expect(parsed.message).toMatch(/also found no notes/i);
	});

	it("describes the tool differently depending on whether embeddings are available", async () => {
		const withIndex = createSearchNotesTool({} as App).description;
		mockSearchEmbedIndex = null;
		const withoutIndex = createSearchNotesTool({} as App).description;

		expect(withIndex).not.toBe(withoutIndex);
		expect(withoutIndex).toMatch(/lexical only/i);
	});

	/*
	 * The description is always derived from live state, never read back from the stored
	 * config.
	 *
	 * Tool descriptions aren't user-editable — ToolConfigForm renders no input for them — so
	 * a stored value is only ever a cached shipped default. Honouring it would freeze the
	 * tool at whichever variant was current when the config was last written, which is
	 * exactly the bug the old "is it still a known default?" Set existed to work around
	 * (#401 removed the Set along with the need for it).
	 */
	it("ignores a stored description and always derives from the live index state", async () => {
		mockStoredDescription = "a stale description cached in the agent config";

		const withIndex = createSearchNotesTool({} as App).description;
		mockSearchEmbedIndex = null;
		const withoutIndex = createSearchNotesTool({} as App).description;

		expect(withIndex).not.toBe(mockStoredDescription);
		expect(withoutIndex).not.toBe(mockStoredDescription);
		expect(withoutIndex).toMatch(/lexical only/i);
	});

	/*
	 * A configured index id is necessary but NOT sufficient.
	 *
	 * `semanticSearch` returns a bare `[]` when the index is uninitialized, has no
	 * instance, no model, no embeddings, the query is too large, or a provider call
	 * threw — and `[]` reads identically to "this query has no matches". Reporting the
	 * latter for the former makes the agent treat an infrastructure failure as evidence
	 * about the vault's contents. These pin the distinction per cause, because the retry
	 * advice differs: a missing index cannot appear mid-conversation, but a building one
	 * can finish.
	 */
	it("downgrades when the index is configured but not initialized", async () => {
		semanticStore([], { isReady: false });

		const tool = createSearchNotesTool({} as App);
		const parsed = JSON.parse(String(await tool.invoke({ query: "alpha", algorithm: "semantic" })));

		expect(parsed.algorithm).toBe("lexical");
		expect(parsed.requestedAlgorithm).toBe("semantic");
		expect(parsed.message).toMatch(/could not be initialized/i);
		// Must NOT tell the agent this is permanent — a provider can come back.
		expect(parsed.message).not.toMatch(/do not retry/i);
		expect(parsed.results.length).toBeGreaterThan(0);
	});

	/*
	 * An empty index must NOT downgrade.
	 *
	 * `ensureIndex` builds on demand — `if (count === 0 …) await this.buildFullIndex(...)`
	 * — so a configured-but-empty index is a first search that populates it and then
	 * answers normally. An availability check that rejects on `documentCount === 0`
	 * preempts that build and reports a permanent-sounding failure for a state that
	 * resolves itself.
	 */
	it("does not downgrade an empty index — the search builds it on demand", async () => {
		const semanticSearch = semanticStore([{ path: "Notes/sem.md", name: "sem", score: 0.9 }], {
			documentCount: 0,
		});

		const tool = createSearchNotesTool({} as App);
		const parsed = JSON.parse(String(await tool.invoke({ query: "alpha", algorithm: "hybrid" })));

		expect(semanticSearch).toHaveBeenCalled();
		expect(parsed.algorithm).toBe("hybrid");
		expect(parsed.requestedAlgorithm).toBeUndefined();
		expect(parsed.message).toBeUndefined();
	});

	it("downgrades rather than throwing when availability cannot be determined", async () => {
		mockWaitForVectorStore.mockResolvedValue(true);
		mockGetVectorStoreService.mockReturnValue({
			semanticSearch: vi.fn(),
			getStats: vi.fn().mockRejectedValue(new Error("index failed to open")),
		});

		const tool = createSearchNotesTool({} as App);
		const parsed = JSON.parse(String(await tool.invoke({ query: "alpha", algorithm: "semantic" })));

		expect(parsed.algorithm).toBe("lexical");
		expect(parsed.requestedAlgorithm).toBe("semantic");
		expect(parsed.results.length).toBeGreaterThan(0);
	});

	/*
	 * `recentOnly` returns the recent-note history and never searches, so no algorithm
	 * applies. Resolving one anyway labelled the history as lexical output and, on an
	 * empty history, claimed a search found nothing for a search that never ran —
	 * sending the agent off to reformulate a query that was never used.
	 */
	it("does not claim a downgrade for a recentOnly call", async () => {
		mockSearchEmbedIndex = null;

		const tool = createSearchNotesTool({} as App);
		const parsed = JSON.parse(String(await tool.invoke({ recentOnly: true, algorithm: "semantic" })));

		// The point of the fix: no downgrade metadata for a path that never searched,
		// and no `algorithm` either — labelling plain history as lexical/semantic/hybrid
		// retrieval output is false, and `algorithm` is a field consumers trust.
		expect(parsed.algorithm).toBeUndefined();
		expect(parsed.requestedAlgorithm).toBeUndefined();
		expect(parsed.message).not.toMatch(/semantic search is unavailable/i);
	});

	it("reports no algorithm for recentOnly even when the index is healthy", async () => {
		semanticStore([{ path: "Notes/sem.md", name: "sem", score: 0.9 }]);

		const tool = createSearchNotesTool({} as App);
		const parsed = JSON.parse(String(await tool.invoke({ recentOnly: true, algorithm: "semantic" })));

		expect(parsed.algorithm).toBeUndefined();
		expect(parsed.recentOnly).toBe(true);
	});

	it("explains an empty recentOnly result as history, not a failed search", async () => {
		mockSearchEmbedIndex = null;

		const tool = createSearchNotesTool({} as App);
		const parsed = JSON.parse(String(await tool.invoke({ recentOnly: true, algorithm: "hybrid" })));

		expect(parsed.results).toHaveLength(0);
		expect(parsed.message).toMatch(/not a search/i);
		expect(parsed.message).not.toMatch(/try a different search term/i);
	});
});

/*
 * `maxResults` is a per-call parameter for the same reason as `algorithm`: "find the
 * note about X" wants a handful and "what do I have on Y" wants a page, and only the
 * caller knows which. It is clamped rather than rejected — a model asking for 100 means
 * "as many as you can", and failing the call over it helps nobody.
 */
describe("search_notes maxResults parameter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRecentNotes.length = 0;
		mockSearchEmbedIndex = null;
		mockStoredDescription = "default description (embeddings available)";
		mockWaitForVectorStore.mockResolvedValue(false);
		mockWaitForLexicalSearch.mockResolvedValue(true);
		mockShouldBlockFile.mockReturnValue(false);
		mockGetLexicalSearchService.mockReturnValue({ search: mockLexicalSearch, browse: mockBrowse });
		mockLexicalSearch.mockResolvedValue(
			Array.from({ length: 40 }, (_, i) => ({ path: `Notes/n${i}.md`, name: `n${i}`, score: 100 - i })),
		);
	});

	it("defaults to 10 when the caller does not ask", async () => {
		const tool = createSearchNotesTool({} as App);
		const parsed = JSON.parse(String(await tool.invoke({ query: "alpha" })));

		expect(parsed.maxResults).toBe(10);
		expect(parsed.results).toHaveLength(10);
	});

	it("honours a caller-supplied value", async () => {
		const tool = createSearchNotesTool({} as App);
		const parsed = JSON.parse(String(await tool.invoke({ query: "alpha", maxResults: 3 })));

		expect(parsed.results).toHaveLength(3);
	});

	it("clamps above the ceiling instead of failing", async () => {
		const tool = createSearchNotesTool({} as App);
		const parsed = JSON.parse(String(await tool.invoke({ query: "alpha", maxResults: 500 })));

		expect(parsed.maxResults).toBe(25);
		expect(parsed.results).toHaveLength(25);
	});

	it("clamps a non-positive value to at least one result", async () => {
		const tool = createSearchNotesTool({} as App);
		const parsed = JSON.parse(String(await tool.invoke({ query: "alpha", maxResults: 0 })));

		expect(parsed.results).toHaveLength(1);
	});
});
