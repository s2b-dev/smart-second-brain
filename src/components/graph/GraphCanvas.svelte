<script lang="ts">
import { onMount, untrack } from "svelte";
import { Menu } from "obsidian";
import { forceSimulation, type SimulationNodeDatum, type SimulationLinkDatum } from "d3-force";
import type { GraphData, GraphNode, EdgeType } from "../../types/graph";
import { deriveClusterRepresentativesFromGraph } from "../../views/smart-graph/graphDataBuilder";
import {
	computeCoreNodeBounds,
	computeNodeBounds,
	easeOutCubic,
	framingFocus,
	framingTransform,
	GRAPH_FIT_MAX_SCALE,
	type BoundingBox,
	type FramingPadding,
} from "../../utils/graphAnimation";
import { buildTopicRegion } from "../../utils/convexHull";
import { type WorldRect, pointInPolygon, rectContains, trimOutliers } from "../../utils/graphGeometry";
import { autoNodeSize, densityForceProfile, nodeDrawRadius, zoomNodeScale } from "../../utils/graphUtils";
import { applyLayoutForces, clusterCohesionForce, type LayoutPhysicsConfig } from "../../utils/graphLayout";
import { resolveNodePaths, topicNodeId } from "../../utils/mergeNodes";
import { PixiRenderer, readThemeColors, type ClusterPillHit } from "./pixiRenderer";

interface Props {
	graphData: GraphData;
	linkDistance: number;
	class?: string;
	onUserViewportChange?: () => void;
	alwaysRefitOnDataChange?: boolean;
	directedWikiEdges?: boolean;
	chargeStrength?: number;
	centerStrength?: number;
	linkStrength?: number;
	showWikiLinks?: boolean;
	/** When false, inferred semantic similarity edges are not drawn (they still inform topics). */
	showSemanticLinks?: boolean;
	/** When true, drawn inferred edges take the accent colour instead of the shared line colour. */
	highlightSemanticLinks?: boolean;
	/** When false, the tinted topic regions are not drawn. */
	showTopicHulls?: boolean;
	focusedClusters?: Set<number>;
	clusterLabels?: Record<number, string>;
	/** When false, the cluster/topic label pills are not drawn over the graph. */
	showClusterLabels?: boolean;
	/**
	 * Strength of the cluster cohesion force (0 = off, default 0.15).
	 * Pulls nodes toward their cluster centroid each simulation tick.
	 */
	clusterCohesionStrength?: number;
	onNodeClick?: (path: string) => void;
	/** A tag node was clicked; receives the tag as labelled (with its `#`). */
	onTagClick?: (tag: string) => void;
	/** Fold or unfold one topic. Used by the context menu's direct actions. */
	onSetTopicCollapsed?: (cluster: number, collapsed: boolean) => void;
	onRevealFile?: (path: string) => void;
	/**
	 * `pan` frames the cluster in the viewport; omit it to select without moving
	 * the camera. `multi` toggles membership instead of replacing the selection.
	 */
	onFocusCluster?: (cluster: number, pan?: boolean, multi?: boolean) => void;
	lassoMode?: boolean;
	onSelectionChange?: (paths: string[]) => void;
	onClearFocusedClusters?: () => void;
	onHoverPreview?: (event: MouseEvent, path: string, targetEl: HTMLElement) => void;
	/** Collapse or expand all topics at once (the atom button / S shortcut). */
	onToggleCollapseAll?: () => void;
	immersed?: boolean;
	onExitImmerse?: () => void;
	// Selection-bar verbs, mirrored as keyboard shortcuts so a selection made on
	// the canvas can be acted on without moving to the bar.
	onCollapseSelectedTopics?: () => void;
	onImmerse?: () => void;
	onOpenAllSelected?: () => void;
	onSendToChat?: () => void;
	/** Open an explicit set of notes, sharing the bulk-open confirmation. */
	onOpenPaths?: (paths: string[]) => void;
	/** Step topic granularity (Leiden γ) by one level. Arrow keys. */
	onGranularityStep?: (delta: number) => void;
}

let {
	graphData,
	linkDistance,
	class: className = "",
	onUserViewportChange,
	alwaysRefitOnDataChange = false,
	directedWikiEdges = false,
	chargeStrength = -1000,
	centerStrength = 0.1,
	linkStrength = 1,
	showWikiLinks = true,
	showSemanticLinks = true,
	highlightSemanticLinks = false,
	showTopicHulls = true,
	focusedClusters = new Set<number>(),
	clusterLabels = {},
	showClusterLabels = true,
	clusterCohesionStrength = 0.15,
	onNodeClick,
	onTagClick,
	onSetTopicCollapsed,
	onRevealFile,
	onFocusCluster,
	lassoMode = false,
	onSelectionChange,
	onClearFocusedClusters,
	onHoverPreview,
	onToggleCollapseAll,
	immersed = false,
	onExitImmerse,
	onCollapseSelectedTopics,
	onImmerse,
	onOpenAllSelected,
	onSendToChat,
	onOpenPaths,
	onGranularityStep,
}: Props = $props();

let containerEl: HTMLButtonElement;

// Invisible anchor element repositioned over hovered nodes for Obsidian's hover popover
let hoverAnchorEl: HTMLAnchorElement;

// Pixi renderer instance
let pixi: PixiRenderer | null = null;

// Node size auto-tuned from graph size: larger for small graphs, smaller for dense ones.
// Uses a continuous log scale so the transition is smooth, clamped to a readable range.
//
// Counts the notes the graph *represents* — a collapsed topic counts as its
// members, not as one node. The tune adapts to vault size, and reading the
// on-screen node count instead made collapse-all jump the base (2 → 5 on a
// large vault, with the degree cap and label font scaling along): the closer
// camera fit already magnifies the handful of topic nodes, so re-inflating
// their world radius on top rendered them as giant discs.
let representedNoteCount = $derived(
	graphData.nodes.reduce(
		(count, node) =>
			count + (node.kind === "topic" ? (node.memberPaths?.length ?? 1) : node.kind === "tag" ? 0 : 1),
		0,
	),
);
let nodeSize = $derived(autoNodeSize(representedNoteCount));

// Density-adaptive physics: unlike node size (which keys off *represented*
// notes so folding doesn't change the sizing regime), the forces key off the
// nodes actually on screen — that count is what decides how far out the camera
// must sit to frame everything. Each force gets its own multiplier (see
// densityForceProfile for the asymmetry between the intra- and inter-cluster
// length scales). The user's slider values are the baseline at the reference
// density, where every multiplier is exactly 1.
let visibleNodeCount = $derived(graphData.nodes.length);
let forceProfile = $derived(densityForceProfile(visibleNodeCount));
/** Density-adjusted link distance — for the circle pre-layout's sizing. */
let effectiveLinkDistance = $derived(linkDistance * forceProfile.spacing);
/** Density-adjusted cohesion — for the color-only path's in-place strength sync. */
let effectiveClusterCohesion = $derived(clusterCohesionStrength * forceProfile.cohesion);

/**
 * The raw physics inputs {@link applyLayoutForces} derives everything from —
 * the density profile is applied inside it, never here, so the canvas and the
 * headless layout benchmark cannot disagree about the effective values.
 */
function layoutPhysicsConfig(): LayoutPhysicsConfig {
	return {
		linkDistance,
		chargeStrength,
		centerStrength,
		linkStrength,
		clusterCohesionStrength,
		nodeSize,
		visibleNodeCount,
	};
}

// Edge alpha auto-tuned from edge count: fade edges as the graph grows denser so
// overlapping edges don't compound into a dark mass.  Clamped to [0.18, 0.60].
let baseEdgeAlpha = $derived(Math.max(0.18, Math.min(0.6, 1.0 / Math.sqrt(Math.max(graphData.edges.length, 4)))));

// Interaction state
let hoveredNode: GraphNode | null = $state(null);
let draggedNode: GraphNode | null = $state(null);
let hasDragged = false;
// Track pointer-down position to detect viewport pans (which also fire click)
let pointerDownScreenPos: { x: number; y: number } | null = null;
/** Pointer type of the press in progress, so the click that follows can apply
 *  touch tolerances. `click` itself carries no `pointerType`. */
let pointerDownType = "mouse";

/**
 * How far the pointer may travel between press and release and still count as a
 * click rather than a pan.
 *
 * A mouse pivots on a fixed cursor, so 4px is generous. A fingertip does not: a
 * deliberate tap routinely slides 10px or more, which silently turned every tap
 * on a node into a "pan" and made nodes unselectable by touch. Reuses the same
 * slack the long-press path already allows for the identical reason.
 */
function clickMoveTolerance(pointerType: string): number {
	return pointerType === "touch" || pointerType === "pen" ? LONG_PRESS_MOVE_TOLERANCE : 4;
}

/** Extra screen-space hit slack for finger taps — see findNodeAt. */
const TOUCH_HIT_SLACK = 8;

/**
 * Touch has no hover: a finger is either down or gone, so the node highlight
 * (label + connected-neighbour emphasis) had no state to live in and merely
 * flashed for the length of the press — the browser fires a synthetic
 * `mouseleave` as the touch sequence ends, which cleared it.
 *
 * So on touch the highlight LATCHES: tapping a node holds it lit until the next
 * tap moves it elsewhere or clears it on empty canvas. That mirrors what hover
 * gives a mouse — "this is the node I am looking at, these are its links" — as
 * a persistent state rather than a transient one, and needs no gesture the user
 * has to discover. Mouse hover is untouched.
 */
let touchLatchedNode: GraphNode | null = $state(null);

function hitSlack(pointerType: string): number {
	return pointerType === "touch" || pointerType === "pen" ? TOUCH_HIT_SLACK : 0;
}

// Long-press → context menu (touch has no right-click). Armed on pointerdown
// over a node, cancelled by movement/lift; fires the same menu as oncontextmenu.
let longPressTimer: number | null = null;
let longPressFired = false;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;

function cancelLongPress() {
	if (longPressTimer !== null) {
		window.clearTimeout(longPressTimer);
		longPressTimer = null;
	}
}

// Non-reactive drag reference — directly mutates the d3 SimNode's fx/fy
// without going through Svelte's $state proxy (wiki mode only)
let dragSimNode: SimNode | null = null;

/**
 * Framing margin for camera fits.
 *
 * `computeNodeBounds` measures node *centres*, so anything drawn around a node
 * falls outside the box: its own radius, its label, and — the big one — the
 * topic hull, which extends `HULL_PADDING` plus a node radius past the
 * outermost member. Without room for that, fits clip the top and bottom
 * clusters even though every node centre is technically in view.
 */
const GRAPH_FIT_PADDING: FramingPadding = {
	top: 90,
	right: 70,
	bottom: 70,
	left: 70,
};

// Lasso selection state
let selectedNodes: Set<string> = $state(new Set());
let isLassoing = $state(false);
let lassoPoints: Array<{ x: number; y: number }> = [];
let lassoJustFinished = false;

// Track which node already had a hover-preview triggered (fire once per node)
let previewTriggeredForNode: string | null = null;
let pendingUserViewportMove = false;
let pendingUserViewportZoom = false;

// Track whether we need an initial fit-to-view after first simulation setup
let needsInitialFit = true;
// Tick counter for periodic camera refits during force-mode settling
let forceTickCount = 0;

// Hide canvas during the initial chaos phase on fresh loads (no cached positions).
// Starts hidden; revealed immediately when positions are known, or after 300ms on fresh loads.
let canvasVisible = $state(false);
let canvasRevealTimer: number | null = null;

// Simulation reference — $state so the hot-update $effect re-runs when simulation is (re)created
let simulation: ReturnType<typeof forceSimulation<SimNode>> | null = $state(null);
// Last applied force parameters, so the hot-update effect can tell a real physics
// change from a settings-object replacement that left every number untouched.
// Cleared whenever a simulation is created so a fresh one always gets its forces.
let lastPhysicsSignature: string | null = null;
/**
 * True while a re-cluster transition is running with its slower decay settings.
 * `alphaDecay`/`velocityDecay` persist on the simulation, so they have to be
 * restored once it settles or every later interaction inherits the slow feel.
 */
let isReclustering = false;
/** The active simulation's own decay values, captured at construction. */
let baseAlphaDecay = 0.02;
let baseVelocityDecay = 0.3;

/** False while the graph's leaf is hidden (background tab, collapsed sidebar). */
let leafVisible = true;
/** True when the simulation was stopped mid-settle because the leaf went hidden. */
let simPausedWhileHidden = false;

// D3-compatible node/link types
/**
 * The graph container with the teardown hook we stash on it. Declared rather than reached
 * for via `any` so both the write and the read agree on the shape.
 */
type GraphCleanupHost = HTMLElement & { __graphCleanup?: () => void };

type SimNode = GraphNode & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode> & {
	weight: number;
	type: EdgeType;
	/** Born in the latest data change — only these take the edge fade-in. */
	isNew?: boolean;
};

let simNodes: SimNode[] = [];
let simLinks: SimLink[] = [];

// Pre-split edge arrays – built once in setupSimulation, reused every frame.
// Holds every drawable edge type; per-type visibility is decided in drawEdges.
let renderableSimLinks: SimLink[] = [];

// Edge fade-in: edges *born in the latest data change* start invisible and
// fade to full opacity (see `SimLink.isNew`). Pre-existing edges are exempt,
// so a local change — one topic folding, one note arriving — doesn't flash
// the whole graph's edges.
let edgeFadeAlpha = 1;
const EDGE_FADE_RATE = 0.04; // reaches 1 in 25 ticks (~0.4s at 60fps)

/** Cross-fade speed for topic regions — reaches 1 in ~15 frames (~250ms at 60fps). */
const HULL_FADE_RATE = 0.067;

/**
 * How far a topic's notes are seeded from its collapsed position when expanding.
 * Just enough that the force sim has a gradient to push them apart — seeding
 * them all on the exact same point would leave them stuck there. Deliberately
 * small: the visible outward travel *is* the expand animation, and any distance
 * covered by the seed itself is a teleport the eye can't follow.
 */
const EXPAND_SCATTER_RADIUS = 18;

/**
 * Spawn-grow animation for nodes born in a data change (a topic node on
 * collapse, member notes on expand, a note created while the graph is open).
 * Growing from a fraction of the final radius at the position the change
 * happened gives the eye a single point to follow instead of a full-size pop.
 */
const NODE_SPAWN_MS = 320;
const NODE_SPAWN_START_SCALE = 0.25;

/** Birth timestamps of nodes still growing in, cleared as each finishes. */
const nodeSpawnTimes = new Map<string, number>();

/**
 * Alpha held during a collapse/expand transition — matches what releasing a drag
 * uses, since that is the pull strength observed to actually recentre a stranded
 * node.
 */
const RETARGET_ALPHA = 0.3;
/**
 * How long that alpha is held. Long enough for a distant topic to travel to the
 * middle, short enough that the graph still visibly comes to rest.
 */
const RETARGET_HOLD_MS = 1200;

/**
 * Re-clustering transition (granularity level change).
 *
 * Deliberately gentler than a retarget: every node gets a new destination at
 * once, so a high alpha with the default decay makes the whole graph snap. A
 * lower starting alpha limits how hard nodes are pushed, the slow `alphaDecay`
 * gives them time to arrive rather than being cut off mid-flight, and the high
 * `velocityDecay` (drag) stops them overshooting and rebounding — that
 * combination reads as flowing rather than jumping.
 */
const RECLUSTER_ALPHA = 0.22;
const RECLUSTER_ALPHA_DECAY = 0.012;
const RECLUSTER_VELOCITY_DECAY = 0.55;
/**
 * Cohesion multiplier held during the re-cluster transition.
 *
 * The equilibrium cohesion is tuned gentle (base strength × density profile ×
 * per-cluster member damping — combined ~5× weaker than it once was, so
 * settled clusters keep breathing room). Migration across the layout to a
 * *new* topic needs the strong pull back for a moment, or freshly split
 * topics stay spatially interleaved with overlapping hulls. Ramped back to the
 * equilibrium strength as the transition ends (see RECLUSTER_BOOST_RAMP_*).
 */
const RECLUSTER_COHESION_BOOST = 3;

/**
 * Alpha span over which the migration boost eases back to equilibrium.
 *
 * The boost used to be handed back in one step at alpha < 0.02 — but at 3× the
 * equilibrium pull, the migration leaves every cluster compressed well past
 * where charge repulsion wants it, and the simulation still has ~2.5s of ticks
 * left below 0.02. Stepping the force field there made the settled-looking
 * graph visibly push apart once, seconds after the migration seemed done.
 *
 * The ramp spans the *whole* transition (it starts at RECLUSTER_ALPHA, i.e. on
 * the first tick) rather than a narrow window at the end: a flat full-boost
 * plateau followed by a late release still read as two animations — migrate,
 * then relax. Eased from the start, relinquishing the boost is simply part of
 * the settling motion.
 */
const RECLUSTER_BOOST_RAMP_START = RECLUSTER_ALPHA;
const RECLUSTER_BOOST_RAMP_END = 0.02;

/**
 * Current cohesion boost factor for the migration, as a function of alpha.
 * Pure in alpha so the tick handler and the physics-rebuild effect can never
 * disagree about the strength mid-transition.
 *
 * Smoothstep rather than linear: its zero slope at both ends means the factor
 * holds near the full boost early — while alpha is high and the migration is
 * covering real distance — and lands on 1 tangentially, so there is no kink in
 * the force field at either boundary. (In wall-clock terms alpha decays
 * exponentially, so the middle of the curve is also stretched over the longest
 * stretch of the transition.)
 */
function reclusterBoostFactor(alpha: number): number {
	if (alpha >= RECLUSTER_BOOST_RAMP_START) return RECLUSTER_COHESION_BOOST;
	if (alpha <= RECLUSTER_BOOST_RAMP_END) return 1;
	const t = (RECLUSTER_BOOST_RAMP_START - alpha) / (RECLUSTER_BOOST_RAMP_START - RECLUSTER_BOOST_RAMP_END);
	const eased = t * t * (3 - 2 * t);
	return RECLUSTER_COHESION_BOOST + (1 - RECLUSTER_COHESION_BOOST) * eased;
}

/**
 * True only while the 3× migration boost is in play — i.e. the transition was
 * started by a topic reassignment. `isReclustering` alone can't distinguish
 * that from a collapse/expand `followLayout` transition, which shares the
 * decay/camera treatment but never boosts cohesion; ramping there would
 * *introduce* a triple-strength pull mid-collapse rather than remove a step.
 */
let reclusterBoostActive = false;

/**
 * Delay before the corrective fit that runs after the layout has stopped
 * drifting. Long enough that the residual creep past the tracking threshold has
 * finished, short enough not to feel like a late lurch.
 */
const SETTLE_FIT_DELAY_MS = 900;

/** Extra world-space breathing room between a topic's outermost node and its region edge. */
const HULL_PADDING = 26;

// Smooth hover highlighting: per-node alpha lerps toward target on each frame.
// 0 = fully dimmed, 1 = fully visible. Drives node, edge, and label opacity.
let hoverAlphas: Map<string, number> = new Map();

/**
 * Hull cross-fade state.
 *
 * A granularity change reassigns every cluster id at once (ids are size-sorted segment
 * positions, so "cluster 3" before and after are unrelated groups). There's no
 * stable identity to tween between, so instead the previous shapes are held and
 * faded out while the new ones fade in — the grouping dissolves rather than cuts.
 */
let outgoingHulls: Array<{ cluster: number; color: string; path: Array<{ x: number; y: number }> }> = [];
let hullFadeProgress = 1;
/** Releases the sustained alpha after a collapse/expand transition. */
let retargetTimer: number | null = null;
/** Fires the corrective fit once post-settle drift has stopped. */
let settleFitTimer: number | null = null;
/** Signature of the current grouping; a change starts a new cross-fade. */
let lastHullSignature = "";
/** Most recently built hull shapes, captured so a change can fade from them. */
let lastHullPaths: Array<{ cluster: number; color: string; path: Array<{ x: number; y: number }> }> = [];
const HOVER_LERP_SPEED = 0.06; // per-frame blend factor (~250ms to settle)

// Adjacency map: nodeId → Set of connected node ids (O(1) hover lookup)
let adjacency: Map<string, Set<string>> = new Map();

// Hover alpha stability tracking.
// When the hover fingerprint is unchanged and alphas have fully settled,
// skip the O(n) lerp loop on subsequent render calls (e.g. viewport pan/zoom).
let hoverAlphasSettled = false;
let lastHoverFingerprint = "";

// Identity ids for the selection sets in the hover fingerprint. Both sets are
// replaced wholesale on change, so instance identity is the reliable signal —
// their *size* is not: swapping one same-sized set for another would read as
// unchanged and leave the fade stale.
const objectIdentityIds = new WeakMap<object, number>();
let nextObjectIdentityId = 1;
function identityOf(value: object): number {
	let id = objectIdentityIds.get(value);
	if (id === undefined) {
		id = nextObjectIdentityId++;
		objectIdentityIds.set(value, id);
	}
	return id;
}

// Cluster legend hit areas for click detection (screen space)
let clusterAnchorHitAreas: ClusterPillHit[] = [];

/** The topic pill under a screen-space point, if any. */
function clusterPillAt(x: number, y: number): ClusterPillHit | undefined {
	return clusterAnchorHitAreas.find(
		(area) => x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h,
	);
}

function isOverClusterPill(x: number, y: number): boolean {
	return clusterPillAt(x, y) !== undefined;
}

// ── Cursor ──────────────────────────────────────────────────
//
// One function owns the canvas cursor, and it is a pure function of the
// present state — never of a transition. The previous code assigned the
// cursor inside the "did the hovered node change?" guard, so moving from a
// topic pill (which forces hoveredNode = null) onto empty canvas compared
// null to null, skipped the assignment, and left `pointer` stuck on the
// canvas. Deriving from current position instead makes that class of bug
// unrepresentable.
//
// Clickable things resolve to `var(--cursor)` rather than a literal
// `pointer` so the graph tracks Obsidian's "Use pointer cursor for clickable
// elements" setting, exactly like the native `.clickable-icon` buttons on the
// toolbar rail. Grab/grabbing stay literal: panning is direct manipulation of
// a surface, not a click target, so it is not what that setting governs.
// Guarded on `ready`, not just non-null: `pixi` is assigned before
// `renderer.init()` is awaited, and the `canvas` getter reads `this.app`, which
// only exists once that init has run. The lasso effect below fires on mount and
// can land inside exactly that window, where a non-null `pixi` would still
// throw. This is the hazard `PixiRenderer.ready` already exists to describe.
function applyCursor(overInteractive: boolean) {
	if (!pixi?.ready) return;
	pixi.canvas.style.cursor = overInteractive ? "var(--cursor)" : lassoMode ? "crosshair" : "grab";
}

// ── On-demand render scheduling ─────────────────────────────
//
// Every render trigger funnels through requestRender, which coalesces any
// number of same-frame requests (sim tick + camera animation + hover fade…)
// into one render pass per animation frame. The Pixi application ticker is
// disabled, so the GPU draws exactly once per pass and a settled, untouched
// graph costs nothing at idle.
//
// The mode bounds how much of the scene is rebuilt:
//   world   — content changed (positions, data, hover/fade state): rebuild
//             everything.
//   zoom    — only the camera scale changed: counter-scaled strokes and label
//             visibility need refreshing, but edge tessellation waits until
//             the scale drifts past EDGE_REDRAW_SCALE_STEP.
//   overlay — the camera panned: world-space layers move with the viewport
//             transform for free; only screen-space content (labels, pills,
//             tooltip) refreshes.
type RenderMode = "overlay" | "zoom" | "world";
const RENDER_MODE_RANK: Record<RenderMode, number> = { overlay: 0, zoom: 1, world: 2 };
let renderRafId: number | null = null;
let pendingRenderMode: RenderMode | null = null;

function requestRender(mode: RenderMode) {
	if (pendingRenderMode === null || RENDER_MODE_RANK[mode] > RENDER_MODE_RANK[pendingRenderMode]) {
		pendingRenderMode = mode;
	}
	if (renderRafId != null) return;
	renderRafId = window.requestAnimationFrame(() => {
		renderRafId = null;
		const nextMode = pendingRenderMode ?? "world";
		pendingRenderMode = null;
		render(nextMode);
	});
}

/**
 * Scale drift (as a fraction) a zoom must accumulate before edges are
 * re-tessellated. Edge widths counter-scale with the camera (`1.2 / scale`),
 * so skipping a rebuild leaves them up to this much too thick or thin —
 * invisible at 5%, while smooth-wheel zooming stops paying the full O(E)
 * tessellation on every frame.
 */
const EDGE_REDRAW_SCALE_STEP = 0.05;
/** Camera scale at which edges were last tessellated. */
let lastEdgeDrawScale = 1;

/**
 * Zoom band currently governing the label budget (index into
 * LABEL_BUDGET_ZOOM_STEPS). Held across frames so a camera hovering exactly on a
 * threshold doesn't oscillate between two budgets — the band only changes once
 * the scale has moved decisively past the boundary (see LABEL_BUDGET_HYSTERESIS).
 */
let labelBudgetStepIndex = -1;
/** Camera scale at the last viewport-move callback — distinguishes zoom from pan. */
let lastViewportScale = 1;

/**
 * Margin (fraction of the view size per side) kept tessellated around the view
 * when culling offscreen edges. Wide enough that ordinary panning stays inside
 * it; a pan past it forces a re-tessellation before the gap scrolls into view.
 */
const EDGE_CULL_MARGIN = 0.35;
/** Cull rect used at the last edge tessellation — null when nothing was culled. */
let lastEdgeCullRect: WorldRect | null = null;
/** Set when a pan left the culled margin; forces an edge redraw next render. */
let edgesViewportStale = false;

/** The camera's visible world rect, padded by `marginFactor` of its size per side. */
function viewWorldRect(renderer: PixiRenderer, marginFactor: number): WorldRect {
	const tl = renderer.screenToWorld(0, 0);
	const br = renderer.screenToWorld(renderer.width, renderer.height);
	const mx = (br.x - tl.x) * marginFactor;
	const my = (br.y - tl.y) * marginFactor;
	return { minX: tl.x - mx, minY: tl.y - my, maxX: br.x + mx, maxY: br.y + my };
}

/**
 * Graph keyboard shortcuts.
 *
 * Exported because the canvas is not the only place these have to work: clicking
 * a topic row in the settings panel makes a selection *and* moves focus to that
 * row, so a canvas-scoped listener left the selection-bar verbs (I/O/A/C)
 * unreachable — the shortcuts were dead exactly when there was something to use
 * them on, and clicking back onto the canvas to restore focus cleared the
 * selection. The view binds this at its own root so anything inside the graph
 * leaf keeps them live.
 */
export function handleKeyDown(e: KeyboardEvent) {
	const tag = (e.target as HTMLElement | null)?.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
	// A slider or other range control owns its arrow keys; stepping granularity
	// from under it would fight the control the user is actually operating.
	if ((e.target as HTMLElement | null)?.closest?.('input, [role="slider"], [contenteditable="true"]')) return;

	if (
		(e.key === "Meta" || e.key === "Control") &&
		hoveredNode &&
		onHoverPreview &&
		previewTriggeredForNode !== hoveredNode.id
	) {
		triggerNodePreview(e, hoveredNode);
		return;
	}

	const renderer = pixi;
	if (!renderer) return;

	// Bare keys only. ⌘O / ⌘A / ⌘C are real Obsidian and system shortcuts, and a
	// graph pane that swallowed them would break copy and "open file".
	if (e.metaKey || e.ctrlKey || e.altKey) return;

	switch (e.key) {
		case "Escape":
			if (isLassoing) {
				isLassoing = false;
				lassoPoints = [];
				pixi?.resumeViewport();
				requestRender("world");
			} else if (selectedNodes.size > 0) {
				clearSelection();
			} else if (immersed) {
				onExitImmerse?.();
			} else if (focusedClusters.size > 0) {
				onClearFocusedClusters?.();
			}
			break;
		case "f":
			if (selectedNodes.size > 0) {
				panToSelection();
			} else {
				fitToView();
			}
			break;
		case "s":
			onToggleCollapseAll?.();
			break;
		// Selection-bar verbs. All no-op without a selection, so they stay inert
		// while panning an unselected graph.
		case "c":
			onCollapseSelectedTopics?.();
			break;
		case "i":
			if (selectedNodes.size > 0) onImmerse?.();
			break;
		case "o":
			if (selectedNodes.size > 0) onOpenAllSelected?.();
			break;
		case "a":
			if (selectedNodes.size > 0) onSendToChat?.();
			break;
		case "=":
		case "+": {
			zoomByFactor(1.2);
			break;
		}
		case "-": {
			zoomByFactor(1 / 1.2);
			break;
		}
		// Arrows step topic granularity — finer up, coarser down — while +/- stay
		// on camera scale. Up meaning "finer" matches the slider, where dragging
		// right splits topics further.
		case "ArrowUp": {
			e.preventDefault();
			onGranularityStep?.(1);
			break;
		}
		case "ArrowDown": {
			e.preventDefault();
			onGranularityStep?.(-1);
			break;
		}
	}
}

// Persistent label occlusion grid — allocated once, zeroed at the start of each render.
// Avoids a ~10KB allocation + GC at 60fps. Resized only when canvas dimensions change.
/**
 * Occupied label-occlusion cells for the current frame, keyed by packed
 * world-anchored cell coordinates. A Set rather than the previous screen-sized
 * Uint8Array because world-anchored columns are unbounded (and negative);
 * cleared each frame rather than reallocated.
 */
const labelCellsOccupied = new Set<number>();

// Node ID → SimNode map for O(1) lookups (built once in setupSimulation)
let simNodeMap: Map<string, SimNode> = new Map();
let clusterRepresentativeIds: Set<string> = new Set();
let clusterRepresentativeNodes: Map<number, SimNode> = new Map();
let clusterNodeCounts: Map<number, number> = new Map();

/**
 * Re-derive the per-cluster metadata the topic pills read: which node speaks for
 * each topic, and how many notes it holds.
 *
 * Needed on both paths into a new grouping — a full rebuild and the
 * `isColorOnlyChange` fast path, which reassigns clusters without touching
 * topology. Requires `simNodeMap` to already match `data`.
 */
function refreshClusterMetadata(data: GraphData) {
	const representatives = deriveClusterRepresentativesFromGraph(data);
	clusterRepresentativeIds = new Set([...representatives.values()].map((node) => node.id));
	clusterRepresentativeNodes = new Map(
		[...representatives].flatMap(([cluster, node]) => {
			const simNode = simNodeMap.get(node.id);
			return simNode ? [[cluster, simNode] as const] : [];
		}),
	);
	clusterNodeCounts = new Map<number, number>();
	for (const node of data.nodes) {
		if (node.cluster == null) continue;
		clusterNodeCounts.set(node.cluster, (clusterNodeCounts.get(node.cluster) ?? 0) + 1);
	}
}

// Cached label sort order — rebuilt only when hover/selection/highlight state changes.
// Between frames where only positions move, the priority of each node is stable.
let cachedSortedLabelNodes: SimNode[] = [];
let cachedSortKey = "";
// Incremented every time simNodes is fully rebuilt (graph data change).
// Including this in the sort key ensures stale node references are never reused.
let simNodesVersion = 0;

// Persistent position memory — survives across buildInternalData calls.
// Nodes that leave the view (e.g. during immersion) retain their last-known
// positions here so they are restored instantly when they re-appear, avoiding
// a full force-simulation re-settle on immersion exit.
const persistentPositionCache = new Map<string, { x: number; y: number }>();

// Set by markIncrementalUpdate() and consumed by the next setupGraph: the
// incoming data is a live vault-change patch, so the layout settles gently in
// place and the camera stays put instead of re-framing the whole graph.
let incrementalUpdatePending = false;

/**
 * Arm the next graph-data change as a live incremental update (issue #404).
 *
 * Called by the view right before it patches `graphData` in response to vault
 * events. Without this, any node addition takes the mode-switch path — slow
 * drift plus a camera refit — which would yank the view around every time a
 * note is created while the graph is open.
 */
export function markIncrementalUpdate() {
	incrementalUpdatePending = true;
}

/**
 * Carry a node's layout position across a rename.
 *
 * Called before the renamed graph data lands: the new id inherits the old
 * node's position (live simulation position first, cached position as
 * fallback), so a renamed note stays where it was instead of re-scattering.
 */
export function transferNodePosition(oldId: string, newId: string) {
	if (oldId === newId) return;
	const sim = simNodeMap.get(oldId);
	const position =
		sim && sim.x != null && sim.y != null ? { x: sim.x, y: sim.y } : persistentPositionCache.get(oldId);
	if (position) persistentPositionCache.set(newId, { x: position.x, y: position.y });
	persistentPositionCache.delete(oldId);
}

// Cached cluster map for edge rendering (nodeId → cluster).
// Rebuilt only when simNodes changes — cluster assignments are stable between renders.
let cachedNodeClusterMap: Map<string, number | undefined> = new Map();
let cachedNodeClusterMapVersion = -1;

function getNodeClusterMap(): Map<string, number | undefined> {
	if (cachedNodeClusterMapVersion !== simNodesVersion) {
		cachedNodeClusterMap = new Map(simNodes.map((n) => [n.id, n.cluster]));
		cachedNodeClusterMapVersion = simNodesVersion;
	}
	return cachedNodeClusterMap;
}

/**
 * Clear the current lasso selection.
 */
export function clearSelection() {
	selectedNodes = new Set();
	onSelectionChange?.([]);
	requestRender("world");
}

/**
 * Get paths for all nodes belonging to any of the given clusters.
 */
export function getNodePathsForClusters(clusters: Set<number>): string[] {
	// A collapsed topic's own `path` is its synthetic id, so resolve through
	// `resolveNodePaths` to get the real member notes it stands for.
	return simNodes.filter((n) => n.cluster != null && clusters.has(n.cluster)).flatMap(resolveNodePaths);
}

/**
 * Select nodes by their paths (e.g. from cluster selection).
 */
export function selectNodesByPaths(paths: string[]) {
	const pathSet = new Set(paths);
	// Match collapsed topics too: a topic node is selected when any note it
	// stands for is in the set, so a selection survives folding and unfolding.
	selectedNodes = new Set(simNodes.filter((n) => resolveNodePaths(n).some((p) => pathSet.has(p))).map((n) => n.id));
	requestRender("world");
}

/**
 * Convert screen coordinates to graph (world) coordinates via the viewport.
 */
function screenToGraph(screenX: number, screenY: number): { x: number; y: number } {
	if (!pixi) return { x: screenX, y: screenY };
	return pixi.screenToWorld(screenX, screenY);
}

// ── Spatial hit grid ────────────────────────────────────────
// findNodeAt runs on every mousemove, and a linear scan over a large vault's
// nodes is measurable input-latency work. A uniform hash grid answers the same
// query from a few cells instead. Positions move every tick while the layout
// settles, so the grid is only (re)built once the simulation is near rest —
// while it's moving, the plain scan runs, since rebuilding per query would
// cost more than the scan it replaces.
let hitGrid: Map<number, Array<{ node: SimNode; order: number }>> | null = null;
let hitGridCellSize = 1;
let hitGridDirty = true;
let hitGridMaxRadius = 0;

/** Cell coordinates support ±32k cells from the origin. */
const HIT_GRID_KEY_OFFSET = 32768;
function hitGridKey(cx: number, cy: number): number {
	return (cx + HIT_GRID_KEY_OFFSET) * 65536 + (cy + HIT_GRID_KEY_OFFSET);
}

function buildHitGrid() {
	hitGridMaxRadius = 0;
	for (const node of simNodes) {
		const radius = getNodeRadius(node);
		if (radius > hitGridMaxRadius) hitGridMaxRadius = radius;
	}
	hitGridCellSize = Math.max(64, hitGridMaxRadius * 2);
	hitGrid = new Map();
	for (let i = 0; i < simNodes.length; i++) {
		const node = simNodes[i];
		if (node.x == null || node.y == null) continue;
		const key = hitGridKey(Math.floor(node.x / hitGridCellSize), Math.floor(node.y / hitGridCellSize));
		let cell = hitGrid.get(key);
		if (!cell) {
			cell = [];
			hitGrid.set(key, cell);
		}
		cell.push({ node, order: i });
	}
	hitGridDirty = false;
}

/** The original linear scan — still used while the layout is in motion. */
function findNodeLinear(x: number, y: number, hitRadius: number, displayFactor: number): GraphNode | null {
	// Search in reverse order (top-most nodes first)
	for (let i = simNodes.length - 1; i >= 0; i--) {
		const node = simNodes[i];
		const dx = (node.x ?? 0) - x;
		const dy = (node.y ?? 0) - y;
		const reach = getNodeRadius(node) * displayFactor + hitRadius;
		if (dx * dx + dy * dy <= reach * reach) {
			return node;
		}
	}
	return null;
}

/**
 * Find the node at the given screen coordinates.
 *
 * Picks the top-most match (highest index in `simNodes`), matching the
 * original reverse-scan semantics in both paths.
 */
/**
 * `extraSlack` widens the hit target in SCREEN pixels before the zoom division,
 * so it stays a constant on-screen distance at any camera scale. Touch passes
 * slack because a fingertip's contact patch is ~8-10mm against a mouse hotspot
 * of one pixel; without it, hitting a node on a phone is a game of luck.
 */
function findNodeAt(screenX: number, screenY: number, extraSlack = 0): GraphNode | null {
	const { x, y } = screenToGraph(screenX, screenY);
	const scale = pixi?.scale ?? 1;
	const hitRadius = (Math.max(1, nodeSize) + 4 + extraSlack) / scale;
	// Nodes are drawn counter-scaled against the zoom, so the hit target must
	// grow and shrink with them. Applied at query time only — the grid itself
	// stores camera-independent positions and stays valid across zooms.
	const displayFactor = zoomNodeScale(scale);

	// While ticking, positions change under the grid every frame — scan instead.
	if (hitGridDirty && simulation && simulation.alpha() > 0.03) {
		return findNodeLinear(x, y, hitRadius, displayFactor);
	}
	if (hitGridDirty || !hitGrid) buildHitGrid();

	// The zoomed-out hit slack can exceed one cell, so widen the neighbourhood
	// to however many cells the search radius spans.
	const searchRadius = hitGridMaxRadius * displayFactor + hitRadius;
	const span = Math.ceil(searchRadius / hitGridCellSize);
	const cx = Math.floor(x / hitGridCellSize);
	const cy = Math.floor(y / hitGridCellSize);

	let best: SimNode | null = null;
	let bestOrder = -1;
	for (let gx = cx - span; gx <= cx + span; gx++) {
		for (let gy = cy - span; gy <= cy + span; gy++) {
			const cell = hitGrid?.get(hitGridKey(gx, gy));
			if (!cell) continue;
			for (const { node, order } of cell) {
				if (order <= bestOrder) continue;
				const dx = (node.x ?? 0) - x;
				const dy = (node.y ?? 0) - y;
				const reach = getNodeRadius(node) * displayFactor + hitRadius;
				if (dx * dx + dy * dy <= reach * reach) {
					best = node;
					bestOrder = order;
				}
			}
		}
	}
	return best;
}

/**
 * Build one smoothed region per topic from the simulation's current positions.
 *
 * Recomputed every frame rather than cached because nodes move continuously
 * while the force layout settles — a stale hull would visibly lag its notes.
 * Cost is O(n log n) over ~hundreds of nodes, which is negligible next to the
 * per-frame edge and node work already happening.
 *
 * Outlier members are trimmed first: a single node flung far from its topic
 * would otherwise stretch the region across the whole canvas and swallow
 * unrelated topics.
 */
function computeTopicHulls(): Array<{ cluster: number; color: string; path: Array<{ x: number; y: number }> }> {
	if (simNodes.length === 0) return [];

	const byCluster = new Map<number, SimNode[]>();
	for (const node of simNodes) {
		if (node.cluster == null) continue;
		// A collapsed topic node already *is* its group — drawing a region around
		// a single node would just ring it in a redundant bubble.
		if (node.kind === "topic") continue;
		const list = byCluster.get(node.cluster);
		if (list) list.push(node);
		else byCluster.set(node.cluster, [node]);
	}

	// Start a cross-fade when *membership* changes, not when nodes merely move —
	// positions shift every frame while the simulation settles, and re-triggering
	// on those would restart the fade forever.
	const signature = [...byCluster.entries()]
		.map(([cluster, nodes]) => `${cluster}:${nodes.length}`)
		.sort()
		.join("|");
	if (signature !== lastHullSignature) {
		// Hold the shapes as they last looked, so they can fade from that state.
		if (lastHullSignature !== "" && lastHullPaths.length > 0) {
			outgoingHulls = lastHullPaths;
			hullFadeProgress = 0;
		}
		lastHullSignature = signature;
	}

	const padding = getNodeRadius({ degree: 0 } as GraphNode) + HULL_PADDING;
	const hulls: Array<{ cluster: number; color: string; path: Array<{ x: number; y: number }> }> = [];

	for (const [cluster, nodes] of byCluster) {
		const points = nodes
			.map((node) => ({ x: node.x ?? 0, y: node.y ?? 0 }))
			.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
		if (points.length === 0) continue;

		const path = buildTopicRegion(trimOutliers(points), padding);
		if (!path) continue;

		hulls.push({ cluster, color: nodes[0].color ?? "", path });
	}

	lastHullPaths = hulls;
	return hulls;
}

/**
 * Get the draw radius for a node from its degree and the auto-tuned nodeSize.
 *
 * Delegates to the shared {@link nodeDrawRadius} formula (also used by the
 * renderer's `syncNodes`) so hit-testing, collision spacing and label offsets
 * can never disagree with the drawn circle. Bridge nodes are surfaced by the
 * highlight toggle's color, not by size.
 */
function getNodeRadius(node: GraphNode): number {
	return nodeDrawRadius(node, nodeSize);
}

/**
 * Update the Pixi renderer with current state and draw one frame.
 *
 * See {@link requestRender} for how calls are scheduled and what each mode
 * skips. Everything after the world-space section runs in every mode: labels,
 * pills and the tooltip are placed in screen space, so a camera move changes
 * their layout even when no node moved.
 */
function render(mode: RenderMode) {
	if (!pixi || !pixi.ready) return;
	// Narrowed once here so the nested helpers below (which close over it) don't
	// each have to re-check a field the early return already guaranteed.
	const renderer = pixi;

	const width = renderer.width;
	const height = renderer.height;
	const scale = renderer.scale;
	const c = renderer.theme;
	const isWorld = mode === "world";

	// Advance edge fade-in (smooth crossfade on mode / data changes).
	// Fades advance only on world frames, and an unfinished fade requests the
	// next world frame below — so a concurrent zoom or pan can't stall it, and
	// it needs no frame source of its own once the simulation is at rest.
	if (isWorld && edgeFadeAlpha < 1) {
		edgeFadeAlpha = Math.min(1, edgeFadeAlpha + EDGE_FADE_RATE);
		if (edgeFadeAlpha < 1) requestRender("world");
	}

	// ── Smooth hover alpha interpolation ──────────────────────
	// Build a fingerprint of everything that determines alpha targets.
	// If it matches the previous frame and alphas have fully settled, skip the
	// O(n) lerp loop — nothing would change anyway (e.g. during viewport pan).
	const hoverFingerprint = `${hoveredNode?.id ?? ""}|${draggedNode?.id ?? ""}|${identityOf(selectedNodes)}|${identityOf(focusedClusters)}|${simNodesVersion}`;
	const skipHoverLoop = !isWorld || (hoverAlphasSettled && hoverFingerprint === lastHoverFingerprint);
	if (isWorld) lastHoverFingerprint = hoverFingerprint;

	let hoverSettled = hoverAlphasSettled;
	if (!skipHoverLoop) {
		hoverSettled = true;
		const hasSelection = selectedNodes.size > 0;
		for (const node of simNodes) {
			let target: number;
			if (node.highlighted || hoveredNode?.id === node.id || draggedNode?.id === node.id) {
				target = 1;
			} else if (hasSelection && !selectedNodes.has(node.id)) {
				target = 0.15;
			} else if (
				!hasSelection &&
				focusedClusters.size > 0 &&
				(node.cluster == null || !focusedClusters.has(node.cluster))
			) {
				target = 0.1;
			} else if (hoveredNode) {
				const isConnected = adjacency.get(hoveredNode.id)?.has(node.id) ?? false;
				target = isConnected ? 1 : 0.15;
			} else {
				target = 0.85;
			}

			const prev = hoverAlphas.get(node.id) ?? 0.85;
			const next = prev + (target - prev) * HOVER_LERP_SPEED;
			const final = Math.abs(next - target) < 0.01 ? target : next;
			hoverAlphas.set(node.id, final);
			if (final !== target) hoverSettled = false;
		}
	}
	hoverAlphasSettled = hoverSettled;

	// Ask for another world frame while alphas are still converging.
	if (isWorld && !hoverSettled) requestRender("world");

	// ── World-space layers ─────────────────────────────────────
	// Skipped entirely on pure pans: hulls, edges and nodes live inside the
	// viewport container, so the camera transform moves them for free.
	if (mode !== "overlay") {
		const nodeClusterMap = getNodeClusterMap();

		// ── Topic regions ──────────────────────────────────────
		if (showTopicHulls) {
			const hulls = computeTopicHulls();
			// Advance the cross-fade toward the new grouping. Eased so the dissolve
			// starts quickly and settles gently, matching the camera animations.
			// World frames only, and an unfinished fade requests the next one — the
			// force simulation can already be at rest when a grouping changes (e.g.
			// changing granularity on a settled layout), so the fade sustains itself.
			if (isWorld && hullFadeProgress < 1) {
				hullFadeProgress = Math.min(1, hullFadeProgress + HULL_FADE_RATE);
				if (hullFadeProgress >= 1) outgoingHulls = [];
				else requestRender("world");
			}
			// The incoming grouping fades with the cross-fade itself, not with the
			// edge fade: tying it to `edgeFadeAlpha` blanked every region on any
			// data change, so folding one topic made all of them blink. During a
			// cross-fade the unchanged topics resolve between two near-identical
			// shapes at complementary alphas, which reads as holding steady.
			renderer.drawHulls(hulls, {
				focusedClusters,
				fadeAlpha: outgoingHulls.length > 0 ? easeOutCubic(hullFadeProgress) : 1,
				outgoing: outgoingHulls,
				outgoingAlpha: outgoingHulls.length > 0 ? 1 - easeOutCubic(hullFadeProgress) : 0,
			});
		} else {
			// Regions are hidden — drop any in-flight fade so re-enabling them starts
			// clean rather than dissolving from a grouping that's since gone stale.
			outgoingHulls = [];
			lastHullPaths = [];
			lastHullSignature = "";
			hullFadeProgress = 1;
			renderer.drawHulls([], { focusedClusters, fadeAlpha: 1 });
		}

		// ── Edges ──────────────────────────────────────────────
		// Re-tessellating every edge is the priciest CPU step of a frame, so
		// zoom-only frames skip it until the scale has drifted enough for the
		// counter-scaled widths to be visibly off (see EDGE_REDRAW_SCALE_STEP),
		// and edges outside the margined view are culled entirely.
		const scaleDrift = Math.abs(scale - lastEdgeDrawScale) / (lastEdgeDrawScale || 1);
		if (isWorld || scaleDrift > EDGE_REDRAW_SCALE_STEP || edgesViewportStale) {
			const cullRect = viewWorldRect(renderer, EDGE_CULL_MARGIN);
			renderer.drawEdges(
				renderableSimLinks as unknown as Array<{
					source: { id: string; x: number; y: number; kind?: string };
					target: { id: string; x: number; y: number; kind?: string };
					type: string;
					weight?: number;
				}>,
				{
					showWikiLinks,
					showSemanticLinks,
					highlightSemanticLinks,
					directedWikiEdges,
					hoveredNodeId: hoveredNode?.id ?? null,
					adjacency,
					focusedClusters,
					selectedNodes,
					hoverAlphas,
					edgeFadeAlpha,
					baseEdgeAlpha,
					nodeClusterMap,
					cullRect,
				},
			);
			lastEdgeDrawScale = scale;
			edgesViewportStale = false;
			// Pan-staleness tracking only matters if the rect actually excluded
			// part of the graph — when everything fit inside it, no pan can
			// reveal a missing edge, so the moved handler can skip the check.
			const bounds = computeNodeBounds(simNodes);
			lastEdgeCullRect = bounds && rectContains(cullRect, bounds) ? null : cullRect;
		}

		// ── Nodes ──────────────────────────────────────────────
		// Advance spawn-grow animations: each newborn node's radius eases from a
		// fraction to full size, finished entries drop out, and an unfinished
		// animation requests the next world frame so it completes even once the
		// simulation is at rest.
		let spawnScales: Map<string, number> | null = null;
		if (nodeSpawnTimes.size > 0) {
			const now = performance.now();
			spawnScales = new Map();
			for (const [id, born] of nodeSpawnTimes) {
				const t = (now - born) / NODE_SPAWN_MS;
				if (t >= 1) {
					nodeSpawnTimes.delete(id);
					continue;
				}
				spawnScales.set(id, NODE_SPAWN_START_SCALE + (1 - NODE_SPAWN_START_SCALE) * easeOutCubic(t));
			}
			if (isWorld && nodeSpawnTimes.size > 0) requestRender("world");
		}
		renderer.syncNodes(simNodes, nodeSize, {
			selectedNodes,
			hoveredNodeId: hoveredNode?.id ?? null,
			draggedNodeId: draggedNode?.id ?? null,
			focusedClusters,
			isForceMode: true,
			hoverAlphas,
			nodeClusterMap,
			spawnScales,
		});
	}

	// ── Labels ─────────────────────────────────────────────────
	// Labels appear automatically when a node's screen-space radius reaches a
	// readable threshold — no manual zoom setting needed. The occlusion grid
	// handles crowding; this threshold handles legibility.
	const MIN_LABEL_SCREEN_RADIUS = 5; // px — node must be at least this big on screen

	/**
	 * Simulation alpha at and below which ordinary labels are fully visible.
	 *
	 * Deliberately below the 0.05 the camera's final fit uses: the camera only has
	 * to stop chasing the layout, whereas a label has to be *readable*, and text
	 * still creeping is more distracting than text that arrives late. The layout
	 * keeps drifting visibly for a while after alpha 0.05.
	 */
	const LABEL_SETTLE_ALPHA = 0.02;
	/** Alpha at which ordinary labels are fully hidden; between the two they fade. */
	const LABEL_SETTLE_ALPHA_MAX = 0.05;
	/**
	 * Ordinary labels fade out while the layout is still moving.
	 *
	 * Anchoring the occlusion lattice to the world stopped labels re-rolling under
	 * a *camera* move, but during a live simulation the nodes genuinely move
	 * relative to each other, so cell ownership legitimately changes frame to
	 * frame and the flicker is real rather than an artefact. There's nothing to
	 * read mid-settle anyway — the captions are still sliding around — so they
	 * fade in once the graph stops.
	 *
	 * A fade rather than a hard cutoff: switching at a threshold would make every
	 * label pop in at once the instant alpha crossed it.
	 *
	 * Hovered, highlighted and cluster-representative labels are exempt — those
	 * answer a direct question ("what is this?") and must respond immediately,
	 * settled or not.
	 */
	const simAlpha = simulation?.alpha() ?? 0;
	const settleLabelAlpha =
		simAlpha <= LABEL_SETTLE_ALPHA
			? 1
			: simAlpha >= LABEL_SETTLE_ALPHA_MAX
				? 0
				: 1 - (simAlpha - LABEL_SETTLE_ALPHA) / (LABEL_SETTLE_ALPHA_MAX - LABEL_SETTLE_ALPHA);

	/**
	 * How many *ordinary* nodes may be captioned at once.
	 *
	 * The radius gate alone barely discriminates: `nodeDrawRadius` is
	 * `log1p(degree)`-shaped, so a degree-3 note and a degree-30 hub differ by
	 * only a couple of screen pixels and nearly every node clears the threshold
	 * together. Hundreds then contend for the same occlusion cells, and because
	 * winning a cell is binary, two similar nodes drifting a pixel apart trade the
	 * label back and forth every frame — that's the flicker, not the volume alone.
	 *
	 * Ranking by size and captioning only the top slice fixes both: the hubs
	 * worth reading keep their labels (and keep them *stably*, since the ranking
	 * only changes when the graph does), while the long tail stays quiet until you
	 * hover it or zoom in far enough that few nodes are on screen at all.
	 *
	 * Priority tiers above ordinary — hovered, its neighbours, highlighted, and
	 * cluster representatives — are exempt and never counted against this budget.
	 *
	 * The budget is the overview value; it grows with zoom (see below), where
	 * crowding is the thing that stops being true.
	 */
	const ORDINARY_LABEL_BUDGET_BASE = 12;
	/**
	 * Graphs at or below this many nodes skip the budget entirely.
	 *
	 * The budget exists to resolve contention, and a small graph has none — the
	 * occlusion grid alone keeps it readable. Capping here would only hide labels
	 * that fit perfectly well.
	 */
	const LABEL_BUDGET_MIN_NODES = 60;
	/**
	 * Zoom multipliers on the budget, applied in discrete steps.
	 *
	 * A budget computed continuously from `scale` slides by one label at a time as
	 * the camera moves, and since each increment flips exactly one caption on or
	 * off, panning and zooming made labels blink. Stepping instead means the
	 * budget holds constant across a whole zoom band and changes at a handful of
	 * thresholds — a single deliberate change rather than a continuous shimmer.
	 *
	 * Zooming in still earns more labels: fewer nodes remain on screen, so the
	 * occlusion grid has room the cap shouldn't be withholding.
	 */
	const LABEL_BUDGET_ZOOM_STEPS: Array<{ minScale: number; multiplier: number }> = [
		{ minScale: 4, multiplier: 5 },
		{ minScale: 2, multiplier: 2.5 },
		{ minScale: 1, multiplier: 1 },
	];
	/**
	 * Fraction the scale must overshoot a boundary before the band changes.
	 * Without it, a camera resting on a threshold flips between two budgets on
	 * sub-pixel jitter — trading the flicker for a rarer but identical one.
	 */
	const LABEL_BUDGET_HYSTERESIS = 0.12;
	const nextStepIndex = LABEL_BUDGET_ZOOM_STEPS.findIndex((step) => {
		// Leaving the current band costs extra; entering a new one is unchanged, so
		// the boundary is sticky in whichever direction we're already committed to.
		const isCurrent = LABEL_BUDGET_ZOOM_STEPS.indexOf(step) === labelBudgetStepIndex;
		const threshold = isCurrent ? step.minScale * (1 - LABEL_BUDGET_HYSTERESIS) : step.minScale;
		return scale >= threshold;
	});
	if (nextStepIndex !== -1) labelBudgetStepIndex = nextStepIndex;
	const zoomMultiplier = LABEL_BUDGET_ZOOM_STEPS[labelBudgetStepIndex]?.multiplier ?? 1;
	const ORDINARY_LABEL_BUDGET =
		simNodes.length <= LABEL_BUDGET_MIN_NODES
			? Number.POSITIVE_INFINITY
			: Math.round(ORDINARY_LABEL_BUDGET_BASE * zoomMultiplier);
	const showClusterAnchors = showClusterLabels && clusterRepresentativeNodes.size > 0;
	const hovId = hoveredNode?.id ?? null;
	const hoverNeighbors = hovId ? adjacency.get(hovId) : undefined;

	// Nodes are drawn counter-scaled against the zoom; labels must anchor above
	// the circle as drawn, size themselves against it, and judge visibility by
	// the size the user actually sees.
	const labelZoomFactor = zoomNodeScale(scale);

	// Label font size in CSS pixels (screen space).
	// The renderer counter-scales each label with t.scale.set(1/viewport_scale), which
	// makes the effective screen size equal to t.style.fontSize exactly — so these
	// values are on-screen pixel heights at every zoom level, no division by scale.
	//
	// Sized per node against the circle as drawn (which carries the degree curve
	// and the zoom counter-scale on top of `nodeSize`), because a single shared
	// size fails in both directions: derived from the base it left big collapsed
	// topics captioned in tiny text, and derived from the largest node it made
	// every label big whenever a few large nodes were on screen.
	//
	// The response is deliberately compressed — a node 4× the radius gets a 2×
	// label, not 4× — so size differences stay legible as a hierarchy without
	// the largest captions dominating the canvas.
	const LABEL_FONT_MIN_PX = 10;
	const LABEL_FONT_MAX_PX = 22;
	/** Node screen radius that maps to the baseline font size. */
	const LABEL_REFERENCE_RADIUS = 6;
	const baselineFontPx = Math.max(nodeSize * 2.5, LABEL_FONT_MIN_PX);
	function labelFontFor(node: SimNode): number {
		const screenRadius = getNodeRadius(node) * labelZoomFactor * scale;
		const ratio = Math.sqrt(Math.max(screenRadius, 1) / LABEL_REFERENCE_RADIUS);
		return Math.round(Math.min(LABEL_FONT_MAX_PX, Math.max(LABEL_FONT_MIN_PX, baselineFontPx * ratio)));
	}

	// The occlusion grid is a fixed lattice, so it takes one representative
	// size — the baseline. Per-label widths are still measured exactly in
	// `canDrawLabel`; this only sets the row height.
	const LABEL_FONT_PX = Math.round(Math.max(baselineFontPx, LABEL_FONT_MIN_PX));

	// Label occlusion culling — grid-based O(n) instead of O(n²) linear scan.
	// Cells are LABEL_CELL_W×LABEL_CELL_H screen pixels, but anchored to the
	// *world* origin rather than the screen corner: a pan moves every label and
	// the lattice together, so nobody changes cells and contention outcomes hold
	// still. When the lattice was screen-anchored, panning slid all labels across
	// fixed cell boundaries, and two labels that never visually overlapped could
	// share a cell at one camera offset and not the next — re-rolling who wins on
	// every pan frame, which read as labels flashing while the camera moved.
	// A label is allowed only if none of the cells it spans are already occupied.
	const LABEL_CELL_W = 60; // px — approx half an average label width
	const LABEL_CELL_H = LABEL_FONT_PX + 6; // px — label height + padding
	const LABEL_PAD_X = 2;
	const LABEL_PAD_Y = 1;
	labelCellsOccupied.clear();
	// Where the world origin currently lands on screen; subtracting it from a
	// screen coordinate yields a pan-invariant coordinate (world × zoom).
	const labelGridOrigin = renderer.worldToScreen(0, 0);

	function canDrawLabel(nodeX: number, labelY: number, approxCharCount: number, fontPx = LABEL_FONT_PX): boolean {
		// Font sizes are already in screen px, so sw/sh are screen px directly
		const sw = approxCharCount * fontPx * 0.55;
		const sh = fontPx;
		const screen = renderer.worldToScreen(nodeX, labelY);
		const x1 = screen.x - sw / 2 - LABEL_PAD_X;
		const y1 = screen.y - sh - LABEL_PAD_Y;
		const x2 = screen.x + sw / 2 + LABEL_PAD_X;
		const y2 = screen.y + LABEL_PAD_Y;

		// Reject anything off-screen outright (screen space — this part *should*
		// track the camera). Off-screen labels would otherwise occupy cells — and,
		// now that ordinary labels are budgeted, spend a slot — while painting
		// nothing the user can see. That also makes zooming in behave: as fewer
		// nodes remain on screen, the budget is spent on them rather than on hubs
		// somewhere off-canvas.
		if (x2 < 0 || y2 < 0 || x1 > width || y1 > height) return false;

		// Convert to world-anchored cell range (unbounded ints, negative is fine).
		const col0 = Math.floor((x1 - labelGridOrigin.x) / LABEL_CELL_W);
		const col1 = Math.floor((x2 - labelGridOrigin.x) / LABEL_CELL_W);
		const row0 = Math.floor((y1 - labelGridOrigin.y) / LABEL_CELL_H);
		const row1 = Math.floor((y2 - labelGridOrigin.y) / LABEL_CELL_H);

		// Pack col/row into one integer key. 16 bits each — collisions need cells
		// 65 536 apart (≈4M px), far beyond any real layout.
		const cellKey = (c: number, r: number) => ((c & 0xffff) << 16) | (r & 0xffff);

		// Check — any occupied cell means overlap
		for (let r = row0; r <= row1; r++) {
			for (let c = col0; c <= col1; c++) {
				if (labelCellsOccupied.has(cellKey(c, r))) return false;
			}
		}
		// Mark cells as occupied
		for (let r = row0; r <= row1; r++) {
			for (let c = col0; c <= col1; c++) {
				labelCellsOccupied.add(cellKey(c, r));
			}
		}
		return true;
	}

	// Sort nodes by label priority — cached between frames where priority hasn't changed.
	// Priority depends on: hovered node, hover neighbors, highlighted nodes, cluster reps, degree.
	// Positions change every force-tick but priority doesn't — skip the O(n log n) sort those frames.
	let highlightedCount = 0;
	for (const n of simNodes) if (n.highlighted) highlightedCount++;
	const sortKey = `${hovId ?? ""}|${simNodesVersion}|${clusterRepresentativeIds.size}|${highlightedCount}`;
	if (sortKey !== cachedSortKey) {
		cachedSortKey = sortKey;
		cachedSortedLabelNodes = simNodes.filter((n) => n.x != null && n.y != null);
		cachedSortedLabelNodes.sort((a, b) => {
			const pa =
				a.id === hovId
					? 0
					: hoverNeighbors?.has(a.id)
						? 1
						: a.highlighted
							? 2
							: clusterRepresentativeIds.has(a.id)
								? 3
								: 4;
			const pb =
				b.id === hovId
					? 0
					: hoverNeighbors?.has(b.id)
						? 1
						: b.highlighted
							? 2
							: clusterRepresentativeIds.has(b.id)
								? 3
								: 4;
			if (pa !== pb) return pa - pb;
			// Tie-break by the shared draw radius, so label priority always follows
			// what size *means* for each kind — degree for notes, member count for
			// topics — and the biggest circles claim label space first.
			return getNodeRadius(b) - getNodeRadius(a);
		});
	}
	const sortedLabelNodes = cachedSortedLabelNodes;

	// Ordinary (untiered) labels placed so far this frame, against
	// ORDINARY_LABEL_BUDGET. Nodes arrive size-sorted, so the budget is spent on
	// the biggest (for notes: most connected) nodes first.
	let ordinaryLabelsDrawn = 0;

	const labelEntries: Array<{
		nodeX: number;
		nodeY: number;
		text: string;
		color: string;
		alpha: number;
		fontSize: number;
	}> = [];

	for (const node of sortedLabelNodes) {
		const radius = getNodeRadius(node) * labelZoomFactor;
		const labelY = node.y - radius - 2 / scale;
		const nodeAlpha = hoverAlphas.get(node.id) ?? 0.85;
		// Screen-space radius: how large the node circle appears on screen
		const screenRadius = radius * scale;
		// Each label is sized to its own node, so occlusion must measure with it.
		const fontSize = labelFontFor(node);

		if (hovId && node.id === hovId) {
			// Hovered node: always show label, skip occlusion check (it wins)
			canDrawLabel(node.x, labelY, node.label.length, fontSize);
			labelEntries.push({
				nodeX: node.x,
				nodeY: labelY,
				text: node.label,
				color: c.textNormal,
				alpha: 1,
				fontSize,
			});
		} else if (hovId && hoverNeighbors?.has(node.id)) {
			if (!canDrawLabel(node.x, labelY, node.label.length, fontSize)) continue;
			labelEntries.push({
				nodeX: node.x,
				nodeY: labelY,
				text: node.label,
				color: c.textMuted,
				alpha: nodeAlpha,
				fontSize,
			});
		} else if (node.highlighted && !hovId) {
			if (!canDrawLabel(node.x, labelY, node.label.length, fontSize)) continue;
			labelEntries.push({
				nodeX: node.x,
				nodeY: labelY,
				text: node.label,
				color: c.textAccent,
				alpha: 1,
				fontSize,
			});
		} else if (
			settleLabelAlpha > 0 &&
			screenRadius >= MIN_LABEL_SCREEN_RADIUS &&
			ordinaryLabelsDrawn < ORDINARY_LABEL_BUDGET
		) {
			// Node is large enough on screen to anchor a label — show it if space allows
			if (!canDrawLabel(node.x, labelY, node.label.length, fontSize)) continue;
			// Counted only once the label is actually placed, so labels lost to
			// occlusion don't silently consume the budget and leave it under-filled.
			ordinaryLabelsDrawn++;
			// Smooth fade-in over a 2px radius window so labels don't pop in abruptly
			const fadeAlpha = Math.min(1, (screenRadius - MIN_LABEL_SCREEN_RADIUS) / 2);
			labelEntries.push({
				nodeX: node.x,
				nodeY: labelY,
				text: node.label,
				color: node.highlighted ? c.textAccent : c.textNormal,
				alpha: nodeAlpha * fadeAlpha * settleLabelAlpha,
				fontSize,
			});
		}
	}

	renderer.drawLabels(labelEntries);

	// ── Lasso ──────────────────────────────────────────────────
	if (isLassoing && lassoPoints.length >= 2) {
		renderer.drawLasso(lassoPoints);
	} else {
		renderer.clearLasso();
	}

	// ── Cluster anchor pills (screen space) ────────────────────
	if (showClusterAnchors) {
		const ANCHOR_PILL_H = 20;
		const ANCHOR_GAP = 4;
		/**
		 * Vertical offsets tried before a pill is dropped, in preference order:
		 * its natural spot, then progressively further above and below. Enough to
		 * rescue a label in mild crowding without letting it drift so far from its
		 * topic that the leader line stops being legible.
		 */
		const ANCHOR_NUDGE_OFFSETS = [0, -26, 26, -52, 52];
		/** How far outside the viewport a topic anchor may sit and still be labelled. */
		const ANCHOR_OFFSCREEN_MARGIN = 40;

		const anchorPlacements: Array<{
			cluster: number;
			nodeScreenX: number;
			nodeScreenY: number;
			text: string;
			pillW: number;
			pillH: number;
			x: number;
			y: number;
			isFocused: boolean;
			color: string;
			/** Topic size — biggest topics claim label space first. */
			nodeCount: number;
		}> = [];

		for (const [cluster, node] of clusterRepresentativeNodes) {
			if (node.x == null || node.y == null) continue;
			// Unfocused topics keep their label (drawn dimmed via `isFocused`) rather
			// than being dropped: hiding them would leave nothing to Shift-click, so
			// building a multi-topic selection from the graph would be impossible.
			// A collapsed topic node already renders its own name, and its "cluster"
			// is just itself — a pill here would read "Topic · 1" beside the group
			// it stands for.
			if (node.kind === "topic") continue;

			const screen = renderer.worldToScreen(node.x, node.y);
			// Skip topics whose anchor is off-screen. Clamping them to the canvas
			// edge (as this used to) stacks every out-of-view topic into the margin,
			// far from the notes it describes — a label pointing nowhere is worse
			// than no label.
			if (
				screen.x < -ANCHOR_OFFSCREEN_MARGIN ||
				screen.x > width + ANCHOR_OFFSCREEN_MARGIN ||
				screen.y < -ANCHOR_OFFSCREEN_MARGIN ||
				screen.y > height + ANCHOR_OFFSCREEN_MARGIN
			) {
				continue;
			}

			const anchorLabel = clusterLabels[cluster] ?? node.label;
			const nodeCount = clusterNodeCounts.get(cluster) ?? 0;
			const anchorText = `${anchorLabel} · ${nodeCount}`;
			// Approximate pill width: ~7px per char + padding
			const pillWidth = Math.min(200, Math.max(80, anchorText.length * 7 + 16));
			const pillX = Math.max(8, Math.min(width - pillWidth - 8, screen.x + 8));
			const pillY = Math.max(8, Math.min(height - ANCHOR_PILL_H - 8, screen.y - ANCHOR_PILL_H - 6));

			anchorPlacements.push({
				cluster,
				nodeScreenX: screen.x,
				nodeScreenY: screen.y,
				text: anchorText,
				pillW: pillWidth,
				pillH: ANCHOR_PILL_H,
				x: pillX,
				y: pillY,
				// With nothing selected every topic reads as focused — matching the
				// hull path — so pills only dim once a selection actually exists.
				isFocused: focusedClusters.size === 0 || focusedClusters.has(cluster),
				color: node.color ?? c.graphNode,
				// Drives placement priority: the biggest topics claim space first.
				nodeCount,
			});
		}

		// Overlap resolution: nudge, then DROP whatever still collides.
		//
		// Nudging alone is only viable while there's somewhere to nudge to. Past a
		// few dozen topics the canvas simply cannot hold every pill, and pushing
		// them around produces an unreadable pile — so labels are placed biggest
		// topic first and any that still collide are left out. A dropped topic
		// keeps its coloured region and its row in the panel; only the pill goes.
		//
		// Focused topics claim space ahead of size: once a selection exists, the
		// label the user just picked must not be crowded out by a larger topic
		// they didn't.
		anchorPlacements.sort(
			(a, b) => Number(b.isFocused) - Number(a.isFocused) || (b.nodeCount ?? 0) - (a.nodeCount ?? 0) || a.y - b.y,
		);

		const placed: typeof anchorPlacements = [];
		const collides = (a: (typeof anchorPlacements)[number], b: (typeof anchorPlacements)[number]) =>
			a.x < b.x + b.pillW + ANCHOR_GAP &&
			a.x + a.pillW + ANCHOR_GAP > b.x &&
			a.y < b.y + b.pillH + ANCHOR_GAP &&
			a.y + a.pillH + ANCHOR_GAP > b.y;

		for (const candidate of anchorPlacements) {
			// Try the preferred spot, then a few offsets above/below the anchor
			// before giving up — a small nudge saves most labels in mild crowding.
			let positioned = false;
			for (const dy of ANCHOR_NUDGE_OFFSETS) {
				const y = Math.max(8, Math.min(height - candidate.pillH - 8, candidate.y + dy));
				const trial = { ...candidate, y };
				if (!placed.some((other) => collides(trial, other))) {
					candidate.y = y;
					positioned = true;
					break;
				}
			}
			if (positioned) placed.push(candidate);
		}

		clusterAnchorHitAreas = renderer.drawClusterPills(placed);
	} else {
		clusterAnchorHitAreas = renderer.drawClusterPills([]);
	}

	// ── Node tooltip ───────────────────────────────────────────
	if (hoveredNode && hoveredNode.x != null && hoveredNode.y != null) {
		renderer.showNodeTooltip(hoveredNode, clusterLabels, false, true);
	} else {
		renderer.hideTooltip();
	}

	// One GPU draw per pass — the application ticker is disabled.
	renderer.renderFrame();
}

// ============================================================================
// Event handlers
// ============================================================================

function handleMouseDown(e: PointerEvent) {
	e.preventDefault();
	// Don't steal focus when a modal (e.g. search modal) is open — that would
	// trap keyboard events in the graph container and make the modal unresponsive.
	if (!document.querySelector(".modal-container")) {
		containerEl.focus();
	}
	if (!pixi) return;

	// Any pointer-down is user intent — abort auto-fit and stop periodic refits
	pixi.abortAnimation();
	needsInitialFit = false;
	const canvas = pixi.canvas;
	const rect = canvas.getBoundingClientRect();
	const x = e.clientX - rect.left;
	const y = e.clientY - rect.top;
	pointerDownScreenPos = { x, y };
	pointerDownType = e.pointerType;

	// Topic pills are screen-space overlays drawn on top of everything, so they
	// claim the pointer before the lasso does. Without this, Shift+pointerdown on
	// a pill starts a lasso, which sets `lassoJustFinished` and makes handleClick
	// bail before it ever reaches the pill hit-test — the label would look clickable
	// with Shift but do nothing.
	if (isOverClusterPill(x, y)) return;

	// Shift+click on a node toggles its selection; Shift+drag on empty space starts lasso
	if (lassoMode || e.shiftKey) {
		const node = findNodeAt(x, y);
		if (node && e.shiftKey && !lassoMode) {
			const next = new Set(selectedNodes);
			if (next.has(node.id)) {
				next.delete(node.id);
			} else {
				next.add(node.id);
			}
			selectedNodes = next;
			onSelectionChange?.(simNodes.filter((n) => next.has(n.id)).flatMap(resolveNodePaths));
			lassoJustFinished = true;
			requestRender("world");
			return;
		}
		isLassoing = true;
		// Pause pixi-viewport drag during lasso
		pixi.pauseViewport();
		const graphPos = screenToGraph(x, y);
		lassoPoints = [graphPos];
		canvas.setPointerCapture(e.pointerId);
		return;
	}

	const node = findNodeAt(x, y, hitSlack(e.pointerType));

	if (node) {
		const sn = simNodeMap.get(node.id);
		if (!sn) return;
		// Touch: show the node's label/neighbor highlight on tap (no hover), and
		// arm a long-press that opens the context menu (no right-click).
		if (e.pointerType === "touch" || e.pointerType === "pen") {
			if (hoveredNode !== node) {
				hoveredNode = node;
				requestRender("world");
			}
			longPressFired = false;
			cancelLongPress();
			longPressTimer = window.setTimeout(() => {
				longPressTimer = null;
				longPressFired = true;
				openNodeMenu(node, e.clientX, e.clientY);
			}, LONG_PRESS_MS);
		}
		draggedNode = node;
		dragSimNode = sn;
		hasDragged = false;
		// Pause pixi-viewport drag during node drag
		pixi.pauseViewport();
		simulation?.alphaTarget(0.3).restart();
		sn.fx = sn.x;
		sn.fy = sn.y;
		canvas.setPointerCapture(e.pointerId);
		pendingUserViewportMove = false;
	}
	// Pan is handled by pixi-viewport automatically
	else {
		pendingUserViewportMove = true;
	}
}

function handleMouseMove(e: PointerEvent) {
	if (!pixi) return;
	const canvas = pixi.canvas;
	const rect = canvas.getBoundingClientRect();
	const x = e.clientX - rect.left;
	const y = e.clientY - rect.top;

	// Movement past a small tolerance means pan/drag, not a long-press.
	if (longPressTimer !== null && pointerDownScreenPos) {
		const moved = Math.hypot(x - pointerDownScreenPos.x, y - pointerDownScreenPos.y);
		if (moved > LONG_PRESS_MOVE_TOLERANCE) cancelLongPress();
	}

	if (isLassoing) {
		const graphPos = screenToGraph(x, y);
		// Throttle: only add point if moved at least 3px in screen space from last point
		const last = lassoPoints[lassoPoints.length - 1];
		if (last) {
			const lastScreen = pixi.worldToScreen(last.x, last.y);
			const dist = Math.sqrt((x - lastScreen.x) ** 2 + (y - lastScreen.y) ** 2);
			if (dist < 3) return;
		}
		lassoPoints = [...lassoPoints, graphPos];
		requestRender("world");
		return;
	}

	if (dragSimNode) {
		// Drag node.
		//
		// `hasDragged` makes handleClick discard the click that follows, so it must
		// mean "the user actually moved this node", not "a pointermove arrived". A
		// fingertip jitters by a few pixels during any deliberate tap, which set the
		// flag on every touch and swallowed the selection click even once the click
		// distance check allowed it. Gate on the same per-device tolerance so a tap
		// still selects while a real drag still suppresses.
		if (pointerDownScreenPos) {
			const movedX = x - pointerDownScreenPos.x;
			const movedY = y - pointerDownScreenPos.y;
			const tolerance = clickMoveTolerance(pointerDownType);
			if (movedX * movedX + movedY * movedY > tolerance * tolerance) hasDragged = true;
		} else {
			hasDragged = true;
		}
		// Dragging with a mouse drops the hover highlight — the label would trail
		// the cursor and the cursor is already the pointer. Touch is the opposite
		// case: the finger covers the node, so the label and its lit connections
		// are the only feedback about what is being moved. Keep them on the dragged
		// node, which the renderer already positions from the node's live
		// coordinates, so they follow it for free.
		if (pointerDownType === "touch" || pointerDownType === "pen") {
			hoveredNode = draggedNode;
		} else {
			hoveredNode = null;
		}
		const graphPos = screenToGraph(x, y);
		dragSimNode.fx = graphPos.x;
		dragSimNode.fy = graphPos.y;
		requestRender("world");
	} else {
		// Hover detection: check cluster legend first, then nodes
		if (isOverClusterPill(x, y)) {
			applyCursor(true);
			if (hoveredNode) {
				hoveredNode = null;
				requestRender("world");
			}
			return;
		}

		const node = findNodeAt(x, y);
		// Outside the guard below: the cursor follows the pointer's current
		// position, while the guard gates only the expensive re-render.
		applyCursor(node !== null);
		if (node !== hoveredNode) {
			hoveredNode = node;
			previewTriggeredForNode = null;
			requestRender("world");
		}
		// Cmd/Ctrl+hover triggers note preview (fire once per node)
		if (node && (e.metaKey || e.ctrlKey) && onHoverPreview && previewTriggeredForNode !== node.id) {
			triggerNodePreview(e, node);
		}
	}
}

function handleMouseUp(_e: PointerEvent) {
	cancelLongPress();
	if (isLassoing) {
		isLassoing = false;
		lassoJustFinished = true;
		pixi?.resumeViewport();
		if (lassoPoints.length >= 3) {
			const merged = new Set(selectedNodes);
			for (const node of simNodes) {
				if (node.x == null || node.y == null) continue;
				if (pointInPolygon(node.x, node.y, lassoPoints)) {
					merged.add(node.id);
				}
			}
			if (merged.size !== selectedNodes.size) {
				selectedNodes = merged;
				onSelectionChange?.(simNodes.filter((n) => merged.has(n.id)).flatMap(resolveNodePaths));
			}
		}
		lassoPoints = [];
		requestRender("world");
		return;
	}
	if (dragSimNode) {
		simulation?.alphaTarget(0);
		dragSimNode.fx = null;
		dragSimNode.fy = null;
		// A touch drag kept the highlight on the node being moved; latch it so the
		// synthetic mouseleave that ends the touch doesn't wipe it on release.
		if ((pointerDownType === "touch" || pointerDownType === "pen") && hasDragged) {
			touchLatchedNode = draggedNode;
		}
		draggedNode = null;
		dragSimNode = null;
		pixi?.resumeViewport();
	}
}

function handleClick(e: MouseEvent) {
	// A long-press already opened the context menu — don't also open the file.
	if (longPressFired) {
		longPressFired = false;
		return;
	}
	if (hasDragged) {
		hasDragged = false;
		return;
	}
	if (lassoJustFinished) {
		lassoJustFinished = false;
		return;
	}
	if (!pixi) return;

	const rect = pixi.canvas.getBoundingClientRect();
	const x = e.clientX - rect.left;
	const y = e.clientY - rect.top;

	// If the pointer travelled past the tolerance since pointerdown the user was
	// panning — ignore. The tolerance is per input device: see clickMoveTolerance.
	if (pointerDownScreenPos) {
		const dx = x - pointerDownScreenPos.x;
		const dy = y - pointerDownScreenPos.y;
		pointerDownScreenPos = null;
		const tolerance = clickMoveTolerance(pointerDownType);
		if (dx * dx + dy * dy > tolerance * tolerance) return;
	}

	const clickSlack = hitSlack(pointerDownType);
	const pill = clusterPillAt(x, y);
	if (pill) {
		// A topic's label selects that topic — the same act as clicking its row in
		// the Topics panel, with the same modifier for multi-select. Selection is
		// the noun the selection bar's verbs (Immerse, Open all, Collapse…) act on,
		// so the label stays one consistent gesture and collapsing moves there.
		onFocusCluster?.(pill.cluster, false, e.shiftKey || e.metaKey || e.ctrlKey);
		requestRender("world");
		return;
	}
	const node = findNodeAt(x, y, clickSlack);

	// Touch has no hover, so a tap is what moves the highlight: latch it onto the
	// tapped node (or drop it when the tap lands on empty canvas) and keep
	// `hoveredNode` — which every render path already reads — pointing at it.
	if (pointerDownType === "touch" || pointerDownType === "pen") {
		touchLatchedNode = node;
		if (hoveredNode !== node) {
			hoveredNode = node;
			previewTriggeredForNode = null;
			requestRender("world");
		}
	}

	if (node) {
		// A collapsed topic has no file behind it, so clicking selects the topic —
		// the same gesture as clicking its label. Expanding it is a verb in the
		// selection bar, which keeps "click a topic" meaning one thing whether the
		// topic is folded or not.
		if (node.kind === "topic") {
			if (node.cluster != null) {
				onFocusCluster?.(node.cluster, false, e.shiftKey || e.metaKey || e.ctrlKey);
			}
		} else if (node.kind === "tag") {
			// No file behind a tag either — searching for it is what a tag click
			// does everywhere else in Obsidian.
			onTagClick?.(node.label);
		} else if (onNodeClick) {
			onNodeClick(node.path);
		}
	} else {
		// Click on empty space clears selection and focused clusters
		if (selectedNodes.size > 0) clearSelection();
		if (focusedClusters.size > 0) onClearFocusedClusters?.();
	}
}

// Wheel is handled by pixi-viewport — no manual handleWheel needed.
// We just need a render on viewport move to update overlays.

function handleWheel() {
	// User is zooming — abort any running camera animation immediately
	pixi?.abortAnimation();
	needsInitialFit = false;
	pendingUserViewportZoom = true;
}

/**
 * Fire the hover-link preview for a node exactly once.
 * Positions the invisible anchor at the node's screen location.
 */
function triggerNodePreview(event: MouseEvent | KeyboardEvent, node: GraphNode) {
	if (!pixi) return;
	const screen = pixi.worldToScreen(node.x ?? 0, node.y ?? 0);
	// worldToScreen returns coords relative to the canvas element.
	// hoverAnchorEl is position:absolute within containerEl, so we must
	// subtract the canvas offset relative to the container.
	const canvasRect = pixi.canvas.getBoundingClientRect();
	const containerRect = containerEl.getBoundingClientRect();
	const offsetX = canvasRect.left - containerRect.left;
	const offsetY = canvasRect.top - containerRect.top;
	// Nothing to preview for a synthetic topic or tag node.
	if (node.kind === "topic" || node.kind === "tag") return;

	hoverAnchorEl.href = node.path;
	hoverAnchorEl.dataset.href = node.path;
	hoverAnchorEl.setAttribute("aria-label", node.label);
	hoverAnchorEl.style.left = `${screen.x + offsetX}px`;
	hoverAnchorEl.style.top = `${screen.y + offsetY}px`;
	previewTriggeredForNode = node.id;
	onHoverPreview?.(event as MouseEvent, node.path, hoverAnchorEl);
}

function handleMouseLeave() {
	cancelLongPress();
	// A touch sequence ends with a synthetic mouseleave, which is what used to
	// wipe the tap highlight a frame after it appeared. A latched node survives
	// it — only a real tap elsewhere clears the latch.
	if (touchLatchedNode) {
		applyCursor(false);
		return;
	}
	hoveredNode = null;
	previewTriggeredForNode = null;
	// Leaving while over a node or pill would otherwise strand `var(--cursor)`
	// on the canvas, so re-entering over empty space starts out wrong.
	applyCursor(false);
	requestRender("world");
}

function handleContextMenu(e: MouseEvent) {
	e.preventDefault();
	if (!pixi) return;
	const rect = pixi.canvas.getBoundingClientRect();
	const x = e.clientX - rect.left;
	const y = e.clientY - rect.top;
	const node = findNodeAt(x, y);

	if (!node) return;
	openNodeMenu(node, e.clientX, e.clientY);
}

/**
 * Build and show the node context menu at a viewport position. Shared by
 * right-click (desktop) and long-press (touch), so mobile users can reach
 * "Reveal in file explorer" / cluster actions that have no other entry point.
 */
function openNodeMenu(node: GraphNode, clientX: number, clientY: number) {
	const menu = new Menu();

	if (node.kind === "topic") {
		// No file behind a collapsed topic — offer the group actions instead.
		menu.addItem((item) =>
			item
				.setTitle("Expand topic")
				.setIcon("expand")
				.onClick(() => {
					if (node.cluster != null) onSetTopicCollapsed?.(node.cluster, false);
				}),
		);
		menu.addItem((item) =>
			item
				.setTitle(`Open all ${node.memberPaths?.length ?? 0} notes`)
				.setIcon("files")
				.onClick(() => {
					// Route through the shared handler so a 60-note topic hits the
					// same confirmation the selection bar's "Open all" does.
					onOpenPaths?.(node.memberPaths ?? []);
				}),
		);
	} else if (node.kind === "tag") {
		// A tag belongs to no topic, so none of the cluster actions below apply.
		menu.addItem((item) =>
			item
				.setTitle("Search notes with this tag")
				.setIcon("search")
				.onClick(() => {
					onTagClick?.(node.label);
				}),
		);
		menu.showAtPosition({ x: clientX, y: clientY });
		return;
	} else {
		menu.addItem((item) =>
			item
				.setTitle("Open file")
				.setIcon("file-text")
				.onClick(() => {
					onNodeClick?.(node.path);
				}),
		);

		menu.addItem((item) =>
			item
				.setTitle("Reveal in file explorer")
				.setIcon("folder-open")
				.onClick(() => {
					onRevealFile?.(node.path);
				}),
		);
	}

	menu.addSeparator();

	menu.addItem((item) =>
		item
			.setTitle("Focus on this cluster")
			.setIcon("scan")
			.onClick(() => {
				if (node.cluster != null) {
					// Framing the cluster is the whole point of this menu item.
					onFocusCluster?.(node.cluster, true);
				}
			}),
	);

	// Clicking a label selects rather than folds, so the per-topic fold needs a
	// home — here, alongside the collapsed node's "Expand topic".
	if (node.kind !== "topic" && node.cluster != null) {
		const cluster = node.cluster;
		menu.addItem((item) =>
			item
				.setTitle("Collapse topic")
				.setIcon("shrink")
				.onClick(() => {
					onSetTopicCollapsed?.(cluster, true);
				}),
		);
	}

	menu.addItem((item) =>
		item
			.setTitle("Select this cluster")
			.setIcon("box-select")
			.onClick(() => {
				if (node.cluster != null) {
					const clusterPaths = simNodes.filter((n) => n.cluster === node.cluster).map((n) => n.path);
					selectNodesByPaths(clusterPaths);
					onSelectionChange?.(clusterPaths);
				}
			}),
	);

	menu.showAtPosition({ x: clientX, y: clientY });
}

// ============================================================================
// Cluster cohesion helpers
// ============================================================================

/** Compute the 2D centroid (mean x, y) for each cluster. */
// ============================================================================
// Shared graph data setup (used by both wiki and smart modes)
// ============================================================================

/**
 * Position a node inherits when its id is new but the *thing* it represents was
 * already on screen.
 *
 * Collapsing and expanding change node ids — a note is `Corpus/x.md`, its topic
 * is `topic:3` — so the position cache misses in both directions and the layout
 * scatters everything onto a ring, which reads as nodes flying in from nowhere.
 * Mapping between the two forms keeps the transition in place:
 *
 * - collapsing: the topic node starts at its members' centroid
 * - expanding: each note starts where its topic node was, then spreads out
 *
 * Returns null when there's nothing to inherit from, leaving the caller's
 * existing ring-scatter fallback in charge.
 */
function inheritedPosition(
	node: GraphNode,
	oldPositions: Map<string, { x: number; y: number }>,
): { x: number; y: number } | null {
	// Only positions from the frame we're leaving count. Falling back to the
	// persistent cache here would inherit from a layout that is no longer on
	// screen, which is exactly the jump this function exists to prevent.
	const lookup = (id: string) => oldPositions.get(id);

	// Collapsing: average wherever this topic's members currently sit.
	if (node.kind === "topic" && node.memberPaths?.length) {
		let x = 0;
		let y = 0;
		let found = 0;
		for (const path of node.memberPaths) {
			const position = lookup(path);
			if (!position) continue;
			x += position.x;
			y += position.y;
			found++;
		}
		if (found === 0) return null;
		return { x: x / found, y: y / found };
	}

	// Expanding: start from the topic node this note was folded into. A small
	// deterministic offset keeps the members from stacking exactly on top of each
	// other, which would leave the force sim with no gradient to separate them.
	if (node.cluster != null) {
		const topicPosition = lookup(topicNodeId(node.cluster));
		if (topicPosition) {
			let hash = 5381;
			for (let i = 0; i < node.id.length; i++) hash = ((hash * 33) ^ node.id.charCodeAt(i)) >>> 0;
			const angle = (hash % 360) * (Math.PI / 180);
			const radius = EXPAND_SCATTER_RADIUS * (0.4 + ((hash >>> 9) % 100) / 100);
			return { x: topicPosition.x + Math.cos(angle) * radius, y: topicPosition.y + Math.sin(angle) * radius };
		}
	}

	return null;
}

/**
 * Build the internal node/link data structures from the incoming GraphData.
 * This is shared between wiki (d3-force) and smart (static) modes.
 */
function buildInternalData(data: GraphData): {
	oldPositions: Map<string, { x: number; y: number }>;
	allPositionsKnown: boolean;
	isFreshLayout: boolean;
} {
	// Save old positions for smooth transitions and persist them for future restores
	const oldPositions = new Map<string, { x: number; y: number }>();
	for (const n of simNodes) {
		if (n.x != null && n.y != null) {
			oldPositions.set(n.id, { x: n.x, y: n.y });
			persistentPositionCache.set(n.id, { x: n.x, y: n.y });
		}
	}

	// Identity of the outgoing frame, for entrance animations: nodes and edges
	// not present in it are the *change*, and only they animate in — the rest of
	// the graph holds still so the change is what the eye lands on.
	const previousNodeIds = new Set(simNodes.map((n) => n.id));
	const previousEdgeKeys = new Set<string>();
	for (const link of renderableSimLinks) {
		previousEdgeKeys.add(simLinkKey((link.source as SimNode).id, (link.target as SimNode).id, link.type));
	}

	// Compute centroid from all known positions (old + cached) for scattering new nodes
	let centroidX = 0;
	let centroidY = 0;
	const knownForCentroid = oldPositions.size > 0 ? oldPositions : persistentPositionCache;
	if (knownForCentroid.size > 0) {
		for (const { x, y } of knownForCentroid.values()) {
			centroidX += x;
			centroidY += y;
		}
		centroidX /= knownForCentroid.size;
		centroidY /= knownForCentroid.size;
	}
	// Radius of the known layout, for placing connection-less new nodes on its
	// rim. Dropping them at the centroid buries them inside the existing node
	// mass where they're invisible (and charge repulsion pushes an isolated node
	// out to the rim anyway — the rim is simply where it will settle).
	let knownLayoutRadius = 0;
	for (const { x, y } of knownForCentroid.values()) {
		const distance = Math.hypot(x - centroidX, y - centroidY);
		if (distance > knownLayoutRadius) knownLayoutRadius = distance;
	}

	// Create mutable copies.
	// Priority: oldPositions (current frame) → persistentPositionCache (prior view) → circle pre-layout.
	let newNodeIndex = 0;
	let allPositionsKnown = true;
	const isFreshLayout = oldPositions.size === 0 && persistentPositionCache.size === 0;
	simNodesVersion++;
	hoverAlphasSettled = false;
	hitGridDirty = true;
	const hasAnyKnown = oldPositions.size > 0 || persistentPositionCache.size > 0;
	const unknownCount = data.nodes.filter((n) => !oldPositions.has(n.id) && !persistentPositionCache.has(n.id)).length;
	// Spread radius for circle pre-layout: scale with node count so the graph fills
	// a reasonable area before forces kick in (reduces initial chaos).
	const circleRadius = Math.max(150, Math.sqrt(unknownCount) * effectiveLinkDistance * 0.5);

	// A node created while the graph is open should appear next to what it
	// connects to, not in a ring around the whole layout — seed unknown nodes at
	// the centroid of their already-positioned neighbours when they have any.
	const knownPosition = (id: string) => oldPositions.get(id) ?? persistentPositionCache.get(id);
	const neighborIds = new Map<string, string[]>();
	if (unknownCount > 0 && hasAnyKnown) {
		for (const e of data.edges) {
			if (!neighborIds.has(e.source)) neighborIds.set(e.source, []);
			if (!neighborIds.has(e.target)) neighborIds.set(e.target, []);
			neighborIds.get(e.source)?.push(e.target);
			neighborIds.get(e.target)?.push(e.source);
		}
	}
	const neighborSeedPosition = (id: string): { x: number; y: number } | null => {
		const neighbors = neighborIds.get(id);
		if (!neighbors) return null;
		let sumX = 0;
		let sumY = 0;
		let count = 0;
		for (const neighborId of neighbors) {
			const position = knownPosition(neighborId);
			if (!position) continue;
			sumX += position.x;
			sumY += position.y;
			count++;
		}
		if (count === 0) return null;
		const angle = Math.random() * 2 * Math.PI;
		const radius = 30 + Math.random() * 40;
		return { x: sumX / count + Math.cos(angle) * radius, y: sumY / count + Math.sin(angle) * radius };
	};

	// The latch pins a node from the previous graph. Rebuilding (immerse, collapse,
	// refresh) can drop that node, which would strand its highlight, so release it
	// with the graph it belonged to.
	touchLatchedNode = null;

	simNodes = data.nodes.map((n) => {
		const sn: SimNode = { ...n };
		// Priority matters: a position inherited from what this node *replaces on
		// screen right now* beats a cached one from some earlier layout. The cache
		// exists to restore a view you navigated away from; during a collapse or
		// expand it holds stale coordinates that make nodes jump.
		const old = oldPositions.get(n.id) ?? inheritedPosition(n, oldPositions) ?? persistentPositionCache.get(n.id);
		if (old) {
			sn.x = old.x;
			sn.y = old.y;
		} else {
			allPositionsKnown = false;
			const seeded = hasAnyKnown ? neighborSeedPosition(n.id) : null;
			if (seeded) {
				sn.x = seeded.x;
				sn.y = seeded.y;
			} else if (hasAnyKnown) {
				// No positioned neighbours — scatter on the rim of the known
				// layout: the sparse band where an unconnected node settles
				// anyway, and still inside the current camera frame (the camera
				// doesn't move for live updates, so "just past the furthest
				// node" would be just out of view).
				const angle = (2 * Math.PI * newNodeIndex) / Math.max(1, unknownCount);
				const radius =
					knownLayoutRadius > 0 ? knownLayoutRadius * (0.9 + Math.random() * 0.1) : 80 + Math.random() * 60;
				sn.x = centroidX + Math.cos(angle) * radius;
				sn.y = centroidY + Math.sin(angle) * radius;
			} else {
				// Fresh load: evenly space all nodes on a circle so forces start from
				// a structured layout rather than a random pile — much less initial chaos.
				const angle = (2 * Math.PI * newNodeIndex) / Math.max(1, unknownCount);
				sn.x = Math.cos(angle) * circleRadius;
				sn.y = Math.sin(angle) * circleRadius;
			}
			newNodeIndex++;
		}
		return sn;
	});

	simNodeMap = new Map(simNodes.map((n) => [n.id, n]));

	// Stamp entrance animations for nodes born in this change. A fresh layout is
	// excluded — everything is new there, and it has its own reveal (the canvas
	// stays hidden until the layout partially settles).
	if (previousNodeIds.size > 0) {
		const now = performance.now();
		for (const n of simNodes) {
			if (!previousNodeIds.has(n.id)) nodeSpawnTimes.set(n.id, now);
		}
	}
	// Nodes removed by the change can't finish an animation they're no longer in.
	for (const id of nodeSpawnTimes.keys()) {
		if (!simNodeMap.has(id)) nodeSpawnTimes.delete(id);
	}

	// flatMap rather than filter-then-map: doing the lookups once and dropping the edge
	// when either end is missing gives the same result without asserting non-null on a
	// second lookup the compiler cannot tie to the earlier `has` checks.
	simLinks = data.edges.flatMap((e) => {
		const source = simNodeMap.get(e.source);
		const target = simNodeMap.get(e.target);
		if (!source || !target) return [];
		return [
			{
				source,
				target,
				weight: e.weight,
				type: e.type,
				isNew: !previousEdgeKeys.has(simLinkKey(e.source, e.target, e.type)),
			},
		];
	});

	// Pre-split by edge type to avoid filtering every render frame. Every
	// drawable type is listed: the renderer decides per frame which of them
	// the display toggles currently show.
	renderableSimLinks = simLinks.filter((l) => l.type === "wiki" || l.type === "semantic" || l.type === "tag");
	refreshClusterMetadata(data);

	// Build adjacency map for O(1) hover-dimming lookups
	adjacency = new Map();
	for (const link of simLinks) {
		const sId = (link.source as SimNode).id;
		const tId = (link.target as SimNode).id;
		if (!adjacency.has(sId)) adjacency.set(sId, new Set());
		if (!adjacency.has(tId)) adjacency.set(tId, new Set());
		adjacency.get(sId)?.add(tId);
		adjacency.get(tId)?.add(sId);
	}

	// Start the edge fade-in. Only edges marked `isNew` above consume it — the
	// rest of the graph renders at full opacity throughout, so a local change
	// (one topic folding) no longer flashes every edge on screen.
	edgeFadeAlpha = 0;

	return { oldPositions, allPositionsKnown, isFreshLayout };
}

/** Canonical identity of a rendered edge — endpoint order doesn't matter. */
function simLinkKey(a: string, b: string, type: string): string {
	return a < b ? `${a}\0${b}\0${type}` : `${b}\0${a}\0${type}`;
}

// ============================================================================
// Wiki mode: d3-force simulation setup
// ============================================================================

function setupForceSimulation(
	oldPositions: Map<string, { x: number; y: number }>,
	allPositionsKnown: boolean,
	isFreshLayout: boolean,
	isIncrementalUpdate = false,
) {
	// A fresh simulation has no applied parameters yet, so the hot-update effect
	// must treat its next run as a real change rather than a no-op repeat.
	lastPhysicsSignature = null;

	simulation = forceSimulation<SimNode>(simNodes);
	// Full production force set — shared with the headless layout benchmark, so
	// what gets measured there is exactly what runs here.
	applyLayoutForces(simulation, simNodes, simLinks, layoutPhysicsConfig());
	simulation
		.on("tick", () => {
			// Positions moved — the spatial hit grid no longer matches them.
			hitGridDirty = true;
			// A finished re-cluster transition hands its slower decay back, so the
			// next drag or retarget feels normal instead of inheriting the drift.
			// The migration cohesion boost isn't stepped off here — it eases out
			// along `reclusterBoostFactor` as alpha falls through the ramp window,
			// so releasing the over-compressed clusters is part of the same settle
			// instead of a visible second push after it.
			if (isReclustering && simulation) {
				const tickAlpha = simulation.alpha();
				if (reclusterBoostActive && tickAlpha < RECLUSTER_BOOST_RAMP_START) {
					const clusterForce = simulation.force("cluster") as
						| ReturnType<typeof clusterCohesionForce>
						| undefined;
					clusterForce?.strength(effectiveClusterCohesion * reclusterBoostFactor(tickAlpha));
				}
				if (tickAlpha < RECLUSTER_BOOST_RAMP_END) {
					isReclustering = false;
					reclusterBoostActive = false;
					simulation.alphaDecay(baseAlphaDecay).velocityDecay(baseVelocityDecay);
				}
			}

			// During initial settling, continuously refit the camera so it
			// tracks the expanding layout smoothly instead of staying zoomed-in.
			if (needsInitialFit && pixi) {
				forceTickCount++;
				// Refit every 3 ticks (~50ms) with a short animation that
				// overlaps the next refit, producing fluid camera motion.
				// A re-cluster settles slowly, so its camera samples less often and
				// eases for longer — otherwise the view is busier than the nodes.
				const refitEvery = isReclustering ? 6 : 3;
				if (forceTickCount % refitEvery === 0) {
					const bounds = computeNodeBounds(simNodes);
					if (bounds) {
						// Centre on the core (so unsorted strays don't drag the view
						// off to one side) while the scale still fits every node.
						const frame = framingFocus(
							bounds,
							{ width: pixi.width, height: pixi.height },
							GRAPH_FIT_PADDING,
							GRAPH_FIT_MAX_SCALE,
							computeCoreNodeBounds(simNodes),
						);
						pixi.animateToFrame(frame.centerX, frame.centerY, frame.scale, isReclustering ? 400 : 150);
					}
				}
				// Once settled, do one final smooth fit and stop tracking.
				if (simulation && simulation.alpha() < 0.05) {
					needsInitialFit = false;
					forceTickCount = 0;
					animateCameraToNodes(undefined, GRAPH_FIT_PADDING, 500);
					// The layout can still creep after alpha drops below the tracking
					// threshold — clusters keep spreading for a while — so that "final"
					// fit is often already stale. Take one more measurement after the
					// drift has actually stopped, but only *apply* it if the framing
					// really went stale: on a collapse the graph is already settled
					// and framed, and an unconditional refit reads as the camera
					// lurching out for no reason a second after it arrived.
					const settledBounds = computeNodeBounds(simNodes);
					if (settleFitTimer != null) window.clearTimeout(settleFitTimer);
					settleFitTimer = window.setTimeout(() => {
						settleFitTimer = null;
						if (driftedSince(settledBounds)) {
							animateCameraToNodes(undefined, GRAPH_FIT_PADDING, 500);
						}
					}, SETTLE_FIT_DELAY_MS);
				}
			}
			requestRender("world");
		})
		.alphaDecay(isFreshLayout ? 0.04 : 0.02)
		.velocityDecay(isFreshLayout ? 0.5 : 0.3);

	// Remember this simulation's decay so a re-cluster transition can borrow
	// slower values and hand them back exactly, rather than guessing a default.
	baseAlphaDecay = simulation.alphaDecay();
	baseVelocityDecay = simulation.velocityDecay();
	isReclustering = false;
	// A fresh force set carries no migration boost; a stale flag would let the
	// tick handler re-apply one to a simulation that never asked for it.
	reclusterBoostActive = false;

	// On a fresh layout, hide the canvas briefly so the first visible frame is
	// already partially settled rather than the initial random-pile explosion.
	if (isFreshLayout) {
		canvasVisible = false;
		if (canvasRevealTimer != null) window.clearTimeout(canvasRevealTimer);
		canvasRevealTimer = window.setTimeout(() => {
			canvasVisible = true;
			canvasRevealTimer = null;
		}, 300);
	} else {
		canvasVisible = true;
	}

	// Note Context can opt into an unconditional refit on graph changes, even
	// when positions are restored from cache.
	if (alwaysRefitOnDataChange) {
		simulation.alpha(Math.max(simulation.alpha(), 0.08));
		needsInitialFit = true;
		forceTickCount = 0;
	}
	// A live vault-change patch settles locally around the changed nodes (they
	// were seeded near their neighbours) and never moves the camera — the user
	// may be reading the graph while a note syncs in.
	else if (isIncrementalUpdate && oldPositions.size > 0) {
		simulation.alpha(allPositionsKnown ? 0.05 : 0.3);
		needsInitialFit = false;
	}
	// All nodes restored from cache → gentle settle, no camera refit needed.
	// Some nodes had prior positions (mode switch) → slow drift into place.
	// No prior positions → full simulation from scratch.
	else if (allPositionsKnown) {
		simulation.alpha(0.05);
		needsInitialFit = false;
	} else if (oldPositions.size > 0) {
		simulation.alpha(0.15).alphaDecay(0.008).velocityDecay(0.4);
		needsInitialFit = true;
		forceTickCount = 0;
	}

	// A graph rebuilt while its leaf is hidden (e.g. data arriving into a
	// background tab) shouldn't burn CPU settling a layout nobody can see —
	// the visibility observer resumes it on reveal.
	if (!leafVisible) {
		simPausedWhileHidden = true;
		simulation.stop();
	}
}

// ============================================================================
// Main graph setup — dispatches to wiki or smart layout engine
// ============================================================================

/**
 * Returns true when only node colors / cluster indices changed — the topology
 * (node IDs, count, edges) is identical to the current simNodes/simLinks.
 * Used to short-circuit a full layout restart on color-mode switches.
 */
function isColorOnlyChange(data: GraphData): boolean {
	if (simNodes.length === 0) return false;
	if (simNodes.length !== data.nodes.length) return false;
	const existingIds = new Set(simNodes.map((n) => n.id));
	if (!data.nodes.every((n) => existingIds.has(n.id))) return false;
	// Compare filtered edge count — simLinks excludes edges whose endpoints are
	// outside the rendered node set, so comparing against data.edges directly
	// produces a false mismatch whenever dangling edges exist.
	const filteredEdgeCount = data.edges.filter((e) => existingIds.has(e.source) && existingIds.has(e.target)).length;
	return simLinks.length === filteredEdgeCount;
}

function setupGraph(data: GraphData) {
	// Consume the incremental flag whichever path this change takes, so a
	// leftover flag can't misclassify a later unrelated rebuild.
	const isIncrementalUpdate = incrementalUpdatePending;
	incrementalUpdatePending = false;

	if (data.nodes.length === 0) {
		if (simulation) {
			simulation.stop();
			simulation = null;
		}
		return;
	}

	// Color-only update: topology unchanged, only colors/clusters differ.
	// Patch simNodes in-place rather than rebuilding the simulation.
	if (isColorOnlyChange(data)) {
		// Reassigning clusters changes where the cohesion force wants nodes to sit,
		// so the layout has to re-settle — but only when the assignment actually
		// changed. A pure recolour (highlight toggles) must leave the graph still.
		let clustersChanged = false;
		for (const node of data.nodes) {
			const sn = simNodeMap.get(node.id);
			if (sn !== undefined) {
				if (sn.cluster !== node.cluster) clustersChanged = true;
				sn.color = node.color;
				sn.cluster = node.cluster;
				sn.highlighted = node.highlighted;
			}
		}
		// Sync the cohesion force strength to the current prop value — but never
		// mid-transition: a pure recolor (highlight toggle) landing while a
		// re-cluster is still migrating would silently drop the boost early.
		const clusterForce = simulation?.force("cluster") as ReturnType<typeof clusterCohesionForce> | undefined;
		if (clusterForce && !isReclustering) clusterForce.strength(effectiveClusterCohesion);
		// Re-derive cluster metadata so pills on the canvas reflect the new segmentation.
		// (buildInternalData is not called in this path, so we update it explicitly.)
		refreshClusterMetadata(data);

		// New topics mean new cluster centroids, so the nodes have to move there.
		// The cohesion force alone can't do it once alpha has decayed — it would be
		// applied to a simulation that is no longer ticking, leaving colours and
		// hulls updated over a frozen layout.
		if (clustersChanged && clusterCohesionStrength > 0 && simulation && simulation.alpha() < RECLUSTER_ALPHA) {
			// Equilibrium cohesion is tuned deliberately gentle (density profile,
			// per-cluster member damping) so settled clusters keep breathing room —
			// but that same gentleness can no longer *migrate* nodes across the
			// layout when a granularity change hands them new topics, so freshly
			// split groups stayed spatially interleaved and their hulls overlapped.
			// Boost the pull for the transition only; the tick handler eases it
			// back to equilibrium across the RECLUSTER_BOOST_RAMP alpha window.
			reclusterBoostActive = true;
			clusterForce?.strength(effectiveClusterCohesion * RECLUSTER_COHESION_BOOST);
			simulation
				.alpha(RECLUSTER_ALPHA)
				.alphaDecay(RECLUSTER_ALPHA_DECAY)
				.velocityDecay(RECLUSTER_VELOCITY_DECAY)
				.restart();
			isReclustering = true;
			// Frame the regrouped layout, since re-clustering can move nodes far.
			needsInitialFit = true;
			forceTickCount = 0;
		}

		if (pixi) requestRender("world");
		return;
	}

	// Full setup needed — stop existing simulation first
	if (simulation) {
		simulation.stop();
		simulation = null;
	}

	const { oldPositions, allPositionsKnown, isFreshLayout } = buildInternalData(data);
	setupForceSimulation(oldPositions, allPositionsKnown, isFreshLayout, isIncrementalUpdate);
}

// React to graphData changes — setupGraph is called via untrack so that writes
// to $state simulation inside setupForceSimulation don't re-trigger this effect.
$effect(() => {
	const _data = graphData;
	void _data;
	untrack(() => setupGraph(graphData));
});

// Re-render when appearance settings or prop-driven overlay content change
// (nodeSize, link toggles, topic names arriving from the AI labeling pass, a
// focus selection made in the Topics panel, …). Nothing else re-renders on
// prop changes, so every prop render() reads belongs in this list.
$effect(() => {
	void nodeSize;
	void showWikiLinks;
	void showSemanticLinks;
	void highlightSemanticLinks;
	void showTopicHulls;
	void alwaysRefitOnDataChange;
	void directedWikiEdges;
	void showClusterLabels;
	void clusterLabels;
	void focusedClusters;
	// nodeSize feeds node radii, which the hit grid bakes in at build time.
	hitGridDirty = true;
	if (pixi) requestRender("world");
});

// Lasso is toggled from the toolbar, so the pointer is over the rail — not the
// canvas — when the mode flips, and no pointermove follows to refresh the
// cursor. Without this the crosshair only appears once you happen to move over
// a node and back off it. DOM manipulation in response to a prop, which is what
// $effect is for.
$effect(() => {
	const _lasso = lassoMode;
	void _lasso;
	// Mid-gesture the cursor belongs to the drag, not to hover state. Untracked
	// so this effect keys on lassoMode alone and isn't also re-run by the
	// lasso's own start/end.
	untrack(() => {
		if (isLassoing || dragSimNode) return;
		applyCursor(false);
	});
});

// Hot-update force parameters without full rebuild.
// Reheats the simulation when it has settled so changes are visible immediately.
// Reading `simulation` ($state) means this effect re-runs when a new simulation
// is created (e.g. after a full graph rebuild), so slider changes always apply.
$effect(() => {
	// Everything applyLayoutForces reads. Raw slider values plus the two
	// value-stable $deriveds (nodeSize, visibleNodeCount) that feed the density
	// profile — a color-only graph change re-evaluates the deriveds but doesn't
	// re-fire this effect, so a settled layout can't be perturbed by a repaint.
	const _charge = chargeStrength;
	const _link = linkDistance;
	const _center = centerStrength;
	const _linkStr = linkStrength;
	const _cohesion = clusterCohesionStrength;
	const _nodeSize = nodeSize;
	const _count = visibleNodeCount;
	const sim = simulation; // $state — tracks simulation creation

	if (!sim) return;

	// One shared code path with initial setup (and the layout benchmark):
	// recreating the forces wholesale is cheap, and mutating them field-by-field
	// here previously meant the weight-aware link functions had to be carefully
	// re-applied by hand or the coupling scaling silently dropped.
	applyLayoutForces(sim, simNodes, simLinks, {
		linkDistance: _link,
		chargeStrength: _charge,
		centerStrength: _center,
		linkStrength: _linkStr,
		clusterCohesionStrength: _cohesion,
		nodeSize: _nodeSize,
		visibleNodeCount: _count,
	});
	// Recreating the forces resets cohesion to its equilibrium strength; restore
	// the migration boost if a re-cluster is still in flight, or a settings
	// write landing mid-transition would strand topics half-migrated. At the
	// alpha-dependent factor, not the full boost — a write landing mid-ramp
	// snapping the strength back up to 3× would reintroduce exactly the
	// discontinuity the ramp exists to remove. Gated on the boost flag because
	// `followLayout` transitions share `isReclustering` without ever boosting.
	if (reclusterBoostActive) {
		const migratingCluster = sim.force("cluster") as ReturnType<typeof clusterCohesionForce> | undefined;
		migratingCluster?.strength(effectiveClusterCohesion * reclusterBoostFactor(sim.alpha()));
	}

	// Reheat only when a force parameter really changed. `settings` is replaced
	// wholesale on every write (`{ ...settings, ...partial }`), which invalidates
	// each property read even when the number is identical — so without this
	// comparison a purely visual toggle (topic labels, highlights) would restart
	// the layout at alpha 0.3 and visibly re-shuffle the graph.
	const signature = `${_charge}:${_link}:${_center}:${_linkStr}:${_cohesion}:${_nodeSize}:${_count}`;
	const changed = signature !== lastPhysicsSignature;
	lastPhysicsSignature = signature;
	if (changed && sim.alpha() < 0.05) {
		sim.alpha(0.3).restart();
	}
});

onMount(() => {
	// Stop the simulation while this leaf is hidden — a background tab or a
	// collapsed sidebar hides via display:none, which IntersectionObserver
	// reports as non-intersecting. A layout nobody can see shouldn't tick
	// d3-force at 60fps; it resumes from its current alpha on reveal.
	const visibilityObserver = new IntersectionObserver((entries) => {
		const visible = entries[entries.length - 1]?.isIntersecting ?? true;
		if (visible === leafVisible) return;
		leafVisible = visible;
		if (!visible) {
			if (simulation && simulation.alpha() > 0.02) simPausedWhileHidden = true;
			simulation?.stop();
		} else {
			if (simPausedWhileHidden) {
				simPausedWhileHidden = false;
				simulation?.restart();
			}
			requestRender("world");
		}
	});
	visibilityObserver.observe(containerEl);

	// Initialize Pixi renderer
	const theme = readThemeColors(containerEl);
	const renderer = new PixiRenderer();
	pixi = renderer;

	// `renderer.init()` awaits WebGL context creation, so the cleanup below can run
	// before it resolves (the user closes the graph tab while it is starting up).
	// The cleanup is synchronous and would find `__graphCleanup` still unassigned,
	// after which this continuation would register a ResizeObserver, a
	// MutationObserver on document.body and a `css-change` listener that nothing
	// owns — leaking them plus `containerEl` and the destroyed renderer. Bail here
	// instead; the cleanup has already released everything that existed at its turn.
	let mountDisposed = false;

	renderer
		.init(containerEl, theme)
		.then(() => {
			if (mountDisposed) return;
			lastViewportScale = renderer.scale;
			// Re-render when the viewport moves. A zoom must refresh counter-scaled
			// strokes and label visibility; a pure pan only needs the screen-space
			// overlay (labels, pills, tooltip) re-laid-out.
			renderer.onViewportMoved(() => {
				const scale = renderer.scale;
				if (scale !== lastViewportScale) {
					lastViewportScale = scale;
					requestRender("zoom");
				} else {
					requestRender("overlay");
				}
				// A pan can carry the view outside the margin edges were culled to —
				// re-tessellate before the missing region scrolls fully into view.
				if (lastEdgeCullRect && !rectContains(lastEdgeCullRect, viewWorldRect(renderer, 0))) {
					edgesViewportStale = true;
					requestRender("zoom");
				}
				if (pendingUserViewportMove || pendingUserViewportZoom) {
					pendingUserViewportMove = false;
					pendingUserViewportZoom = false;
					onUserViewportChange?.();
				}
			});

			// Mobile WebViews reclaim the GPU when the app is backgrounded, losing
			// the WebGL context. Pixi rebuilds its GPU state on restore, but with
			// on-demand rendering nothing would repaint the cleared canvas until the
			// next interaction — so schedule a full pass (including edge
			// re-tessellation, since GPU-side geometry was dropped with the context).
			renderer.onContextRestored(() => {
				edgesViewportStale = true;
				requestRender("world");
			});

			// If graphData arrived before pixi was ready (happens when GraphCanvas
			// mounts while a build completes, e.g. on first open), do the initial
			// snap/fit that setupForceSimulation missed.
			if (simNodes.length > 0) {
				// Force mode: simulation is already running.
				// If it has already settled (alpha low), snap the camera immediately
				// since the tick loop won't fire again to do the initial fit.
				const alpha = simulation?.alpha() ?? 0;
				if (alpha < 0.05) {
					const bounds = computeNodeBounds(simNodes);
					if (bounds) {
						const frame = framingFocus(
							bounds,
							{ width: renderer.width, height: renderer.height },
							GRAPH_FIT_PADDING,
							GRAPH_FIT_MAX_SCALE,
							computeCoreNodeBounds(simNodes),
						);
						renderer.snapToFrame(frame.centerX, frame.centerY, frame.scale);
					}
				} else {
					// Simulation still running — tick loop will handle fitting.
					needsInitialFit = true;
					forceTickCount = 0;
				}
				requestRender("world");
			}

			// Same "catch up on what was missed while initializing" idea as the fit
			// above: applyCursor is a no-op until the renderer is ready, so anything
			// that set the cursor during init was dropped. Replay it once here so the
			// canvas doesn't wait for the first pointermove to show the right cursor.
			applyCursor(false);

			const resizeObserver = new ResizeObserver(() => {
				const rect = containerEl.getBoundingClientRect();
				renderer.resize(rect.width, rect.height);
				requestRender("world");
			});
			resizeObserver.observe(containerEl);

			// Listen for Obsidian theme changes — covers both "css-change" events (CSS
			// snippets) and class mutations on body (.theme-dark / .theme-light toggle).
			const handleCssChange = () => {
				const newTheme = readThemeColors(containerEl);
				renderer.updateTheme(newTheme);
				requestRender("world");
			};
			document.body.addEventListener("css-change", handleCssChange);

			const themeMutationObserver = new MutationObserver((mutations) => {
				for (const m of mutations) {
					if (m.type === "attributes" && m.attributeName === "class") {
						handleCssChange();
						break;
					}
				}
			});
			themeMutationObserver.observe(document.body, {
				attributes: true,
				attributeFilter: ["class"],
			});

			// Store cleanup references. Stashed on the element (rather than a local) so the
			// teardown below can find it even though it is created inside an async
			// continuation that may not have run yet.
			(containerEl as GraphCleanupHost).__graphCleanup = () => {
				resizeObserver.disconnect();
				document.body.removeEventListener("css-change", handleCssChange);
				themeMutationObserver.disconnect();
			};
		})
		.catch((error) => {
			// A WebGL context failure would otherwise surface only as an unhandled
			// rejection. Nothing is registered yet at this point, so there is nothing
			// to unwind — report it and leave the canvas blank.
			console.error("[GraphCanvas] Failed to initialize the graph renderer:", error);
		});

	return () => {
		// Tell a still-pending `renderer.init()` continuation to bail — see above.
		mountDisposed = true;
		(containerEl as GraphCleanupHost).__graphCleanup?.();
		visibilityObserver.disconnect();
		if (renderRafId != null) {
			cancelAnimationFrame(renderRafId);
			renderRafId = null;
		}
		if (retargetTimer != null) window.clearTimeout(retargetTimer);
		if (settleFitTimer != null) window.clearTimeout(settleFitTimer);
		if (canvasRevealTimer != null) window.clearTimeout(canvasRevealTimer);
		if (simulation) {
			simulation.stop();
			simulation = null;
		}
		renderer.destroy();
		pixi = null;
	};
});

/**
 * How much the layout's extent must change after the settle before a
 * corrective refit is worth it. Below this the framing is still essentially
 * right, and re-running it just moves the camera under the user.
 */
const SETTLE_REFIT_DRIFT_THRESHOLD = 0.12;

/**
 * Whether the layout has drifted enough since `previous` to justify refitting.
 *
 * A fresh build keeps spreading after alpha decays, so its first "final" fit
 * really is stale. A collapse settles almost immediately at a layout the
 * camera already framed — there the delayed refit had nothing to correct and
 * only read as an unexplained zoom-out a second later.
 */
function driftedSince(previous: BoundingBox | null): boolean {
	if (!previous) return false;
	const current = computeNodeBounds(simNodes);
	if (!current) return false;
	const previousWidth = Math.max(previous.maxX - previous.minX, 1);
	const previousHeight = Math.max(previous.maxY - previous.minY, 1);
	const widthDrift = Math.abs(current.maxX - current.minX - previousWidth) / previousWidth;
	const heightDrift = Math.abs(current.maxY - current.minY - previousHeight) / previousHeight;
	return Math.max(widthDrift, heightDrift) > SETTLE_REFIT_DRIFT_THRESHOLD;
}

/** Animate the camera to frame the given nodes with the specified padding and duration. */
function animateCameraToNodes(
	filter?: (node: SimNode) => boolean,
	padding: number | FramingPadding = 40,
	duration = 400,
	// Whole-graph framings cap the zoom; selection zooms pass a permissive cap
	// because magnifying a few chosen notes is the point of the gesture.
	maxScale = GRAPH_FIT_MAX_SCALE,
) {
	if (!pixi) return;
	// Always frame the full bounds: an explicit fit means "show me everything",
	// and framing only a trimmed core left excluded nodes stranded outside the
	// viewport — which reads as a broken fit, not a smart one. Keeping strays
	// from dominating the frame is the layout's job (satellite centering,
	// sparse spread), not the camera's.
	const bounds = computeNodeBounds(simNodes, filter);
	if (!bounds) return;
	// Whole-graph framings centre on the core so a lopsided ring of unsorted
	// notes doesn't shove the main graph aside; an explicit selection is
	// centred on exactly what was selected.
	const centreBounds = filter ? null : computeCoreNodeBounds(simNodes);
	const target = framingFocus(bounds, { width: pixi.width, height: pixi.height }, padding, maxScale, centreBounds);
	pixi.animateToFrame(target.centerX, target.centerY, target.scale, duration);
}

/**
 * Track the layout with the camera until it settles.
 *
 * Reuses the same per-tick refit the initial layout uses: a short animation
 * every few ticks, each overlapping the next, so the camera follows the nodes
 * continuously instead of jumping between fixed snapshots. Use this whenever the
 * node set changes shape under the user (collapse, expand) — a one-shot
 * `fitToView` frames positions the simulation is still moving away from, which
 * reads as a stutter.
 */
export function followLayout() {
	if (simNodes.length === 0 || !simulation) return;
	needsInitialFit = true;
	forceTickCount = 0;

	// Hold a high alpha for a moment rather than bumping it once and letting it
	// decay. Collapsing replaces a wide note layout with a handful of nodes that
	// inherit their members' centroid, so an outlying topic can start thousands
	// of pixels out — and the centering force is deliberately weak (0.05) to keep
	// the note-level graph from being squashed. A decaying nudge barely moves
	// such a node, which is why the view stayed zoomed out until the node was
	// dragged: releasing a drag sets alphaTarget(0.3), and *that* sustained pull
	// is what recentred it. This gives the transition the same treatment.
	//
	// Damped like the granularity transition: the sustained alpha with the
	// default (low) drag made expanding notes spring out and rebound, and moved
	// the camera on the fast refit cadence — jumpy on both counts. The recluster
	// drag keeps the motion flowing, and `isReclustering` selects the slower,
	// longer-eased camera sampling; the tick handler hands both back once the
	// layout comes to rest.
	simulation.alphaTarget(RETARGET_ALPHA).velocityDecay(RECLUSTER_VELOCITY_DECAY).restart();
	isReclustering = true;
	if (retargetTimer != null) window.clearTimeout(retargetTimer);
	retargetTimer = window.setTimeout(() => {
		retargetTimer = null;
		// Back to 0 so the layout can actually come to rest.
		simulation?.alphaTarget(0);
	}, RETARGET_HOLD_MS);
}

/**
 * Fit the graph to the viewport with smooth animation.
 */
export function fitToView() {
	if (simNodes.length === 0) return;
	animateCameraToNodes(undefined, GRAPH_FIT_PADDING, 600);
}

/**
 * Zoom the viewport by a multiplicative factor around the screen center.
 * Backs the +/- keyboard shortcuts.
 */
function zoomByFactor(factor: number) {
	const renderer = pixi;
	if (!renderer) return;
	const newScale = Math.min(10, Math.max(0.05, renderer.scale * factor));
	const center = renderer.screenToWorld(renderer.width / 2, renderer.height / 2);
	renderer.moveCenter(center.x, center.y, newScale);
	onUserViewportChange?.();
	requestRender("zoom");
}

/**
 * Smoothly pan and zoom to frame the currently selected nodes.
 */
export function panToSelection() {
	if (selectedNodes.size === 0) return;
	animateCameraToNodes((n) => selectedNodes.has(n.id), 60, 400, 4);
}

/**
 * Smoothly pan and zoom to frame the nodes belonging to the given clusters.
 */
export function panToClusters(clusters: Set<number>) {
	if (simNodes.length === 0 || clusters.size === 0) return;
	animateCameraToNodes((n) => n.cluster != null && clusters.has(n.cluster), 60, 400, 4);
}
</script>

<button
  type="button"
  class={["graph-canvas-container", className].filter(Boolean).join(" ")}
  style="opacity: {canvasVisible ? 1 : 0}; transition: opacity 0.2s ease;"
  bind:this={containerEl}
  onpointerdown={handleMouseDown}
  onpointermove={handleMouseMove}
  onpointerup={handleMouseUp}
  onclick={handleClick}
  onwheel={handleWheel}
  onmouseleave={handleMouseLeave}
  oncontextmenu={handleContextMenu}
>
  <!-- Pixi.js creates its own <canvas> inside this container via pixi.init() -->
  <!-- Invisible anchor for Obsidian hover-link popover positioning -->
  <a
    bind:this={hoverAnchorEl}
    class="hover-anchor internal-link"
    aria-hidden="true"
    tabindex="-1"
    href="about:blank"
  ></a>
</button>

<style>
  .graph-canvas-container {
    width: 100%;
    height: 100%;
    overflow: hidden;
    position: relative;
    display: block;
    padding: 0;
    border: 0;
    background: transparent;
    text-align: initial;
    outline: none;
    cursor: grab;
    touch-action: none; /* Required for pointer capture to work */
    /* The container is a <button> only so it can take keyboard focus for the
       graph's shortcuts — it is a canvas surface, not a control. Suppress the
       tap feedback a real button gets: WebKit's grey flash on touch, and the
       box-shadow Obsidian's mobile theme puts on :active/:focus buttons. */
    -webkit-tap-highlight-color: transparent;
    box-shadow: none;
  }

  /* Obsidian's button rules set a background on these states; the canvas must
     stay transparent so the graph shows through unchanged when tapped. */
  .graph-canvas-container:active,
  .graph-canvas-container:hover,
  .graph-canvas-container:focus,
  .graph-canvas-container:focus-visible {
    background: transparent;
    box-shadow: none;
    outline: none;
  }

  .graph-canvas-container:active {
    cursor: grabbing;
  }

  /* Pixi creates a <canvas> child — ensure it fills the container */
  .graph-canvas-container :global(canvas) {
    display: block;
    width: 100% !important;
    height: 100% !important;
  }

  .hover-anchor {
    position: absolute;
    width: 1px;
    height: 1px;
    pointer-events: none;
  }
</style>
