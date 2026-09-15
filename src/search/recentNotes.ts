/**
 * Recent-note retrieval helpers.
 *
 * Extracted from the agent search-tool so the logic is reusable by
 * SearchModal and any other consumer without importing the agent layer.
 */

import { type App, TFile, getAllTags } from "obsidian";
import { compileFilter, matchesSearchFilter } from "./searchFilters";
import { getData } from "../stores/dataStore.svelte";
import { isAgentFilePath } from "../utils/fileFiltering";
import { RECENT_NOTE_WINDOW_MS } from "../types/plugin";
import type { SearchFilter, SearchResult } from "../vectorstore/types";

/**
 * Boost range is unchanged from the previous rank-based scheme on purpose: the
 * downstream ranking in `finalSearchRanking` is tuned against these magnitudes
 * (and divides by MAX_RECENT_BOOST to recover a 0-1 strength), so only the
 * mapping from note to boost changes here, not the scale it produces.
 */
export const MAX_RECENT_BOOST = 4.5;
const MIN_RECENT_BOOST = 0.5;
const RECENT_SCORE_WEIGHT = 0.6;

/**
 * Fraction of the window over which a note holds full strength. Re-opening a
 * note is a strong signal for the rest of the working day; the decay should
 * describe "this has gone cold", not punish a note for being three hours old.
 */
const RECENT_FULL_STRENGTH_FRACTION = 1 / 7;

export interface RecentBoostInfo {
	boost: number;
	recentRank: number;
}

function getRecentStrength(recentBoost: number): number {
	return recentBoost / MAX_RECENT_BOOST;
}

export function getRecentRerankScore(baseScore: number, recentBoost: number): number {
	const recentStrength = recentBoost > 0 ? getRecentStrength(recentBoost) : 0;
	return baseScore * (1 + recentStrength * RECENT_SCORE_WEIGHT);
}

function getCachedTags(cache: Parameters<typeof getAllTags>[0] | null | undefined): string[] {
	if (!cache) return [];
	return Array.from(new Set((getAllTags(cache) ?? []).filter((tag) => tag.length > 0)));
}

/**
 * Map a note's age to its boost. Returns 0 outside the window, which is the
 * signal callers use to drop the note from the recent set entirely.
 *
 * Within the window the curve is flat at full strength for the first day, then
 * decays linearly to the floor at the far edge, so the boost degrades smoothly
 * instead of falling off a cliff the moment a note turns seven days old.
 */
export function getRecentNoteBoost(ageMs: number): number {
	if (!Number.isFinite(ageMs) || ageMs >= RECENT_NOTE_WINDOW_MS) return 0;
	// A clock change (or a fixture stamped in the future) must not read as stale.
	const age = Math.max(0, ageMs);

	const fullStrengthMs = RECENT_NOTE_WINDOW_MS * RECENT_FULL_STRENGTH_FRACTION;
	if (age <= fullStrengthMs) return MAX_RECENT_BOOST;

	const decayProgress = (age - fullStrengthMs) / (RECENT_NOTE_WINDOW_MS - fullStrengthMs);
	return MAX_RECENT_BOOST - decayProgress * (MAX_RECENT_BOOST - MIN_RECENT_BOOST);
}

function getRecentlyOpenedNotes(app: App, filter?: SearchFilter): SearchResult[] {
	const pluginData = getData();
	const vault = app.vault;
	if (typeof vault?.getAbstractFileByPath !== "function") return [];

	const compiled = filter ? compileFilter(filter) : undefined;
	const results: SearchResult[] = [];
	const now = Date.now();
	// `recentNotes` is sorted most-recent-first, so `index` still describes the
	// note's position in the history — it is reported for debugging, but no
	// longer determines the boost.
	for (const [index, entry] of pluginData.recentNotes.entries()) {
		const recentBoost = getRecentNoteBoost(now - entry.lastOpenedAt);
		// Outside the window: not recent, regardless of how few notes precede it.
		if (recentBoost <= 0) continue;

		const file = vault.getAbstractFileByPath(entry.path);
		if (!(file instanceof TFile)) continue;
		// `file-open` records every file, including agent machinery (a user opening a
		// skill or prompt note from the editor). Those are excluded from indexing and
		// search, so recency must not resurface them either. Filtered at read time
		// rather than record time so already-persisted entries are covered too.
		if (isAgentFilePath(file.path)) continue;

		const cache = app.metadataCache.getFileCache(file);
		const docTags = getCachedTags(cache);
		if (!matchesSearchFilter(file.path, docTags, compiled ?? filter)) continue;

		results.push({
			path: file.path,
			name: file.basename,
			frontmatter: cache?.frontmatter,
			tags: docTags,
			matchBadges: ["recent"],
			score: recentBoost,
			rankingDebug: {
				recentRank: index + 1,
				recentBoost,
				baseScore: recentBoost,
			},
		});
	}
	return results;
}

function mergeRecentNotes(...collections: SearchResult[][]): SearchResult[] {
	const merged = new Map<string, SearchResult>();
	for (const collection of collections) {
		for (const result of collection) {
			const existing = merged.get(result.path);
			if (!existing) {
				merged.set(result.path, result);
				continue;
			}
			merged.set(result.path, {
				...existing,
				frontmatter: existing.frontmatter ?? result.frontmatter,
				tags: existing.tags ?? result.tags,
				score: Math.max(existing.score ?? 0, result.score ?? 0),
			});
		}
	}
	return Array.from(merged.values()).sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
}

/** Get deduplicated recent notes from the user's recently opened history, optionally filtered. */
export function getRecentNotes(app: App, filter?: SearchFilter): SearchResult[] {
	return mergeRecentNotes(getRecentlyOpenedNotes(app, filter));
}

/** Build a path→boost map from recent results. */
export function buildRecentBoostMap(results: SearchResult[]): Map<string, RecentBoostInfo> {
	const map = new Map<string, RecentBoostInfo>();
	for (const [index, result] of results.entries()) {
		const nextBoost = result.score ?? 0;
		const existing = map.get(result.path);
		if (!existing || nextBoost > existing.boost) {
			map.set(result.path, { boost: nextBoost, recentRank: index + 1 });
		}
	}
	return map;
}
