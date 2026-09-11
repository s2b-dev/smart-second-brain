<script lang="ts">
import { untrack, tick, onDestroy } from "svelte";
import { getAllTags, Notice, TFile, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import { settingsAction, showActionNotice } from "../../utils/actionNotice";
import { getPlugin } from "../../stores/state.svelte";
import { getData } from "../../stores/dataStore.svelte";
import { getIndexableVaultFiles, isAgentFilePath, isEmbeddableFile } from "../../utils/fileFiltering";
import { Logger } from "../../utils/logging";
import { isMobileUI } from "../../utils/platform";
import { ConfirmModal } from "../modal/ConfirmModal";
import {
	type GraphData,
	type GraphEdge,
	type GraphNode,
	type SpaceSegment,
	type SmartGraphSettings,
	DEFAULT_SMART_GRAPH_SETTINGS,
	generateClusterColors,
	THEME_COLOR_VARS,
} from "../../types/graph";
import {
	buildWikiGraph,
	buildSemanticEdges,
	resolveSegments,
	type GraphFilter,
} from "../../views/smart-graph/graphDataBuilder";
import { getVectorStoreService, waitForVectorStore, waitForVectorStoreIndex } from "../../vectorstore";
import {
	labelTopics,
	topicMembershipKey,
	TITLES_PER_TOPIC,
	type TopicToLabel,
} from "../../views/smart-graph/topicLabeler";
import {
	buildTopicHierarchy,
	coarseResolutionFor,
	deriveGranularityLadder,
	maxGranularityLevel,
	MIN_GRANULARITY_LEVEL,
	resolutionToGranularity,
	summarizePartition,
	GRANULARITY_LEVEL_RESOLUTIONS,
	GRANULARITY_PROBE_RESOLUTIONS,
	granularityToResolution,
	type TopicHierarchy,
} from "../../utils/topicHierarchy";
import { computeNodeDegrees, edgeKey, graphTopologySignature, isTagNode } from "../../utils/graphUtils";
import { openTagSearch } from "../../utils/tagSearch";
import {
	applyWikiPatch,
	queryNoteSemanticEdges,
	replaceSemanticEdgesForPaths,
	voteNodeCommunity,
} from "../../utils/liveGraphPatch";
import {
	clearCachedPartitions,
	ensureActiveGraphCache,
	getActiveGraphSignature,
	getCachedGranularityLadder,
	getCachedPartition,
	getCachedResolution,
	getCachedSemanticEdges,
	getTopicLabelCache,
	loadPersistedTopicCaches,
	scheduleTopicCacheSave,
	setCachedGranularityLadder,
	setCachedPartition,
	setCachedResolution,
	setCachedSemanticEdges,
	swapActiveGraphCache,
} from "../../views/smart-graph/topicCaches";
import { buildCollapsedGraph, UNSORTED_CLUSTER } from "../../utils/mergeNodes";
import { leidenAsync } from "../../utils/computeWorkerManager";
import { VIEW_TYPE_CHAT } from "../../views/chat/Chat";
import { VIEW_TYPE_SMART_GRAPH } from "../../views/smart-graph/SmartGraphView";
import { getSessionRegistry } from "../../stores/chatStore.svelte";
import LoadingAnimation from "../ui/LoadingAnimation.svelte";
import BottomSheet from "../ui/BottomSheet.svelte";
import Button from "../ui/Button.svelte";
import GraphCanvas from "./GraphCanvas.svelte";
import GraphControls from "./GraphControls.svelte";

const plugin = getPlugin();
const data = getData();

// Start restoring persisted topic caches immediately so the IndexedDB read
// overlaps mounting; buildGraph awaits the same promise before reading them.
void loadPersistedTopicCaches();

// Graph state

let settings: SmartGraphSettings = $derived({
	...DEFAULT_SMART_GRAPH_SETTINGS,
	...(data.smartGraphSettings ?? {}),
});
let isLoading = $state(false);
/**
 * True while a Leiden compute is in flight (fresh runs only; cache hits are effectively instant
 * and don't set this). Used to short-circuit the atom toggle and prevent racing state writes.
 */
let isLeidenRunning = $state(false);
let loadingMessage = $state("Building graph...");
let defaultClusterLabels: Record<number, string> = $state({});

/** Fine topic → parent topic nesting derived from the two levels. */
let topicHierarchy: TopicHierarchy | null = $state(null);

/**
 * The granularity slider's rungs for this vault, derived by probing (see
 * {@link deriveGranularityLevels}). Holds the static fallback until probing lands; the
 * slider stays hidden until then so its range never changes under the user.
 */
let granularityLadder: number[] = $state([...GRANULARITY_LEVEL_RESOLUTIONS]);

/**
 * True once probing has settled the ladder for the current graph. Gates both the
 * slider's appearance and the probe itself, so dragging can't re-trigger it.
 */
let hasDerivedGranularityLadder = $state(false);

/** Guards against overlapping probe runs while one is already in flight. */
let isDerivingGranularityLadder = false;

/**
 * Set after a build's initial fit, cleared when the first topics arrive.
 *
 * The initial fit necessarily frames a graph that has no topics yet; once Leiden
 * assigns them the cluster force reshapes everything, so the camera needs one
 * more pass to follow.
 */
let refitAfterTopicsSettle = false;

// Leiden community state — computed async in worker, cleared on graph rebuild
let leidenCommunities: Record<string, number> = $state({});

// (The Leiden cache, graph signature, semantic edge cache and topic label
// cache live in `topicCaches` — module-scoped so they survive view reopen,
// and persisted to IndexedDB so they survive an Obsidian restart too.)

// Filter state
let selectedFolders: string[] = $state([]);
let selectedTags: string[] = $state([]);
let selectedExtensions: string[] = $state([]);

// Available filters
let availableFolders: string[] = $state([]);
let availableTags: string[] = $state([]);
let availableExtensions: string[] = $state([]);

// Canvas ref
let canvasComponent: GraphCanvas | undefined = $state(undefined);

// Lasso / selection state
let lassoMode = $state(false);
let selectedPaths: string[] = $state([]);
let immersePaths: Set<string> | null = $state(null);
let isImmersed: boolean = $derived(immersePaths !== null);

/**
 * Live width of the graph toolbar, reported by GraphControls. The mobile
 * immerse banner shares the top strip with that toolbar and has to stop short
 * of it: the toolbar is right-aligned and its width varies with the button
 * count (immersing adds an exit button) and with wrapping on narrow phones, so
 * a hardcoded reservation goes stale the moment either changes.
 */
let toolbarWidth = $state(0);
/**
 * What the user immersed *into*, when that was topics rather than a raw lasso.
 *
 * Snapshotted at immerse time because the thing it names stops existing the
 * moment we immerse: the subset gets re-segmented into its own topics under its
 * own cluster ids, so `focusedClusters` (cleared anyway by the reset) could not
 * be resolved back to these names afterwards. Null means the selection wasn't a
 * topic selection, and the bar falls back to counting notes.
 */
let immerseTopicLabels: string[] | null = $state(null);
let focusedClusters: Set<number> = $state(new Set());

// Whether a chat view is currently *visible* to the user. Graph selection is
// ambient (it shows in any open chat automatically), so the selection bar only
// needs an explicit "Open in Chat" action when there's no chat the user can
// currently see. A chat leaf parked in a collapsed sidebar (or hidden background
// tab) doesn't count. Tracked reactively via workspace listeners since
// getLeavesOfType() isn't reactive.
let hasOpenChat = $state(false);
function isLeafVisible(leaf: WorkspaceLeaf): boolean {
	const el = (leaf as { containerEl?: HTMLElement }).containerEl;
	if (el?.style.display === "none") return false;
	const root = leaf.getRoot();
	const { leftSplit, rightSplit } = plugin.app.workspace;
	// In a sidebar → only visible when that sidebar isn't collapsed.
	if (root === leftSplit) return !(leftSplit as { collapsed?: boolean }).collapsed;
	if (root === rightSplit) return !(rightSplit as { collapsed?: boolean }).collapsed;
	// Main editor area → visible unless the tab is hidden behind another (display:none).
	return true;
}
function refreshHasOpenChat() {
	hasOpenChat = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT).some(isLeafVisible);
}
refreshHasOpenChat();
const chatOpenEventRefs = [
	plugin.app.workspace.on("layout-change", refreshHasOpenChat),
	plugin.app.workspace.on("active-leaf-change", refreshHasOpenChat),
	// Collapsing/expanding a sidebar fires `resize` but not layout-change, so this
	// is what keeps the button in sync when the user toggles the chat sidebar.
	plugin.app.workspace.on("resize", refreshHasOpenChat),
];
onDestroy(() => {
	for (const ref of chatOpenEventRefs) plugin.app.workspace.offref(ref);
});

/**
 * Upper bound on notes for semantic edge building.
 *
 * Neighbour search is HNSW-accelerated past ~2k chunks (see
 * `computeSemanticPairs`), so the old O(n²) time wall is gone. What remains is
 * memory: the store's worker gathers every on-screen chunk vector into one flat
 * batch for the scan, roughly notes × chunks-per-note × dim × 4 bytes — on the
 * order of 150 MB at this cap with dim 1024, transiently, on top of the resident
 * index. Past it that batch itself becomes the problem and the graph stays
 * wiki-only.
 */
const SEMANTIC_EDGE_MAX_NOTES = 20000;

/**
 * Minimum fraction of on-screen nodes a cached partition must still cover to
 * be painted as interim topics while the real segmentation computes. High
 * enough that a heavily changed vault paints honestly grey instead of mostly
 * wrong; low enough that everyday edits between sessions keep instant topics.
 */
const INTERIM_TOPIC_MIN_COVERAGE = 0.8;

/**
 * Scales cosine similarity into the same range as authored-link weights for
 * community detection. Below 1.0 so an explicit `[[link]]` stays the stronger
 * statement about how two notes relate.
 */
const SEMANTIC_LEIDEN_WEIGHT = 0.7;

/**
 * Colour for the folded "Unsorted" node — deliberately neutral so it reads as
 * leftovers rather than as another topic competing for attention.
 */
const UNSORTED_NODE_COLOR = "hsl(0, 0%, 55%)";

// Topics are always segmented by Leiden community; there is no other mode.
let segments: SpaceSegment[] = $state([]);
let focusedSegmentIds: Set<string> = $state(new Set());

/** LLM-generated topic names, keyed by topic id. Overrides the hub-filename default. */
let generatedClusterLabels: Record<number, string> = $state({});
/** True while topic labels are being generated. */
let isLabeling = $state(false);
/** Aborts an in-flight labeling pass when the graph changes underneath it. */
let labelingAbort: AbortController | null = null;

let effectiveClusterLabels: Record<number, string> = $derived({
	...defaultClusterLabels,
	...generatedClusterLabels,
});

/**
 * `segments` with the current topic names applied.
 *
 * The label baked into a segment is the hub-filename default, fixed at the
 * moment Leiden resolved. AI names arrive later and only ever landed in
 * `effectiveClusterLabels`, so the canvas pills renamed themselves while the
 * panel's list kept the old names. Deriving the panel's copy keeps one source of
 * truth for what a topic is called. A segment's index *is* its cluster id (they
 * are assigned `cluster: i` from this same array in `resolveAndApplySegments`).
 */
let labeledSegments: SpaceSegment[] = $derived(
	segments.map((segment, cluster) => {
		const label = effectiveClusterLabels[cluster];
		return label === undefined || label === segment.label ? segment : { ...segment, label };
	}),
);

let graphData: GraphData = $state({ nodes: [], edges: [] });

/**
 * Which topics are folded into a single node.
 *
 * Collapse is per-topic: clicking a topic's label folds just that group, and
 * the atom button is a shortcut that folds or unfolds them all at once. Tracking
 * the collapsed set directly (rather than a global flag plus exceptions) keeps
 * the two entry points consistent — whatever the user does, this set is the
 * single answer to "what is folded right now".
 *
 * Independent of granularity: granularity decides *how many* topics exist, this decides
 * whether each is drawn as a group or as its notes.
 */
let collapsedTopics: Set<number> = $state(new Set());

/** All topic ids currently present, for collapse-all / expand-all. */
let allTopicIds: number[] = $derived.by(() => {
	const ids = new Set(graphData.nodes.map((node) => node.cluster).filter((c): c is number => c != null));
	// Notes with no topic are foldable too — in the merged view they'd otherwise
	// sit among the topic nodes looking like topics of their own. (Tags never
	// have a topic and never fold, so they don't make an "Unsorted" group.)
	if (graphData.nodes.some((node) => !isTagNode(node) && node.cluster == null)) ids.add(UNSORTED_CLUSTER);
	return [...ids].sort((a, b) => a - b);
});

/**
 * Collapse-all as a *mode* rather than an enumerated set.
 *
 * Storing "every id at the time you pressed it" breaks under granularity: changing γ
 * re-runs Leiden, which both invents new topics and renumbers existing ones, so
 * a stored id set stops describing the graph almost immediately. As a mode, any
 * topic the new resolution produces is collapsed too — which is what the button
 * claims to mean.
 *
 * `expandedTopics` holds the exceptions the user has opened by hand.
 */
let collapseAll = $state(false);
/** Topics explicitly opened while collapse-all is on. */
let expandedTopics: Set<number> = $state(new Set());

/** The effective collapsed set for the current graph. */
let effectiveCollapsedTopics: Set<number> = $derived(
	collapseAll ? new Set(allTopicIds.filter((id) => !expandedTopics.has(id))) : collapsedTopics,
);

/** True when the graph is in collapse-all mode — drives the atom button. */
let isTopicsCollapsed = $derived(collapseAll);

/**
 * Collapse/expand in the selection bar acts on whole *topics*, so it's offered
 * only for a topic selection (`focusedClusters`), not an arbitrary lasso — a
 * freehand selection that happens to cover a topic's notes isn't the same as
 * choosing that topic, and folding it would surprise.
 *
 * The button expands when every selected topic is already collapsed, and
 * collapses otherwise, so a mixed selection resolves to one obvious action.
 */
let selectedTopicsCollapseAction: "collapse" | "expand" | null = $derived.by(() => {
	if (focusedClusters.size === 0) return null;
	const allCollapsed = [...focusedClusters].every((c) => effectiveCollapsedTopics.has(c));
	return allCollapsed ? "expand" : "collapse";
});

/** The graph as rendered: topics collapsed to single nodes, or as-is. */
let displayGraphData: GraphData = $derived.by(() => {
	// Collapsing is meaningless with topics hidden: every node is unsorted, so
	// folding would merge the whole graph into one "Unsorted · N" node instead of
	// showing the raw view the toggle is for. `handleSettingsChange` already
	// clears the folds when topics are switched off, but this guard is what makes
	// the bad state unreachable — any other path that leaves collapse state set
	// (a restored setting, a rebuild) can't resurrect it.
	if (!(settings.showTopics ?? true)) return graphData;
	if (effectiveCollapsedTopics.size === 0) return graphData;
	return buildCollapsedGraph(graphData, {
		collapsedTopics: effectiveCollapsedTopics,
		topicLabels: effectiveClusterLabels,
		collapseUnsorted: true,
		unsortedColor: UNSORTED_NODE_COLOR,
	});
});

/**
 * How many notes the graph holds. `graphData.nodes` also carries tag nodes when
 * tags are shown, and those aren't notes for any purpose here — counts shown to
 * the user, the semantic-scan ceiling, the drift threshold.
 */
let noteNodeCount = $derived(graphData.nodes.reduce((count, node) => (isTagNode(node) ? count : count + 1), 0));

/** Options for the wiki graph build, from the scope settings. */
function wikiGraphOptions() {
	return { includeTags: settings.showTags ?? false };
}

// Build cancellation — abort stale builds when a new one starts
let currentBuild: AbortController | null = null;

// Generation guard for async continuations. Bumped by every new build and by
// onDestroy, so a slow await (buildWikiGraph tick, leidenAsync) that resolves
// after a newer build started — or after the view was
// closed — bails instead of writing stale state over the current graph or onto
// a destroyed component. AbortController alone was insufficient: it was only
// checked in the catch, so success-path writes ran unconditionally.
let buildVersion = 0;
let isDestroyed = false;

function getFilter(): GraphFilter {
	// `markdownOnly` narrows to just .md; explicit extension picks (if any) still win.
	const extensions = selectedExtensions.length > 0 ? selectedExtensions : settings.markdownOnly ? ["md"] : undefined;
	return {
		folders: selectedFolders.length > 0 ? selectedFolders : undefined,
		tags: selectedTags.length > 0 ? selectedTags : undefined,
		extensions,
	};
}

function createAutoRebuildSignature(filter: GraphFilter): string {
	return JSON.stringify({
		folders: [...(filter.folders ?? [])].sort(),
		tags: [...(filter.tags ?? [])].sort(),
		extensions: [...(filter.extensions ?? [])].sort(),
		showWikiLinks: settings.showWikiLinks,
		markdownOnly: settings.markdownOnly,
		showTags: settings.showTags ?? false,
	});
}

/** Resolve the current theme colour palette from CSS variables. */
function resolveThemeColors(): string[] {
	const style = getComputedStyle(document.body);
	return THEME_COLOR_VARS.map((v) => style.getPropertyValue(v).trim()).filter(Boolean);
}

/**
 * Gather available folder and tag options from the vault.
 */
function loadFilterOptions() {
	const vaultFiles = getIndexableVaultFiles(plugin.app.vault);

	// Folders: Get unique top-level and second-level folders
	const folders = new Set<string>();
	for (const file of vaultFiles) {
		const parts = file.path.split("/");
		if (parts.length > 1) {
			folders.add(parts[0]);
			if (parts.length > 2) {
				folders.add(`${parts[0]}/${parts[1]}`);
			}
		}
	}
	availableFolders = [...folders].sort();

	// Tags: Get all unique tags from the vault (only md files have metadata)
	const tags = new Set<string>();
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		if (isAgentFilePath(file.path)) continue;
		const cache = plugin.app.metadataCache.getFileCache(file);
		if (cache) {
			const fileTags = getAllTags(cache) ?? [];
			for (const tag of fileTags) {
				tags.add(tag);
			}
		}
	}
	availableTags = [...tags].sort();

	// Extensions: Get all unique file extensions from the vault
	const extensions = new Set<string>();
	for (const file of vaultFiles) {
		extensions.add(file.extension.toLowerCase());
	}
	availableExtensions = [...extensions].sort();
}

/**
 * Fetch semantic similarity edges for the current node set.
 *
 * Returns an empty list (rather than throwing) whenever embeddings aren't
 * usable — no graph index configured, the store never came up, or the index
 * hasn't finished building. The graph stays wiki-only in that case.
 */
async function loadSemanticEdges(wikiData: GraphData, localBuildVersion: number): Promise<GraphEdge[]> {
	if (!data.graphEmbedIndex) return [];
	// Only notes have embeddings; tag nodes are neither scanned nor counted.
	const noteNodes = wikiData.nodes.filter((node) => !isTagNode(node));
	if (noteNodes.length < 2 || noteNodes.length > SEMANTIC_EDGE_MAX_NOTES) return [];

	const serviceReady = await waitForVectorStore();
	if (!serviceReady || localBuildVersion !== buildVersion) return [];

	const indexReady = await waitForVectorStoreIndex(data.graphEmbedIndex);
	if (!indexReady || localBuildVersion !== buildVersion) return [];

	const inst = await getVectorStoreService()
		.getOrCreateInstance(data.graphEmbedIndex)
		.catch(() => null);
	if (!inst || localBuildVersion !== buildVersion) return [];

	// The search is pure over (wiki graph, semantic settings, embeddings). The
	// index's lastUpdated stamp bumps on every vector write, so together these
	// fully key the result — a reopen or no-change Refresh skips re-running the
	// neighbour search inside the store.
	const metadata = await inst.store.getMetadata().catch(() => null);
	if (localBuildVersion !== buildVersion) return [];
	const cacheKey = [
		graphTopologySignature(wikiData),
		data.graphEmbedIndex,
		metadata?.lastUpdated ?? "no-metadata",
		settings.semanticNeighborCount,
		settings.semanticThreshold,
	].join("|");
	// Keyed (not single-slot), so both sides of an immerse or filter round-trip
	// keep their edge sets and the return leg is served from cache.
	const cachedEdges = getCachedSemanticEdges(cacheKey);
	if (cachedEdges) return cachedEdges;

	// Only connect notes that are actually on screen, and never duplicate a pair
	// the user already linked by hand. The store scans its own vectors and
	// returns pairs; no embedding is copied to this thread.
	const includePaths = new Set(noteNodes.map((node) => node.path));
	const wikiEdgeKeys = new Set(wikiData.edges.map((edge) => edgeKey(edge.source, edge.target)));

	const edges = await buildSemanticEdges(inst.store, includePaths, {
		neighborCount: settings.semanticNeighborCount,
		threshold: settings.semanticThreshold,
		excludeEdgeKeys: wikiEdgeKeys,
	});
	setCachedSemanticEdges(cacheKey, edges);
	scheduleTopicCacheSave();
	return edges;
}

/**
 * Build the graph structure and apply topic assignments.
 *
 * The wiki graph paints immediately so the view is never blank, then semantic
 * edges are fused in once embeddings resolve and Leiden runs over the union.
 * Topic detection therefore sees inferred relationships too, which is what lets
 * unlinked notes land in a topic at all.
 */
async function buildGraph() {
	currentBuild?.abort();
	const ac = new AbortController();
	currentBuild = ac;
	const localBuildVersion = ++buildVersion;
	isLoading = true;
	loadingMessage = "Building graph...";

	try {
		// Restored caches must be in place before this build reads them: the
		// semantic-edge cache is consulted mid-build, and the signature comparison
		// below decides whether persisted partitions apply. Resolves instantly
		// after the first call.
		await loadPersistedTopicCaches();
		if (localBuildVersion !== buildVersion) return;

		const filter = getFilter();
		const { graphData: wikiData } = buildWikiGraph(
			plugin.app,
			filter,
			immersePaths ?? undefined,
			wikiGraphOptions(),
		);
		// A newer build (or unmount) superseded us before we could apply.
		if (localBuildVersion !== buildVersion) return;
		graphData = wikiData;
		isLoading = false;

		// A pending refit belongs to the build being replaced. (Topic-state
		// invalidation waits until the fused graph is known — see below.)
		refitAfterTopicsSettle = false;

		// Stale-while-revalidate topics: a fresh view instance starts with no
		// communities, so even a fully cached reopen would paint grey until the
		// fused graph resolves — and after a vault change (or a restart following
		// one) the wait is a full semantic scan plus a Leiden run. If the cached
		// partition still covers most of these nodes, paint it as an interim:
		// stale for at most the few changed notes, and replaced the moment the
		// real segmentation lands.
		if (Object.keys(leidenCommunities).length === 0) {
			const cached = getCachedPartition(graphTopologySignature(wikiData), currentPartitionKey());
			if (cached) {
				const covered = wikiData.nodes.reduce((n, node) => (cached[node.id] !== undefined ? n + 1 : n), 0);
				if (covered >= wikiData.nodes.length * INTERIM_TOPIC_MIN_COVERAGE) {
					Logger.info(
						`[SmartGraph] Interim topics from cache (${covered}/${wikiData.nodes.length} nodes covered)`,
					);
					leidenCommunities = cached;
				}
			}
		}

		// Paint the authored graph right away so the view isn't blank while
		// embeddings load, then refine it once semantic edges arrive.
		resolveAndApplySegments(graphData);

		let semanticEdges: GraphEdge[] = [];
		try {
			semanticEdges = await loadSemanticEdges(wikiData, localBuildVersion);
		} catch (error) {
			// Embeddings are an enhancement, not a requirement — degrade to wiki-only.
			console.error("[SmartGraph] Failed to build semantic edges:", error);
		}
		if (localBuildVersion !== buildVersion) return;

		if (semanticEdges.length > 0) {
			const fused = { ...wikiData, edges: [...wikiData.edges, ...semanticEdges] };
			// Degree drives node size and the Detail filter's hub ranking. Recompute it
			// over the fused edge set so semantically-central notes read as hubs too.
			const degreeMap = computeNodeDegrees(fused.edges);
			graphData = {
				...fused,
				nodes: fused.nodes.map((node) => ({ ...node, degree: degreeMap.get(node.path) ?? 0 })),
			};
			resolveAndApplySegments(graphData);
		}

		// Invalidate derived topic state only when the graph actually changed.
		// Leiden, the hierarchy and the ladder are pure over (graph, seed, γ) —
		// a rebuild that lands on an identical graph (Refresh with no vault
		// changes, a filter round-trip) keeps them all, so the topics reappear
		// from cache instantly instead of re-spending seconds of worker time.
		const signature = graphTopologySignature(graphData);
		if (signature !== getActiveGraphSignature()) {
			// A different graph: re-key the active cache slot. The outgoing
			// graph's derivations are archived under its signature and restored
			// when that graph comes back (immerse exit, a filter round-trip), so
			// those transitions re-apply topics from cache instead of re-running
			// Leiden, the ladder probes and labeling from scratch.
			// Pass the γ on screen so it's recorded against the *outgoing* graph
			// before the slot re-keys.
			const restored = swapActiveGraphCache(signature, settings.leidenResolution);
			// Whichever way the swap went, the archive layout changed on disk.
			scheduleTopicCacheSave();
			// A fresh (or restored) segmentation replaces every incremental
			// vote, so accumulated live-update drift is settled.
			liveTopicDrift = 0;
			// The hierarchy is per-graph component state; recomputed by the
			// segmentation run below (from cache when restored).
			topicHierarchy = null;
			const restoredLadder = getCachedGranularityLadder(signature);
			if (restored && restoredLadder) {
				granularityLadder = restoredLadder;
				hasDerivedGranularityLadder = true;
			} else {
				granularityLadder = [...GRANULARITY_LEVEL_RESOLUTIONS];
				// The ladder describes another graph; hide the slider until it's re-derived.
				hasDerivedGranularityLadder = false;
			}
			// Granularity is per-graph: dialling the topics finer while immersed
			// describes the subset, not the vault. Restore this graph's own γ so
			// returning to it re-segments the way the user left it rather than
			// inheriting the granularity set on the graph in between.
			const restoredResolution = getCachedResolution(signature);
			if (restoredResolution != null && restoredResolution !== settings.leidenResolution) {
				data.smartGraphSettings = { ...settings, leidenResolution: restoredResolution };
				// Topic ids are positions in a fresh partition, so anything holding
				// an id (folds, focus, selection) refers to a different grouping now.
				clearTopicIndexedState();
			}
		} else if (getCachedGranularityLadder(signature)) {
			// A fresh view instance starts on the fallback ladder even though this
			// graph has already been probed — restore the derived ladder so the
			// slider appears immediately instead of hiding through a re-probe.
			granularityLadder = getCachedGranularityLadder(signature) ?? granularityLadder;
			hasDerivedGranularityLadder = true;
		}

		void runLeidenSegmentation();

		await tick();
		if (localBuildVersion !== buildVersion) return;
		try {
			canvasComponent?.fitToView();
		} catch {
			/* pixi not ready */
		}
		// The fit above frames the graph as it looks *before* topics exist. Leiden
		// is still running, and once it assigns communities the cluster-cohesion
		// force pulls the layout into a visibly different shape — so that first fit
		// is already stale and nodes drift out of view. Re-frame once the topics
		// have actually landed.
		refitAfterTopicsSettle = true;
		// Live vault-change patches may run from here on — they diff against a
		// graph this build has now fully established.
		hasBuiltOnce = true;
	} catch (e) {
		if (ac.signal.aborted || localBuildVersion !== buildVersion) return;
		console.error("[SmartGraph] Error building graph:", e);
		graphData = { nodes: [], edges: [] };
		isLoading = false;
	}
}

// Rebuild on filter/settings changes (debounced 300ms).
// We depend on a derived signature so the effect only fires when the tracked *values* change,
// not whenever the `settings` derived is recomputed (which happens on any settings write,
// including leidenResolution changes that should NOT trigger a rebuild).
let buildGraphSignature = $derived(
	JSON.stringify({
		folders: selectedFolders,
		tags: selectedTags,
		extensions: selectedExtensions,
		showWikiLinks: settings.showWikiLinks,
		markdownOnly: settings.markdownOnly,
		// Tag nodes are part of the built graph (they carry edges and degree),
		// not a draw-time overlay, so showing them is a rebuild — a cheap one:
		// the topology signature ignores the tag layer, so topics and semantic
		// edges come straight back from cache.
		showTags: settings.showTags ?? false,
		// Semantic edges are computed during the build, so changing how they're
		// derived needs a rebuild (unlike `showSemanticLinks`, which only hides them).
		semanticNeighborCount: settings.semanticNeighborCount,
		semanticThreshold: settings.semanticThreshold,
	}),
);
$effect(() => {
	buildGraphSignature;
	const timer = window.setTimeout(() => untrack(() => void buildGraph()), 300);
	return () => window.clearTimeout(timer);
});

// Re-apply segment coloring when highlight toggles change (no Leiden re-run needed).
// Use a derived signature to avoid firing on every settings write — see buildGraphSignature above.
let highlightSignature = $derived(`${settings.highlightIsolated}:${settings.highlightBridges}`);
$effect(() => {
	highlightSignature;
	untrack(() => {
		if (graphData.nodes.length > 0) resolveAndApplySegments(graphData);
	});
});

/**
 * Re-run community detection when the user switches between fused and link-only
 * topics. Cached per mode, so flipping back and forth is instant after the first
 * run of each.
 */
let linkOnlyTopicsSignature = $derived(settings.linkOnlyTopics);
let linkOnlyTopicsInitial = true;
$effect(() => {
	linkOnlyTopicsSignature;
	untrack(() => {
		if (linkOnlyTopicsInitial) {
			linkOnlyTopicsInitial = false;
			return;
		}
		if (graphData.nodes.length === 0) return;
		// The ladder's rungs are the groupings *these* edges support, so switching
		// between fused and link-only invalidates them: link-only sees far fewer
		// edges and usually supports fewer distinct levels. Re-derive rather than
		// leave the slider offering levels the current edge set can't produce.
		hasDerivedGranularityLadder = false;
		void runLeidenSegmentation();
	});
});

onDestroy(() => {
	// Invalidate any in-flight async build/Leiden continuations so they bail
	// instead of writing $state on a destroyed component, and abort the current
	// build.
	isDestroyed = true;
	buildVersion++;
	currentBuild?.abort();
	labelingAbort?.abort();
});

// ─── Live vault-change updates (issue #404) ─────────────────────────────
//
// While the view is open, vault and metadata events patch the open graph in
// place instead of waiting for a manual Refresh. The wiki structure is diffed
// against a fresh (cheap) rebuild; semantic edges are re-queried per changed
// note against the live vault index; topics are re-assigned by neighbour vote,
// with a full Leiden re-run only once enough incremental drift accumulates.
// Refresh remains ground truth — it rebuilds everything from scratch.

/** Quiet period after the last vault/metadata event before a patch is applied. */
const LIVE_UPDATE_DEBOUNCE_MS = 1500;
/** Re-check cadence for notes whose embeddings haven't landed yet. */
const SEMANTIC_RETRY_INTERVAL_MS = 5000;
/**
 * Give up waiting for fresh embeddings after this many checks (~2 min): covers
 * the vector store's 10s modify debounce plus embedding latency, without
 * polling forever for notes that will never be (re-)embedded.
 */
const SEMANTIC_RETRY_MAX_ATTEMPTS = 24;

/**
 * Incrementally voted topic assignments since the last full Leiden run. Each
 * vote is a heuristic stand-in for Leiden; past a threshold the approximations
 * compound and the real thing re-runs (see {@link maybeReclusterAfterDrift}).
 */
let liveTopicDrift = 0;
/** True once the first full build has landed — live patches diff against it. */
let hasBuiltOnce = false;
let liveUpdateTimer: number | null = null;
/** Renames since the last flush, applied to the canvas position cache first. */
let pendingRenames: Array<{ from: string; to: string }> = [];
/**
 * Notes whose semantic edges need re-querying, keyed by path. `mtime` is the
 * file mtime the stored embeddings must catch up to before the query is worth
 * running; `attempts` bounds the wait.
 */
const pendingSemantic = new Map<string, { mtime: number; attempts: number }>();
let semanticRetryTimer: number | null = null;
let isProcessingSemantic = false;

function isLiveRelevantFile(file: TAbstractFile): file is TFile {
	return file instanceof TFile && !isAgentFilePath(file.path);
}

/** Queue a note for a semantic re-query once its embeddings are current. */
function queueSemanticRefresh(file: TFile) {
	if (!data.graphEmbedIndex || !isEmbeddableFile(file)) return;
	pendingSemantic.set(file.path, { mtime: file.stat.mtime, attempts: 0 });
}

function scheduleLiveUpdate() {
	if (isDestroyed) return;
	if (liveUpdateTimer != null) window.clearTimeout(liveUpdateTimer);
	liveUpdateTimer = window.setTimeout(() => {
		liveUpdateTimer = null;
		flushLiveUpdate();
	}, LIVE_UPDATE_DEBOUNCE_MS);
}

const liveVaultEventRefs = [
	plugin.app.vault.on("create", (file) => {
		if (!isLiveRelevantFile(file)) return;
		queueSemanticRefresh(file);
		scheduleLiveUpdate();
	}),
	plugin.app.vault.on("modify", (file) => {
		if (!isLiveRelevantFile(file)) return;
		queueSemanticRefresh(file);
		scheduleLiveUpdate();
	}),
	plugin.app.vault.on("delete", (file) => {
		if (!isLiveRelevantFile(file)) return;
		pendingSemantic.delete(file.path);
		scheduleLiveUpdate();
	}),
	plugin.app.vault.on("rename", (file, oldPath) => {
		if (!(file instanceof TFile)) return;
		pendingSemantic.delete(oldPath);
		if (isAgentFilePath(file.path) && isAgentFilePath(oldPath)) return;
		pendingRenames.push({ from: oldPath, to: file.path });
		queueSemanticRefresh(file);
		scheduleLiveUpdate();
	}),
];
// Fires when link resolution completes after any change — this is what catches
// edits whose only effect is on OTHER notes' resolved links (e.g. creating a
// note that turns previously unresolved links elsewhere into edges).
const liveMetadataEventRef = plugin.app.metadataCache.on("resolved", () => scheduleLiveUpdate());

onDestroy(() => {
	for (const ref of liveVaultEventRefs) plugin.app.vault.offref(ref);
	plugin.app.metadataCache.offref(liveMetadataEventRef);
	if (liveUpdateTimer != null) window.clearTimeout(liveUpdateTimer);
	if (semanticRetryTimer != null) window.clearTimeout(semanticRetryTimer);
});

/** Apply pending vault changes to the open graph. */
function flushLiveUpdate() {
	if (isDestroyed) return;
	// A full build in flight already sees the current vault; patching under it
	// would race two writers of graphData. Come back once it lands.
	if (!hasBuiltOnce || isLoading) {
		scheduleLiveUpdate();
		return;
	}

	// Renames first: the canvas position cache must know the new ids before the
	// patched data lands, so renamed notes stay in place.
	for (const { from, to } of pendingRenames) canvasComponent?.transferNodePosition(from, to);
	pendingRenames = [];

	// New folders/tags/extensions should appear in the filter dropdowns too.
	loadFilterOptions();

	const { graphData: freshWiki } = buildWikiGraph(
		plugin.app,
		getFilter(),
		immersePaths ?? undefined,
		wikiGraphOptions(),
	);
	const patch = applyWikiPatch(graphData, freshWiki);
	if (patch.changed) {
		const communities = { ...leidenCommunities };
		let drift = 0;
		for (const path of patch.removedPaths) {
			if (communities[path] !== undefined) {
				delete communities[path];
				drift++;
			}
		}
		const topicEdges = getTopicEdgesFor(patch.data);
		for (const path of patch.addedPaths) {
			const vote = voteNodeCommunity(path, topicEdges, communities, leidenWeight);
			if (vote !== undefined) {
				communities[path] = vote;
				drift++;
			}
		}
		// A surviving note whose links changed may now belong elsewhere; re-vote
		// it, but only count actual moves as drift.
		for (const path of patch.touchedPaths) {
			const vote = voteNodeCommunity(path, topicEdges, communities, leidenWeight);
			if (vote !== undefined && vote !== communities[path]) {
				communities[path] = vote;
				drift++;
			}
		}
		// `focusedClusters`/`focusedSegmentIds` hold indices into `segments` — but
		// `applyLivePatch` below rebuilds `segments` from scratch (sorted by size,
		// undersized ones dropped), so an index that pointed at "Marine Ecology"
		// can point at a different topic, or nothing, once it returns. Capture what
		// community each focused index actually meant *before* that happens, so it
		// can be re-resolved to wherever that same community landed afterward —
		// otherwise the focus silently follows the wrong topic (or none) post-patch,
		// which breaks topic highlighting/panel rows generally, not just the label.
		const focusedCommunityIdsBeforePatch = new Set(
			[...focusedClusters].flatMap((cluster) => {
				const id = segments[cluster]?.communityId;
				return id === undefined ? [] : [id];
			}),
		);

		applyLivePatch(patch.data, communities, drift);

		// Re-resolve focus to the rebuilt `segments` array by community identity.
		if (focusedClusters.size > 0) {
			const nextFocusedClusters = new Set(
				segments.flatMap((segment, index) =>
					segment.communityId !== undefined && focusedCommunityIdsBeforePatch.has(segment.communityId)
						? [index]
						: [],
				),
			);
			focusedClusters = nextFocusedClusters;
			focusedSegmentIds = new Set([...nextFocusedClusters].flatMap((c) => (segments[c] ? [segments[c].id] : [])));
		}

		// A removed note can't stay selected — mirror the pruned selection out so
		// chat trays don't keep offering a note that no longer exists.
		if (patch.removedPaths.length > 0 && selectedPaths.length > 0) {
			const removed = new Set(patch.removedPaths);
			const surviving = selectedPaths.filter((path) => !removed.has(path));
			if (surviving.length !== selectedPaths.length) {
				canvasComponent?.selectNodesByPaths(surviving);
				handleSelectionChange(surviving, true, topicLabelForCommunities(communities, surviving));
			}
		}

		Logger.info(
			`[SmartGraph] Live patch: +${patch.addedPaths.length} −${patch.removedPaths.length} nodes, ${patch.touchedPaths.length} touched (drift ${liveTopicDrift})`,
		);
	} else {
		Logger.debug("[SmartGraph] Live update: no structural change");
	}

	void processPendingSemanticQueries();
}

/**
 * Land a patched graph: canvas told to stay put, communities updated, segments
 * re-resolved, drift accounted.
 */
function applyLivePatch(patched: GraphData, communities: Record<string, number>, drift: number) {
	canvasComponent?.markIncrementalUpdate();
	leidenCommunities = communities;
	// Keep the current rung's cache entry in step, so a granularity round-trip
	// back to this γ doesn't resurrect the pre-patch assignment. Other rungs go
	// stale for the changed notes only, until drift or Refresh re-clusters.
	//
	// Addressed by signature rather than written to whichever slot is active.
	// Both callers arrive from async contexts (a debounce timer, and after an
	// awaited semantic query), so another leaf may own the slot by now — and
	// the "does this key exist" test would then match *its* graph and overwrite
	// that graph's partition. The entry belongs to the graph being patched,
	// which is the pre-patch one: this vote describes how its communities move,
	// and the caller re-keys to `patched` immediately after.
	const patchedSignature = graphTopologySignature(graphData);
	// Only refresh an entry that exists — a missing one means a fresh Leiden run
	// is in flight for this key, and it will land its own (better) result.
	if (
		Object.keys(communities).length > 0 &&
		getCachedPartition(patchedSignature, currentPartitionKey()) !== undefined
	) {
		setCachedPartition(patchedSignature, currentPartitionKey(), communities);
		scheduleTopicCacheSave();
	}
	graphData = patched;
	resolveAndApplySegments(graphData);
	liveTopicDrift += drift;
	maybeReclusterAfterDrift();
}

/**
 * Fall back to a real Leiden run once enough incremental votes accumulated.
 *
 * Each vote is locally plausible but never merges or splits communities the
 * way Leiden would, so approximation error compounds with every patch. The
 * threshold scales with graph size — a fixed count would re-cluster a large
 * vault constantly and a small one never. The granularity ladder survives:
 * its rungs describe the vault's structure coarsely enough that a few percent
 * of changed notes don't invalidate them.
 */
function maybeReclusterAfterDrift() {
	const threshold = Math.max(8, Math.ceil(noteNodeCount * 0.02));
	if (liveTopicDrift < threshold) return;
	Logger.info(`[SmartGraph] Live topic drift ${liveTopicDrift} ≥ ${threshold} — re-running Leiden`);
	liveTopicDrift = 0;
	// The cached partitions and the hierarchy describe the pre-drift graph.
	// Re-key through the swap rather than assigning the slot directly: assigning
	// `graphSignature` and clearing the map would discard whatever graph the
	// slot currently holds — another leaf's partitions, if it owns the slot.
	// The swap archives that graph first, then hands us an empty map keyed to
	// ours (or this graph's own archived entry, if it has been seen before).
	const signature = graphTopologySignature(graphData);
	swapActiveGraphCache(signature);
	clearCachedPartitions(signature);
	topicHierarchy = null;
	void runLeidenSegmentation();
}

/**
 * Re-query semantic edges for changed notes, waiting for their embeddings.
 *
 * The vector store re-embeds a modified note ~10s after the last edit, so a
 * query at patch time would read stale vectors. Each queued note is retried on
 * an interval until its stored mtime catches up with the file — or attempts
 * run out, in which case whatever vectors exist are used (better than
 * dropping the note's inferred edges entirely).
 */
async function processPendingSemanticQueries() {
	if (isDestroyed || isProcessingSemantic || pendingSemantic.size === 0) return;
	if (!data.graphEmbedIndex) {
		pendingSemantic.clear();
		return;
	}
	// Same ceiling as the full build: past it the graph is wiki-only, so there
	// are no semantic edges to keep current.
	if (noteNodeCount > SEMANTIC_EDGE_MAX_NOTES) {
		pendingSemantic.clear();
		return;
	}
	isProcessingSemantic = true;
	const localBuildVersion = buildVersion;
	try {
		const serviceReady = await waitForVectorStore();
		if (!serviceReady || isDestroyed) return;
		const store = await getVectorStoreService()
			.getOrCreateInstance(data.graphEmbedIndex)
			.then((inst) => inst.store)
			.catch(() => null);
		if (!store || isDestroyed) return;

		const nodePaths = new Set(graphData.nodes.filter((node) => !isTagNode(node)).map((node) => node.path));
		const replacements = new Map<string, GraphEdge[]>();
		/**
		 * Retire an entry only if it is still the one this pass processed.
		 *
		 * The loop awaits the vector store, and an edit landing during that await
		 * replaces the entry with a newer mtime. Deleting by path alone would
		 * discard that replacement, leaving the note on stale semantic edges
		 * until some later vault event happened to requeue it.
		 */
		const retire = (path: string, processed: { mtime: number; attempts: number }) => {
			if (pendingSemantic.get(path) === processed) pendingSemantic.delete(path);
		};
		for (const [path, entry] of [...pendingSemantic]) {
			// Filtered out of the graph (or deleted since queueing) — nothing to do.
			if (!nodePaths.has(path)) {
				retire(path, entry);
				continue;
			}
			const storedMtime = await store.getDocumentMtime(path).catch(() => undefined);
			if (isDestroyed) return;
			const embeddingsCurrent = storedMtime !== undefined && storedMtime >= entry.mtime;
			if (!embeddingsCurrent && entry.attempts < SEMANTIC_RETRY_MAX_ATTEMPTS) {
				entry.attempts++;
				continue;
			}
			retire(path, entry);
			// Never embedded (private, excluded, provider down) — no edges to infer.
			if (storedMtime === undefined) continue;

			const wikiKeys = new Set(
				graphData.edges
					.filter((e) => e.type === "wiki" && (e.source === path || e.target === path))
					.map((e) => edgeKey(e.source, e.target)),
			);
			const edges = await queryNoteSemanticEdges(store, path, nodePaths, {
				neighborCount: settings.semanticNeighborCount,
				threshold: settings.semanticThreshold,
				excludeEdgeKeys: wikiKeys,
			}).catch((error) => {
				Logger.error(`[SmartGraph] Live semantic query failed for ${path}:`, error);
				return [] as GraphEdge[];
			});
			if (isDestroyed) return;
			// Requeued while the query ran: the note changed again, so this result
			// already describes an older version. Drop it and let the retry pass
			// (which the finally block schedules) query the current content.
			if (pendingSemantic.has(path)) continue;
			replacements.set(path, edges);
		}

		// A full rebuild landed while we were querying — it recomputed every
		// semantic edge itself, so these results describe a replaced graph.
		if (localBuildVersion !== buildVersion) return;

		if (replacements.size > 0) {
			const paths = new Set(replacements.keys());
			const merged = [...replacements.values()].flat();
			const { data: patched, changed } = replaceSemanticEdgesForPaths(graphData, paths, merged);
			if (changed) {
				const communities = { ...leidenCommunities };
				let drift = 0;
				const topicEdges = getTopicEdgesFor(patched);
				for (const path of paths) {
					const vote = voteNodeCommunity(path, topicEdges, communities, leidenWeight);
					if (vote !== undefined && vote !== communities[path]) {
						communities[path] = vote;
						drift++;
					}
				}
				applyLivePatch(patched, communities, drift);
				Logger.info(`[SmartGraph] Live semantic patch for ${paths.size} note(s)`);
			}
		}
	} finally {
		isProcessingSemantic = false;
		scheduleSemanticRetry();
	}
}

function scheduleSemanticRetry() {
	if (isDestroyed || pendingSemantic.size === 0 || semanticRetryTimer != null) return;
	semanticRetryTimer = window.setTimeout(() => {
		semanticRetryTimer = null;
		void processPendingSemanticQueries();
	}, SEMANTIC_RETRY_INTERVAL_MS);
}

/**
 * Drop every piece of state recorded against topic *numbers*.
 *
 * Cluster ids are size-sorted positions in a fresh partition, so "topic 3"
 * before and after a re-run are unrelated groups. Anything holding an id — a
 * fold, a focus, a selection — would silently reattach to the wrong topic.
 *
 * `collapseAll` survives deliberately: it's a mode, not an id, so it still means
 * what it says under any numbering.
 */
function clearTopicIndexedState() {
	if (collapsedTopics.size > 0) collapsedTopics = new Set();
	if (expandedTopics.size > 0) expandedTopics = new Set();
	// Focus and selection are id-keyed too — leaving them would highlight whichever
	// unrelated group inherited the number.
	if (focusedClusters.size > 0 || focusedSegmentIds.size > 0 || selectedPaths.length > 0) {
		handleClearSelection();
	}
}

// Handlers
function handleSettingsChange(partial: Partial<SmartGraphSettings>) {
	// Compared as partition identities rather than field-by-field: resolution,
	// seed and link-mode each re-run Leiden and renumber every topic, so keying
	// the reset off the key itself covers all three (and anything added later)
	// instead of relying on this list staying complete.
	const previousKey = currentPartitionKey();
	data.smartGraphSettings = { ...settings, ...partial };
	if (currentPartitionKey() !== previousKey) clearTopicIndexedState();
	// Remember the granularity against *this* graph, so switching away and back
	// (immerse, filters) restores it rather than the last γ set anywhere. Every
	// path that changes γ — slider drag, commit, arrow keys, dev panel — routes
	// through here.
	if (partial.leidenResolution !== undefined) {
		setCachedResolution(graphTopologySignature(graphData), partial.leidenResolution);
	}
	// Topics are applied in `resolveAndApplySegments`, which nothing re-runs on its
	// own — repaint from the communities already in hand. Deliberately not a Leiden
	// run: this toggle is display-only, so both directions are just a re-colour.
	if (partial.showTopics !== undefined) {
		// Hiding topics strips every node's cluster, so `allTopicIds` collapses to
		// the single UNSORTED sentinel. Left standing, collapse-all would then fold
		// the entire graph into one "Unsorted · N" node — the opposite of the raw
		// view this toggle exists to show — and the collapse control is disabled
		// while topics are hidden, so it couldn't be undone from the toolbar.
		// There are no topics to be collapsed in this state, so drop the folds
		// outright rather than carrying them into a view they can't describe.
		if (partial.showTopics === false) {
			collapseAll = false;
			collapsedTopics = new Set();
			expandedTopics = new Set();
		}
		resolveAndApplySegments(graphData);
	}
}

function handleFolderFilterChange(folders: string[]) {
	selectedFolders = folders;
}

function handleTagFilterChange(tags: string[]) {
	selectedTags = tags;
}

function handleExtensionFilterChange(extensions: string[]) {
	selectedExtensions = extensions;
}

function handleFitToView() {
	canvasComponent?.fitToView();
}

function handleRefresh() {
	loadFilterOptions();
	// Keep the current communities while the rebuild runs: they repaint the
	// interim graph, and if the vault is unchanged the cache confirms them
	// instantly — clearing here would just flash the topics away and back.
	void buildGraph();
}

function handleNodeClick(path: string) {
	plugin.app.workspace.openLinkText(path, "", false);
}

function handleTagClick(tag: string) {
	void openTagSearch(plugin.app, tag);
}

function handleRevealFile(path: string) {
	const file = plugin.app.vault.getAbstractFileByPath(path);
	if (file) {
		// Reveal in Obsidian's file explorer
		const explorer = plugin.app.workspace.getLeavesOfType("file-explorer")[0];
		if (explorer) {
			// `revealInFolder` is an undocumented internal on the file-explorer view.
			(explorer.view as { revealInFolder?: (file: TAbstractFile) => void }).revealInFolder?.(file);
		}
	}
}

/**
 * Focus a topic and select its notes.
 *
 * `pan` is opt-in because the callers want opposite things: the "Focus on this
 * cluster" context-menu item exists to fly the camera there, while clicking a
 * topic label is a selection gesture — moving the view between clicks would
 * push the next label you meant to click off-screen.
 *
 * `multi` mirrors `handleFocusSegment`: plain click replaces the selection
 * (or clears it if this was the only one), Shift/⌘ toggles membership.
 */
function handleFocusCluster(cluster: number, pan = false, multi = true) {
	const next = new Set(focusedClusters);
	if (multi) {
		if (next.has(cluster)) next.delete(cluster);
		else next.add(cluster);
	} else if (next.size === 1 && next.has(cluster)) {
		next.clear();
	} else {
		next.clear();
		next.add(cluster);
	}
	focusedClusters = next;

	// Selecting a topic by its label and by its panel row are the same act, so keep
	// the panel's highlighted rows in step. `node.cluster` is the index into
	// `segments` (assigned as `cluster: i` in resolveAndApplySegments), so the id
	// is a direct lookup.
	focusedSegmentIds = new Set([...next].flatMap((c) => (segments[c] ? [segments[c].id] : [])));

	// Sync selection: select all nodes belonging to any focused cluster
	if (next.size > 0) {
		const paths = canvasComponent?.getNodePathsForClusters(next) ?? [];
		canvasComponent?.selectNodesByPaths(paths);
		handleSelectionChange(paths);
		if (pan) canvasComponent?.panToClusters(next);
	} else {
		handleSelectionChange([]);
		canvasComponent?.clearSelection();
	}
}

/**
 * Adopt a new selection: the single place that records it and mirrors it out.
 *
 * Every path that changes the selection routes through here — canvas lasso,
 * topic label, panel row — so the graph and each open chat's context tray can
 * never disagree about what is selected.
 *
 * `isMaintenance` marks the one caller (the live-patch handler below) that
 * republishes a *shrunk* version of the existing selection because notes were
 * deleted out from under it — not a new user gesture. A chat tray needs this
 * distinction verbatim, not inferred from path-set shape: a user picking a
 * smaller selection (Shift-click, deselecting a topic, drilling into one
 * cluster) also produces a subset of the prior selection, so shape alone
 * can't tell the two apart. Per-chat dismissals should survive maintenance
 * pruning but reset on every real selection change, however it was made.
 *
 * `topicLabelOverride` lets the same maintenance caller supply a label it
 * already computed synchronously against the just-updated `communities`,
 * instead of falling through to `selectedTopicLabels`. That derivation reads
 * `canvasComponent`'s `simNodes`, which the canvas only rebuilds from
 * `graphData` on its own next reactive flush — still stale in the same
 * synchronous block that just reassigned `graphData` via `applyLivePatch`.
 * Every other caller sets `focusedClusters`/`selectedPaths` and calls in
 * synchronously too, but through *this* component's own reactive graph
 * (`segments`, `effectiveClusterLabels`), which is current already.
 */
function handleSelectionChange(paths: string[], isMaintenance = false, topicLabelOverride?: string[] | null) {
	selectedPaths = paths;
	const messenger = getSessionRegistry();
	if (messenger) {
		// Ambient: mirror the live graph selection into every open chat's tray.
		messenger.graphSelection = [...paths];
		messenger.graphSelectionIsMaintenance = isMaintenance;
		// Callers set focusedClusters/selectedPaths before calling in, so this
		// derivation is already current for the selection just adopted above —
		// except the maintenance caller, which passes its own override (see above).
		const labels = topicLabelOverride !== undefined ? topicLabelOverride : selectedTopicLabels;
		messenger.graphSelectionTopicLabel = labels?.join(", ") ?? null;
	}
}

function handleLassoModeChange(active: boolean) {
	lassoMode = active;
	if (!active) {
		canvasComponent?.clearSelection();
		handleSelectionChange([]);
	}
}

/**
 * Notes above which "Open all" asks first. Opening a tab per note has no undo,
 * and this is now reachable from a single keypress — a stray `O` on a 76-note
 * topic would bury the workspace.
 */
const OPEN_ALL_CONFIRM_THRESHOLD = 10;

// Touch devices have no keyboard, so don't advertise shortcuts they can't press.
const onMobile = isMobileUI();
/** Append a shortcut hint to a tooltip on desktop only. */
const withKey = (tooltip: string, key: string) => (onMobile ? tooltip : `${tooltip} (${key})`);

/**
 * Whether the settings panel is hidden. Owned here rather than inside
 * `GraphControls` because on mobile it is a bottom sheet, and the selection
 * sheet has to be able to take that slot over — see below.
 */
let isControlsCollapsed = $state(true);

/**
 * One sheet at a time: a selection appearing closes the settings sheet.
 *
 * Both surfaces are bottom-anchored on mobile, so leaving them both open would
 * either stack them over most of the screen or have them overlap. The selection
 * wins because it is the more transient of the two and the one the user just
 * created.
 *
 * A genuine side effect on a separate surface, not state synchronisation: it
 * fires on the *transition into* having a selection, so reopening the settings
 * sheet while a selection is still live doesn't immediately close it again.
 */
// Keyed on the selection alone, matching what actually opens the sheet on
// mobile. Including `isImmersed` here would close the settings sheet on entering
// immerse, where nothing takes the sheet slot in return — immersion's affordance
// is a toolbar button now, precisely so it does not occupy the canvas.
let hadSelection = false;
$effect(() => {
	const hasSelection = selectedPaths.length > 0;
	if (hasSelection && !hadSelection && onMobile) isControlsCollapsed = true;
	hadSelection = hasSelection;
});

/**
 * Open a set of notes in tabs, confirming first past the threshold.
 *
 * Shared by the selection bar's "Open all" and a collapsed topic's context
 * menu — the latter routinely covers a whole topic, so it needs the guard at
 * least as much.
 */
async function handleOpenPaths(paths: string[]) {
	if (paths.length === 0) return;

	if (paths.length > OPEN_ALL_CONFIRM_THRESHOLD) {
		const modal = new ConfirmModal(
			plugin.app,
			"Open all notes",
			`This opens ${paths.length} notes in new tabs. Closing them again is manual.`,
			`Open ${paths.length} tabs`,
		);
		modal.open();
		if (!(await modal.promise).confirmed) return;
	}

	for (const path of paths) {
		plugin.app.workspace.openLinkText(path, "", "tab");
	}
}

function handleOpenAllSelected() {
	void handleOpenPaths(selectedPaths);
}

async function handleSendToChat() {
	const paths = selectedPaths;
	if (paths.length === 0) return;
	// Read before the awaits below give the user a chance to change the selection.
	const topicLabel = selectedTopicLabels?.join(", ") ?? null;

	// Reveal an existing chat (uncollapsing its sidebar) or create one.
	const { workspace } = plugin.app;
	const existingLeaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
	if (!existingLeaf) {
		await plugin.agentManager.createNewChat();
	} else {
		workspace.revealLeaf(existingLeaf);
	}

	const messenger = getSessionRegistry();
	if (messenger) {
		// Ambient selection (shown in every chat) …
		messenger.graphSelection = [...paths];
		messenger.graphSelectionIsMaintenance = false;
		messenger.graphSelectionTopicLabel = topicLabel;
		// … plus a one-shot signal so the just-opened/focused chat grabs focus.
		messenger.pendingGraphNotes = [...paths];
	} else {
		new Notice("Chat is not initialized yet. Please open a chat first.");
	}
}

function handleZoomToSelection() {
	canvasComponent?.panToSelection();
}

function handleClearSelection() {
	focusedClusters = new Set();
	focusedSegmentIds = new Set();
	canvasComponent?.clearSelection();
	handleSelectionChange([]);
}

/** Same naming ladder (and same fallbacks) the canvas uses for a topic node, so
 * every surface calls a topic exactly what its pill did. */
function clusterLabel(cluster: number): string {
	return cluster === UNSORTED_CLUSTER
		? "Unsorted"
		: (effectiveClusterLabels[cluster] ?? segments[cluster]?.label ?? `Topic ${cluster}`);
}

/**
 * Name the topics `paths` exactly matches under `communities` (path → raw
 * Leiden community id), or null if it isn't an exact match — used only by the
 * live-patch handler, whose `communities` is current but whose canvas isn't
 * yet (see `handleSelectionChange`'s `topicLabelOverride` doc).
 *
 * `focusedClusters` holds *segment indices* (`segments[i]`, assigned `i` by
 * `resolveAndApplySegments`/`resolveSegmentsByLeiden` after sorting and
 * dropping undersized communities) — not raw community ids. The two numeric
 * spaces aren't interchangeable: sorting and drops mean a segment's index can
 * differ from its `communityId`. Map through `segments[i].communityId` (set
 * by `resolveAndApplySegments`, already current — it runs synchronously
 * inside `applyLivePatch`, before this is called) rather than comparing
 * `communities` values against `focusedClusters` directly.
 *
 * Mirrors `getNodePathsForClusters`'s exclusion of unsorted notes (`cluster
 * == null` never matches, even if `UNSORTED_CLUSTER` is itself focused) —
 * but unlike the canvas method, doesn't resolve collapsed topic nodes back
 * to their members, so a selection touching a currently-collapsed topic
 * conservatively falls back to null (count-based label) rather than risk a
 * wrong match.
 */
function topicLabelForCommunities(communities: Record<string, number>, paths: string[]): string[] | null {
	if (focusedClusters.size === 0 || paths.length === 0) return null;
	const focusedCommunityIds = new Set(
		[...focusedClusters].flatMap((cluster) => {
			const id = segments[cluster]?.communityId;
			return id === undefined ? [] : [id];
		}),
	);
	// Every focused segment must have resolved to a real community id — if
	// segments haven't caught up either (shouldn't happen, but this is exactly
	// the kind of ordering assumption that bit the canvas-based check), bail
	// out to the safe count-based fallback rather than risk a wrong match.
	if (focusedCommunityIds.size !== focusedClusters.size) return null;
	const topicPaths = Object.entries(communities)
		.filter(([, communityId]) => focusedCommunityIds.has(communityId))
		.map(([path]) => path);
	const selected = new Set(paths);
	if (topicPaths.length !== selected.size || !topicPaths.every((path) => selected.has(path))) return null;
	return [...focusedClusters].map(clusterLabel);
}

/**
 * Name the topics the current selection consists of, or null if it isn't one.
 *
 * "Is one" is deliberately strict — the focused topics' members must be exactly
 * the selected paths. Clicking a topic label selects its notes, but the user can
 * then add or remove notes by hand, and a selection that merely *overlaps* a
 * topic isn't that topic.
 *
 * The canvas call reads its non-reactive `simNodes`, but every path that
 * changes a topic's membership also runs `handleSelectionChange` or resets
 * `focusedClusters` — both tracked here — so this can't go stale in between.
 */
let selectedTopicLabels: string[] | null = $derived.by(() => {
	if (focusedClusters.size === 0 || selectedPaths.length === 0) return null;
	const topicPaths = new Set(canvasComponent?.getNodePathsForClusters(focusedClusters) ?? []);
	const selected = new Set(selectedPaths);
	if (topicPaths.size !== selected.size || ![...topicPaths].every((path) => selected.has(path))) return null;
	return [...focusedClusters].map(clusterLabel);
});

async function handleImmerse() {
	if (selectedPaths.length === 0) return;
	immersePaths = new Set(selectedPaths);
	// Read the topic names *before* the reset below clears `focusedClusters`.
	// Only a pure topic selection earns a name: if the user lassoed extra notes
	// on top of a focused topic, the paths no longer match the topic's members
	// and calling the immersion by that topic's name would misdescribe it.
	immerseTopicLabels = selectedTopicLabels;
	// Immersing rebuilds the graph to contain ONLY these notes, so "selected"
	// stops meaning anything — every remaining node is in the set. Clearing just
	// `selectedPaths` + the canvas (as this did) left the focused clusters/segments
	// and every open chat's context tray still holding the pre-immerse selection,
	// so the tray showed stale notes and dimming persisted. Reuse the full reset.
	handleClearSelection();
	await buildGraph();
}

async function handleExitImmerse() {
	immersePaths = null;
	immerseTopicLabels = null;
	// Leaving immerse restores the full graph; any selection made inside the
	// immersed subset refers to a different node set, so drop it too.
	handleClearSelection();
	await buildGraph();
}

/**
 * Weight an edge for community detection on a common scale.
 *
 * Wiki weights are link counts (1, 2, 3…) while semantic weights are cosine
 * similarities (~0.55–1.0), so the raw values aren't comparable — passing them
 * through unchanged would let a single authored link dominate a strong semantic
 * match. Authored links are deliberately kept the stronger signal, with repeat
 * links damped so one heavily-linked pair can't swamp a topic.
 */
function leidenWeight(edge: GraphEdge): number {
	if (edge.type === "wiki") return 1 + Math.log2(Math.max(1, edge.weight));
	return edge.weight * SEMANTIC_LEIDEN_WEIGHT;
}

/**
 * The edges community detection runs over.
 *
 * Normally authored *and* inferred — that fusion is what lets notes with no wiki
 * links land in a topic. In link-only mode inferred edges are excluded so the
 * topics reflect nothing but the user's own linking.
 */
function getTopicEdges(): GraphEdge[] {
	return getTopicEdgesFor(graphData);
}

/** Same filter over an arbitrary graph — used by live patches before they land. */
function getTopicEdgesFor(gd: GraphData): GraphEdge[] {
	return gd.edges.filter((e) =>
		settings.linkOnlyTopics ? e.type === "wiki" : e.type === "wiki" || e.type === "semantic",
	);
}

/**
 * Cache key for one Leiden partition — the seed, resolution and edge mode fully
 * determine the result, so this doubles as an identity for "which grouping is
 * this". Link-only results must never share a slot with fused ones.
 */
function partitionKey(
	resolution: number,
	linkOnly = settings.linkOnlyTopics,
	seed: number = settings.leidenSeed,
): string {
	return `${seed}:${resolution}:${linkOnly ? "wiki" : "fused"}`;
}

/** The partition the controls are currently asking for. */
function currentPartitionKey(): string {
	return partitionKey(settings.leidenResolution);
}

async function runLeidenSegmentation() {
	const localBuildVersion = buildVersion;
	// The graph this run describes, captured before any await. A live vault patch
	// changes the node set without bumping buildVersion or the partition key, so
	// neither of those guards would notice — the result would be applied over,
	// and cached against, a graph it was never computed for. It also addresses
	// every cache access below, so another leaf owning the shared active slot
	// cannot divert them.
	const runSignature = graphTopologySignature(graphData);
	// Re-assert our own graph in the active slot before reading from it.
	ensureActiveGraphCache(runSignature);
	const topicEdges = getTopicEdges();
	if (topicEdges.length === 0) {
		// Link-only mode on a vault with no links at all: clear stale communities so
		// the graph honestly shows "nothing is linked" instead of the fused result.
		if (settings.linkOnlyTopics) {
			leidenCommunities = {};
			resolveAndApplySegments(graphData);
		}
		return;
	}

	const cacheKey = currentPartitionKey();
	const cached = getCachedPartition(runSignature, cacheKey);
	if (cached) {
		Logger.info(`[SmartGraph] Leiden cache hit (γ=${settings.leidenResolution.toFixed(2)})`);
		leidenCommunities = cached;
		resolveAndApplySegments(graphData);
		// The hierarchy and the granularity ladder describe the *graph*, not the current γ,
		// so they're computed once per build. Re-running them here would fire on
		// every step of a slider drag, which is exactly the hot path.
		void computeTopicHierarchy(topicEdges);
		if (!hasDerivedGranularityLadder) void deriveGranularityLevels(topicEdges);
		return;
	}

	const sources = topicEdges.map((e) => e.source);
	const targets = topicEdges.map((e) => e.target);
	const weights = topicEdges.map(leidenWeight);
	const start = performance.now();
	isLeidenRunning = true;
	let result: Awaited<ReturnType<typeof leidenAsync>>;
	try {
		result = await leidenAsync(sources, targets, weights, settings.leidenSeed, settings.leidenResolution);
	} finally {
		isLeidenRunning = false;
	}
	// The graph was rebuilt (or the view closed) while Leiden ran; its
	// communities are keyed by nodes that may no longer exist. Discard them
	// rather than applying stale segments over the current graph.
	if (localBuildVersion !== buildVersion) return;
	// Same for a live patch, which changes the graph without a rebuild: the
	// result describes a node set that has since moved on. The patch's own
	// neighbour-vote already covers the affected notes, and drift will trigger
	// a fresh run when it accumulates.
	if (graphTopologySignature(graphData) !== runSignature) {
		Logger.info("[SmartGraph] Discarding a Leiden result the graph has moved past");
		return;
	}
	Logger.info(
		`[SmartGraph] Leiden (γ=${settings.leidenResolution.toFixed(2)}, ${topicEdges.length} edges, ${graphData.nodes.length} nodes): ${Math.round(performance.now() - start)}ms`,
	);
	// Always worth caching — the result is correct for the settings it ran under,
	// even if those are no longer the ones on screen. Addressed by signature:
	// another leaf may have re-keyed the active slot while this ran, and an
	// unaddressed write would file this partition under *its* graph.
	setCachedPartition(runSignature, cacheKey, result);
	scheduleTopicCacheSave();
	// …but only *apply* it if those settings are still current. `buildVersion`
	// alone can't tell: it tracks graph rebuilds, while γ, seed and link-mode all
	// change the partition without touching the graph. A slow run started at one γ
	// would otherwise land after the user moved to another (served instantly from
	// cache) and quietly replace it, leaving the controls describing a grouping
	// the canvas isn't showing.
	if (currentPartitionKey() !== cacheKey) {
		Logger.info("[SmartGraph] Discarding a Leiden result the settings have moved past");
		return;
	}
	leidenCommunities = result;
	resolveAndApplySegments(graphData);
	void computeTopicHierarchy(topicEdges);
	void deriveGranularityLevels(topicEdges);
}

/**
 * Derive this vault's granularity ladder by probing candidate resolutions.
 *
 * How many *distinct* groupings a vault supports depends on its size and
 * structure — a fixed ladder is right for one vault and wrong for the next. So
 * each γ is run once and only those producing a new topic count become rungs;
 * the slider then has exactly as many steps as there are real groupings.
 *
 * Every probe also fills the Leiden cache, so this pays for itself: after it
 * finishes, moving the slider is instant at every level.
 */
async function deriveGranularityLevels(topicEdges: GraphEdge[]) {
	if (isDerivingGranularityLadder || hasDerivedGranularityLadder) return;
	isDerivingGranularityLadder = true;

	const localBuildVersion = buildVersion;
	// Same shared-slot guard as runLeidenSegmentation: the probes both read and
	// fill the active Leiden cache.
	ensureActiveGraphCache(graphTopologySignature(graphData));
	// Captured once, and used for every probe below. The loop awaits between
	// rungs, so reading these live would let a mid-loop change split the ladder
	// across two partitions — and, because they also form the cache key, file
	// old-seed results under the new seed. One ladder must describe one partition.
	const linkOnly = settings.linkOnlyTopics;
	const seed = settings.leidenSeed;
	const sources = topicEdges.map((e) => e.source);
	const targets = topicEdges.map((e) => e.target);
	const weights = topicEdges.map(leidenWeight);

	const probes: Array<{ resolution: number; topicCount: number; isFragmented: boolean }> = [];
	const start = performance.now();
	// Count only what the view will actually render: Leiden runs over topic
	// edges, so its map covers just connected nodes, and segment resolution
	// drops communities whose members aren't on screen.
	const visibleNodeIds = new Set(graphData.nodes.map((node) => node.id));
	// The graph this sweep describes. The loop awaits per rung, so another leaf
	// can re-key the active slot between them — every read and write below is
	// addressed by signature rather than trusting whichever slot is current.
	const runSignature = graphTopologySignature(graphData);

	try {
		for (const resolution of GRANULARITY_PROBE_RESOLUTIONS) {
			if (localBuildVersion !== buildVersion) return;

			const cacheKey = partitionKey(resolution, linkOnly, seed);
			let communities = getCachedPartition(runSignature, cacheKey);
			if (!communities) {
				try {
					const result = await leidenAsync(sources, targets, weights, seed, resolution);
					if (localBuildVersion !== buildVersion) return;
					setCachedPartition(runSignature, cacheKey, result);
					communities = result;
				} catch (error) {
					// A failed probe just means one fewer candidate rung.
					Logger.error(`[SmartGraph] Granularity probe failed at γ=${resolution}:`, error);
					continue;
				}
			}
			probes.push({ resolution, ...summarizePartition(communities, visibleNodeIds) });
		}

		if (localBuildVersion !== buildVersion) return;
		// The rungs describe the partition the probes ran under. If the seed or the
		// link mode moved on, publishing them would give the slider levels derived
		// from a grouping that is no longer on screen — and because the probes seed
		// the cache under the old partition, dragging would then hit misses and
		// skip levels.
		//
		// Re-probing has to happen from here. Whatever changed already called
		// `runLeidenSegmentation`, and that call's `deriveGranularityLevels` was
		// turned away by the `isDerivingGranularityLadder` guard while this run held
		// it — so nothing else is left to rebuild the ladder.
		if (linkOnly !== settings.linkOnlyTopics || seed !== settings.leidenSeed) {
			Logger.info("[SmartGraph] Re-probing the granularity ladder: the partition changed mid-derivation");
			isDerivingGranularityLadder = false;
			void deriveGranularityLevels(getTopicEdges());
			return;
		}
		// A live patch changed the graph under the sweep (no rebuild, so
		// buildVersion didn't move). The rungs describe a topology that is no
		// longer on screen; re-probe rather than publishing them.
		if (graphTopologySignature(graphData) !== runSignature) {
			Logger.info("[SmartGraph] Re-probing the granularity ladder: the graph changed mid-derivation");
			isDerivingGranularityLadder = false;
			void deriveGranularityLevels(getTopicEdges());
			return;
		}

		const ladder = deriveGranularityLadder(probes);
		if (ladder) {
			granularityLadder = ladder;
			Logger.info(
				`[SmartGraph] Granularity ladder: ${ladder.length} levels (γ ${ladder.map((g) => g.toFixed(2)).join(", ")}) in ${Math.round(performance.now() - start)}ms`,
			);
		} else {
			// Too few distinct groupings to build a ladder from — keep the fallback,
			// but still reveal the slider so the control isn't withheld forever.
			Logger.info("[SmartGraph] Granularity ladder: too few distinct groupings, keeping the default");
		}
		hasDerivedGranularityLadder = true;
		// Remember the outcome for this graph, so reopening the view restores the
		// ladder instead of re-probing. The probes also filled the Leiden cache,
		// so this save persists every rung at once. Addressed by signature: the
		// sweep awaits a Leiden run per rung, so another leaf may hold the active
		// slot by now, and an unaddressed write would hand *its* slider levels
		// derived from this topology.
		setCachedGranularityLadder(runSignature, granularityLadder);
		scheduleTopicCacheSave();
	} finally {
		isDerivingGranularityLadder = false;
	}
}

/**
 * Compute the parent level of the topic hierarchy.
 *
 * Runs Leiden a second time at a lower γ over the same edges, then nests the
 * current (fine) topics inside the result. This is what lets the outline view
 * roll notes *up* into a broader topic instead of hiding them.
 *
 * Failure is non-fatal: without a hierarchy the graph simply stays single-level.
 */
async function computeTopicHierarchy(topicEdges: GraphEdge[]) {
	const localBuildVersion = buildVersion;
	const fineResolution = settings.leidenResolution ?? 1.0;
	const coarseResolution = coarseResolutionFor(fineResolution);
	const cacheKey = partitionKey(coarseResolution);
	// The hierarchy nests the *live* `leidenCommunities` inside the coarse result
	// computed here, so the two have to come from the same partition. Remember
	// which one that is: the coarse Leiden below may await long enough for γ, the
	// seed or the link mode to move on.
	const finePartition = currentPartitionKey();
	// Addressed by signature for the same reason as the segmentation run: the
	// coarse Leiden below awaits, and another leaf may re-key the active slot.
	const runSignature = graphTopologySignature(graphData);

	let communities: Record<string, number>;
	const cached = getCachedPartition(runSignature, cacheKey);
	if (cached) {
		communities = cached;
	} else {
		try {
			const result = await leidenAsync(
				topicEdges.map((e) => e.source),
				topicEdges.map((e) => e.target),
				topicEdges.map(leidenWeight),
				settings.leidenSeed,
				coarseResolution,
			);
			if (localBuildVersion !== buildVersion) return;
			// Same live-patch hazard as the segmentation run: a vault patch changes
			// the node set without bumping buildVersion or the partition key, so
			// this coarse result describes a topology that has moved on. Caching it
			// under the current signature would pair it with fine communities it
			// never nested under, and the outline would show parents that match
			// neither the canvas nor the controls.
			if (graphTopologySignature(graphData) !== runSignature) {
				Logger.info("[SmartGraph] Discarding a coarse partition the graph has moved past");
				return;
			}
			setCachedPartition(runSignature, cacheKey, result);
			scheduleTopicCacheSave();
			communities = result;
		} catch (error) {
			Logger.error("[SmartGraph] Coarse Leiden failed; hierarchy unavailable:", error);
			return;
		}
	}

	if (localBuildVersion !== buildVersion) return;
	// A live patch moves the node set without touching buildVersion or the
	// partition key, so neither guard below would catch it.
	if (graphTopologySignature(graphData) !== runSignature) {
		Logger.info("[SmartGraph] Discarding a hierarchy the graph has moved past");
		return;
	}
	// Pairing this coarse partition with a fine one it never nested under would
	// describe a parent structure that matches neither the controls nor the
	// canvas. The run triggered by whatever changed will rebuild it.
	if (currentPartitionKey() !== finePartition) {
		Logger.info("[SmartGraph] Discarding a hierarchy whose fine partition has moved on");
		return;
	}
	topicHierarchy = buildTopicHierarchy(communities, leidenCommunities);
	Logger.info(
		`[SmartGraph] Hierarchy: ${topicHierarchy.children.length} topics under ${topicHierarchy.parents.size} parents (γ ${coarseResolution.toFixed(2)} → ${fineResolution.toFixed(2)})`,
	);
}

/**
 * Clear the Leiden cache and re-run at the current γ. Used when the seed changes — old
 * cached entries are no longer valid because they cluster to different communities.
 * The granularity ladder is re-derived too, since its rungs came from the old seed.
 */
async function handleSeedChange() {
	// Claim the slot for this graph before clearing it: with a second graph leaf
	// open, the active map may be that leaf's, and its partitions are still
	// valid under the seed *it* is using.
	const signature = graphTopologySignature(graphData);
	ensureActiveGraphCache(signature);
	clearCachedPartitions(signature);
	hasDerivedGranularityLadder = false;
	await runLeidenSegmentation();
}

function handleFocusSegment(segmentId: string, multi: boolean) {
	const next = new Set(focusedSegmentIds);
	if (multi) {
		// Shift/Cmd: toggle this segment in/out of the focused set
		if (next.has(segmentId)) {
			next.delete(segmentId);
		} else {
			next.add(segmentId);
		}
	} else {
		// Plain click: select only this segment, or deselect if already the only one
		if (next.size === 1 && next.has(segmentId)) {
			next.clear();
		} else {
			next.clear();
			next.add(segmentId);
		}
	}
	focusedSegmentIds = next;

	if (next.size === 0) {
		focusedClusters = new Set();
		canvasComponent?.clearSelection();
		handleSelectionChange([]);
		return;
	}

	// Mirror into `focusedClusters` so the canvas agrees about which topics are
	// focused however the selection was made — panel row or topic label.
	const clusters = new Set<number>();
	for (const id of next) {
		const index = segments.findIndex((s) => s.id === id);
		if (index !== -1) clusters.add(index);
	}
	focusedClusters = clusters;

	// Resolve through the canvas rather than reading `segment.paths` directly: a
	// collapsed topic is one synthetic node standing for its members, and only the
	// canvas can map it back to real note paths. Reading the segment would hand
	// chat the pre-collapse paths, so a row click and a label click — the same act
	// — would disagree the moment a topic was folded.
	const paths = canvasComponent?.getNodePathsForClusters(clusters) ?? [];
	canvasComponent?.selectNodesByPaths(paths);
	handleSelectionChange(paths);
	// A plain row click is "take me to this topic", so framing it helps. A
	// Shift/⌘ click is building a multi-selection — moving the view mid-gesture
	// would shift the rows and labels the user is still aiming at.
	if (!multi) canvasComponent?.panToSelection();
}

/**
 * Resolve Leiden community segments from current graphData and apply coloring + highlights.
 */
function resolveAndApplySegments(gd: GraphData) {
	const themeColors = resolveThemeColors();
	// `"none"` resolves to no segments, which strips every node's colour and
	// cluster below — the whole effect of the topics toggle. Suppressing it here
	// rather than skipping the Leiden run keeps `leidenCommunities` intact, so
	// turning topics back on is a re-render rather than a recompute.
	const resolved = resolveSegments(gd, (settings.showTopics ?? true) ? "leiden" : "none", {
		themeColors,
		leidenCommunities,
	});
	segments = resolved;
	// Build path → segment lookup once so the single node-map pass below can do everything:
	// strip stale color/cluster, apply bridge/isolated highlights, apply segment color.
	const pathInfo = new Map<string, { color: string; cluster: number }>();
	for (let i = 0; i < resolved.length; i++) {
		for (const path of resolved[i].paths) {
			if (!pathInfo.has(path)) {
				pathInfo.set(path, { color: resolved[i].color, cluster: i });
			}
		}
	}
	const isLeiden = Object.keys(leidenCommunities).length > 0;
	// Paths touched by at least one authored wiki link — drives the isolated highlight.
	const linkedPaths = new Set<string>();
	for (const edge of gd.edges) {
		if (edge.type !== "wiki") continue;
		linkedPaths.add(edge.source);
		linkedPaths.add(edge.target);
	}
	if (resolved.length > 0) {
		// For the "Highlight bridges" toggle: a true bridge node is one where the MAJORITY of its
		// neighbors belong to a DIFFERENT community than its own. High-degree hubs link to
		// many clusters but are firmly assigned to one — their own community dominates their neighbor
		// vote, so they don't qualify. Only nodes that are structurally "between" communities do.
		// Both edge types count here, matching the Leiden input: a note that ties two topics together
		// by topic rather than by an authored link is exactly as much a bridge.
		const isTopicEdge = (edge: GraphEdge) => edge.type === "wiki" || edge.type === "semantic";
		let bridgeNodes: Set<string> | null = null;
		if (isLeiden) {
			// Build neighbor community vote counts per node
			const neighborCommunityVotes = new Map<string, Map<number, number>>();
			for (const edge of gd.edges) {
				if (!isTopicEdge(edge)) continue;
				const sc = leidenCommunities[edge.source];
				const tc = leidenCommunities[edge.target];
				if (sc === undefined || tc === undefined || sc === tc) continue;
				// source sees a foreign neighbor tc
				let sv = neighborCommunityVotes.get(edge.source);
				if (!sv) {
					sv = new Map();
					neighborCommunityVotes.set(edge.source, sv);
				}
				sv.set(tc, (sv.get(tc) ?? 0) + 1);
				// target sees a foreign neighbor sc
				let tv = neighborCommunityVotes.get(edge.target);
				if (!tv) {
					tv = new Map();
					neighborCommunityVotes.set(edge.target, tv);
				}
				tv.set(sc, (tv.get(sc) ?? 0) + 1);
			}
			// Count total topic-edge degree per node
			const wikiDegree = new Map<string, number>();
			for (const edge of gd.edges) {
				if (!isTopicEdge(edge)) continue;
				wikiDegree.set(edge.source, (wikiDegree.get(edge.source) ?? 0) + 1);
				wikiDegree.set(edge.target, (wikiDegree.get(edge.target) ?? 0) + 1);
			}
			bridgeNodes = new Set<string>();
			for (const [nodeId, foreignVotes] of neighborCommunityVotes) {
				const totalForeignLinks = [...foreignVotes.values()].reduce((a, b) => a + b, 0);
				const total = wikiDegree.get(nodeId) ?? 0;
				// Bridge: more than bridgeThreshold of its links go to nodes outside its own community
				if (total > 0 && totalForeignLinks / total > settings.bridgeThreshold) {
					bridgeNodes.add(nodeId);
				}
			}
		}
		graphData = {
			...gd,
			nodes: gd.nodes.map((n) => {
				const info = pathInfo.get(n.path);
				const isBridge = bridgeNodes?.has(n.id) ?? false;
				// "Isolated" means the user never linked this note — a note pulled into a
				// topic purely by semantic similarity is still unlinked, and that's exactly
				// the gap worth surfacing. So this counts authored links only, not `degree`
				// (which now includes inferred edges). A tag is not a note, so it is
				// never "unlinked".
				const isIsolated = !isTagNode(n) && !linkedPaths.has(n.path);
				const highlighted =
					(settings.highlightBridges && isBridge) || (settings.highlightIsolated && isIsolated);
				return {
					...n,
					color: info?.color ?? undefined,
					cluster: info?.cluster ?? undefined,
					highlighted,
				};
			}),
		};
		const labels: Record<number, string> = {};
		for (let i = 0; i < resolved.length; i++) {
			labels[i] = resolved[i].label;
		}
		defaultClusterLabels = labels;
		// Topic membership changed, so previously generated names may describe a
		// grouping that no longer exists. Rebuild from the cache rather than
		// blanking: entries are keyed by membership, so a topic that survived the
		// change gets its name straight back, and one that didn't simply misses and
		// keeps its hub-filename default. This is also what restores names after a
		// reload — the cache is persisted but `generatedClusterLabels` is not.
		applyCachedTopicLabels();
		if (settings.autoLabelClusters && settings.graphChatModel) {
			void runTopicLabeling();
		}
		// First *real* topics of this build have landed: the cluster force is about
		// to reshape the layout, so track it rather than leaving the camera on the
		// pre-topic framing. Requires actual communities — the early wiki-only
		// passes resolve segments before Leiden has produced any.
		if (refitAfterTopicsSettle && Object.keys(leidenCommunities).length > 0) {
			refitAfterTopicsSettle = false;
			void tick().then(() => canvasComponent?.followLayout());
		}
	} else {
		// No segments — strip stale colors/highlights in one pass
		graphData = {
			...gd,
			nodes: gd.nodes.map((n) =>
				n.color !== undefined || n.cluster !== undefined || n.highlighted
					? { ...n, color: undefined, cluster: undefined, highlighted: false }
					: n,
			),
		};
		defaultClusterLabels = {};
	}
}

/**
 * Whether private note titles must be kept from the graph model.
 *
 * A filename is content: "Q3 Layoff List" leaks the sensitive fact by title
 * alone. The vault-wide privacy filter only runs at index time and is gated on
 * the *embedding* provider, so it says nothing about the graph chat model — a
 * separately configured provider that never passes through that check.
 */
function shouldWithholdPrivateTitles(): boolean {
	const graphProvider = settings.graphChatModel?.provider;
	return graphProvider != null && !data.isProviderTrusted(graphProvider);
}

/**
 * The per-topic title lists used both to *request* labels and to look up
 * already-cached ones.
 *
 * Shared deliberately: the cache is keyed by these titles, so if the two callers
 * ranked or filtered notes differently they would compute different keys and a
 * restored label would never match the run that produced it.
 */
function buildTopicsToLabel(withholdPrivateTitles: boolean): TopicToLabel[] {
	// Rank each topic's notes by degree so the titles we send are representative.
	const nodesByPath = new Map(graphData.nodes.map((node) => [node.path, node]));
	return segments.map((segment, index) => {
		const titles = [...segment.paths]
			.filter((path) => !withholdPrivateTitles || !data.isFilePrivate(path))
			.map((path) => nodesByPath.get(path))
			.filter((node): node is GraphNode => node != null)
			.sort((left, right) => (right.degree ?? 0) - (left.degree ?? 0) || left.label.localeCompare(right.label))
			.map((node) => node.label);
		// A topic whose notes are all private sends nothing and keeps its hub-note
		// fallback — labelTopics skips empty-title topics rather than calling.
		return { id: index, titles, fallbackLabel: segment.label };
	});
}

/**
 * Re-apply already-cached names to the current topics, without any model call.
 *
 * The label cache survives a reload, but `generatedClusterLabels` does not — it
 * is only ever written by a completed run. Without this, a restart shows
 * hub-filename labels for names that are sitting in the cache, and the only way
 * to get them back is to press the button (which now forces a re-generation and
 * re-spends the calls). Cheap enough to run on every topic change: it is a
 * handful of map lookups, and a miss just leaves the default in place.
 */
function applyCachedTopicLabels() {
	const cache = getTopicLabelCache();
	if (cache.size === 0) {
		generatedClusterLabels = {};
		return;
	}

	const topics = buildTopicsToLabel(shouldWithholdPrivateTitles());
	const restored: Record<number, string> = {};
	for (const topic of topics) {
		if (topic.titles.length === 0) continue;
		const cached = cache.get(topicMembershipKey(topic.titles.slice(0, TITLES_PER_TOPIC)));
		if (cached) restored[topic.id] = cached;
	}
	generatedClusterLabels = restored;
}

/**
 * Generate concept names for the current topics via the configured graph model.
 *
 * Notes are offered to the model in hub-first order (same ranking the default
 * label uses), so the most central notes describe the topic. Calls fan out up to
 * the labeller's concurrency limit and can be cancelled mid-run.
 *
 * Unchanged topics are served from cache unless `force` is set — the manual
 * button does force, so an explicit press always re-rolls; the automatic pass
 * does not, so it only pays for topics that actually changed.
 */
async function runTopicLabeling(options: { force?: boolean } = {}) {
	if (!settings.graphChatModel || segments.length === 0) return;

	labelingAbort?.abort();
	const controller = new AbortController();
	labelingAbort = controller;
	const localBuildVersion = buildVersion;

	const withholdPrivateTitles = shouldWithholdPrivateTitles();
	const topics = buildTopicsToLabel(withholdPrivateTitles);

	// Withholding titles quietly degrades the result: topics come back named after
	// a filename, or not renamed at all, with nothing on screen explaining why.
	// Only surfaced on an explicit press — the automatic pass runs on every topic
	// change and would turn this into a recurring nag.
	if (withholdPrivateTitles && options.force) {
		const withheld = segments.filter((segment) =>
			[...segment.paths].some((path) => data.isFilePrivate(path)),
		).length;
		if (withheld > 0) {
			showActionNotice(
				`Private note titles were withheld from ${withheld} ${withheld === 1 ? "topic" : "topics"}. Trust the graph model's provider to include them.`,
				settingsAction("general", "Open provider settings"),
			);
		}
	}

	isLabeling = true;
	try {
		const labels = await labelTopics(topics, settings.graphChatModel, {
			signal: controller.signal,
			cache: getTopicLabelCache(),
			force: options.force,
		});
		// Workers write each label into the membership-keyed cache as they finish,
		// so a cancelled or superseded run still leaves real, paid-for results
		// behind. Persist before the guard below returns, or quitting after a
		// cancel silently throws that work away and re-spends it on restart.
		scheduleTopicCacheSave();
		// A rebuild (or unmount) landed while we were waiting — these labels are
		// keyed to topic ids that may no longer mean the same thing.
		if (controller.signal.aborted || localBuildVersion !== buildVersion) return;
		generatedClusterLabels = labels;
	} finally {
		if (labelingAbort === controller) {
			isLabeling = false;
			labelingAbort = null;
		}
	}
}

/**
 * Manual cancel — the spinner doubles as a stop button while a run is live.
 *
 * Aborting rejects the in-flight calls, which lets `runTopicLabeling`'s existing
 * `finally` clear the spinner and its `signal.aborted` guard drop the partial
 * result. Labels already generated stay in the membership cache, so re-running
 * restores them without another call.
 */
function handleCancelLabeling() {
	labelingAbort?.abort();
}

/**
 * Manual "Label topics" action — ignores the auto toggle.
 *
 * Forces regeneration rather than reusing cached names. Pressing this button
 * when every topic is already cached would otherwise re-display the identical
 * labels without a single call, which reads as the button doing nothing; a
 * deliberate press means "give me different names".
 */
function handleLabelTopics() {
	if (!settings.graphChatModel) {
		// The breadcrumb is the link now, so it comes out of the message text.
		showActionNotice(
			"No graph chat model selected, so topics can't be named.",
			settingsAction("graph", "Open graph settings"),
		);
		return;
	}
	void runTopicLabeling({ force: true });
}

// ─── Saved Views ─────────────────────────────────────────

function handleClearFocusedClusters() {
	handleClearSelection();
}

/**
 * Collapse every topic into a single node, or expand them all back — the atom
 * button and the S shortcut. Every note stays represented either way; folding
 * merges topics into stand-in nodes rather than hiding notes.
 */
async function handleToggleCollapseAll() {
	// Guard against re-entry while a fresh Leiden run is in flight — otherwise rapid clicks
	// race on state writes and can leave the view stuck between modes.
	if (isLeidenRunning) return;

	// Two absolute commands: collapse all, expand all. Neither merges with the
	// folds the user made by hand — "all" means all, in both directions. Clearing
	// both per-topic sets on either press keeps that promise literal and stops a
	// stale fold reappearing later as state nothing on screen explains.
	collapseAll = !collapseAll;
	collapsedTopics = new Set();
	expandedTopics = new Set();

	// Re-frame the camera, but only after the layout has moved. Fitting
	// immediately frames the *old* positions and the nodes then drift out from
	// under the camera; a collapsed graph is also far smaller than the note-level
	// one, so without a refit a large vault leaves the few topic nodes off-screen.
	await tick();
	canvasComponent?.followLayout();
}

/**
 * Fold or unfold a set of topics.
 *
 * Takes an explicit target state rather than toggling each topic, because a
 * mixed selection has to resolve to one outcome — toggling per topic would
 * invert the mix instead of collapsing it.
 *
 * Under collapse-all the state is stored as *exceptions* (`expandedTopics`) so
 * that topics introduced by a later granularity change still arrive collapsed; outside it,
 * as the collapsed set itself. Both directions have to write to whichever set
 * is currently authoritative.
 */
async function setTopicsCollapsed(clusters: Iterable<number>, collapsed: boolean) {
	const targets = [...clusters];
	if (targets.length === 0) return;

	if (collapseAll) {
		const next = new Set(expandedTopics);
		for (const cluster of targets) {
			if (collapsed) next.delete(cluster);
			else next.add(cluster);
		}
		expandedTopics = next;
	} else {
		const next = new Set(collapsedTopics);
		for (const cluster of targets) {
			if (collapsed) next.add(cluster);
			else next.delete(cluster);
		}
		collapsedTopics = next;
	}

	// Folding is a local change, but it can still move the bounds enough to
	// strand nodes off-screen, so follow the settle like collapse-all.
	await tick();

	// Folding swaps a topic's notes for one synthetic node, so the selection has
	// to be re-derived against the new graph — otherwise it empties, the
	// selection bar disappears, and the Expand button goes with it.
	if (focusedClusters.size > 0) {
		const paths = canvasComponent?.getNodePathsForClusters(focusedClusters) ?? [];
		canvasComponent?.selectNodesByPaths(paths);
		handleSelectionChange(paths);
	}

	canvasComponent?.followLayout();
}

/** Apply the selection bar's collapse/expand verb to the selected topics. */
async function handleCollapseSelectedTopics() {
	if (selectedTopicsCollapseAction === null) return;
	await setTopicsCollapsed(focusedClusters, selectedTopicsCollapseAction === "collapse");
}

/** Commit a new topic resolution (γ) and re-run community detection. */
function handleTopicsCommit(resolution: number) {
	handleSettingsChange({ leidenResolution: resolution });
	void runLeidenSegmentation();
}

/**
 * Granularity level derived from the stored resolution, so the slider position
 * survives a reload and stays in sync if γ is changed from elsewhere.
 */
let granularityLevel = $derived(resolutionToGranularity(settings.leidenResolution ?? 1.0, granularityLadder));
/** Highest selectable level — shrinks to however many groupings this vault supports. */
let granularityMaxLevel = $derived(maxGranularityLevel(granularityLadder));

/**
 * Commit a new granularity level: map it to γ and re-run community detection.
 *
 * Changing granularity changes how many topics exist; collapsing (the atom) changes whether
 * they're drawn as groups or notes. The two are independent.
 */
function handleGranularityCommit(level: number) {
	handleTopicsCommit(granularityToResolution(level, granularityLadder));
}

/**
 * Step topic granularity by one level (arrow keys).
 *
 * Commits rather than using the drag path: a keypress is a discrete choice, so
 * the level should resolve even when it isn't already cached. Held arrows are
 * naturally rate-limited by the settle, and out-of-range steps no-op so the
 * ends of the ladder feel like ends rather than silently wrapping.
 */
function handleGranularityStep(delta: number) {
	if (!hasDerivedGranularityLadder) return;
	const next = granularityLevel + delta;
	if (next < MIN_GRANULARITY_LEVEL || next > granularityMaxLevel) return;
	handleGranularityCommit(next);
}

/**
 * Apply a granularity level *while the user is still dragging*.
 *
 * Every rung was computed during probing, so re-segmenting at a new level is a
 * cache hit and lands on the same frame — the graph re-groups under the knob
 * instead of after release, which is what makes granularity feel like a continuous view
 * of one structure rather than a series of separate queries.
 *
 * A level that somehow isn't cached is skipped rather than awaited: firing
 * Leiden runs mid-drag would queue work the user has already scrolled past.
 * `oncommit` still fires on release, so the final position always resolves.
 */
function handleGranularityChange(level: number) {
	const resolution = granularityToResolution(level, granularityLadder);
	if (resolution === settings.leidenResolution) return;

	const cached = getCachedPartition(graphTopologySignature(graphData), partitionKey(resolution));
	if (!cached) return;

	handleSettingsChange({ leidenResolution: resolution });
	leidenCommunities = cached;
	resolveAndApplySegments(graphData);
}

function handleHoverPreview(event: MouseEvent, path: string, targetEl: HTMLElement) {
	const sourcePath = plugin.app.workspace.getActiveFile()?.path ?? "";
	plugin.app.workspace.trigger("hover-link", {
		event,
		source: VIEW_TYPE_SMART_GRAPH,
		hoverParent: plugin,
		targetEl,
		linktext: path,
		sourcePath,
	});
}
</script>

<!-- Keydown sits on the whole view, not just the canvas: selecting a topic from
     the settings panel moves focus to that panel row, and a canvas-scoped
     listener meant the selection-bar shortcuts went dead exactly when a
     selection existed. Keydown still only fires for focus inside this subtree,
     so this widens the shortcuts to the graph leaf without claiming keys
     globally. `GraphCanvas.handleKeyDown` already ignores text inputs. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="smart-graph-view"
  style="--s2b-graph-toolbar-width: {toolbarWidth}px"
  onkeydown={(e) => canvasComponent?.handleKeyDown(e)}
>
  {#if isLoading && graphData.nodes.length === 0}
    <div class="graph-loading">
      <LoadingAnimation />
      <p>{loadingMessage}</p>
    </div>
  {:else}
    <GraphCanvas
      bind:this={canvasComponent}
      graphData={displayGraphData}
      directedWikiEdges={settings.directedWikiEdges}
      linkDistance={settings.linkDistance}
      chargeStrength={settings.chargeStrength}
      centerStrength={settings.centerStrength}
      linkStrength={settings.linkStrength}
      showWikiLinks={settings.showWikiLinks}
      showSemanticLinks={settings.showSemanticLinks ?? true}
      highlightSemanticLinks={settings.highlightSemanticLinks ?? false}
      showTopicHulls={settings.showTopicHulls ?? true}
      {focusedClusters}
      clusterLabels={effectiveClusterLabels}
      showClusterLabels={settings.showClusterLabels ?? true}
      clusterCohesionStrength={settings.clusterCohesionStrength ?? 0.15}
      onNodeClick={handleNodeClick}
      onTagClick={handleTagClick}
      onSetTopicCollapsed={(cluster, collapsed) => void setTopicsCollapsed([cluster], collapsed)}
      onRevealFile={handleRevealFile}
      onFocusCluster={handleFocusCluster}
      {lassoMode}
      onSelectionChange={handleSelectionChange}
      onClearFocusedClusters={handleClearFocusedClusters}
      onHoverPreview={handleHoverPreview}
      onToggleCollapseAll={handleToggleCollapseAll}
      immersed={isImmersed}
      onExitImmerse={handleExitImmerse}
      onCollapseSelectedTopics={() => void handleCollapseSelectedTopics()}
      onImmerse={() => void handleImmerse()}
      onOpenAllSelected={handleOpenAllSelected}
      onSendToChat={() => void handleSendToChat()}
      onOpenPaths={(paths) => void handleOpenPaths(paths)}
      onGranularityStep={handleGranularityStep}
    />
  {/if}

  <!-- What the selection bar says about itself, shared by both modalities. -->
  {#snippet selectionCount()}
    {#if selectedPaths.length > 0}
      {#if selectedTopicLabels}
        <!-- The selection IS one or more whole topics (strict match — see
             `selectedTopicLabels`), so name them the way the pill the user
             clicked did. The count stays: the name says *what*, the count says
             *how much*, and the mid-dot joins them as the independent facts
             they are — the same composition " · immersed" already uses. -->
        <strong title={selectedTopicLabels.join(", ")}>{selectedTopicLabels.join(", ")}</strong>
        · {selectedPaths.length}
        {selectedPaths.length === 1 ? "note" : "notes"} selected{isImmersed ? " · immersed" : ""}
      {:else}
        <strong>{selectedPaths.length}</strong>
        {selectedPaths.length === 1 ? "note" : "notes"} selected{isImmersed ? " · immersed" : ""}
      {/if}
    {:else if immerseTopicLabels}
      <!-- Immersed into topics: name them. The count is what the graph already
           shows, whereas the name is the one thing that isn't on screen once
           the topic's own pill is gone.

           Phrased as a sentence rather than the "· immersed" suffix the other
           two branches use: that mid-dot joins two independent facts (what is
           selected, what mode you are in), which is right when the left side is
           a count. A topic name isn't independent of the mode — it's the thing
           immersed into — so it reads as the object of the verb instead. -->
      Immersed into
      <strong title={immerseTopicLabels.join(", ")}>{immerseTopicLabels.join(", ")}</strong>
    {:else}
      <strong>{noteNodeCount}</strong>
      {noteNodeCount === 1 ? "note" : "notes"} · immersed
    {/if}
  {/snippet}

  <!-- Mobile's answer to the desktop selection bar's "Immersed into X".
       Immersion is a mode with no visible trace once the topic's own pill is
       gone: the graph just shows fewer notes, with nothing saying which subset
       or why. Desktop states that in the bar it already keeps on screen, but on
       mobile that bar is a sheet driven by the selection, and immersion
       deliberately does not hold it open (see below) — so the name had nowhere
       to live and the only cue was the rail's exit button.

       Top-left: the toolbar row is right-aligned at the same offset, so the two
       share the strip without overlapping, and the bottom is already spoken for
       by the selection sheet and Obsidian's navbar. Non-interactive — exiting
       stays the rail's job, one control for one action. -->
  {#if isImmersed && onMobile}
    <div class="graph-immerse-banner">
      <span class="selection-count">
        {#if immerseTopicLabels}
          Immersed into
          <strong>{immerseTopicLabels.join(", ")}</strong>
        {:else}
          <!-- A raw lasso has no name to give, so fall back to the size of what
               you're in — the same thing the desktop bar says in this case. -->
          Immersed · <strong>{noteNodeCount}</strong>
          {noteNodeCount === 1 ? "note" : "notes"}
        {/if}
      </span>
    </div>
  {/if}

  <!-- Immersion is a *mode* you work inside, not a transient result like a
       selection, so on mobile it must not hold the sheet open: a sheet plus its
       dismiss layer covers the canvas, which left the graph you just immersed
       into un-pannable, un-selectable and impossible to immerse further. The
       sheet is therefore driven by the selection alone, and immersion carries
       its own persistent affordance on the toolbar (see GraphControls), which
       floats above the canvas without blocking it. -->
  {#if onMobile ? selectedPaths.length > 0 : isImmersed || selectedPaths.length > 0}
    {#if onMobile}
      <!--
        The desktop bar's only mobile treatment was `flex-wrap: wrap`, which
        turned one row into three and left the divider — a rule that separates
        the count from the verbs — pointing at nothing. A sheet is a narrow
        column by construction, so the verbs stack as full-width rows and the
        divider has no job to be left without.

        Not draggable: this is a fixed list of verbs with nothing to expand
        into, so a handle would advertise a gesture that does nothing.
      -->
      <BottomSheet
        open={true}
        onClose={handleClearSelection}
        draggable={false}
        ariaLabel="Graph selection"
      >
        <!-- Same structure as the settings sheet: a heading outside a
             `.setting-items` card holding the rows, so the two sheets read as
             one surface rather than two hand-styled ones. -->
        <div class="selection-sheet setting-group">
          <div class="selection-sheet-header">
            <span class="selection-count">{@render selectionCount()}</span>
            <Button iconId="x" onClick={handleClearSelection} tooltip="Clear selection" />
          </div>
          <div class="selection-sheet-actions setting-items">
            <!-- Promoted from icon-only to a labelled row. It rendered at
                 30x26 on the bar — the easiest control here to mis-tap, and
                 it sat next to a destructive one. -->
            <Button
              iconId="scan"
              buttonText="Zoom to selection"
              onClick={handleZoomToSelection}
              tooltip="Move the camera to fit the selected notes"
            />
            {#if selectedTopicsCollapseAction !== null}
              <Button
                iconId={selectedTopicsCollapseAction === "collapse" ? "chevrons-down-up" : "chevrons-up-down"}
                buttonText={selectedTopicsCollapseAction === "collapse" ? "Collapse" : "Expand"}
                onClick={() => void handleCollapseSelectedTopics()}
                tooltip={selectedTopicsCollapseAction === "collapse"
                  ? "Fold the selected topics into single nodes"
                  : "Unfold the selected topics back into notes"}
              />
            {/if}
            <Button
              iconId="scan-search"
              buttonText="Immerse"
              onClick={handleImmerse}
              tooltip="Rebuild graph with selected notes only"
            />
            {#if !hasOpenChat}
              <Button
                iconId="message-square"
                buttonText="Open in chat"
                onClick={handleSendToChat}
                tooltip="Reveal the chat and attach the selected notes"
              />
            {/if}
            <Button
              iconId="copy-plus"
              buttonText="Open all"
              onClick={handleOpenAllSelected}
              tooltip="Open all selected notes in new tabs"
            />
          </div>
        </div>
      </BottomSheet>
    {:else}
      <div class="graph-selection-bar">
        <span class="selection-count">{@render selectionCount()}</span>
        <!-- Left of the divider with the count: this moves the camera, it doesn't
             act on the notes the way the verbs on the right do. Grouping it with
             the count keeps that split legible, and leaves both icon-only buttons
             bracketing the labelled actions rather than sitting among them. -->
        {#if selectedPaths.length > 0}
          <Button iconId="scan" onClick={handleZoomToSelection} tooltip="Zoom to selection (F)" />
        {/if}
        <div class="selection-divider"></div>
        <div class="selection-actions">
          {#if selectedPaths.length > 0}
            {#if selectedTopicsCollapseAction !== null}
              <!-- Same chevrons as the toolbar's collapse-all: this is that action
                   scoped to a selection rather than a different one, so it should
                   not carry a different glyph. -->
              <Button
                iconId={selectedTopicsCollapseAction === "collapse" ? "chevrons-down-up" : "chevrons-up-down"}
                buttonText={selectedTopicsCollapseAction === "collapse" ? "Collapse" : "Expand"}
                onClick={() => void handleCollapseSelectedTopics()}
                tooltip={withKey(
                  selectedTopicsCollapseAction === "collapse"
                    ? "Fold the selected topics into single nodes"
                    : "Unfold the selected topics back into notes",
                  "C",
                )}
              />
            {/if}
            <Button
              iconId="scan-search"
              buttonText="Immerse"
              onClick={handleImmerse}
              tooltip={withKey("Rebuild graph with selected notes only", "I")}
            />
            {#if !hasOpenChat}
              <Button
                iconId="message-square"
                buttonText="Open in chat"
                onClick={handleSendToChat}
                tooltip={withKey("Reveal the chat and attach the selected notes", "A")}
              />
            {/if}
            <Button
              iconId="copy-plus"
              buttonText="Open all"
              onClick={handleOpenAllSelected}
              tooltip={withKey("Open all selected notes in new tabs", "O")}
            />

            <!-- Icon-only: dismissing isn't one of the verbs you came here for, so
                 it reads as an affordance on the bar rather than a peer action. -->
            <Button iconId="x" onClick={handleClearSelection} tooltip="Clear selection (Esc)" />
          {:else}
            <Button buttonText="Exit" onClick={handleExitImmerse} tooltip="Exit immerse (Esc)" />
          {/if}
        </div>
      </div>
    {/if}
  {/if}

  <GraphControls
    {settings}
    {isLoading}
    loadingLabel={loadingMessage}
    onSettingsChange={handleSettingsChange}
    onFitToView={handleFitToView}
    onRefresh={handleRefresh}
    onReapplySegments={() => resolveAndApplySegments(graphData)}
    onSeedChange={() => void handleSeedChange()}
    {granularityLevel}
    {granularityMaxLevel}
    granularityReady={hasDerivedGranularityLadder}
    onGranularityChange={handleGranularityChange}
    onGranularityCommit={handleGranularityCommit}
    isLeidenRunning={isLeidenRunning}
    {isLabeling}
    onLabelTopics={handleLabelTopics}
    onCancelLabeling={handleCancelLabeling}
    {lassoMode}
    onLassoModeChange={handleLassoModeChange}
    {graphData}
    nodeCount={displayGraphData.nodes.length}
    segments={labeledSegments}
    {isTopicsCollapsed}
    focusedSegmentIds={focusedSegmentIds}
    onFocusSegment={handleFocusSegment}
    onToggleCollapseAll={handleToggleCollapseAll}
    bind:isCollapsed={isControlsCollapsed}
    {isImmersed}
    onExitImmerse={handleExitImmerse}
    onToolbarWidth={(width) => (toolbarWidth = width)}
  />
</div>

<style>
  .smart-graph-view {
    width: 100%;
    height: 100%;
    position: relative;
    background: var(--background-primary);
    overflow: hidden;
  }

  /* Obsidian's mobile navbar floats over the bottom of the view, covering the
     last ~84px of the canvas — nodes that settle down there (isolated ones
     especially) end up under it and can't be tapped. Reserve the navbar's
     height the same way the chat composer does, so the graph's usable area
     ends above it. */
  :global(.is-mobile) .smart-graph-view {
    height: calc(100% - (52px + env(safe-area-inset-bottom)));
  }

  .graph-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
    color: var(--text-muted);
  }

  .graph-loading p {
    margin: 0;
    font-size: 14px;
  }

  .graph-selection-bar {
    position: absolute;
    /* Clear Obsidian's status bar, which floats over the bottom-right of the
       canvas — at the previous 12px the two overlapped and the word/backlink
       counts collided with the bar's own buttons. */
    bottom: 34px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px 6px 14px;
    /* Page fill + border, no shadow — the plugin's surface language after the
       composer went flat: a surface is defined by its outline, not by
       elevation. This bar previously used `--background-secondary` +
       `--shadow-l` to read as a floating popover, which made it the one
       shadowed slab left in the plugin. The bar is opaque, so separation from
       the canvas behind it comes from the border alone, exactly like the
       composer against the page. */
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    /* `--radius-l` (12px) rather than the composer's literal 22px: that 22px is
       half the composer's height — a pill — not a house rounding, and it only
       reads as one at that height. 12px is Obsidian's own value for floating
       panels, and being a token it tracks whatever the user's theme defines. */
    border-radius: var(--radius-l);
    z-index: 12;
    white-space: nowrap;
    animation: s2b-selection-bar-in 120ms ease-out;
  }

  /* Slide up a touch on appear — the bar shows up in response to a selection
     made elsewhere on the canvas, so a little motion draws the eye to it. */
  @keyframes s2b-selection-bar-in {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }

  /* Same flat surface language as the selection bar — page fill, border, no
     shadow — so the two read as one family rather than two floating slabs. */
  .graph-immerse-banner {
    position: absolute;
    top: 8px;
    left: 8px;
    display: flex;
    align-items: center;
    padding: 6px 12px;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-l);
    /* Below the toolbar rail (13) and the sheet (14): this is a passive label,
       so nothing it could cover should lose its tap. Above the canvas. */
    z-index: 11;
    /* The toolbar row is right-aligned at the same top offset. Leave it the
       corner: reserve its MEASURED width (published as a custom property by the
       view root) plus an 8px gutter, and truncate rather than push into it.

       This was a hardcoded `calc(100% - 160px)` justified as "3 buttons at
       44px". Both numbers were wrong: the buttons are 30px, and immersing —
       precisely when this banner exists — adds a sixth (exit) button, so the
       row is ~210px and painted straight over the banner, which sits below it
       at z-index 11. Measuring removes the class of bug rather than re-guessing
       the constant: the count also changes with the DEV-only wrench button, and
       the row wraps on narrow phones. */
    max-width: calc(100% - var(--s2b-graph-toolbar-width, 0px) - 16px);
    animation: s2b-immerse-banner-in 120ms ease-out;
  }

  /* Drops in from above, mirroring the selection bar's rise from below — both
     appear in response to something done on the canvas, not at their own edge. */
  @keyframes s2b-immerse-banner-in {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* The banner's own box already caps the width against the toolbar, so the
     sentence just fills it — the desktop bar's fixed 30ch would either overflow
     a narrow phone or cut a name short on a wide one. */
  .graph-immerse-banner .selection-count {
    max-width: 100%;
  }

  .selection-count {
    font-size: var(--font-ui-small);
    font-weight: var(--font-medium);
    color: var(--text-muted);
    /* Counts are a couple of characters; topic names are free text and can be
       long enough to stretch the bar across the canvas.

       The cap lives on the whole sentence rather than on the <strong>: an
       inline-block with `overflow: hidden` takes its BOTTOM MARGIN EDGE as its
       baseline, not its text baseline, so capping the <strong> that way dropped
       the name ~2.5px below the muted words beside it (measured) — and
       `vertical-align: baseline` cannot correct it, because that displaced edge
       *is* the baseline. Truncating at this level keeps <strong> plain inline
       text, so it stays flush, and the ellipsis still lands. */
    display: block;
    max-width: 30ch;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* The number (or topic name) is the thing being acted on, so it carries the
     emphasis while the surrounding words stay muted. */
  .selection-count :global(strong) {
    color: var(--text-normal);
    font-weight: var(--font-semibold);
  }

  .selection-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* Quiet toolbar buttons. Obsidian's stock `button` styling
     (`--interactive-normal` fill + `--input-shadow`) is its FORM treatment —
     Settings pages, dialogs — where each button is a standalone control on a
     page. In a toolbar Obsidian's own convention is transparent-at-rest
     controls that highlight on hover (view-header actions, search-view
     toggles), and the composer's action row already treats its labelled
     triggers the same way. With the bar itself flat, the stock fill also
     re-imported the raised-slab look at button scale: several small
     `--input-shadow`s inside a deliberately shadowless bar. The bar's border
     and divider do the grouping; buttons need no individual fill to read as
     actionable in a bar that only appears once something is selected.
     (Scoped to the floating bar — the mobile selection sheet styles its own
     rows.) */
  .graph-selection-bar :global(button) {
    background: transparent;
    box-shadow: none;
  }

  .graph-selection-bar :global(button:hover) {
    background: var(--background-modifier-hover);
  }

  /* Separates the count and its view control from the verbs acting on the notes. */
  .selection-divider {
    width: 1px;
    align-self: stretch;
    margin: 2px 0;
    background: var(--background-modifier-border);
    flex-shrink: 0;
  }

  /* ── Mobile selection sheet ──────────────────────────────────────────────
     Replaces the wrapped bar entirely. The bar used to hang at a hardcoded
     `bottom: 92px` to clear Obsidian's floating navbar, which left it in open
     canvas attached to neither the content nor the screen edge; the sheet is
     anchored at `bottom: 0` inside `.smart-graph-view`, which already subtracts
     the navbar band from its own height, so the clearance comes from the one
     measurement that was already right. */

  /* Core sizes `.setting-group` for a full settings tab; this is a narrow
     column, same as the settings sheet. */
  .selection-sheet {
    max-width: none;
    width: 100%;
  }

  /* The count is the sheet's heading, so it matches a `.setting-item-heading`:
     outside the card, 16px in so it shares the rows' left edge, no rule (the
     card below provides the separation). */
  .selection-sheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 32px;
    padding: 0 16px;
    margin-bottom: 8px;
  }

  /* The card holding the verbs. Background set explicitly rather than left to
     `--setting-items-background`, which outside a settings tab resolves to the
     same value as the sheet behind it — see the settings panel for the same
     note. */
  .selection-sheet-actions {
    display: flex;
    flex-direction: column;
    background-color: var(--background-primary);
    padding-block: 4px;
  }

  /* Full-width rows at the touch floor. `justify-content` is set explicitly
     because Obsidian's base `button` rule centres content, which ragged the
     labels once the buttons became full-width. Transparent, like a
     `.setting-item` inside a card — the card paints the surface. */
  .selection-sheet-actions :global(button) {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
    width: 100%;
    min-height: 44px;
    padding: 10px 16px;
    text-align: left;
    background: none;
    border: none;
    border-radius: 0;
    box-shadow: none;
  }

  /* Hairlines between rows, the way core separates items within one card.
     `:not(:first-child)` rather than a border on every row, so the card's own
     rounded top edge stays clean. */
  .selection-sheet-actions :global(button:not(:first-child)) {
    border-top: 1px solid var(--background-modifier-border);
  }
</style>
