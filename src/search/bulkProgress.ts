/**
 * Progress wording shared by the two bulk indexers' notices — the lexical build
 * (`LexicalSearchService`) and the embedding build (`VectorStoreService`) — and
 * the embedding row in settings, so the surfaces read as one feature.
 */

import { t } from "../i18n";

/** A bulk run's extraction tail: see `IndexingProgress.extraction`. */
export interface ExtractionProgress {
	done: number;
	total: number;
	/** Whether the run has reached the tail yet. */
	active: boolean;
}

export interface BulkProgressInput {
	/** Files done (indexed) so far, over the whole run. */
	processed: number;
	total: number;
	skipped?: number;
	etaMs?: number | null;
	extraction?: ExtractionProgress | null;
	/** The file being read, shown while in the extraction tail. */
	currentFile?: string | null;
}

export interface BulkProgressText {
	/** One-line status, e.g. "980/1000 · then 20 PDFs (~1m left)". */
	status: string;
	/** Bar fill, 0–100 — of the current phase, so the extraction tail does not sit at 99 %. */
	percentage: number;
}

/**
 * Format an estimated-time-remaining duration (in ms) as a short human string,
 * e.g. "45s", "3m", "1h 12m". Rounds up so the estimate never reads as "0s"
 * while work is still in flight.
 */
export function formatEta(ms: number): string {
	const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const totalMinutes = Math.ceil(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m`;

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function pdfs(count: number): string {
	return t("plugin.bulk_progress.pdfs", { count });
}

function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

/**
 * Describe a bulk run's progress in two phases. Counted in files, a run whose
 * PDFs come last (they are) reached ~99 % on its notes and then sat there while
 * the PDFs — each costing what hundreds of notes do — were extracted. So:
 *
 * - notes phase: the overall count, plus "then N PDFs" so the wait is expected;
 * - extraction phase: "PDFs 3/20 · report.pdf", with the bar showing that
 *   phase's own progress.
 */
export function describeBulkProgress(input: BulkProgressInput): BulkProgressText {
	const { processed, total, skipped = 0, etaMs = null, extraction, currentFile } = input;
	const skippedText = skipped > 0 ? ` ${t("plugin.bulk_progress.skipped", { count: skipped })}` : "";
	const etaText = etaMs !== null ? ` ${t("plugin.bulk_progress.eta", { eta: formatEta(etaMs) })}` : "";

	if (extraction?.active && extraction.total > 0) {
		const fileText = currentFile ? ` · ${basename(currentFile)}` : "";
		return {
			status: `${t("plugin.bulk_progress.pdfs_progress", { done: extraction.done, total: extraction.total })}${fileText}${skippedText}${etaText}`,
			percentage: Math.round((extraction.done / extraction.total) * 100),
		};
	}

	const pending =
		extraction && extraction.total > 0
			? ` · ${t("plugin.bulk_progress.then", { pdfs: pdfs(extraction.total) })}`
			: "";
	return {
		status: `${processed}/${total}${pending}${skippedText}${etaText}`,
		percentage: total > 0 ? Math.round((processed / total) * 100) : 100,
	};
}
