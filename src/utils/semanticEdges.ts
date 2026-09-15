/**
 * Semantic Edge Scan
 *
 * The neighbour search behind the smart graph's inferred edges, kept free of
 * Obsidian and vault types so it can run inside the compute worker as well as
 * on the main thread.
 *
 * Inputs are a flat vector batch plus a per-vector note index (large notes are
 * embedded as several chunks), which is what survives a structured-clone
 * transfer. Outputs are index pairs; callers map them back to paths.
 *
 * Two kernels share one output contract ({@link computeSemanticPairs}): an
 * exact O(n²) pairwise scan for small graphs, and an HNSW-accelerated
 * approximate search past {@link SEMANTIC_HNSW_MIN_CHUNKS} chunks, where the
 * quadratic scan stops being viable.
 */

import { HNSW } from "hnsw";
import { mulberry32 } from "./seededRandom";

/**
 * How many semantic neighbours each note may contribute. Kept deliberately low:
 * the union of every note's top-K is already denser than it looks, because an
 * edge survives if *either* endpoint ranks the other.
 */
export const DEFAULT_SEMANTIC_NEIGHBOR_COUNT = 5;

/**
 * Minimum cosine similarity for a semantic edge. Below roughly this value pairs
 * are mostly noise floor rather than genuine topical overlap, so a lower bound
 * matters more than K for keeping topics clean.
 */
export const DEFAULT_SEMANTIC_THRESHOLD = 0.55;

/** A scored pair of note indices, ordered so `source < target`. */
export interface SemanticPair {
	source: number;
	target: number;
	score: number;
}

export interface SemanticScanOptions {
	neighborCount?: number;
	threshold?: number;
	/**
	 * Note-index pairs (encoded `${min}:${max}`) to skip — used to suppress pairs
	 * that already have an authored wiki link.
	 */
	excludePairs?: Set<string>;
}

/** Encode an unordered note-index pair for dedupe/exclusion lookups. */
export function pairKey(a: number, b: number): string {
	return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** The flat shape both scan kernels consume: `count` vectors of `dim` floats, back to back. */
export interface ChunkBatch {
	data: Float32Array;
	count: number;
	dim: number;
	/** `chunkOwners[i]` is the note index owning chunk `i`. */
	chunkOwners: Int32Array;
}

/**
 * Accumulates chunk vectors straight into the flat batch, growing the buffer
 * geometrically, so a whole-set read never has to exist alongside the batch —
 * the caller streams rows in and only the batch survives.
 *
 * Chunks whose dimensionality doesn't match the first vector are dropped: a
 * stale index entry from a previous embedding model would otherwise corrupt the
 * flat batch, whose stride assumes a single dim.
 */
export class ChunkBatchBuilder {
	private data = new Float32Array(0);
	private owners: number[] = [];
	private count = 0;
	private dim = -1;

	add(noteIndex: number, vector: Float32Array): void {
		if (this.dim === -1) this.dim = vector.length;
		if (vector.length !== this.dim || this.dim === 0) return;

		const needed = (this.count + 1) * this.dim;
		if (needed > this.data.length) {
			const grown = new Float32Array(Math.max(needed, this.data.length * 2));
			grown.set(this.data);
			this.data = grown;
		}
		this.data.set(vector, this.count * this.dim);
		this.owners.push(noteIndex);
		this.count++;
	}

	/** The batch, trimmed to its exact size. The builder must not be reused afterwards. */
	finish(): ChunkBatch {
		const dim = this.dim === -1 ? 0 : this.dim;
		const data = this.data.length === this.count * dim ? this.data : this.data.slice(0, this.count * dim);
		this.data = new Float32Array(0);
		return { data, count: this.count, dim, chunkOwners: Int32Array.from(this.owners) };
	}
}

/**
 * Semantic pairs among `paths` from an in-memory set of chunk vectors — the
 * same computation the vector store runs in its worker over IndexedDB rows,
 * for callers (and tests) that already hold the vectors. Note indices in the
 * result are positions in `paths`; chunks of notes outside `paths` are ignored.
 */
export function semanticPairsFromDocuments(
	documents: Iterable<{ path: string; vector: Float32Array }>,
	paths: string[],
	options: SemanticScanOptions = {},
): Promise<SemanticPair[]> {
	const noteIndexByPath = new Map(paths.map((path, index) => [path, index]));
	const batch = new ChunkBatchBuilder();
	for (const document of documents) {
		const noteIndex = noteIndexByPath.get(document.path);
		if (noteIndex !== undefined) batch.add(noteIndex, document.vector);
	}
	const { data, count, dim, chunkOwners } = batch.finish();
	return computeSemanticPairs(data, count, dim, chunkOwners, paths.length, options);
}

/**
 * Pre-normalize every chunk vector so similarity is a plain dot product.
 *
 * The scan compares each pair of notes, so a vector's norm would otherwise be
 * recomputed once per comparison — O(n²) redundant work. Normalizing up front
 * makes it O(n).
 */
function normalizeChunks(data: Float32Array, count: number, dim: number): Float32Array {
	const normalized = new Float32Array(count * dim);
	for (let i = 0; i < count; i++) {
		const offset = i * dim;
		let norm = 0;
		for (let d = 0; d < dim; d++) {
			const value = data[offset + d];
			norm += value * value;
		}
		norm = Math.sqrt(norm);
		if (norm === 0) continue;
		for (let d = 0; d < dim; d++) {
			normalized[offset + d] = data[offset + d] / norm;
		}
	}
	return normalized;
}

/**
 * Best cosine similarity between any chunk of note `a` and any chunk of note `b`.
 *
 * Best-chunk (rather than a mean vector) keeps a note discoverable by any one of
 * its sections, so a note covering several topics still matches each of them.
 */
function bestChunkSimilarity(normalized: Float32Array, dim: number, aChunks: number[], bChunks: number[]): number {
	let best = Number.NEGATIVE_INFINITY;
	for (const ai of aChunks) {
		const aOffset = ai * dim;
		for (const bi of bChunks) {
			const bOffset = bi * dim;
			let dot = 0;
			for (let d = 0; d < dim; d++) {
				dot += normalized[aOffset + d] * normalized[bOffset + d];
			}
			if (dot > best) best = dot;
		}
	}
	return best;
}

/**
 * Scan all note pairs and return the top-K neighbours of each, deduped.
 *
 * `chunkOwners[i]` gives the note index owning chunk `i`; `noteCount` is the
 * number of distinct notes. Exact but O(chunks²) — use via
 * {@link computeSemanticPairs}, which switches to the HNSW kernel when the
 * batch is large enough that this scan would take seconds.
 */
export function scanSemanticPairs(
	data: Float32Array,
	chunkCount: number,
	dim: number,
	chunkOwners: Int32Array,
	noteCount: number,
	options: SemanticScanOptions = {},
): SemanticPair[] {
	const neighborCount = options.neighborCount ?? DEFAULT_SEMANTIC_NEIGHBOR_COUNT;
	const threshold = options.threshold ?? DEFAULT_SEMANTIC_THRESHOLD;
	const excludePairs = options.excludePairs;

	if (neighborCount <= 0 || noteCount < 2 || dim === 0 || chunkCount === 0) return [];

	// Invert chunk → note into note → chunks.
	const chunksByNote: number[][] = Array.from({ length: noteCount }, () => []);
	for (let i = 0; i < chunkCount; i++) {
		const owner = chunkOwners[i];
		if (owner >= 0 && owner < noteCount) chunksByNote[owner].push(i);
	}

	const normalized = normalizeChunks(data, chunkCount, dim);

	// Similarity is symmetric, so score each unordered pair once and let both
	// endpoints consider it for their own top-K list.
	const candidates: Array<Array<{ note: number; score: number }>> = Array.from({ length: noteCount }, () => []);
	for (let a = 0; a < noteCount; a++) {
		const aChunks = chunksByNote[a];
		if (aChunks.length === 0) continue;
		for (let b = a + 1; b < noteCount; b++) {
			const bChunks = chunksByNote[b];
			if (bChunks.length === 0) continue;
			const score = bestChunkSimilarity(normalized, dim, aChunks, bChunks);
			if (!Number.isFinite(score) || score < threshold) continue;
			candidates[a].push({ note: b, score });
			candidates[b].push({ note: a, score });
		}
	}

	return selectTopPairs(candidates, neighborCount, excludePairs);
}

/**
 * Union of every note's top-K candidate neighbours, deduped so an unordered
 * pair is emitted once.
 *
 * Shared by both kernels so their output semantics match exactly — including
 * the subtlety that a wiki-linked (excluded) pair still *occupies* one of a
 * note's K slots before being dropped at emission.
 */
function selectTopPairs(
	candidates: Array<Array<{ note: number; score: number }>>,
	neighborCount: number,
	excludePairs?: Set<string>,
): SemanticPair[] {
	const pairs: SemanticPair[] = [];
	const seen = new Set<string>();
	for (let note = 0; note < candidates.length; note++) {
		const list = candidates[note];
		if (list.length === 0) continue;
		// Ties break on note index so results are stable across runs.
		list.sort((left, right) => right.score - left.score || left.note - right.note);
		const limit = Math.min(neighborCount, list.length);
		for (let i = 0; i < limit; i++) {
			const { note: other, score } = list[i];
			const key = pairKey(note, other);
			if (seen.has(key) || excludePairs?.has(key)) continue;
			seen.add(key);
			pairs.push({
				source: Math.min(note, other),
				target: Math.max(note, other),
				score,
			});
		}
	}

	return pairs;
}

// ============================================================================
// HNSW-accelerated kernel
// ============================================================================

/**
 * Chunk count above which the exact scan hands over to the HNSW kernel.
 *
 * The exact scan's cost is chunks² · dim / 2 — measured around 1–2s at 2k
 * chunks with dim 1024, and growing quadratically from there. HNSW pays an
 * n·log n build instead, which loses below this size (the exact scan is
 * already sub-second and deterministic) and wins increasingly above it.
 */
const SEMANTIC_HNSW_MIN_CHUNKS = 2000;

/** Seed for the HNSW level-selection PRNG — fixed so rebuilds of the same vault produce the same edges. */
const HNSW_LEVEL_SEED = 42;

/**
 * Approximate top-K neighbour search over an in-memory HNSW index.
 *
 * Builds a transient index over exactly the chunks in this batch (never the
 * live vault index — that contains notes outside the current graph, whose hits
 * would crowd out on-screen neighbours) and queries it once per chunk. A note
 * pair's score is the best hit between any of their chunks, which converges on
 * the exact scan's best-chunk semantics because every chunk of both notes gets
 * to propose the pair.
 *
 * Two determinism/perf patches are applied to the `hnsw` library instance:
 * - level selection is re-seeded (the library uses `Math.random`, which would
 *   make graph edges — and therefore Leiden topics — drift between rebuilds);
 * - the similarity function is replaced with a plain dot product, since chunks
 *   are pre-normalized and the library's cosine re-derives both norms on every
 *   comparison (3× the multiplies for the same result).
 *
 * Exported so tests can exercise this kernel directly on small inputs; callers
 * should go through {@link computeSemanticPairs}.
 */
export async function approximateSemanticPairs(
	data: Float32Array,
	chunkCount: number,
	dim: number,
	chunkOwners: Int32Array,
	noteCount: number,
	options: SemanticScanOptions = {},
): Promise<SemanticPair[]> {
	const neighborCount = options.neighborCount ?? DEFAULT_SEMANTIC_NEIGHBOR_COUNT;
	const threshold = options.threshold ?? DEFAULT_SEMANTIC_THRESHOLD;
	if (neighborCount <= 0 || noteCount < 2 || dim === 0 || chunkCount === 0) return [];

	const normalized = normalizeChunks(data, chunkCount, dim);
	const chunkVector = (chunk: number) => normalized.subarray(chunk * dim, (chunk + 1) * dim);

	const ownChunkCounts = new Int32Array(noteCount);
	for (let i = 0; i < chunkCount; i++) {
		const owner = chunkOwners[i];
		if (owner >= 0 && owner < noteCount) ownChunkCounts[owner]++;
	}

	const index = new HNSW(16, 200, dim, "cosine");
	const internals = index as unknown as {
		probs: number[];
		selectLevel: () => number;
		similarityFunction: (a: number[] | Float32Array, b: number[] | Float32Array) => number;
	};
	const rand = mulberry32(HNSW_LEVEL_SEED);
	// Same walk as the library's selectLevel, with a seeded source.
	internals.selectLevel = () => {
		let r = rand();
		for (let i = 0; i < internals.probs.length; i++) {
			const p = internals.probs[i];
			if (r < p) return i;
			r -= p;
		}
		return internals.probs.length - 1;
	};
	internals.similarityFunction = (a, b) => {
		let dot = 0;
		for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
		return dot;
	};

	const points: Array<{ id: number; vector: Float32Array }> = new Array(chunkCount);
	for (let i = 0; i < chunkCount; i++) points[i] = { id: i, vector: chunkVector(i) };
	await index.buildIndex(points);

	// Best score seen for each unordered note pair, across every chunk query.
	const pairBest = new Map<string, { a: number; b: number; score: number }>();
	for (let chunk = 0; chunk < chunkCount; chunk++) {
		const owner = chunkOwners[chunk];
		if (owner < 0 || owner >= noteCount) continue;
		// Over-fetch: hits include this note's own chunks and duplicate chunks of
		// the same neighbour, none of which count toward its K distinct notes.
		const k = Math.min(chunkCount, neighborCount * 3 + ownChunkCounts[owner]);
		const hits = index.searchKNN(chunkVector(chunk), k, { efSearch: Math.max(64, k * 3) });
		for (const hit of hits) {
			const other = chunkOwners[hit.id];
			if (other === owner || other < 0 || other >= noteCount) continue;
			if (!Number.isFinite(hit.score) || hit.score < threshold) continue;
			const key = pairKey(owner, other);
			const existing = pairBest.get(key);
			if (!existing || hit.score > existing.score) {
				pairBest.set(key, { a: Math.min(owner, other), b: Math.max(owner, other), score: hit.score });
			}
		}
	}

	const candidates: Array<Array<{ note: number; score: number }>> = Array.from({ length: noteCount }, () => []);
	for (const { a, b, score } of pairBest.values()) {
		candidates[a].push({ note: b, score });
		candidates[b].push({ note: a, score });
	}

	return selectTopPairs(candidates, neighborCount, options.excludePairs);
}

/**
 * Compute semantic neighbour pairs, choosing the kernel by batch size.
 *
 * Small batches take the exact O(chunks²) scan — deterministic, exact, and
 * already sub-second at this size. Larger batches take the approximate HNSW
 * path, whose n·log n build is what lets vaults far past the old quadratic
 * wall get semantic edges at all.
 */
export async function computeSemanticPairs(
	data: Float32Array,
	chunkCount: number,
	dim: number,
	chunkOwners: Int32Array,
	noteCount: number,
	options: SemanticScanOptions = {},
): Promise<SemanticPair[]> {
	if (chunkCount < SEMANTIC_HNSW_MIN_CHUNKS) {
		return scanSemanticPairs(data, chunkCount, dim, chunkOwners, noteCount, options);
	}
	return approximateSemanticPairs(data, chunkCount, dim, chunkOwners, noteCount, options);
}
