/**
 * Graph Layout Physics
 *
 * The force assembly behind the smart graph's d3-force simulation, extracted
 * from the canvas so the *identical* physics can run headlessly — the layout
 * benchmark (`scripts/graph-layout-bench.ts`) measures the same forces the
 * user sees, not a reimplementation that could drift.
 *
 * {@link applyLayoutForces} is idempotent: it (re)creates every force from the
 * given config, so the canvas uses it both for initial setup and for
 * hot-applying slider changes. The density profile is applied *inside* —
 * callers pass raw baseline values plus the visible-node count, which makes it
 * impossible for a caller to forget the density scaling.
 *
 * Free of Svelte and Pixi; depends only on d3-force and the pure tuning
 * functions in graphUtils.
 */

import {
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3-force";
import { densityForceProfile, nodeDrawRadius } from "./graphUtils";

/** The node shape the physics needs — a structural subset of the canvas's SimNode. */
export interface LayoutNode extends SimulationNodeDatum {
	id: string;
	degree?: number;
	kind?: string;
	cluster?: number;
	/** For topic nodes — drives their draw (and thus collide) radius. */
	memberPaths?: string[];
	/** For topic nodes — the vault's largest topic, which the radius is normalized to. */
	largestTopicSize?: number;
}

/** The link shape the physics needs — a structural subset of the canvas's SimLink. */
export interface LayoutLink<N extends LayoutNode = LayoutNode> extends SimulationLinkDatum<N> {
	weight: number;
	type: string;
}

/** Raw (pre-density) physics parameters — the user's slider values. */
export interface LayoutPhysicsConfig {
	linkDistance: number;
	chargeStrength: number;
	centerStrength: number;
	linkStrength: number;
	clusterCohesionStrength: number;
	/** Auto-tuned base node radius (drives collide spacing). */
	nodeSize: number;
	/** Visible node count — drives the density force profile. */
	visibleNodeCount: number;
}

/**
 * Distance below which charge repulsion stops growing (d3 `distanceMin`).
 *
 * Guards against the 1/d² singularity when nodes start stacked, but it also
 * sets how much short-range "breathing room" charge can create: with the old
 * value of 30 — half a link length — repulsion was capped across exactly the
 * range where neighbouring notes sit, so intra-cluster spacing collapsed onto
 * the collide floor (benchmark `breathe` ≈ 1.0 at every density ≥ 120 nodes).
 */
const CHARGE_DISTANCE_MIN = 12;

/** How much each doubling of an edge's weight increases its pull. */
const WEIGHT_PULL_SCALE = 0.35;
/** Ceiling on weight-based pull, so one dominant pair can't collapse together. */
const WEIGHT_PULL_MAX = 3;

/**
 * Coupling ratio (pair weight ÷ the graph's median topic-link weight) at which
 * a topic pair reaches its shortest rest length. Above this the distance stops
 * shrinking, so one dominant pair can't drag two topics on top of each other.
 */
const WEIGHT_DISTANCE_REL_SATURATION = 6;
/** Shortest a topic link may become, as a fraction of the normal link distance. */
const MIN_TOPIC_LINK_DISTANCE_FACTOR = 0.45;

/**
 * Minimum surface-to-surface gap a topic link's rest length preserves.
 *
 * Rest length is measured between *centers*, but coupling is about surfaces:
 * without this floor, a heavily-crossed pair of large topics gets a rest
 * length shorter than the sum of their radii — the spring literally asks the
 * discs to overlap, the pair sits collide-bound, and the collapsed view's
 * breathing room pins at 1.0 regardless of every other force.
 */
const TOPIC_SURFACE_GAP = 8;

/**
 * Extra pull applied to an edge based on its weight.
 *
 * Only collapsed topic-to-topic edges use this. Their weight is a *count* of how
 * many note-level links cross between two topics, so without it a pair joined by
 * 200 links sits exactly as far apart as one joined by 3 — the edge would encode
 * coupling without the layout ever showing it.
 *
 * Log-scaled and clamped: crossing counts are heavy-tailed, so a linear mapping
 * would let one dominant pair collapse onto each other while everything else
 * drifted apart. Note-level edges are left alone — their weights are cosine
 * scores and small link counts that already behave.
 */
function weightPull(link: LayoutLink): number {
	const source = link.source as LayoutNode;
	const target = link.target as LayoutNode;
	if (source?.kind !== "topic" && target?.kind !== "topic") return 1;

	const weight = Math.max(1, link.weight);
	return Math.min(WEIGHT_PULL_MAX, 1 + Math.log2(weight) * WEIGHT_PULL_SCALE);
}

/**
 * Rest length for a link, shortened for heavily-crossed topic pairs.
 *
 * Strength alone cannot express coupling: in d3-force every link is a spring
 * with a rest length and a stiffness, and stiffness only changes how *fast* a
 * pair converges — not where it settles. With one fixed distance, two topics
 * joined by 200 links come to rest exactly as far apart as two joined by 3.
 * Shortening the spring is what actually pulls coupled topics together.
 *
 * The shortening is *relative* to the graph's own median coupling, not an
 * absolute crossing count. Absolute counts scale with vault size: on a small
 * collapsed view nearly every pair blew past a fixed saturation, so all
 * springs shrank in unison and the whole ring compressed — uniform shrinkage
 * conveys no coupling structure at all. Measured against the median, the
 * typical pair keeps a moderate length and only genuinely-above-average
 * coupling pulls tighter, at every vault size.
 *
 * The median is computed lazily on first call, because the endpoints are only
 * resolved to node objects (with their `kind`) once the link force
 * initializes — before that, callers may hold string ids.
 */
function makeWeightedLinkDistance(
	effectiveLinkDistance: number,
	nodeSize: number,
	links: readonly LayoutLink[],
): (link: LayoutLink) => number {
	const isTopicLink = (link: LayoutLink) =>
		(link.source as LayoutNode)?.kind === "topic" || (link.target as LayoutNode)?.kind === "topic";

	let medianTopicWeight: number | null = null;
	const computeMedianTopicWeight = () => {
		const weights = links
			.filter(isTopicLink)
			.map((link) => Math.max(1, link.weight))
			.sort((a, b) => a - b);
		return weights.length > 0 ? weights[Math.floor(weights.length / 2)] : 1;
	};

	return (link) => {
		if (!isTopicLink(link)) return effectiveLinkDistance;

		if (medianTopicWeight === null) medianTopicWeight = computeMedianTopicWeight();
		// Log curve over the coupling *ratio*: the median pair sits partway in,
		// pairs several times the median reach full shortening.
		const relative = Math.max(1, link.weight) / medianTopicWeight;
		const t = Math.min(1, Math.log2(1 + relative) / Math.log2(1 + WEIGHT_DISTANCE_REL_SATURATION));
		const desired = effectiveLinkDistance * (1 - t * (1 - MIN_TOPIC_LINK_DISTANCE_FACTOR));
		// Never ask two discs to interpenetrate — floor at touching + a gap.
		const source = link.source as LayoutNode;
		const target = link.target as LayoutNode;
		const surfaceFloor = nodeDrawRadius(source, nodeSize) + nodeDrawRadius(target, nodeSize) + TOPIC_SURFACE_GAP;
		return Math.max(desired, surfaceFloor);
	};
}

function computeClusterCentroids(nodes: LayoutNode[]): Map<number, { x: number; y: number; count: number }> {
	const sums = new Map<number, { sx: number; sy: number; count: number }>();
	for (const n of nodes) {
		if (n.cluster == null) continue;
		const c = n.cluster;
		const entry = sums.get(c) ?? { sx: 0, sy: 0, count: 0 };
		entry.sx += n.x ?? 0;
		entry.sy += n.y ?? 0;
		entry.count += 1;
		sums.set(c, entry);
	}
	const centroids = new Map<number, { x: number; y: number; count: number }>();
	for (const [c, { sx, sy, count }] of sums) {
		centroids.set(c, { x: sx / count, y: sy / count, count });
	}
	return centroids;
}

/** Cluster size at which the cohesion pull is undamped. */
const COHESION_REFERENCE_MEMBERS = 40;
/**
 * Damping floor, so huge clusters never lose coherence entirely.
 *
 * Set by the layout benchmark: at 0.4 the biggest clusters swelled until
 * neighbouring topics interpenetrated (`gap` < 1.0 on the 8k scenario). This
 * keeps most of the breathing room the damping buys while holding topics
 * visually separate.
 */
const COHESION_MEMBER_DAMP_FLOOR = 0.55;

/**
 * Per-cluster damping of the cohesion pull by member count.
 *
 * The pull is proportional to a node's distance from its cluster centroid, and
 * that distance grows ~√members — so at one shared strength, a 900-member
 * cluster compresses its rim about five times harder than a 40-member one.
 * That was the benchmark's stuck `breathe` signature: the crushed scenarios
 * (immersed, large, huge) were exactly the ones with the biggest clusters, at
 * every graph size. √-damping cancels the geometric growth, so cohesion holds
 * clusters together without squeezing bigger ones harder.
 */
function cohesionMemberDamp(memberCount: number): number {
	if (memberCount <= COHESION_REFERENCE_MEMBERS) return 1;
	return Math.max(COHESION_MEMBER_DAMP_FLOOR, Math.sqrt(COHESION_REFERENCE_MEMBERS / memberCount));
}

/**
 * Custom d3-force that gently pulls each node toward its cluster's 2D centroid.
 * The centroid is recomputed every tick so it tracks the moving average.
 */
export function clusterCohesionForce(nodes: LayoutNode[], strength: number) {
	let _strength = strength;

	function force(alpha: number) {
		// Recompute centroids each tick so they follow the nodes
		const centroids = computeClusterCentroids(nodes);

		for (const node of nodes) {
			// Skip pinned nodes
			if (node.fx != null && node.fy != null) continue;

			// Unclustered nodes feel no cohesion. The previous `?? 0` fallback
			// silently treated them as members of community 0 — and ids are
			// size-sorted, so every unsorted note was dragged toward the *largest*
			// topic, piling up as a crescent on its rim instead of settling where
			// charge and centering balance.
			if (node.cluster == null) continue;
			const centroid = centroids.get(node.cluster);
			if (!centroid) continue;

			const damp = cohesionMemberDamp(centroid.count);
			const dx = centroid.x - (node.x ?? 0);
			const dy = centroid.y - (node.y ?? 0);
			node.vx = (node.vx ?? 0) + dx * _strength * damp * alpha;
			node.vy = (node.vy ?? 0) + dy * _strength * damp * alpha;
		}
	}

	force.strength = (s?: number) => {
		if (s === undefined) return _strength;
		_strength = s;
		return force;
	};

	// d3 force interface: initialize is a no-op since we track nodes directly
	force.initialize = () => {};

	return force;
}

/**
 * (Re)install every layout force on the simulation from raw config.
 *
 * Idempotent — forces are recreated wholesale, so this serves both initial
 * setup and hot-applying a changed parameter. Recreating rather than mutating
 * keeps one code path: d3's per-force initialize is cheap (link bias/count,
 * collide radii), and it re-reads anything derived from the nodes.
 */
export function applyLayoutForces<N extends LayoutNode, L extends LayoutLink<N>>(
	// `Simulation<N, undefined>` matches what `forceSimulation<N>()` returns —
	// the link datum only matters on the link force itself, registered below.
	simulation: Simulation<N, undefined>,
	nodes: N[],
	links: L[],
	config: LayoutPhysicsConfig,
): void {
	const profile = densityForceProfile(config.visibleNodeCount);
	const effectiveLinkDistance = config.linkDistance * profile.spacing;
	const effectiveCharge = config.chargeStrength * profile.charge;
	const effectiveCenter = config.centerStrength * profile.center;
	const effectiveCohesion = config.clusterCohesionStrength * profile.cohesion;

	// The base d3 link strength (1 / max degree of the endpoints) is kept as a
	// factor so the user's linkStrength acts as a multiplier, matching how
	// Obsidian's native graph behaves.
	const linkForce = forceLink<N, L>(links)
		.id((d) => d.id)
		.distance(makeWeightedLinkDistance(effectiveLinkDistance, config.nodeSize, links));
	const defaultLinkStrengthFn = linkForce.strength();
	linkForce.strength((l, i, all) => config.linkStrength * defaultLinkStrengthFn(l, i, all) * weightPull(l));

	// Clustered nodes take the density-profiled centering; satellites take
	// exactly twice it. Centering is the sole inward force an unlinked node
	// feels, so at the same strength it settles well outside the linked
	// structure — the doubling stands in for the links it doesn't have. A
	// *ratio* (rather than an absolute boost or floor, both tried) is what
	// behaves at every density: an absolute boost out-pulled deeply-relaxed
	// sparse graphs ~6× and dragged satellites inside the topic ring, while a
	// floor collapsed to no compensation at all wherever the profile is
	// neutral, sending them far out again.
	const satelliteCenter = effectiveCenter * 2;
	const centerStrengthOf = (node: N) => (node.cluster == null ? satelliteCenter : effectiveCenter);

	simulation
		.force("link", linkForce)
		.force("charge", forceManyBody().strength(effectiveCharge).distanceMin(CHARGE_DISTANCE_MIN))
		// Obsidian uses forceX + forceY for centering (spring toward origin),
		// NOT forceCenter (which shifts the centroid). This is the key difference.
		.force("centerX", forceX<N>(0).strength(centerStrengthOf))
		.force("centerY", forceY<N>(0).strength(centerStrengthOf))
		.force("cluster", clusterCohesionForce(nodes, effectiveCohesion))
		.force(
			"collide",
			forceCollide<N>().radius((d) => nodeDrawRadius(d, config.nodeSize) + 2),
		);
}

/**
 * Build a simulation with the full production force set, stopped.
 *
 * The canvas manages its own alpha/decay/tick lifecycle; headless callers
 * (the layout benchmark) tick it manually.
 */
export function createLayoutSimulation<N extends LayoutNode, L extends LayoutLink<N>>(
	nodes: N[],
	links: L[],
	config: LayoutPhysicsConfig,
): Simulation<N, undefined> {
	const simulation = forceSimulation<N>(nodes).stop();
	applyLayoutForces(simulation, nodes, links, config);
	return simulation;
}
