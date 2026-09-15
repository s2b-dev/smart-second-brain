/**
 * Pacing and crash-backoff shared by the two bulk indexers — the lexical build
 * (`LexicalSearchService.bulkIndexFiles`) and the embedding build
 * (`VectorStoreService.embedFilesInBatches`).
 *
 * Everything here encodes behaviour measured on a phone during the #430 / #432
 * investigations, not preferences. The comments on each value say what was
 * observed; change the value only with a new measurement.
 */

import { type App, Platform, type TFile } from "obsidian";
import { isBinaryTextFile } from "../utils/fileFiltering";
import { Logger } from "../utils/logging";

/**
 * How many notes a bulk run indexes between durable checkpoints.
 *
 * Each checkpoint persists the whole in-memory index (the lexical index is
 * serialised in full; the HNSW graph's topology is rewritten in full), so the
 * interval trades save cost against how much progress a crash can lose. On
 * mobile the process can be killed by the OS mid-build; a checkpoint every few
 * hundred notes lets the next boot's validation resume roughly where this run
 * died instead of starting over.
 */
export const BULK_CHECKPOINT_INTERVAL = 250;

/**
 * Pause between bulk batches, and after each checkpoint.
 *
 * Tokenizing text files back-to-back allocates garbage faster than the mobile
 * WebView's GC reclaims it, so an unthrottled loop balloons the footprint until
 * the OS kills the process — measured as a reload every ~10 s on a large vault.
 * (PDF extraction used to throttle the loop by accident; ordering PDFs last
 * removed that brake.) Real pauses give the collector room to keep up. Desktop
 * has no memory ceiling and only yields the event loop.
 *
 * Read at call time (not module load) so the platform can be flipped in tests.
 */
export function bulkBatchPauseMs(): number {
	return Platform.isMobile ? 100 : 0;
}

/** Extra pause after a checkpoint's full-index serialization, for the same reason. */
export function bulkCheckpointPauseMs(): number {
	return Platform.isMobile ? 250 : 0;
}

/**
 * How long after layout-ready a bulk run may start on mobile, before backoff.
 *
 * Boot is the highest-pressure window — the vault, the metadata cache, and
 * every plugin allocate at once, and the OS kill ceiling is effectively lower
 * because of it. Starting an indexer into that spike is what turned one kill
 * into a kill loop: each reload restarted indexing at second zero and died
 * again. Waiting lets the boot spike drain first; steady state idles at ~2% CPU.
 */
export const MOBILE_BULK_BASE_DELAY_MS = 15_000;

/** Upper bound for the crash-backoff delay. */
export const MOBILE_BULK_MAX_DELAY_MS = 300_000;

/** Yield the event loop for `ms` (a real pause on mobile, a bare yield on desktop). */
export function bulkPause(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Start delay for a scheduled bulk run, given how many previous attempts died
 * mid-run: the mobile base delay doubled per crashed attempt, capped. Desktop
 * never waits.
 */
export function bulkStartDelayMs(crashedAttempts: number): number {
	if (!Platform.isMobile) return 0;
	return Math.min(MOBILE_BULK_BASE_DELAY_MS * 2 ** Math.max(0, crashedAttempts), MOBILE_BULK_MAX_DELAY_MS);
}

/**
 * Counts bulk runs that did not complete, so the next scheduled run can wait
 * longer before starting.
 *
 * How boot pressure varies is unknowable from inside the WebView (there is no
 * JS memory-pressure API), so no fixed delay can be right on every device: 15 s
 * was measured to land inside the boot spike on a phone already under system
 * pressure, where the OS killed the process seconds into the run. Instead the
 * delay adapts to observed deaths: every bulk attempt writes this marker and a
 * completed run clears it, so a marker still present at boot means the last
 * attempt died mid-run — and the next one waits twice as long. Obsidian's
 * vault-scoped local storage (`App.loadLocalStorage` / `saveLocalStorage`), not
 * plugin data: it survives the kill (the plugin's data debounce may not) and
 * stays out of sync.
 *
 * One marker per indexer per vault (`s2b-<indexer>-bulk-attempts`; Obsidian
 * scopes the key to the vault): the two indexers die independently and back
 * off independently.
 */
export class BulkAttemptMarker {
	private readonly key: string;
	private readonly storage: VaultLocalStorage;

	constructor(indexer: string, storage: VaultLocalStorage) {
		this.key = `s2b-${indexer}-bulk-attempts`;
		this.storage = storage;
	}

	/** Number of consecutive attempts that died mid-run (0 when the last run completed). */
	read(): number {
		const raw = Number(this.storage.loadLocalStorage(this.key));
		return Number.isFinite(raw) && raw > 0 ? raw : 0;
	}

	/** Record that a run is starting. Call before the first read of the run. */
	markAttempt(): void {
		this.storage.saveLocalStorage(this.key, String(this.read() + 1));
	}

	/** Record that the run survived (completed or was cancelled by the user). */
	clear(): void {
		this.storage.saveLocalStorage(this.key, null);
	}
}

/** The slice of {@link App} the marker persists through (vault-scoped local storage). */
export type VaultLocalStorage = Pick<App, "loadLocalStorage" | "saveLocalStorage">;

/**
 * Scheduled bulk runs, across both indexers, run one after another on this
 * chain, in the order they were scheduled. The lexical and embedding builds
 * used to start on the same tick and each read every note — and extracted
 * every PDF, the expensive read — on its own; on a phone that also meant two
 * bulk allocators competing inside the boot spike. Sequenced, each file is
 * read once per run, and the search index (fast, no provider round trips) is
 * complete before the embedding run starts. A run that throws is logged and
 * does not block the ones behind it.
 */
let bulkRunChain: Promise<void> = Promise.resolve();

/** Test hook: drop whatever is queued so one test's run cannot delay the next. */
export function resetBulkRunQueue(): void {
	bulkRunChain = Promise.resolve();
}

/**
 * Run `work` after the platform-appropriate bulk start delay — and after any
 * bulk run scheduled before it has finished — logging when the delay was
 * lengthened by earlier crashed attempts. `label` names the indexer in that
 * log line.
 *
 * The run is queued at once and waits out its own delay *inside* the chain,
 * so scheduling order is run order even when the indexers' crash backoffs
 * differ (each has its own marker): a lexical run with a longer backoff still
 * goes before the embedding run scheduled after it.
 */
export function scheduleBulkRun(label: string, marker: BulkAttemptMarker, work: () => Promise<void>): void {
	const attempts = marker.read();
	const delay = bulkStartDelayMs(attempts);
	if (attempts > 0) {
		Logger.warn(
			`[${label}] Last bulk index attempt did not complete (${attempts} in a row) — delaying the next by ${Math.round(delay / 1000)}s`,
		);
	}
	const readyAt = Date.now() + delay;
	bulkRunChain = bulkRunChain
		.then(async () => {
			// Always through a timer, even for no delay: a run never starts inside
			// the tick that scheduled it (layout-ready, or a run's own completion).
			await bulkPause(Math.max(0, readyAt - Date.now()));
			await work();
		})
		.catch((error: unknown) => {
			Logger.error(`[${label}] Bulk run failed:`, error);
		});
}

/**
 * Bulk-indexing file order: cheap text files first, binary-extraction files
 * (PDFs) last. PDF text extraction is minutes of work on a large vault, and
 * putting it first held the whole searchable corpus hostage to it — this way
 * every note is searchable early even if the PDF tail never finishes.
 */
export function orderForBulkIndexing(files: TFile[]): TFile[] {
	return [...files].sort((a, b) => Number(isBinaryTextFile(a)) - Number(isBinaryTextFile(b)));
}
