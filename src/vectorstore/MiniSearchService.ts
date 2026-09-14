/**
 * MiniSearch Service
 *
 * Provides BM25 based lexical search using MiniSearch library.
 * Indexes document titles and content for fast full-text search.
 * Persists index to IndexedDB for instant startup.
 */

import MiniSearch, { type SearchResult as MiniSearchResult } from "minisearch";
import {
	type LexicalCandidateEvidence,
	type LexicalRankingFeatures,
	type LexicalScoringConfig,
	scoreLexicalCandidate,
} from "../search/lexicalScoring";
import { type QueryPlan, createQueryPlan } from "../search/queryPlan";
import { type TitleBoostScale, getTitleMatchKind, matchesLeadingTitlePrefix } from "../search/searchRanking";
import { isNumericSearchTerm, normalizeSearchText, tokenizeSearchText } from "../search/searchTermUtils";
import { getTermBoost, isStopword } from "../search/stopwords";
import { LogLvl, Logger, getLogLevel } from "../utils/logging";
import { toError } from "../utils/toError";

import { getDbName } from "./types";

/**
 * Lexical (BM25) title boost scale.
 * Uses absolute score values tuned for BM25 result magnitudes.
 */
const LEXICAL_TITLE_SCALE: TitleBoostScale = {
	exact: 300,
	leadingPrefixNumeric: 4000,
	leadingPrefix: 140,
	startsWith: 70,
	contains: 25,
	numericAllTerms: 1200,
	numericPartialTerms: 600,
	allTerms: 24,
	partialTermFactor: 12,
};

/** Lexical alias boost max (absolute). */
const LEXICAL_ALIAS_MAX = 220;
/** Lexical tag boost max (absolute). */
const LEXICAL_TAG_MAX = 55;
/** Lexical path-segment boost max (absolute). */
const LEXICAL_PATH_MAX = 35;

const DB_NAME_PREFIX = "s2b-minisearch";
const DB_VERSION = 5;
const STORE_NAME = "index";

/**
 * How long to wait on a blocked `indexedDB.open` before failing with a real error.
 * A blocked open fires neither `success` nor `error`, so without a bound it hangs
 * forever. Mirrors the same constant in HNSWVectorStore.
 */
const OPEN_BLOCKED_TIMEOUT_MS = 10_000;
const INDEX_KEY = "main";
/** Bump whenever the indexed file set or field schema changes to force a full reindex. */
const STORAGE_SCHEMA_VERSION = 10;

export interface LexicalSearchResult {
	path: string;
	name: string;
	aliases?: string[];
	tags?: string[];
	score: number;
	features?: LexicalRankingFeatures;
}

export interface AutocompleteCacheSnapshot {
	tags: string[];
	tagChildCount: Map<string, number>;
	folders: string[];
}

interface IndexedDocument {
	id: string;
	path: string;
	title: string;
	aliases: string;
	tags: string;
	pathSegments: string;
	content: string;
}

interface RankedLexicalResult {
	result: MiniSearchResult;
	matchTier: number;
	adjustedScore: number;
	features: LexicalRankingFeatures;
}

interface CandidateEvidence extends LexicalCandidateEvidence {
	path: string;
}

const IDENTITY_SEARCH_FIELDS = ["title", "aliases", "tags", "pathSegments"] as const;
const CONTENT_SEARCH_FIELDS = ["content"] as const;

const NUMERIC_SUFFIX_BASE_TITLE_PENALTY = 24;
const LEXICAL_SCORING_CONFIG: LexicalScoringConfig = {
	titleScale: LEXICAL_TITLE_SCALE,
	aliasMax: LEXICAL_ALIAS_MAX,
	tagMax: LEXICAL_TAG_MAX,
	pathMax: LEXICAL_PATH_MAX,
	numericSuffixBasePenalty: NUMERIC_SUFFIX_BASE_TITLE_PENALTY,
};

function shouldIdentityPrefixMatch(term: string): boolean {
	return term.length >= 1;
}

/**
 * Content-field prefix matching is for genuine term prefixes, so it is gated on the
 * term carrying meaning. The length check alone admitted stopwords at exactly the
 * threshold: German `ich` is 3 characters, so it prefix-matched `ichtzone` and (with
 * `fuzzy: 0.2`) reached `sich` and `erheblich`, letting a function word match half a
 * German note. Stopwords still match exactly — they are just not expanded.
 */
function shouldContentPrefixMatch(term: string): boolean {
	return term.length >= 3 && !isStopword(term);
}

/**
 * Smallest share of a matched word that the query term must cover for a content
 * prefix/fuzzy expansion to count.
 *
 * A shared prefix is not a shared meaning. German `essen` ("food") covers only 45% of
 * `essentially`, and matching it made `griechisches essen` rank a hydrothermal-vent
 * note first while the vault's only Greek-food note sat at #4 — the other query term,
 * `griechisches`, has no lexical match at all, so the noise term decided the ranking
 * outright. All three of that query's lexical hits were `essen` → `essential*`.
 *
 * Measured against real pairs, 0.6 separates the two populations: it rejects
 * `essen`/`essentially` (0.45) and `ich`/`ichtzone` (0.38) while keeping
 * `mediterr`/`mediterranean` (0.62), `sourdo`/`sourdough` (0.67), `recipe`/`recipes`
 * (0.86) and `spare`/`sparen` (0.83). The one deliberate loss is `photo`/
 * `photovoltaic` (0.42), which is genuinely ambiguous — as a content-field match it
 * reads more like coincidence than intent.
 */
const MIN_CONTENT_PREFIX_COVERAGE = 0.6;

/**
 * Levenshtein distance, capped: returns `maxDistance + 1` as soon as every remaining
 * possibility exceeds the cap, so two long unrelated words (a 10- and an 11-letter
 * word with almost no letters in common) bail out in O(n) rather than the full O(nm)
 * table. `maxDistance` here is always small (see {@link isPlausibleExpansionSource}),
 * so the bound matters for content fields with many candidate words.
 */
function boundedLevenshtein(a: string, b: string, maxDistance: number): number {
	if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

	let previousRow = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const currentRow = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const value = Math.min(
				(previousRow[j] ?? Number.POSITIVE_INFINITY) + 1,
				currentRow[j - 1] + 1,
				(previousRow[j - 1] ?? Number.POSITIVE_INFINITY) + cost,
			);
			currentRow.push(value);
			rowMin = Math.min(rowMin, value);
		}
		// Every cell in this row already exceeds the cap, so it can only grow from here.
		if (rowMin > maxDistance) return maxDistance + 1;
		previousRow = currentRow;
	}
	return previousRow[b.length] ?? maxDistance + 1;
}

/**
 * `true` when `query` plausibly expanded to `word` via MiniSearch's own matching
 * rules — a real prefix, or within `fuzzy: 0.2`'s edit-distance budget — rather than
 * merely being long enough by coincidence. Coverage without this check is not
 * evidence of a relationship: `griechisch` (10 chars) is 91% the length of the
 * unrelated `essentially` (11 chars) and would clear any length-ratio *or*
 * length-difference threshold on its own, despite the two sharing no prefix, no
 * near-miss spelling, and an actual edit distance of 10 — a length-difference proxy
 * for edit distance was tried first and missed exactly this case, which is why the
 * real (capped) Levenshtein distance is computed here instead.
 */
function isPlausibleExpansionSource(query: string, word: string): boolean {
	if (word.startsWith(query)) return true;
	// Mirrors MiniSearch's `fuzzy: 0.2`: edit distance up to 20% of the query's own
	// length, rounded — the same formula MiniSearchService's `fuzzy` option documents.
	const maxEditDistance = Math.round(query.length * 0.2);
	return boundedLevenshtein(query, word, maxEditDistance) <= maxEditDistance;
}

/**
 * Drop content matches that only connect through a long word sharing a short prefix.
 *
 * Applies to the content field only. Identity search (title/alias/tag/path) keeps
 * matching from one character, because that is the incremental-typing path where a
 * short prefix is exactly what the user means.
 *
 * MiniSearch reports the words a result actually matched (`terms`) alongside the
 * query's own tokens (`queryTerms`), so coverage is computed after the fact — the
 * `prefix` predicate itself only sees the query term and cannot know what it expanded
 * to. Neither array says which query term produced which matched word (confirmed: a
 * single query term can expand to several matched words, e.g. `essen` matching
 * `essence`, `essentially` and `essential` all at once — `terms.length` and
 * `queryTerms.length` are unrelated), so `isPlausibleExpansionSource` reconstructs a
 * candidate pairing from MiniSearch's own matching rules rather than trusting array
 * position or length alone. Skipping that check was the bug: `essentially` cleared a
 * bare length-ratio test against the *unrelated* query term `griechisch`, so the
 * filter passed a result whose only real evidence was `essen` → `essentially` at 45%
 * coverage — exactly the case this filter exists to catch.
 *
 * MiniSearch's score is the sum of every matched term's contribution and it does not
 * expose a per-term breakdown, so a well-covered word cannot be kept while dropping a
 * poorly-covered one within the same result — filtering happens at the result level.
 * Every matched word must therefore be both a plausible expansion of some query term
 * AND well covered by it; requiring only one covered term to pass the whole result
 * would still hand it an unrelated word's score contribution.
 */
function hasSufficientPrefixCoverage(result: MiniSearchResult): boolean {
	const matched: string[] = Array.isArray(result.terms) ? result.terms : [];
	const queried: string[] = Array.isArray(result.queryTerms) ? result.queryTerms : [];
	if (matched.length === 0 || queried.length === 0) return true;

	return matched.every((term) => {
		const word = term.toLowerCase();
		if (word.length === 0) return false;
		return queried.some((queryTerm) => {
			const query = queryTerm.toLowerCase();
			if (query.length === 0) return false;
			// Only expansions are constrained; an exact hit is always its own full word.
			if (query === word) return true;
			if (!isPlausibleExpansionSource(query, word)) return false;
			return query.length / word.length >= MIN_CONTENT_PREFIX_COVERAGE;
		});
	});
}

/**
 * Service for full-text lexical search using MiniSearch.
 * Uses BM25 scoring with field boosting (title 2x, content 1x).
 */
export class MiniSearchService {
	private index: MiniSearch<IndexedDocument>;
	private db: IDBDatabase | null = null;
	private isDirty = false;
	/** Bumped on every mutation; lets an in-flight save detect it saved stale data. */
	private mutationGeneration = 0;
	private savesSuspended = false;
	private saveTimeout: number | null = null;
	private documentPaths = new Set<string>();
	/**
	 * Per-document `mtime` as of the read that produced its indexed content.
	 * Persisted beside `paths` so the startup validation can tell a note that
	 * changed while Obsidian was closed (every sync client's daily case) from
	 * one that is current — presence alone said nothing about staleness.
	 */
	private documentMtimes = new Map<string, number>();
	private documentTitles = new Map<string, string>();
	private documentAliases = new Map<string, string[]>();
	private documentTags = new Map<string, string[]>();
	private documentFolders = new Map<string, string[]>();
	private tagUsageCount = new Map<string, number>();
	private folderUsageCount = new Map<string, number>();
	private readonly dbName: string;
	/** Serialized byte size of the index blob last read from IDB (diagnostics; 0 if none). */
	lastLoadedBytes = 0;

	constructor(vaultId: string, indexId?: string) {
		this.dbName = getDbName(DB_NAME_PREFIX, vaultId, indexId);
		this.index = this.createIndex();
	}

	/**
	 * Create a new MiniSearch index with configured options.
	 */
	private createIndex(): MiniSearch<IndexedDocument> {
		return new MiniSearch<IndexedDocument>({
			fields: ["title", "aliases", "tags", "pathSegments", "content"],
			// `content` is deliberately NOT a store field: the searchable terms live in
			// the inverted index, and retaining the raw text of every note (and every
			// extracted PDF) kept the whole vault's prose in the JS heap — the main
			// reason mobile WebViews hit the OS memory ceiling. Explanation snippets
			// re-read the file on demand instead.
			storeFields: ["path", "title", "aliases", "tags", "pathSegments"],
			idField: "id",
			searchOptions: {
				boost: { title: 2, aliases: 1.8, tags: 1.5, pathSegments: 1.2, content: 1 },
				boostTerm: getTermBoost,
				fuzzy: 0.2,
				prefix: shouldContentPrefixMatch,
			},
			// Simple tokenizer: split on whitespace/punctuation
			tokenize: (text) => {
				return tokenizeSearchText(text);
			},
		});
	}

	/**
	 * Open the IndexedDB database for persistence.
	 */
	async open(): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, DB_VERSION);
			let settled = false;
			let blockedTimer: number | null = null;

			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				if (blockedTimer !== null) window.clearTimeout(blockedTimer);
				fn();
			};

			request.onerror = () => {
				Logger.error("[MiniSearch] Failed to open database:", request.error);
				finish(() => reject(toError(request.error, "Failed to open the lexical index database.")));
			};

			// A blocked open (another connection holds an older version of this
			// per-vault DB — e.g. a second Obsidian window) fires neither `success`
			// nor `error`, so without this the promise hangs forever and takes the
			// lexical-search init with it, silently. See the matching guard in
			// HNSWVectorStore.openIndexedDB.
			request.onblocked = () => {
				Logger.warn(
					`[MiniSearch] open blocked on "${this.dbName}" — another connection is still open (a second Obsidian window on this vault?). Waiting ${OPEN_BLOCKED_TIMEOUT_MS}ms for it to close.`,
				);
				if (blockedTimer !== null) window.clearTimeout(blockedTimer);
				blockedTimer = window.setTimeout(() => {
					finish(() =>
						reject(
							new Error(
								`Timed out opening the lexical index database "${this.dbName}": another Obsidian window has it open with an older version. Close the other window and reload.`,
							),
						),
					);
				}, OPEN_BLOCKED_TIMEOUT_MS);
			};

			request.onsuccess = () => {
				const db = request.result;
				// Yield to a future upgrade from another connection rather than being
				// the connection that blocks it indefinitely.
				db.onversionchange = () => {
					Logger.warn(
						`[MiniSearch] another connection requested a version upgrade of "${this.dbName}" — closing ours to let it proceed.`,
					);
					db.close();
					if (this.db === db) this.db = null;
				};
				finish(() => {
					this.db = db;
					resolve();
				});
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME);
				}
			};
		});
	}

	/**
	 * Load the index from IndexedDB.
	 * @returns true if index was loaded, false if no stored index exists
	 */
	async loadFromStorage(): Promise<boolean> {
		const db = this.db;
		if (!db) {
			Logger.warn("[MiniSearch] Database not open, cannot load index");
			return false;
		}

		return new Promise((resolve) => {
			const transaction = db.transaction(STORE_NAME, "readonly");
			const store = transaction.objectStore(STORE_NAME);
			const request = store.get(INDEX_KEY);

			request.onsuccess = () => {
				const data = request.result;
				if (data?.indexData && data.schemaVersion === STORAGE_SCHEMA_VERSION) {
					try {
						// Record blob size for startup diagnostics. `indexData` is the object from
						// MiniSearch.toJSON(); stringify to approximate its serialized byte size.
						// Gated on INFO logging: stringifying a large index costs CPU, and we must
						// not add that cost to every startup — only when diagnostics are enabled.
						if (getLogLevel() <= LogLvl.INFO) {
							try {
								this.lastLoadedBytes = JSON.stringify(data.indexData).length;
							} catch {
								this.lastLoadedBytes = 0;
							}
						}
						this.index = MiniSearch.loadJS(data.indexData, {
							fields: ["title", "aliases", "tags", "pathSegments", "content"],
							storeFields: ["path", "title", "aliases", "tags", "pathSegments"],
							idField: "id",
						});
						// Rebuild paths set
						this.documentPaths.clear();
						this.documentMtimes.clear();
						this.documentTitles.clear();
						this.documentAliases.clear();
						this.documentTags.clear();
						this.documentFolders.clear();
						this.tagUsageCount.clear();
						this.folderUsageCount.clear();
						// A record saved before mtimes were tracked has none: those
						// documents read as "unknown age", which validation treats as
						// stale and re-indexes once — the index stays searchable meanwhile,
						// which a schema bump (full rebuild from empty) would not allow.
						const mtimes: Record<string, unknown> =
							data.mtimes && typeof data.mtimes === "object" ? data.mtimes : {};
						if (data.paths && Array.isArray(data.paths)) {
							for (const path of data.paths) {
								this.documentPaths.add(path);
								const mtime = mtimes[path];
								if (typeof mtime === "number") this.documentMtimes.set(path, mtime);
								const stored = this.index.getStoredFields(path) as
									| { title?: string; aliases?: string; tags?: string }
									| undefined;
								if (stored?.title) {
									this.documentTitles.set(path, stored.title);
								}
								this.documentAliases.set(path, this.parseStoredAliases(stored?.aliases));
								this.setDocumentAutocompleteMetadata(path, this.parseStoredList(stored?.tags));
							}
						}
						Logger.log(`[MiniSearch] Loaded index with ${this.documentPaths.size} documents`);
						resolve(true);
					} catch (error) {
						Logger.error("[MiniSearch] Failed to deserialize index:", error);
						this.index = this.createIndex();
						resolve(false);
					}
				} else {
					resolve(false);
				}
			};

			request.onerror = () => {
				Logger.error("[MiniSearch] Failed to load index:", request.error);
				resolve(false);
			};
		});
	}

	/**
	 * Save the index to IndexedDB.
	 */
	async saveToStorage(): Promise<void> {
		const db = this.db;
		if (!db) {
			Logger.warn("[MiniSearch] Database not open, cannot save index");
			return;
		}

		// Snapshot the generation with the data. A mutation that lands while the
		// async IndexedDB write is in flight is NOT in this snapshot — clearing
		// `isDirty` unconditionally on success would unmark it, and if nothing
		// dirtied the index again it would silently vanish on the next restart.
		const generation = this.mutationGeneration;
		const indexData = this.index.toJSON();
		const paths = Array.from(this.documentPaths);
		const mtimes = Object.fromEntries(this.documentMtimes);

		return new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE_NAME, "readwrite");
			const store = transaction.objectStore(STORE_NAME);
			const request = store.put({ indexData, paths, mtimes, schemaVersion: STORAGE_SCHEMA_VERSION }, INDEX_KEY);

			request.onsuccess = () => {
				if (this.mutationGeneration === generation) {
					this.isDirty = false;
				}
				Logger.log(`[MiniSearch] Saved index with ${this.documentPaths.size} documents`);
				resolve();
			};

			request.onerror = () => {
				Logger.error("[MiniSearch] Failed to save index:", request.error);
				reject(toError(request.error, "Failed to save the lexical index."));
			};
		});
	}

	/**
	 * Suspend the per-mutation debounced saves for the duration of a bulk index run.
	 *
	 * Each save serializes the ENTIRE index via `toJSON()`. During a bulk build that
	 * debounce fires over and over against an ever-growing index, and on mobile those
	 * repeated full serializations were the allocation spikes that pushed the WebView
	 * past the OS memory ceiling. While suspended, mutations only mark the index dirty;
	 * the bulk caller checkpoints explicitly via `flush()`.
	 */
	suspendScheduledSaves(): void {
		this.savesSuspended = true;
		if (this.saveTimeout) {
			window.clearTimeout(this.saveTimeout);
			this.saveTimeout = null;
		}
	}

	/**
	 * Re-enable debounced saves after a bulk run.
	 *
	 * A mutation that landed while the bulk run's final flush was already
	 * serializing could neither make that flush's snapshot nor schedule a save
	 * of its own (suspension swallowed the schedule; the generation check in
	 * saveToStorage kept it marked dirty). Without rescheduling here it would
	 * stay dirty-but-unscheduled forever and vanish on the next restart.
	 */
	resumeScheduledSaves(): void {
		this.savesSuspended = false;
		if (this.isDirty) {
			this.scheduleSaveTimer();
		}
	}

	/**
	 * Schedule a debounced save operation.
	 * Uses requestIdleCallback so the heavy toJSON() + IndexedDB write only runs
	 * when the browser is idle — never blocking an active user interaction.
	 */
	private scheduleSave(): void {
		this.isDirty = true;
		this.mutationGeneration++;

		if (this.savesSuspended) {
			return;
		}

		this.scheduleSaveTimer();
	}

	private scheduleSaveTimer(): void {
		if (this.saveTimeout) {
			window.clearTimeout(this.saveTimeout);
			this.saveTimeout = null;
		}

		// Wait 5 s, then hand off to the browser's idle scheduler.
		// The 10 s timeout on requestIdleCallback ensures it eventually runs
		// even on a busy browser, but never mid-keystroke or mid-animation.
		this.saveTimeout = window.setTimeout(() => {
			this.saveTimeout = null;
			requestIdleCallback(
				() => void this.saveToStorage().catch((e) => Logger.error("[MiniSearch] Scheduled save failed:", e)),
				{ timeout: 10_000 },
			);
		}, 5000);
	}

	/**
	 * Flush any pending saves immediately.
	 */
	async flush(): Promise<void> {
		if (this.saveTimeout) {
			window.clearTimeout(this.saveTimeout);
			this.saveTimeout = null;
		}

		if (this.isDirty) {
			await this.saveToStorage();
		}
	}

	/**
	 * Add or update a document in the index.
	 * @param path File path (used as unique ID)
	 * @param title Document title (filename without extension)
	 * @param content Document content
	 * @param tags Tags from the metadata cache
	 * @param mtime The file's mtime as of the read that produced `content`. Omitted
	 *   (tests, callers without a file) the document has no known age and the next
	 *   validation re-indexes it.
	 */
	addDocument(path: string, title: string, content: string, tags: string[] = [], mtime?: number): void {
		// Remove existing document if present
		if (this.documentPaths.has(path)) {
			this.removeDocumentAutocompleteMetadata(path);
			this.index.discard(path);
		}
		if (mtime === undefined) this.documentMtimes.delete(path);
		else this.documentMtimes.set(path, mtime);

		const aliases = this.extractAliases(content);
		const normalizedTags = this.normalizeStoredTags(tags);
		const doc: IndexedDocument = {
			id: path,
			path,
			title,
			aliases: aliases.join("\n"),
			tags: normalizedTags.join("\n"),
			pathSegments: this.extractPathSegments(path).join("\n"),
			content,
		};

		this.index.add(doc);
		this.documentPaths.add(path);
		this.documentTitles.set(path, title);
		this.documentAliases.set(path, aliases);
		this.setDocumentAutocompleteMetadata(path, normalizedTags);
		this.scheduleSave();
	}

	/**
	 * Remove a document from the index.
	 * @param path File path to remove
	 */
	removeDocument(path: string): void {
		if (this.documentPaths.has(path)) {
			this.removeDocumentAutocompleteMetadata(path);
			this.index.discard(path);
			this.documentPaths.delete(path);
			this.documentMtimes.delete(path);
			this.documentTitles.delete(path);
			this.documentAliases.delete(path);
			this.scheduleSave();
		}
	}

	/**
	 * Check if a document exists in the index.
	 */
	hasDocument(path: string): boolean {
		return this.documentPaths.has(path);
	}

	/**
	 * The mtime the document was indexed at, or `undefined` when it is not
	 * indexed or was indexed without one (a pre-mtime saved index).
	 */
	getDocumentMtime(path: string): number | undefined {
		return this.documentMtimes.get(path);
	}

	/**
	 * Get all indexed document paths.
	 */
	getDocumentPaths(): IterableIterator<string> {
		return this.documentPaths.values();
	}

	/**
	 * Get the number of indexed documents.
	 */
	get documentCount(): number {
		return this.documentPaths.size;
	}

	/**
	 * Clear all documents from the index.
	 */
	clear(): void {
		this.index = this.createIndex();
		this.documentPaths.clear();
		this.documentMtimes.clear();
		this.documentTitles.clear();
		this.documentAliases.clear();
		this.documentTags.clear();
		this.documentFolders.clear();
		this.tagUsageCount.clear();
		this.folderUsageCount.clear();
		this.scheduleSave();
	}

	getAutocompleteCache(): AutocompleteCacheSnapshot {
		const tagChildCount = new Map<string, number>();
		for (const tag of this.tagUsageCount.keys()) {
			const parts = tag.split("/");
			for (let index = 1; index < parts.length; index++) {
				const parent = parts.slice(0, index).join("/");
				tagChildCount.set(parent, (tagChildCount.get(parent) ?? 0) + 1);
			}
		}

		return {
			tags: Array.from(new Set([...this.tagUsageCount.keys(), ...tagChildCount.keys()])).sort(),
			tagChildCount,
			folders: Array.from(this.folderUsageCount.keys()).sort(),
		};
	}

	/**
	 * Search for documents matching the query.
	 * @param query Search query
	 * @param limit Maximum results to return
	 * @returns Ranked search results with scores
	 */
	search(query: string, limit = 20): LexicalSearchResult[] {
		if (!query.trim()) {
			return [];
		}

		const queryPlan = createQueryPlan(query);
		if (!queryPlan.identityQuery && !queryPlan.contentQuery) {
			return [];
		}

		const identityResults = this.searchIdentityCandidates(queryPlan);
		const contentResults = this.searchContentCandidates(queryPlan);
		const priorityResults = [...this.findPriorityTitleMatches(query), ...this.findPriorityAliasMatches(query)];
		const evidenceByPath = new Map<string, CandidateEvidence>();

		for (const result of priorityResults) {
			this.mergeCandidateEvidence(evidenceByPath, result, "priority");
		}

		for (const result of identityResults) {
			this.mergeCandidateEvidence(evidenceByPath, result, "identity");
		}

		for (const result of contentResults) {
			this.mergeCandidateEvidence(evidenceByPath, result, "content");
		}

		const rankedResults = Array.from(evidenceByPath.values())
			.map((evidence): RankedLexicalResult => this.createRankedLexicalResult(queryPlan, evidence))
			.sort((left, right) => right.matchTier - left.matchTier || right.adjustedScore - left.adjustedScore);

		return rankedResults.slice(0, limit).map(({ result, adjustedScore, features }) => ({
			path: result.id,
			name:
				(result as MiniSearchResult & { title?: string }).title ||
				result.id
					.replace(/\.[^.]+$/, "")
					.split("/")
					.pop() ||
				result.id,
			aliases: this.parseStoredAliases((result as MiniSearchResult & { aliases?: string }).aliases),
			tags: this.parseStoredList((result as MiniSearchResult & { tags?: string }).tags),
			score: adjustedScore,
			features,
		}));
	}

	private mergeCandidateEvidence(
		evidenceByPath: Map<string, CandidateEvidence>,
		result: MiniSearchResult,
		channel: "identity" | "content" | "priority",
	): void {
		const existing = evidenceByPath.get(result.id) ?? {
			path: result.id,
			identityScore: 0,
			contentScore: 0,
			priorityScore: 0,
		};

		if (channel === "identity") {
			existing.identityScore = Math.max(existing.identityScore, result.score);
		} else if (channel === "content") {
			existing.contentScore = Math.max(existing.contentScore, result.score);
		} else {
			existing.priorityScore = Math.max(existing.priorityScore, result.score);
		}

		evidenceByPath.set(result.id, existing);
	}

	private createRankedLexicalResult(queryPlan: QueryPlan, evidence: CandidateEvidence): RankedLexicalResult {
		const result = this.getStoredResult(evidence.path);
		const title =
			(result as MiniSearchResult & { title?: string }).title ||
			result.id
				.replace(/\.[^.]+$/, "")
				.split("/")
				.pop() ||
			result.id;
		const aliases = this.parseStoredAliases((result as MiniSearchResult & { aliases?: string }).aliases);
		const tags = this.parseStoredList((result as MiniSearchResult & { tags?: string }).tags);
		const pathSegments = this.parseStoredList(
			(result as MiniSearchResult & { pathSegments?: string }).pathSegments,
		);
		const features = scoreLexicalCandidate(
			queryPlan,
			title,
			aliases,
			tags,
			pathSegments,
			evidence,
			LEXICAL_SCORING_CONFIG,
		);

		return {
			result: { ...result, score: features.baseScore },
			matchTier: features.matchTier,
			adjustedScore: features.adjustedScore,
			features,
		};
	}

	private getStoredResult(path: string): MiniSearchResult {
		const stored = this.index.getStoredFields(path) as
			| {
					path?: string;
					title?: string;
					aliases?: string;
					tags?: string;
					pathSegments?: string;
			  }
			| undefined;

		return {
			id: path,
			score: 0,
			...(stored ?? { title: this.documentTitles.get(path) }),
		} as MiniSearchResult;
	}

	private searchIdentityCandidates(queryPlan: QueryPlan): MiniSearchResult[] {
		if (!queryPlan.identityQuery) {
			return [];
		}

		return this.index.search(queryPlan.identityQuery, {
			fields: [...IDENTITY_SEARCH_FIELDS],
			boost: { title: 2, aliases: 1.8, tags: 1.5, pathSegments: 1.2 },
			boostTerm: getTermBoost,
			fuzzy: 0.2,
			prefix: shouldIdentityPrefixMatch,
		});
	}

	private searchContentCandidates(queryPlan: QueryPlan): MiniSearchResult[] {
		if (!queryPlan.contentQuery) {
			return [];
		}

		return this.index.search(queryPlan.contentQuery, {
			fields: [...CONTENT_SEARCH_FIELDS],
			boost: { content: 1 },
			boostTerm: getTermBoost,
			fuzzy: 0.2,
			prefix: shouldContentPrefixMatch,
			filter: hasSufficientPrefixCoverage,
			// An expansion is weaker evidence than the word itself. Left at full weight,
			// a prefix hit competes with an exact one, and because fusion normalizes
			// lexical scores against the result set, a query whose only hits are
			// expansions still hands one of them a normalized 1.0.
			weights: { prefix: 0.3, fuzzy: 0.2 },
		});
	}

	private findPriorityTitleMatches(query: string): MiniSearchResult[] {
		const queryPlan = createQueryPlan(query);
		const queryTokens = queryPlan.normalizedTokens;
		const normalizedQuery = queryPlan.normalizedQuery;
		if (queryTokens.length === 0 || !normalizedQuery) {
			return [];
		}

		const shouldRescueShortTitlePrefixes = normalizedQuery.length < 3;

		const results: MiniSearchResult[] = [];
		for (const [path, title] of this.documentTitles) {
			const titleMatchKind = getTitleMatchKind(queryPlan, title);
			const titleTokens = tokenizeSearchText(title);
			const hasNumericLeadingPrefix =
				isNumericSearchTerm(queryTokens[0] ?? "") && matchesLeadingTitlePrefix(queryTokens, titleTokens);
			const hasShortTitlePrefixRescue =
				shouldRescueShortTitlePrefixes &&
				(titleMatchKind === "exact" || titleMatchKind === "leading-prefix" || titleMatchKind === "starts-with");

			if (!hasNumericLeadingPrefix && !hasShortTitlePrefixRescue) {
				continue;
			}

			const stored = this.index.getStoredFields(path) as
				| {
						path?: string;
						title?: string;
						aliases?: string;
						tags?: string;
						pathSegments?: string;
				  }
				| undefined;

			results.push({
				id: path,
				score: 0,
				...(stored ?? { title }),
			} as MiniSearchResult);
		}

		return results.slice(0, 50);
	}

	private findPriorityAliasMatches(query: string): MiniSearchResult[] {
		const normalizedQuery = createQueryPlan(query).normalizedQuery;
		if (!normalizedQuery) {
			return [];
		}

		const results: MiniSearchResult[] = [];
		for (const [path, aliases] of this.documentAliases) {
			if (
				!aliases.some((alias) => {
					const normalizedAlias = normalizeSearchText(alias);
					return (
						normalizedAlias === normalizedQuery ||
						normalizedAlias.startsWith(normalizedQuery) ||
						normalizedAlias.includes(normalizedQuery)
					);
				})
			) {
				continue;
			}

			const stored = this.index.getStoredFields(path) as
				| {
						path?: string;
						title?: string;
						aliases?: string;
						tags?: string;
						pathSegments?: string;
				  }
				| undefined;

			results.push({
				id: path,
				score: 0,
				...(stored ?? { title: this.documentTitles.get(path), aliases: aliases.join("\n") }),
			} as MiniSearchResult);
		}

		return results.slice(0, 50);
	}

	private extractAliases(content: string): string[] {
		const frontmatter = this.extractFrontmatter(content);
		if (!frontmatter) {
			return [];
		}

		const aliases: string[] = [];
		const lines = frontmatter.split(/\r?\n/);

		for (let index = 0; index < lines.length; index++) {
			const match = lines[index].match(/^\s*(aliases?|alias):\s*(.*)$/i);
			if (!match) continue;

			const remainder = match[2].trim();
			if (remainder.startsWith("[") && remainder.endsWith("]")) {
				for (const value of remainder.slice(1, -1).split(",")) {
					const alias = value.trim().replace(/^['"]|['"]$/g, "");
					if (alias) aliases.push(alias);
				}
				continue;
			}

			if (remainder) {
				const alias = remainder.replace(/^['"]|['"]$/g, "");
				if (alias) aliases.push(alias);
				continue;
			}

			for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex++) {
				const itemMatch = lines[nextIndex].match(/^\s*-\s*(.+)$/);
				if (!itemMatch) break;
				const alias = itemMatch[1].trim().replace(/^['"]|['"]$/g, "");
				if (alias) aliases.push(alias);
				index = nextIndex;
			}
		}

		return Array.from(new Set(aliases));
	}

	private extractPathSegments(path: string): string[] {
		const segments = path
			.split("/")
			.slice(0, -1)
			.map((segment) => segment.trim())
			.filter((segment) => segment.length > 0);

		return Array.from(new Set(segments));
	}

	private extractFolderPaths(path: string): string[] {
		const segments = path
			.split("/")
			.slice(0, -1)
			.map((segment) => segment.trim())
			.filter((segment) => segment.length > 0);

		const folders: string[] = [];
		for (let index = 1; index <= segments.length; index++) {
			folders.push(segments.slice(0, index).join("/"));
		}

		return folders;
	}

	private updateUsageCount(map: Map<string, number>, values: string[], delta: 1 | -1): void {
		for (const value of values) {
			const nextCount = (map.get(value) ?? 0) + delta;
			if (nextCount <= 0) {
				map.delete(value);
				continue;
			}

			map.set(value, nextCount);
		}
	}

	private setDocumentAutocompleteMetadata(path: string, tags: string[]): void {
		const normalizedTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)));
		const folders = this.extractFolderPaths(path);

		this.documentTags.set(path, normalizedTags);
		this.documentFolders.set(path, folders);
		this.updateUsageCount(this.tagUsageCount, normalizedTags, 1);
		this.updateUsageCount(this.folderUsageCount, folders, 1);
	}

	private removeDocumentAutocompleteMetadata(path: string): void {
		const tags = this.documentTags.get(path) ?? [];
		const folders = this.documentFolders.get(path) ?? [];

		this.updateUsageCount(this.tagUsageCount, tags, -1);
		this.updateUsageCount(this.folderUsageCount, folders, -1);
		this.documentTags.delete(path);
		this.documentFolders.delete(path);
	}

	private extractFrontmatter(content: string): string | undefined {
		if (!content.startsWith("---\n")) {
			return undefined;
		}

		const endOfFrontmatter = content.indexOf("\n---\n", 4);
		if (endOfFrontmatter === -1) {
			return undefined;
		}

		return content.slice(4, endOfFrontmatter);
	}

	private parseStoredAliases(rawAliases: string | undefined): string[] {
		return this.parseStoredList(rawAliases);
	}

	private parseStoredList(rawValue: string | undefined): string[] {
		if (!rawValue?.trim()) {
			return [];
		}

		return rawValue
			.split(/\r?\n/)
			.map((value) => value.trim())
			.filter((value) => value.length > 0);
	}

	private normalizeStoredTags(tags: string[]): string[] {
		return Array.from(
			new Set(
				tags
					.map((tag) => tag.replace(/^#/, ""))
					.map((tag) => tag.trim())
					.filter((tag) => tag.length > 1),
			),
		);
	}

	/**
	 * Browse all indexed documents (for filter-only queries).
	 * Returns documents sorted alphabetically by path.
	 * @param limit Maximum results to return
	 * @returns All document paths and names
	 */
	/**
	 * List indexed documents in path order, without a query.
	 *
	 * `isCandidate` is applied **before** the limit, not after. Browsing is
	 * ordered by path, so slicing first and filtering afterwards means a filter
	 * only ever sees the alphabetically-earliest `limit` documents: browsing
	 * `Corpus/Typography` in a 300-note vault returned 18 of its 77 notes,
	 * because `Corpus/T…` sorts past the cut. Callers that filter must pass the
	 * predicate down rather than post-filtering the result.
	 */
	browse(limit = 100, isCandidate?: (path: string) => boolean): LexicalSearchResult[] {
		const all = Array.from(this.documentPaths).sort();
		const paths = isCandidate ? all.filter(isCandidate) : all;
		return paths.slice(0, limit).map((path) => ({
			path,
			name:
				path
					.replace(/\.[^.]+$/, "")
					.split("/")
					.pop() || path,
			score: 1,
		}));
	}

	/**
	 * Close the database connection.
	 */
	close(): void {
		if (this.saveTimeout) {
			window.clearTimeout(this.saveTimeout);
		}
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}
}
