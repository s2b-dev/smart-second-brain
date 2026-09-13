/**
 * Vector Store Service
 *
 * Main orchestration service for the embedding-based vector store.
 * Manages multiple indexes (one per embedding model), indexing, search,
 * and export/import via native file dialogs.
 */

import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { decode, encode } from "@msgpack/msgpack";
import { Notice, Platform, TFile, getAllTags } from "obsidian";
import { hydrateEmbeddingModel } from "../lib/modelMetadataNormalizer";
import type SecondBrainPlugin from "../main";
import { fetchModelsDevData } from "../providers/modelsDevApi";
import { getOllamaModelsCache } from "../providers/ollamaModels";
import { fetchOpenRouterModels } from "../providers/openrouterModels";
import { getRegistry } from "../providers/registry";
import {
	BULK_CHECKPOINT_INTERVAL,
	BulkAttemptMarker,
	bulkBatchPauseMs,
	bulkCheckpointPauseMs,
	bulkPause,
	orderForBulkIndexing,
	scheduleBulkRun,
} from "../search/bulkPacing";
import { ensureProviderRegistered } from "../providers/registrySync";
import { getData } from "../stores/dataStore.svelte";
import { chunkText } from "../utils/chunkText";
import { getEmbeddableVaultFiles, isEmbeddableFile, readIndexableContent } from "../utils/fileFiltering";
import { Logger } from "../utils/logging";
import { matchesPathPrefix } from "../utils/pathUtils";
import {
	configureEmbedIndexAction,
	settingsAction,
	showActionNotice,
	showSettingsLinkNotice,
} from "../utils/actionNotice";
import { StartupProfiler } from "../utils/startupProfiler";
import { getDefaultEmbeddingBatchSize, normalizeEmbeddingBatchSize } from "./batchSize";
import { aggregateChunksToNotes } from "./chunkAggregation";
import { formatRetrievalQuery } from "./queryInstruction";
import { createVectorStore } from "./storeFactory";
import {
	type DefaultEmbedModel,
	type DocumentVector,
	INDEX_VERSION,
	type IndexingProgress,
	type IndexingReport,
	type SearchFilter,
	type SerializedIndex,
	type SkipReason,
	type SkippedFile,
	type VectorSearchResult,
	type VectorStore,
	deleteDatabase,
	getDbName,
	makeChunkId,
	sanitizeIndexId,
} from "./types";

// ── Electron dialog helpers (Obsidian desktop) ────────────────────────

interface DialogFilter {
	name: string;
	extensions: string[];
}

/**
 * Require a Node.js built-in module from Electron's renderer process.
 * Works in Obsidian desktop where `require` is exposed on `window`.
 */
function requireNodeModule<T>(id: string): T {
	const globalWithRequire = window as { require?: (id: string) => unknown };
	if (typeof globalWithRequire.require !== "function") {
		throw new Error(`Node module "${id}" is not available in this environment.`);
	}
	return globalWithRequire.require(id) as T;
}

/**
 * Show a native "Save As" dialog and return the chosen file path, or null if
 * the user cancelled.
 */
function showSaveDialog(options: {
	title?: string;
	defaultPath?: string;
	filters?: DialogFilter[];
}): string | null {
	const { remote } = requireNodeModule<{
		remote: {
			dialog: {
				showSaveDialogSync: (options: {
					title?: string;
					defaultPath?: string;
					filters?: DialogFilter[];
				}) => string | undefined;
			};
		};
	}>("electron");
	const result = remote.dialog.showSaveDialogSync({
		title: options.title,
		defaultPath: options.defaultPath,
		filters: options.filters,
	});
	return result ?? null;
}

/**
 * Show a native "Open File" dialog and return the chosen file paths, or null
 * if the user cancelled.
 */
function showOpenDialog(options: {
	title?: string;
	filters?: DialogFilter[];
	properties?: string[];
}): string[] | null {
	const { remote } = requireNodeModule<{
		remote: {
			dialog: {
				showOpenDialogSync: (options: {
					title?: string;
					filters?: DialogFilter[];
					properties?: string[];
				}) => string[] | undefined;
			};
		};
	}>("electron");
	const result = remote.dialog.showOpenDialogSync({
		title: options.title,
		filters: options.filters,
		properties: options.properties,
	});
	return result ?? null;
}

/** Default max input tokens for embedding models when metadata is unavailable */
const DEFAULT_EMBED_MAX_INPUT_TOKENS = 8191;

/** Debounce delay before re-embedding a modified file (ms) */
const MODIFY_DEBOUNCE_MS = 5_000;

/**
 * Chars per token for sizing chunks against a model's input cap.
 *
 * Four is the usual English-prose figure, but a chunk budget has to hold for
 * the densest content a note can contain — JSON, code, tables and non-Latin
 * scripts tokenize at 2–3 chars per token — and an overshoot is a rejected (or
 * silently truncated) chunk. Estimating low costs a few more, smaller chunks
 * on prose; estimating high dropped whole notes from the index (#485).
 */
const CHARS_PER_TOKEN = 3;

/**
 * Over-fetch factor for semantic search. A note is stored as one vector per
 * section, so several of a note's chunks can occupy adjacent result slots; we
 * request more raw neighbors than `topK` and aggregate to distinct notes
 * afterwards so `topK` still yields `topK` distinct notes.
 *
 * This also feeds `aggregateChunksToNotes`: a note's *supporting* chunks only
 * count toward its score if they were actually retrieved, so under-fetching
 * silently degrades aggregation into first-hit-wins. Section-aware chunking
 * raised the fixture corpus from 337 chunks to 2611 (~7.7 chunks per note), so
 * the previous factor of 4 no longer covered a note's own sections.
 */
const CHUNK_OVERFETCH = 10;

let instance: VectorStoreService | null = null;
let pendingInstance: VectorStoreService | null = null;
let pendingInitPromise: Promise<void> | null = null;

/**
 * Get the singleton VectorStoreService instance.
 * Must call initialize() first.
 */
export function getVectorStoreService(): VectorStoreService {
	if (!instance) {
		throw new Error("VectorStoreService not initialized. Call initialize() first.");
	}
	return instance;
}

/**
 * Check if the VectorStoreService has been initialized.
 */
export function isVectorStoreInitialized(): boolean {
	return instance !== null;
}

/**
 * Wait for the VectorStoreService to finish initializing.
 * Resolves immediately if already initialized, or waits for the pending init.
 * Returns true if initialization succeeded, false otherwise.
 */
export async function waitForVectorStore(): Promise<boolean> {
	if (instance) return true;
	if (pendingInitPromise) {
		await pendingInitPromise;
		return instance !== null;
	}
	return false;
}

/**
 * Wait for a specific index instance to be available.
 * Unlike waitForVectorStore(), this does not wait for unrelated indexes.
 */
export async function waitForVectorStoreIndex(indexId?: string | null): Promise<boolean> {
	if (!indexId) return false;

	const service = instance ?? pendingInstance;
	if (!service) return false;

	try {
		await service.getOrCreateInstance(indexId);
		return true;
	} catch (error) {
		Logger.error(`[VectorStore] Failed to initialize index ${indexId}:`, error);
		return false;
	}
}

/**
 * Per-index state container. Each embedding model gets its own instance
 * with separate storage, sync manager, and progress tracking.
 */
interface IndexInstance {
	indexId: string;
	store: VectorStore;
	embeddings: EmbeddingsInterface | null;
	currentProviderId: string | null;
	currentModelId: string | null;
	/**
	 * Registry credential generation the cached `embeddings` was built at.
	 *
	 * The instance snapshots its resolved auth at construction, so provider/model id
	 * equality is not enough to reuse it — an edited API key or baseUrl produces the
	 * same ids while invalidating the instance. Mirrors the `authGen` term in
	 * `AgentManager.buildRunnableCacheKey`, which fixed the identical staleness on
	 * the chat side.
	 */
	currentAuthGeneration: number | null;
	hasValidatedThisSession: boolean;
	/** A startup validation is scheduled (see `scheduleValidation`) and has not run yet. */
	validationScheduled: boolean;
	/** A full build (`buildFullIndex`) is in progress. Validation runs set only `progress.isIndexing`. */
	isIndexing: boolean;
	/** The full build in flight, so a second caller joins it instead of racing it. */
	buildPromise: Promise<void> | null;
	progress: IndexingProgress;
	/** Timestamp (ms) when the current indexing run started, for ETA estimation */
	indexingStartedAt: number | null;
	/** `indexed` count when the current run started, so ETA measures only this run's rate */
	indexingStartCount: number;
	abortController: AbortController | null;
	maxInputTokensCache: {
		provider: string;
		model: string;
		maxInputTokens: number;
	} | null;
	report: IndexingReport | null;
}

/**
 * Status label for an index row: the date it was last built, or why it has none.
 *
 * A build that was cancelled or interrupted never sets `lastBuiltAt`, but the
 * notes it wrote are persisted at every checkpoint and searchable. Reporting
 * that as "Never built" beside a live note count reads as a contradiction (#466).
 */
export function formatIndexBuildStatus(lastBuiltAt: number | null | undefined, documentCount: number): string {
	if (lastBuiltAt) return new Date(lastBuiltAt).toLocaleDateString();
	return documentCount > 0 ? "Build incomplete" : "Never built";
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

/**
 * The subset of a cached embeddings instance's identity that decides reuse.
 * Structural so the predicate below can be exercised without an IndexInstance.
 */
export interface CachedEmbeddingsIdentity {
	providerId: string | null;
	modelId: string | null;
	/** Registry credential generation the instance was built at. */
	authGeneration: number | null;
}

/**
 * Whether a cached embeddings instance can be reused for `want`.
 *
 * Extracted from `getEmbeddingsForInstance` so the rule is directly testable:
 * the method itself is private and reachable only through index initialization,
 * which made the credential check unverifiable by mutation — the guard could be
 * deleted without failing a single test.
 *
 * The `authGeneration` term is the load-bearing one. An embeddings instance
 * snapshots its resolved auth at construction, and index instances live for the
 * whole plugin session, so provider/model equality alone would keep serving an
 * instance built with a rotated-away API key or a stale baseUrl. That fails
 * silently — an embed call just 401s or returns nothing — until Obsidian
 * restarts. Same defect the `authGen` term fixed in the agent's runnable cache.
 */
export function canReuseCachedEmbeddings(
	cached: CachedEmbeddingsIdentity,
	want: { provider: string; model: string },
	currentAuthGeneration: number,
): boolean {
	return (
		cached.providerId === want.provider &&
		cached.modelId === want.model &&
		cached.authGeneration === currentAuthGeneration
	);
}

export interface ValidationProgressCountsInput {
	eligibleFileCount: number;
	pendingFileCount: number;
	validPendingFileCount: number;
}

export function summarizeValidationProgressCounts({
	eligibleFileCount,
	pendingFileCount,
	validPendingFileCount,
}: ValidationProgressCountsInput): { startingIndexedCount: number; totalCount: number } {
	const normalizedEligible = Math.max(eligibleFileCount, 0);
	const normalizedPending = Math.max(Math.min(pendingFileCount, normalizedEligible), 0);
	const normalizedValidPending = Math.max(Math.min(validPendingFileCount, normalizedPending), 0);
	const startingIndexedCount = normalizedEligible - normalizedPending;

	return {
		startingIndexedCount,
		totalCount: startingIndexedCount + normalizedValidPending,
	};
}

/**
 * Write order for a note's chunks: everything after chunk 0 first, chunk 0
 * last. `VectorStore.listNoteMeta` reports a note as indexed only through its
 * chunk-0 row, so writing that row last turns "all chunks stored" into a single
 * durable fact — a process killed part-way through a multi-chunk note leaves
 * rows that validation treats as absent and re-indexes, instead of chunks that
 * carry the current mtime and make the note look complete for good.
 */
export function orderChunksForWriting<T>(chunks: readonly T[]): T[] {
	if (chunks.length <= 1) return [...chunks];
	return [...chunks.slice(1), chunks[0]];
}

/** One chunk of a note queued for embedding. */
interface ChunkEntry {
	file: TFile;
	chunkIndex: number;
	checksum: string;
	embedText: string;
}

/** Report accumulated by a full build; validation runs pass none. */
interface BulkEmbedReport {
	indexedFiles: string[];
	skippedFiles: SkippedFile[];
}

interface BulkEmbedOptions {
	/** Notes already indexed before this run; `indexed` starts here. */
	startingIndexedCount: number;
	/** Notes counted as skipped before the loop starts (excluded, privacy). */
	preFilterSkipped: number;
	/** Remove a note's stored chunks before writing new ones (re-index of a stale note). */
	purgeExisting: boolean;
	notice: Notice | null;
	report?: BulkEmbedReport;
}

interface BulkEmbedOutcome {
	indexedChunks: number;
	/** The run was aborted (user cancel, index deleted, provider unreachable). */
	cancelled: boolean;
}

/**
 * Main service for embedding-based vector search.
 * Manages multiple indexes, one per embedding model.
 */
export class VectorStoreService {
	private readonly plugin: SecondBrainPlugin;
	private readonly instances: Map<string, IndexInstance> = new Map();
	private readonly initializingInstances = new Map<string, Promise<IndexInstance>>();
	private readonly progressListeners = new Map<string, Set<(progress: IndexingProgress) => void>>();
	private readonly modifyTimers = new Map<string, number>();
	private isInitialized = false;
	private readonly vaultId: string;
	/** Crash-backoff marker for scheduled bulk runs (`s2b-embedding-bulk-attempts`, vault-scoped). */
	private readonly bulkAttempts: BulkAttemptMarker;

	private constructor(plugin: SecondBrainPlugin) {
		this.plugin = plugin;
		this.vaultId = getData().vaultSlug;
		this.bulkAttempts = new BulkAttemptMarker("embedding", plugin.app);
	}

	/** Promise tracking initialization, awaited by cleanup to avoid closing mid-init. */
	private initPromise: Promise<void> | null = null;

	/**
	 * Create an IndexInstance for the given index ID.
	 */
	private createInstance(indexId: string): IndexInstance {
		const store = createVectorStore(this.vaultId, indexId);

		return {
			indexId,
			store,
			embeddings: null,
			currentProviderId: null,
			currentModelId: null,
			currentAuthGeneration: null,
			hasValidatedThisSession: false,
			validationScheduled: false,
			isIndexing: false,
			buildPromise: null,
			progress: {
				isIndexing: false,
				total: 0,
				indexed: 0,
				skipped: 0,
				currentFile: null,
				percentage: 0,
				etaMs: null,
			},
			indexingStartedAt: null,
			indexingStartCount: 0,
			abortController: null,
			maxInputTokensCache: null,
			report: null,
		};
	}

	/**
	 * Initialize the VectorStoreService singleton.
	 */
	static async initialize(plugin: SecondBrainPlugin): Promise<VectorStoreService> {
		if (instance) {
			Logger.warn("[VectorStore] Already initialized");
			return instance;
		}

		if (pendingInstance) {
			Logger.warn("[VectorStore] Initialization already in progress");
			if (pendingInitPromise) {
				await pendingInitPromise;
			}
			return instance ?? pendingInstance;
		}

		const service = new VectorStoreService(plugin);
		pendingInstance = service;
		service.initPromise = service.init();
		try {
			await service.initPromise;
			instance = service;
			return service;
		} finally {
			if (pendingInstance === service) {
				pendingInstance = null;
			}
		}
	}

	/**
	 * Start VectorStoreService initialization in the background.
	 * Returns the service immediately for cleanup purposes.
	 * isVectorStoreInitialized() will return false until init completes.
	 */
	static startInitialize(plugin: SecondBrainPlugin): VectorStoreService {
		if (instance) {
			Logger.warn("[VectorStore] Already initialized");
			return instance;
		}

		if (pendingInstance) {
			Logger.warn("[VectorStore] Initialization already in progress");
			return pendingInstance;
		}

		const service = new VectorStoreService(plugin);
		pendingInstance = service;
		pendingInitPromise = service
			.init()
			.then(() => {
				instance = service;
			})
			.catch((error) => {
				if (instance === service) {
					instance = null;
				}
				Logger.error("[VectorStore] Background initialization failed:", error);
			})
			.finally(() => {
				if (pendingInstance === service) {
					pendingInstance = null;
				}
				pendingInitPromise = null;
			});
		service.initPromise = pendingInitPromise;
		return service;
	}

	/**
	 * Internal initialization.
	 *
	 * Desktop opens the currently-referenced indexes (search + graph) right away.
	 * Mobile opens nothing at boot: opening an index spawns its worker and loads
	 * the id maps, and the first write or search then rehydrates the HNSW graph —
	 * the whole vector set, resident in the WebContent process — which is the
	 * #432 kill zone when it lands in the boot spike. Every consumer already goes
	 * through `getOrCreateInstance`, so whatever comes first opens it: the first
	 * search, the graph's semantic-edge request, an explicit reindex, or the
	 * delayed catch-up scheduled here (which waits out the boot spike and backs
	 * off after crashed attempts, like the lexical build).
	 */
	private async init(): Promise<void> {
		try {
			const data = getData();
			const searchIndex = data.searchEmbedIndex;
			const graphIndex = data.graphEmbedIndex;

			// Collect unique index IDs to initialize. When both purposes point at the
			// same model this is a single instance — the Set dedupes it.
			const indexIds = new Set<string>();
			if (searchIndex) indexIds.add(searchIndex);
			if (graphIndex) indexIds.add(graphIndex);

			if (indexIds.size > 0 && Platform.isMobile) {
				Logger.log(`[VectorStore] Mobile: deferring open of ${indexIds.size} index(es) to first use`);
				scheduleBulkRun("VectorStore", this.bulkAttempts, () => this.catchUpDeferredIndexes(indexIds));
			} else if (indexIds.size > 0) {
				await Promise.all(Array.from(indexIds, (indexId) => this.initializeInstance(indexId)));
			}

			// Register vault events
			this.registerEvents();

			this.isInitialized = true;
			Logger.log("[VectorStore] Initialized");
		} catch (error) {
			Logger.error("[VectorStore] Initialization failed:", error);
			throw error;
		}
	}

	private async initializeInstance(indexId: string): Promise<IndexInstance> {
		// Return existing if already open
		const existing = this.instances.get(indexId);
		if (existing) return existing;

		const pending = this.initializingInstances.get(indexId);
		if (pending) return pending;

		const initPromise = (async () => {
			const initStart = performance.now();
			const inst = this.createInstance(indexId);

			// Open IndexedDB — this is the sole persistence layer
			await StartupProfiler.measure(`vectorstore:open[${indexId}]`, () => inst.store.open());

			const [provider = "", ...modelParts] = indexId.split(":");
			const model = modelParts.join(":");

			const runtimeMeta = await inst.store.getMetadata();
			const versionCurrent = runtimeMeta !== null && runtimeMeta.version >= INDEX_VERSION;
			const runtimeMatches =
				runtimeMeta !== null &&
				runtimeMeta.documentCount > 0 &&
				runtimeMeta.providerId === provider &&
				runtimeMeta.modelId === model &&
				versionCurrent;

			if (runtimeMatches && runtimeMeta) {
				inst.currentProviderId = runtimeMeta.providerId;
				inst.currentModelId = runtimeMeta.modelId;
				this.recordDimensions(indexId, runtimeMeta.dimensions);

				Logger.log(
					`[VectorStore] Loaded index for ${indexId} from IDB (${runtimeMeta.documentCount} documents)`,
				);
			} else if (
				runtimeMeta &&
				(runtimeMeta.providerId !== provider || runtimeMeta.modelId !== model || !versionCurrent)
			) {
				const why = !versionCurrent
					? `schema v${runtimeMeta.version} < v${INDEX_VERSION} (pre-chunking)`
					: "model mismatch";
				Logger.log(`[VectorStore] Clearing index for ${indexId} (${why}), will rebuild on next use`);
				await this.clearStore(inst);
			}

			// The settings row reads a cached count from plugin data, which only the
			// runs above keep current. A build interrupted by a quit or reload never
			// reached its final checkpoint, so bring the cache up to date from what
			// the store actually holds before the row can render (#466).
			await this.notifyStatsChanged(inst);

			this.instances.set(indexId, inst);
			Logger.info(`[VectorStore] Init ${indexId}: ${Math.round(performance.now() - initStart)}ms`);
			// Every opened instance gets validated against the vault (missing, stale
			// and orphaned notes) — after the platform's bulk start delay.
			this.scheduleValidation(inst);
			return inst;
		})();

		this.initializingInstances.set(indexId, initPromise);
		try {
			return await initPromise;
		} finally {
			this.initializingInstances.delete(indexId);
		}
	}

	/**
	 * Get or create an instance for the given index ID.
	 * Lazily initializes instances when first accessed.
	 */
	async getOrCreateInstance(indexId: string): Promise<IndexInstance> {
		const existing = this.instances.get(indexId);
		if (existing) return existing;
		return this.initializeInstance(indexId);
	}

	/**
	 * Schedule the startup completeness validation of an open instance.
	 *
	 * Desktop runs it at once (next macrotask, after layout-ready). Mobile waits
	 * out the boot spike and backs off after crashed attempts — `scheduleBulkRun`
	 * and `BulkAttemptMarker` explain the measurements. One pending validation per
	 * instance; a no-op once the instance has validated this session.
	 */
	private scheduleValidation(inst: IndexInstance): void {
		if (inst.hasValidatedThisSession || inst.validationScheduled) return;
		inst.validationScheduled = true;
		this.plugin.app.workspace.onLayoutReady(() => {
			scheduleBulkRun("VectorStore", this.bulkAttempts, async () => {
				inst.validationScheduled = false;
				// Deleted or closed in the meantime.
				if (this.instances.get(inst.indexId) !== inst) return;
				await this.validateIndexOnStartup(inst);
			});
		});
	}

	/**
	 * Mobile boot catch-up: open the indexes that were deferred at init and
	 * validate them, in sequence so two graphs are never rehydrated at once. An
	 * index deselected since boot is left closed. Runs after the bulk start delay.
	 */
	private async catchUpDeferredIndexes(indexIds: Iterable<string>): Promise<void> {
		for (const indexId of indexIds) {
			if (!this.isActiveIndex(indexId)) continue;
			try {
				const inst = await this.getOrCreateInstance(indexId);
				await this.validateIndexOnStartup(inst);
			} catch (error) {
				Logger.error(`[VectorStore] Deferred open of ${indexId} failed:`, error);
			}
		}
	}

	/**
	 * Remember an index's vector width in plugin data, where the settings UI can
	 * read it without opening the index (on mobile that would spawn its worker).
	 */
	private recordDimensions(indexId: string, dimensions: number): void {
		if (!(dimensions > 0)) return;
		const data = getData();
		if (data.getEmbeddingIndex(indexId)?.dimensions === dimensions) return;
		data.updateEmbeddingIndexStats(indexId, { dimensions });
	}

	private async getEmbeddingMaxInputTokens(
		inst: IndexInstance,
		defaultModel: DefaultEmbedModel | null,
	): Promise<number> {
		if (!defaultModel) {
			return DEFAULT_EMBED_MAX_INPUT_TOKENS;
		}

		if (
			inst.maxInputTokensCache?.provider === defaultModel.provider &&
			inst.maxInputTokensCache.model === defaultModel.model
		) {
			return inst.maxInputTokensCache.maxInputTokens;
		}

		const [modelsDevData, openRouterData] = await Promise.all([
			fetchModelsDevData(),
			defaultModel.provider === "openrouter" ? fetchOpenRouterModels() : Promise.resolve(null),
		]);

		const ollamaData =
			defaultModel.provider === "ollama"
				? (() => {
						const ollamaAuth = getData().getResolvedProviderAuth("ollama");
						if (!ollamaAuth?.baseUrl) return null;
						return getOllamaModelsCache(ollamaAuth.baseUrl);
					})()
				: null;

		const metadata = hydrateEmbeddingModel(defaultModel.provider, defaultModel.model, {
			modelsDevData,
			openRouterData,
			ollamaData,
		});

		inst.maxInputTokensCache = {
			provider: defaultModel.provider,
			model: defaultModel.model,
			maxInputTokens: metadata.maxInputTokens,
		};

		return metadata.maxInputTokens;
	}

	private async getMaxEmbeddingContentLength(
		inst: IndexInstance,
		defaultModel: DefaultEmbedModel | null,
	): Promise<number> {
		const maxInputTokens = await this.getEmbeddingMaxInputTokens(inst, defaultModel);
		return maxInputTokens * CHARS_PER_TOKEN;
	}

	/**
	 * Validate the index against the vault on startup.
	 */
	private async validateIndexOnStartup(inst: IndexInstance): Promise<void> {
		const model = this.getModelForInstance(inst);
		if (!model) {
			Logger.log(`[VectorStore] No embedding model for ${inst.indexId}, skipping validation`);
			return;
		}

		if (!this.ensureProviderRegistered(model.provider)) {
			Logger.log(
				`[VectorStore] Provider "${model.provider}" not available for ${inst.indexId}, skipping validation`,
			);
			return;
		}

		const embeddings = this.getEmbeddingsForInstance(inst, model);
		if (!embeddings) {
			Logger.log(`[VectorStore] Failed to create embeddings for ${inst.indexId}, skipping validation`);
			return;
		}

		await this.validateIndexCompleteness(inst, embeddings, model);
	}

	/**
	 * Get the model for an index instance by parsing its indexId.
	 */
	private getModelForInstance(inst: IndexInstance): DefaultEmbedModel | null {
		const [provider, ...modelParts] = inst.indexId.split(":");
		const model = modelParts.join(":");
		if (!provider || !model) return null;
		return { provider, model };
	}

	/**
	 * Get or create embeddings for a specific instance.
	 */
	private getEmbeddingsForInstance(inst: IndexInstance, model: DefaultEmbedModel): EmbeddingsInterface | null {
		const registry = getRegistry();
		const authGeneration = registry.getAuthGeneration();
		// Reuse rule lives in `canReuseCachedEmbeddings` — see there for why the
		// credential generation has to participate.
		if (
			inst.embeddings &&
			canReuseCachedEmbeddings(
				{
					providerId: inst.currentProviderId,
					modelId: inst.currentModelId,
					authGeneration: inst.currentAuthGeneration,
				},
				model,
				authGeneration,
			)
		) {
			return inst.embeddings;
		}

		try {
			inst.embeddings = registry.createEmbeddingInstance(model.provider, model.model);
			inst.currentProviderId = model.provider;
			inst.currentModelId = model.model;
			inst.currentAuthGeneration = authGeneration;
			return inst.embeddings;
		} catch (error) {
			Logger.error(`[VectorStore] Failed to create embeddings for ${inst.indexId}:`, error);
			return null;
		}
	}

	/**
	 * Validate index completeness and update missing/stale entries.
	 */
	private async validateIndexCompleteness(
		inst: IndexInstance,
		embeddings: EmbeddingsInterface,
		defaultModel: DefaultEmbedModel,
	): Promise<void> {
		if (inst.hasValidatedThisSession) return;
		if (inst.isIndexing) {
			// A full build is writing every note right now; validating alongside it
			// would double-write the same chunks. `ensureIndex` marks the instance
			// validated when the build completes.
			Logger.log(`[VectorStore] Skipping validation of ${inst.indexId}: full build in progress`);
			return;
		}
		inst.hasValidatedThisSession = true;

		Logger.log(`[VectorStore] Validating index ${inst.indexId} against vault...`);

		const { vault } = this.plugin.app;
		const allVaultFiles = getEmbeddableVaultFiles(vault);
		const vaultFiles = allVaultFiles.filter((file) => this.shouldIndexFile(file, defaultModel.provider));

		// Per-note `{ path, mtime }` only — this never needs a vector, and reading
		// them all here (a whole-set `getAll()`) was one of the #432 memory spikes.
		// All chunks of a note share the same mtime, so last-write-wins is correct
		// for missing/stale detection should a note ever yield two entries.
		const indexedMap = new Map<string, { mtime: number }>();
		for (const note of await inst.store.listNoteMeta()) {
			indexedMap.set(note.path, { mtime: note.mtime });
		}

		// An empty store is not a repair job, it is a first build, and the two paths
		// differ in what they leave behind: only the full build writes the store's
		// metadata record (the version, dimensions and the id counter — see
		// `HNSWVectorStore.open`) and stamps `lastBuiltAt`. This was reachable for
		// every newly added index: "Add index" runs `ensureIndex`, whose opening of
		// the instance schedules this validation on a zero-delay timer, and the
		// timer wins the race against `ensureIndex`'s two worker round-trips.
		if (indexedMap.size === 0 && vaultFiles.length > 0) {
			Logger.log(`[VectorStore] ${inst.indexId} is empty — running a full build instead of a repair`);
			await this.buildFullIndex(inst, embeddings, defaultModel);
			return;
		}

		// A store built through the old validation path has rows but no metadata
		// record, so nothing persists its dimensions or id counter. Repair that
		// here, whether or not any note needs embedding, so the next open restores
		// both the normal way.
		if (indexedMap.size > 0 && (await inst.store.getMetadata()) === null) {
			Logger.log(`[VectorStore] ${inst.indexId} has rows but no metadata record — writing it`);
			await inst.store.setMetadata(defaultModel.provider, defaultModel.model, INDEX_VERSION);
		}

		const missingFiles: TFile[] = [];
		const staleFiles: TFile[] = [];
		const vaultPaths = new Set<string>();

		for (const file of vaultFiles) {
			vaultPaths.add(file.path);
			const indexed = indexedMap.get(file.path);
			if (!indexed) {
				missingFiles.push(file);
			} else if (indexed.mtime < file.stat.mtime) {
				staleFiles.push(file);
			}
		}

		const orphanedPaths: string[] = [];
		for (const path of indexedMap.keys()) {
			if (!vaultPaths.has(path)) orphanedPaths.push(path);
		}

		const totalUpdates = missingFiles.length + staleFiles.length + orphanedPaths.length;
		if (totalUpdates === 0) {
			Logger.log(`[VectorStore] Index ${inst.indexId} is up to date`);
			// Always sync document count to fix stale cached values
			await this.notifyStatsChanged(inst);
			this.markBuiltIfUnstamped(inst);
			return;
		}

		Logger.log(
			`[VectorStore] ${inst.indexId}: ${missingFiles.length} missing, ${staleFiles.length} stale, ${orphanedPaths.length} orphaned`,
		);

		if (orphanedPaths.length > 0) {
			for (const path of orphanedPaths) {
				await inst.store.remove(path);
			}
			Logger.log(`[VectorStore] Removed ${orphanedPaths.length} orphaned entries`);
			// Removal changes the count on its own; when nothing is left to embed,
			// no bulk run follows to sync it.
			await this.notifyStatsChanged(inst);
		}

		const filesToIndex = [...missingFiles, ...staleFiles];
		let cancelled = false;
		if (filesToIndex.length > 0) {
			const { startingIndexedCount, totalCount } = summarizeValidationProgressCounts({
				eligibleFileCount: vaultFiles.length,
				pendingFileCount: filesToIndex.length,
				validPendingFileCount: filesToIndex.length,
			});
			// Routine catch-ups of a handful of notes stay silent.
			const notice = filesToIndex.length > 5 ? new Notice("", 0) : null;

			this.updateInstanceProgress(inst, {
				isIndexing: true,
				total: totalCount,
				indexed: startingIndexedCount,
				skipped: 0,
				currentFile: null,
			});
			if (notice) this.updateNotice(notice, inst.progress);
			inst.abortController = new AbortController();

			let outcome: BulkEmbedOutcome;
			try {
				outcome = await this.embedFilesInBatches(inst, embeddings, defaultModel, filesToIndex, {
					startingIndexedCount,
					preFilterSkipped: 0,
					// A stale note is re-indexed with a possibly different chunk count;
					// its old chunks go first.
					purgeExisting: true,
					notice,
				});
			} catch (error) {
				// An unexpected abort (not a per-file failure) — don't leave a stuck
				// notice behind on top of whatever surfaced the error.
				notice?.hide();
				throw error;
			} finally {
				inst.abortController = null;
				this.updateInstanceProgress(inst, { isIndexing: false, currentFile: null });
			}
			cancelled = outcome.cancelled;

			if (notice) {
				notice.setMessage(
					cancelled
						? `Indexing cancelled (${outcome.indexedChunks} chunks updated)`
						: `✓ Index updated: ${outcome.indexedChunks} chunks`,
				);
				window.setTimeout(() => notice.hide(), 3000);
			}
			Logger.log(`[VectorStore] Indexed ${outcome.indexedChunks} chunks for ${inst.indexId}`);
		}

		// The note count was synced by the run's final checkpoint in
		// `embedFilesInBatches`, cancelled or not.
		if (!cancelled) this.markBuiltIfUnstamped(inst);
		Logger.log(`[VectorStore] Validation complete for ${inst.indexId}`);
	}

	/**
	 * Stamp `lastBuiltAt` on an index that has no build date but is now complete.
	 *
	 * Only the full build stamps the date, but a build cut short is finished by
	 * the startup validation on the next launch: that run covers every note the
	 * build missed, and what it leaves behind is exactly what an uninterrupted
	 * build would have produced. Without a date the settings row read
	 * "Build incomplete" for good, beside a count that said otherwise (#466).
	 * An existing date is left alone — a routine catch-up is not a rebuild.
	 */
	private markBuiltIfUnstamped(inst: IndexInstance): void {
		const data = getData();
		if (data.getEmbeddingIndex(inst.indexId)?.lastBuiltAt) return;
		data.updateEmbeddingIndexStats(inst.indexId, { lastBuiltAt: Date.now() });
	}

	/**
	 * Register vault file events for incremental updates.
	 * Events are only forwarded to active (selected) instances.
	 * Inactive instances are marked for re-validation on next use.
	 */
	private registerEvents(): void {
		const { vault } = this.plugin.app;

		this.plugin.registerEvent(
			vault.on("create", async (file) => {
				if (file instanceof TFile && isEmbeddableFile(file)) {
					await this.handleFileCreate(file);
				}
			}),
		);

		this.plugin.registerEvent(
			vault.on("modify", (file) => {
				if (file instanceof TFile && isEmbeddableFile(file)) {
					this.handleFileModify(file);
				}
			}),
		);

		this.plugin.registerEvent(
			vault.on("delete", async (file) => {
				if (file instanceof TFile) {
					await this.handleFileDelete(file);
				}
			}),
		);

		this.plugin.registerEvent(
			vault.on("rename", async (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				// No `isEmbeddableFile` gate here: renaming a note to a non-embeddable
				// extension (`note.md` → `note.base`) must still remove the old
				// path's chunks. `handleFileRename` removes first and re-indexes only
				// when the destination is still embeddable.
				await this.handleFileRename(file, oldPath);
			}),
		);
	}

	/**
	 * Check if an index is currently active (selected for search or graph).
	 */
	private isActiveIndex(indexId: string): boolean {
		const data = getData();
		return indexId === data.searchEmbedIndex || indexId === data.graphEmbedIndex;
	}

	/**
	 * Handle new file creation — forward to active instances only.
	 * Inactive instances are marked for re-validation on next use.
	 */
	private async handleFileCreate(file: TFile): Promise<void> {
		for (const inst of this.instances.values()) {
			if (!this.isActiveIndex(inst.indexId)) {
				inst.hasValidatedThisSession = false;
				continue;
			}
			if (!inst.embeddings || inst.isIndexing) continue;
			await this.indexDocumentForInstance(inst, file);
			void this.notifyStatsChanged(inst);
		}
	}

	/**
	 * Handle file modification — debounce re-embedding until 10s of inactivity.
	 * Inactive instances are marked for re-validation on next use.
	 */
	private handleFileModify(file: TFile): void {
		const existing = this.modifyTimers.get(file.path);
		if (existing) window.clearTimeout(existing);

		this.modifyTimers.set(
			file.path,
			window.setTimeout(() => {
				this.modifyTimers.delete(file.path);
				void this.reindexModifiedFile(file);
			}, MODIFY_DEBOUNCE_MS),
		);
	}

	/** Re-embed a modified note in every active instance whose stored copy is older. */
	private async reindexModifiedFile(file: TFile): Promise<void> {
		for (const inst of this.instances.values()) {
			if (!this.isActiveIndex(inst.indexId)) {
				inst.hasValidatedThisSession = false;
				continue;
			}
			if (!inst.embeddings || inst.isIndexing) continue;
			const storedMtime = await inst.store.getDocumentMtime(file.path);
			if (storedMtime && storedMtime >= file.stat.mtime) continue;
			await this.indexDocumentForInstance(inst, file);
			void this.notifyStatsChanged(inst);
		}
	}

	/**
	 * Handle file deletion — forward to active instances only.
	 * Inactive instances are marked for re-validation on next use.
	 */
	private async handleFileDelete(file: TFile): Promise<void> {
		for (const inst of this.instances.values()) {
			if (!this.isActiveIndex(inst.indexId)) {
				inst.hasValidatedThisSession = false;
				continue;
			}
			await inst.store.remove(file.path);
			void this.notifyStatsChanged(inst);
		}
	}

	/**
	 * Handle file rename — forward to active instances only.
	 * Inactive instances are marked for re-validation on next use.
	 */
	private async handleFileRename(file: TFile, oldPath: string): Promise<void> {
		for (const inst of this.instances.values()) {
			if (!this.isActiveIndex(inst.indexId)) {
				inst.hasValidatedThisSession = false;
				continue;
			}
			await inst.store.remove(oldPath);
			if (inst.embeddings) {
				await this.indexDocumentForInstance(inst, file);
			}
			void this.notifyStatsChanged(inst);
		}
	}

	/**
	 * Ensure a provider is registered in the runtime registry.
	 * VectorStoreService may need embeddings before the agent is initialized
	 * (which is the normal point of provider registration), so we register
	 * on demand here when needed.
	 */
	private ensureProviderRegistered(providerId: string): boolean {
		return ensureProviderRegistered(getData(), providerId);
	}

	/**
	 * Ensure the index is built for the given indexId.
	 * Called on-demand when embeddings search is used.
	 */
	async ensureIndex(indexId?: string): Promise<boolean> {
		const data = getData();
		const resolvedId = indexId ?? data.searchEmbedIndex;
		if (!resolvedId) {
			showSettingsLinkNotice(
				this.plugin.app,
				"No embedding model configured. Please set a default embedding model.",
				{
					tab: "search",
					linkText: "Open search settings",
				},
			);
			return false;
		}

		const inst = await this.getOrCreateInstance(resolvedId);
		const model = this.getModelForInstance(inst);
		if (!model) {
			showSettingsLinkNotice(this.plugin.app, "Invalid embedding index configuration.", {
				tab: "search",
				linkText: "Open search settings",
			});
			return false;
		}

		if (!this.ensureProviderRegistered(model.provider)) {
			showSettingsLinkNotice(this.plugin.app, `Provider "${model.provider}" is not configured.`, {
				tab: "general",
				linkText: "Open provider settings",
			});
			return false;
		}

		const embeddings = this.getEmbeddingsForInstance(inst, model);
		if (!embeddings) {
			showSettingsLinkNotice(this.plugin.app, "Failed to initialize embedding model.", {
				tab: "general",
				linkText: "Open provider settings",
			});
			return false;
		}

		// Rebuild if the model changed or the persisted index predates chunking.
		const meta = await inst.store.getMetadata();
		const modelChanged = meta && (meta.providerId !== model.provider || meta.modelId !== model.model);
		const versionStale = meta !== null && meta.version < INDEX_VERSION;

		if (modelChanged || versionStale) {
			Logger.log(
				`[VectorStore] Rebuilding index for ${resolvedId} (${versionStale ? `schema v${meta?.version} < v${INDEX_VERSION}` : "model changed"})`,
			);
			await this.clearStore(inst);
		}

		const count = await inst.store.count();
		if (count === 0 || modelChanged || versionStale) {
			await this.buildFullIndex(inst, embeddings, model);
			inst.hasValidatedThisSession = true;
		} else if (!inst.hasValidatedThisSession) {
			// Not awaited: the search proceeds on the stored index while the catch-up
			// runs after the platform's bulk start delay (immediate on desktop).
			this.scheduleValidation(inst);
		}

		return true;
	}

	/**
	 * Race an embedding call against the instance's abort signal.
	 *
	 * Every abort check in the indexing loops runs *after* an awaited embedding
	 * call, so they only fire if that call returns. When a provider endpoint is
	 * unreachable the request can hang far longer than any user will wait (and,
	 * before `REQUEST_TIMEOUT_MS` existed in `obsidianFetch`, indefinitely) — so
	 * Cancel appeared to do nothing and the progress notice froze at its last count.
	 *
	 * Racing makes Cancel take effect immediately. The underlying request is left
	 * running; it is bounded by the fetch-level timeout and its result is discarded,
	 * which is the right trade against pinning the UI on a dead endpoint.
	 *
	 * Throws `AbortError` when cancelled, so callers can distinguish "user stopped
	 * this" from a genuine provider failure.
	 */
	private async embedWithCancellation<T>(inst: IndexInstance, work: Promise<T>): Promise<T> {
		const signal = inst.abortController?.signal;
		if (!signal) return work;

		return Promise.race([
			work,
			new Promise<never>((_, reject) => {
				if (signal.aborted) {
					reject(new DOMException("Indexing cancelled", "AbortError"));
					return;
				}
				signal.addEventListener("abort", () => reject(new DOMException("Indexing cancelled", "AbortError")), {
					once: true,
				});
			}),
		]);
	}

	/**
	 * True when an error means "the provider is not reachable" rather than "this
	 * particular document could not be embedded".
	 *
	 * The distinction decides whether retrying can possibly help. A malformed
	 * document, a token-limit rejection or a content filter is specific to one
	 * input, so the per-entry fallback is worth running. A transport failure is a
	 * property of the *connection*, and will hit every remaining chunk identically.
	 */
	/**
	 * True only when the *user* cancelled — never for a transport failure.
	 *
	 * The distinction is load-bearing: a bare `error.name === "AbortError"` check
	 * also caught request timeouts (which reject with `TimeoutError`, but used to be
	 * flattened to `AbortError` in `obsidianFetch`), so a dead provider short-circuited
	 * the loop as if the user had pressed Cancel — skipping the unreachable-provider
	 * notice entirely.
	 */
	private isUserCancellation(error: unknown): boolean {
		return this.errorName(error) === "AbortError";
	}

	/**
	 * Read `.name` without an `instanceof Error` check.
	 *
	 * `DOMException` — which is what an aborted fetch rejects with — is not an
	 * `Error` subclass in every environment, so `instanceof` silently misses it and
	 * a timeout gets misread as an ordinary failure.
	 */
	private errorName(error: unknown): string | undefined {
		if (typeof error !== "object" || error === null) return undefined;
		const name = (error as { name?: unknown }).name;
		return typeof name === "string" ? name : undefined;
	}

	private isProviderUnreachable(error: unknown): boolean {
		// `AbortError` is deliberately NOT here: it means the *user* cancelled, which
		// callers handle separately (and treating it as a provider fault would show a
		// spurious "provider unreachable" notice on every cancel). `TimeoutError` is a
		// provider fault and must survive `isUserCancellation` above it.
		if (this.errorName(error) === "TimeoutError") return true;
		const message = error instanceof Error ? error.message : String(error);
		return /network error|you are offline|connection may have changed|fetch failed|failed to fetch|timed out|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|502|503|504/i.test(
			message,
		);
	}

	/**
	 * Abort the run when the provider has failed repeatedly, rather than grinding
	 * through every remaining chunk against a host that is plainly not answering.
	 *
	 * Without this, an unreachable endpoint produces one failed batch, then a
	 * per-entry retry of every chunk in it, then the next batch, and so on —
	 * hundreds of doomed requests (each with the SDK's own internal retries) while
	 * the progress notice sits frozen. Measured against a disconnected provider:
	 * still "Embedding batch 1" and unchanged at 310/370 after 107 s.
	 *
	 * The threshold is >1 so a single blip (one flaky request, a transient 502
	 * under load) still gets the existing per-entry retry path. Two consecutive
	 * transport failures is no longer a blip.
	 */
	private readonly UNREACHABLE_FAILURE_LIMIT = 2;

	private abortForUnreachableProvider(inst: IndexInstance, error: unknown, consecutiveFailures: number): boolean {
		if (!this.isProviderUnreachable(error) || consecutiveFailures < this.UNREACHABLE_FAILURE_LIMIT) return false;

		const reason = error instanceof Error ? error.message : String(error);
		Logger.error(
			`[VectorStore] Stopping indexing for ${inst.indexId}: provider unreachable after ${consecutiveFailures} consecutive failures — ${reason}`,
		);
		showActionNotice(
			"Indexing stopped — the embedding provider is not reachable. Check the connection, then resume.",
			settingsAction("search", "Open search settings"),
			10_000,
		);
		inst.abortController?.abort();
		return true;
	}

	/**
	 * Get the configured batch size for an index, falling back to provider defaults.
	 */
	private getBatchSize(indexId: string, providerId: string): number {
		const configuredBatchSize = getData().getEmbeddingIndex(indexId)?.batchSize;
		return normalizeEmbeddingBatchSize(configuredBatchSize ?? getDefaultEmbeddingBatchSize(providerId), providerId);
	}

	/**
	 * Build the full index for a specific instance. The store has been cleared
	 * (or is empty) when this is called, so chunks are written without purging.
	 */
	private buildFullIndex(
		inst: IndexInstance,
		embeddings: EmbeddingsInterface,
		model: DefaultEmbedModel,
	): Promise<void> {
		// One build per instance. The startup validation and `ensureIndex` can both
		// decide an empty store needs building; the second joins the first rather
		// than reporting "already in progress" against its own twin.
		if (inst.buildPromise) return inst.buildPromise;
		if (inst.isIndexing || inst.progress.isIndexing) {
			new Notice("Indexing already in progress...");
			return Promise.resolve();
		}
		inst.buildPromise = this.runFullBuild(inst, embeddings, model).finally(() => {
			inst.buildPromise = null;
		});
		return inst.buildPromise;
	}

	private async runFullBuild(
		inst: IndexInstance,
		embeddings: EmbeddingsInterface,
		model: DefaultEmbedModel,
	): Promise<void> {
		inst.isIndexing = true;
		inst.abortController = new AbortController();
		const { vault } = this.plugin.app;
		const allFiles = getEmbeddableVaultFiles(vault);

		// Categorize files by skip reason
		const files: TFile[] = [];
		const skippedFiles: SkippedFile[] = [];
		for (const file of allFiles) {
			const reason = this.getFileSkipReason(file, model.provider);
			if (reason) {
				skippedFiles.push({ path: file.path, reason });
			} else {
				files.push(file);
			}
		}
		const report: BulkEmbedReport = { indexedFiles: [], skippedFiles };

		this.updateInstanceProgress(inst, {
			isIndexing: true,
			total: files.length,
			indexed: 0,
			skipped: skippedFiles.length,
			currentFile: null,
			percentage: 0,
			etaMs: null,
		});

		const notice = new Notice("", 0);
		this.updateNotice(notice, inst.progress);

		try {
			await inst.store.setMetadata(model.provider, model.model, INDEX_VERSION);

			const { cancelled } = await this.embedFilesInBatches(inst, embeddings, model, files, {
				startingIndexedCount: 0,
				preFilterSkipped: skippedFiles.length,
				purgeExisting: false,
				notice,
				report,
			});

			// Save the indexing report
			inst.report = { ...report, timestamp: Date.now() };

			// The note count was synced by the run's final checkpoint; only a run
			// that reached the end counts as a build.
			if (!cancelled) {
				getData().updateEmbeddingIndexStats(inst.indexId, { lastBuiltAt: Date.now() });
			}

			const { indexed, skipped } = inst.progress;
			const skippedText = skipped > 0 ? `, ${skipped} skipped` : "";
			notice.setMessage(
				cancelled
					? `Indexing cancelled (${indexed} notes indexed so far)`
					: `✓ Indexed ${indexed} notes${skippedText}`,
			);
			window.setTimeout(() => notice.hide(), 3000);

			Logger.log(`[VectorStore] Full index complete for ${inst.indexId}: ${indexed} indexed, ${skipped} skipped`);
		} catch (error) {
			notice.hide();
			throw error;
		} finally {
			inst.isIndexing = false;
			inst.abortController = null;
			this.updateInstanceProgress(inst, { isIndexing: false, currentFile: null });
		}
	}

	/**
	 * Embed `files` into `inst`: the one bulk loop behind both the full build and
	 * the startup validation (they used to be near-identical copies). Paced and
	 * checkpointed the way the lexical build is — the constants and the
	 * measurements behind them live in `bulkPacing.ts`:
	 *
	 * - Files are read one at a time as the next batch fills, cheap text first and
	 *   PDFs last (`orderForBulkIndexing`), so the corpus text is never resident
	 *   all at once. The previous pre-read held every note's content before the
	 *   first embedding call — on the reference vault, the whole vault as strings.
	 * - After every embedding batch the loop pauses (a real pause on mobile, a
	 *   bare yield on desktop) so the WebView's GC keeps up.
	 * - Every `upsert` is durable on its own; every {@link BULK_CHECKPOINT_INTERVAL}
	 *   notes the graph topology is flushed too. A kill mid-run therefore costs at
	 *   most one interval of re-linking on the next open (`HNSWVectorStore.loadGraph`),
	 *   and the next validation resumes from what is stored — it compares per-note
	 *   mtimes and only embeds what is missing or stale — instead of starting over.
	 * - The crash marker is set before the first read and cleared when the run
	 *   survives (completed or user-cancelled), so a run the OS killed lengthens
	 *   the next scheduled start (`BulkAttemptMarker`).
	 *
	 * The caller owns `inst.abortController` (set before, cleared after) and the
	 * surrounding progress state; this reports per-note `indexed`/`skipped`.
	 */
	private async embedFilesInBatches(
		inst: IndexInstance,
		embeddings: EmbeddingsInterface,
		model: DefaultEmbedModel,
		files: TFile[],
		options: BulkEmbedOptions,
	): Promise<BulkEmbedOutcome> {
		const { vault } = this.plugin.app;
		const { notice, report } = options;
		const batchSize = this.getBatchSize(inst.indexId, model.provider);
		const maxContentLength = await this.getMaxEmbeddingContentLength(inst, model);
		const ordered = orderForBulkIndexing(files);

		// Progress is tracked in files (matching `total`), not chunks: a note is
		// counted once its final chunk is written, so a multi-chunk note advances
		// the bar by one, keeping `indexed <= total` and the ETA well-defined.
		// `skipped` is likewise counted in files; a note failing any chunk counts once.
		const indexedPaths = new Set<string>();
		const skippedPaths = new Set<string>();
		let indexedChunks = 0;
		let notesSinceCheckpoint = 0;
		let dimensionsRecorded = false;
		const noteIndexed = (path: string) => {
			if (indexedPaths.has(path)) return;
			indexedPaths.add(path);
			report?.indexedFiles.push(path);
			notesSinceCheckpoint++;
			this.updateInstanceProgress(inst, { indexed: options.startingIndexedCount + indexedPaths.size });
		};
		const noteSkipped = (path: string, reason: SkipReason) => {
			report?.skippedFiles.push({ path, reason });
			if (skippedPaths.has(path)) return;
			skippedPaths.add(path);
			this.updateInstanceProgress(inst, { skipped: options.preFilterSkipped + skippedPaths.size });
		};
		const refreshNotice = () => {
			if (notice) this.updateNotice(notice, inst.progress);
		};
		const aborted = () => inst.abortController?.signal.aborted === true;

		// A note may have been indexed previously (stale re-index) with a
		// different chunk count; drop its old chunks before writing new ones.
		const purgedPaths = new Set<string>();
		const writeVector = async (entry: ChunkEntry, vector: number[]) => {
			if (options.purgeExisting && !purgedPaths.has(entry.file.path)) {
				await inst.store.remove(entry.file.path);
				purgedPaths.add(entry.file.path);
			}
			if (!dimensionsRecorded) {
				dimensionsRecorded = true;
				this.recordDimensions(inst.indexId, vector.length);
			}
			const doc: DocumentVector = {
				id: makeChunkId(entry.file.path, entry.chunkIndex),
				path: entry.file.path,
				mtime: entry.file.stat.mtime,
				checksum: entry.checksum,
				chunkIndex: entry.chunkIndex,
				vector: new Float32Array(vector),
			};
			await inst.store.upsert(doc);
			indexedChunks++;
			// Chunk 0 is written last (see `orderChunksForWriting`), so its write completes the note.
			if (entry.chunkIndex === 0) noteIndexed(entry.file.path);
		};

		// A note that lost any chunk must not get its chunk 0 written. Chunk 0 is
		// the "note is indexed" marker (`orderChunksForWriting` puts it last), so
		// writing it after a sibling failed would leave a partial note that startup
		// validation reads as complete — its sections silently missing from
		// retrieval for as long as the note's mtime holds. Dropping the note's
		// remaining chunks instead leaves it without `#0`, and the next validation
		// pass re-indexes it whole.
		const failedPaths = new Set<string>();
		const noteFailed = (path: string, reason: SkipReason) => {
			failedPaths.add(path);
			noteSkipped(path, reason);
		};

		// Consecutive transport-level failures. Reset on any success, so a flaky
		// connection that recovers does not accumulate toward the limit.
		let consecutiveUnreachable = 0;
		let batchNumber = 0;

		/** Embed and store one batch. Resolves false when the run must stop. */
		const embedBatch = async (queued: ChunkEntry[]): Promise<boolean> => {
			const batch = queued.filter((entry) => !failedPaths.has(entry.file.path));
			if (batch.length === 0) return true;
			batchNumber++;
			this.updateInstanceProgress(inst, {
				currentFile: batch.length === 1 ? batch[0].file.path : `Embedding batch ${batchNumber}...`,
			});
			refreshNotice();

			try {
				const texts = batch.map((entry) => entry.embedText);
				const vectors = await this.embedWithCancellation(inst, embeddings.embedDocuments(texts));
				// The run may have been aborted (e.g. index deleted) while the
				// embedding call was in flight; bail before writing to a store
				// that could now be closed.
				if (aborted()) return false;
				// The connection answered, so any earlier failure was transient.
				consecutiveUnreachable = 0;
				if (!vectors || vectors.length === 0) {
					Logger.error(`[VectorStore] embedDocuments returned empty result for ${inst.indexId}`);
					for (const entry of batch) noteFailed(entry.file.path, "embed-error");
					return true;
				}
				for (let j = 0; j < batch.length; j++) {
					if (failedPaths.has(batch[j].file.path)) continue;
					if (!vectors[j]) {
						Logger.error(`[VectorStore] Empty vector for ${batch[j].file.path}`);
						noteFailed(batch[j].file.path, "embed-error");
						continue;
					}
					await writeVector(batch[j], vectors[j]);
				}
				return true;
			} catch (error) {
				// A cancelled batch must not fall through to the per-entry retry
				// below: that would re-issue every request in the batch against a
				// provider the user just asked us to stop talking to.
				if (this.isUserCancellation(error)) return false;
				Logger.warn(`[VectorStore] Batch ${batchNumber} failed, falling back to sequential:`, error);
				// A transport failure will hit every remaining chunk the same way,
				// so retrying this batch entry-by-entry is pure waste. Give the
				// connection one more chance, then stop the whole run.
				if (this.isProviderUnreachable(error)) {
					consecutiveUnreachable++;
					if (this.abortForUnreachableProvider(inst, error, consecutiveUnreachable)) return false;
					// Account for the batch before skipping the per-entry retry, so
					// the notes are reported as skipped rather than silently dropped
					// from a run that still claims success.
					for (const entry of batch) noteFailed(entry.file.path, "embed-error");
					return true;
				}
				consecutiveUnreachable = 0;

				for (const entry of batch) {
					if (aborted()) return false;
					if (failedPaths.has(entry.file.path)) continue;
					try {
						const vector = await this.embedWithCancellation(inst, embeddings.embedQuery(entry.embedText));
						if (!vector || vector.length === 0) {
							Logger.error(`[VectorStore] embedQuery returned empty result for ${entry.file.path}`);
							noteFailed(entry.file.path, "embed-error");
							continue;
						}
						await writeVector(entry, vector);
					} catch (entryError) {
						// Cancellation is not a per-file failure. Without this guard,
						// aborting mid-batch fires one error Notice per remaining
						// file and buries the "cancelled" message under them.
						if (this.isUserCancellation(entryError)) return false;
						Logger.error(`[VectorStore] Failed to index ${entry.file.path}:`, entryError);
						const reason = entryError instanceof Error ? entryError.message : String(entryError);
						new Notice(`Failed to embed ${entry.file.basename}: ${reason}`);
						noteFailed(entry.file.path, "embed-error");
					}
				}
				return true;
			}
		};

		/** Pacing after a batch: a checkpoint every interval of notes, a GC pause otherwise. */
		const afterBatch = async (): Promise<void> => {
			refreshNotice();
			if (notesSinceCheckpoint >= BULK_CHECKPOINT_INTERVAL) {
				notesSinceCheckpoint = 0;
				await inst.store.flush();
				// The notes just flushed are searchable now, so the count the
				// settings row shows must say so — not only once the run ends,
				// which an interrupted build never reaches (#466). Best effort:
				// a failed count read must not take the build down with it.
				try {
					await this.notifyStatsChanged(inst);
				} catch (error) {
					Logger.warn(`[VectorStore] Count sync for ${inst.indexId} failed:`, error);
				}
				await bulkPause(bulkCheckpointPauseMs());
			} else {
				await bulkPause(bulkBatchPauseMs());
			}
		};

		// Mark the attempt before the first read; cleared below only when the run
		// survives. See BulkAttemptMarker for why this drives the start backoff.
		this.bulkAttempts.markAttempt();
		let pending: ChunkEntry[] = [];
		let stopped = false;

		for (const file of ordered) {
			if (aborted()) {
				stopped = true;
				break;
			}
			try {
				const content = await readIndexableContent(vault, file);
				const checksum = this.hashContent(content);
				const chunks = chunkText(content, file.basename, maxContentLength);
				for (const chunk of orderChunksForWriting(chunks)) {
					pending.push({
						file,
						chunkIndex: chunk.chunkIndex,
						checksum,
						embedText: chunk.content,
					});
				}
			} catch (error) {
				Logger.error(`[VectorStore] Failed to read ${file.path}:`, error);
				// An unreadable note leaves the run entirely: it is skipped, and
				// `total` shrinks with it so the bar can still reach 100%.
				this.updateInstanceProgress(inst, { total: Math.max(0, inst.progress.total - 1) });
				noteSkipped(file.path, "read-error");
				continue;
			}

			while (pending.length >= batchSize) {
				const batch = pending.splice(0, batchSize);
				if (!(await embedBatch(batch))) {
					stopped = true;
					break;
				}
				await afterBatch();
			}
			if (stopped) break;
		}

		if (!stopped && pending.length > 0) {
			if (await embedBatch(pending)) await afterBatch();
		}
		pending = [];

		const cancelled = aborted();
		if (stopped && !cancelled) {
			Logger.log(`[VectorStore] Bulk embedding for ${inst.indexId} stopped early`);
		} else if (cancelled) {
			Logger.log(`[VectorStore] Indexing cancelled for ${inst.indexId}`);
		}
		// Final checkpoint. The store may already be closed if the run was cancelled
		// because the index was deleted; that is not a failure of this run.
		// This is also the one place the cached note count is brought up to date
		// for every way a run can end. A cancelled run keeps what it wrote, so
		// its count must reflect that too; the pre-#466 code synced only on
		// completion and a cancelled build reported "0 notes indexed".
		if (this.instances.get(inst.indexId) === inst) {
			try {
				await inst.store.flush();
				await this.notifyStatsChanged(inst);
			} catch (error) {
				Logger.warn(`[VectorStore] Final graph flush for ${inst.indexId} failed:`, error);
			}
		}
		// The run survived (a user cancel is not a crash); only an OS kill — or an
		// error thrown past this point — leaves the marker in place.
		this.bulkAttempts.clear();

		return { indexedChunks, cancelled };
	}

	/**
	 * Update the indexing notice with current progress.
	 */
	private updateNotice(notice: Notice, progress: IndexingProgress): void {
		const { indexed, skipped, total, percentage, etaMs } = progress;
		const skippedText = skipped > 0 ? ` (${skipped} skipped)` : "";
		const etaText = etaMs !== null ? ` (~${formatEta(etaMs)} left)` : "";

		const el = notice.messageEl;
		el.empty();

		const container = el.createDiv({ cls: "s2b-indexing-notice" });

		container.createDiv({
			cls: "s2b-indexing-status",
			text: `Indexing: ${indexed}/${total}${skippedText}${etaText}`,
		});

		const progressContainer = container.createDiv({ cls: "s2b-indexing-progress" });
		const progressFill = progressContainer.createDiv({ cls: "s2b-indexing-fill" });
		progressFill.setCssStyles({ width: `${percentage}%` });

		container.createDiv({
			cls: "s2b-indexing-percent",
			text: `${percentage}%`,
		});
	}

	/**
	 * Check if a file should be indexed based on internal filter rules and
	 * privacy rules. When a provider is specified, private files are blocked
	 * for untrusted providers.
	 */
	private shouldIndexFile(file: TFile, provider?: string): boolean {
		return this.getFileSkipReason(file, provider) === null;
	}

	/**
	 * Get the reason a file would be skipped, or null if it should be indexed.
	 */
	private getFileSkipReason(file: TFile, provider?: string): SkipReason | null {
		const pluginData = getData();
		if (!isEmbeddableFile(file)) return "excluded";

		// Privacy check: skip private files for untrusted providers
		if (provider && !pluginData.isProviderTrusted(provider)) {
			if (pluginData.isFilePrivate(file.path)) return "privacy";
		}

		return null;
	}

	/**
	 * Index a single document for a specific instance.
	 */
	private async indexDocumentForInstance(inst: IndexInstance, file: TFile): Promise<void> {
		const model = this.getModelForInstance(inst);
		if (!model) return;
		const embeddings = this.getEmbeddingsForInstance(inst, model);
		if (!embeddings) return;

		if (!this.shouldIndexFile(file, model.provider)) {
			Logger.log(`[VectorStore] Skipping ${file.path}: excluded by internal rules`);
			return;
		}

		try {
			const content = await readIndexableContent(this.plugin.app.vault, file);
			const maxContentLength = await this.getMaxEmbeddingContentLength(inst, model);
			const checksum = this.hashContent(content);
			const chunks = chunkText(content, file.basename, maxContentLength);

			// Embed all chunks first; only touch the store once every embedding
			// succeeded so a mid-way failure can't leave a note partially indexed.
			const vectors: Float32Array[] = [];
			for (const chunk of chunks) {
				const vector = await embeddings.embedQuery(chunk.content);
				if (!vector || vector.length === 0) {
					Logger.error(`[VectorStore] embedQuery returned empty result for ${file.path}`);
					new Notice(`Failed to embed ${file.basename}: empty result from model`);
					return;
				}
				vectors.push(new Float32Array(vector));
			}

			// Replace any prior version's chunks, then write the new ones — chunk 0
			// last, so the note only reads as indexed once every chunk is stored.
			await inst.store.remove(file.path);
			for (const i of orderChunksForWriting(chunks.map((_, index) => index))) {
				const doc: DocumentVector = {
					id: makeChunkId(file.path, chunks[i].chunkIndex),
					path: file.path,
					mtime: file.stat.mtime,
					checksum,
					chunkIndex: chunks[i].chunkIndex,
					vector: vectors[i],
				};
				await inst.store.upsert(doc);
			}

			Logger.log(`[VectorStore] Indexed: ${file.path} (${chunks.length} chunks, ${inst.indexId})`);
		} catch (error) {
			Logger.error(`[VectorStore] Failed to index ${file.path} (${inst.indexId}):`, error);
			const reason = error instanceof Error ? error.message : String(error);
			new Notice(`Failed to embed ${file.basename}: ${reason}`);
		}
	}

	/**
	 * Semantic (embedding-based) search for similar documents with optional filtering.
	 * Uses the search embed index by default.
	 */
	async semanticSearch(
		query: string,
		topK: number,
		threshold?: number,
		filter?: SearchFilter,
	): Promise<VectorSearchResult[]> {
		const isReady = await this.ensureIndex();
		if (!isReady) return [];

		const data = getData();
		const indexId = data.searchEmbedIndex;
		if (!indexId) return [];

		const inst = this.instances.get(indexId);
		if (!inst) return [];

		const model = this.getModelForInstance(inst);
		if (!model) return [];

		const embeddings = this.getEmbeddingsForInstance(inst, model);
		if (!embeddings) return [];

		try {
			// Asymmetric models (Qwen3-Embedding, harrier, BGE) want the query
			// wrapped in a task instruction that documents never carry — see
			// `queryInstruction.ts` for the families and the measured effect.
			// Documents are embedded raw at index time, so this is query-only
			// and needs no reindex.
			const embedInput = formatRetrievalQuery(model.model, query);
			const maxContentLength = await this.getMaxEmbeddingContentLength(inst, model);
			if (embedInput.length > maxContentLength) {
				Logger.warn(
					`[VectorStore] Query too large for embedding model (${embedInput.length} chars > ${maxContentLength} chars)`,
				);
				return [];
			}

			const queryVector = await embeddings.embedQuery(embedInput);
			if (!queryVector || queryVector.length === 0) {
				Logger.error("[VectorStore] embedQuery returned empty result for search query");
				return [];
			}
			const queryVectorTyped = new Float32Array(queryVector);

			const hasFilters = filter?.pathPrefixes?.length || filter?.tags?.length;
			// Over-fetch so filtering + chunk→note dedup still leaves enough
			// distinct notes to fill topK.
			const searchTopK = (hasFilters ? topK * 3 : topK) * CHUNK_OVERFETCH;

			const results = await inst.store.search(queryVectorTyped, searchTopK, threshold);

			const { metadataCache } = this.plugin.app;

			// Apply filters at the *chunk* level first, so aggregation only ever sees
			// chunks the caller is allowed to retrieve.
			const allowedHits: Array<{ path: string; score: number }> = [];
			const passedFilter = new Set<string>();
			const rejectedByFilter = new Set<string>();

			for (const r of results) {
				const path = r.doc.path;
				if (rejectedByFilter.has(path)) continue;

				if (!passedFilter.has(path)) {
					if (filter?.pathPrefixes?.length) {
						const matchesPath = filter.pathPrefixes.some((prefix) => matchesPathPrefix(path, prefix));
						if (!matchesPath) {
							rejectedByFilter.add(path);
							continue;
						}
					}

					if (filter?.tags?.length) {
						const file = this.plugin.app.vault.getAbstractFileByPath(path);
						const cache = file instanceof TFile ? metadataCache.getFileCache(file) : null;
						const docTags = cache ? (getAllTags(cache) ?? []) : [];
						const normalizedFilterTags = filter.tags.map((t) => (t.startsWith("#") ? t : `#${t}`));
						const normalizedDocTags = docTags.map((t) => (t.startsWith("#") ? t : `#${t}`));
						const matchesTag = (filterTag: string) =>
							normalizedDocTags.some(
								(docTag) => docTag === filterTag || docTag.startsWith(`${filterTag}/`),
							);

						const ok = filter.requireAllTags
							? normalizedFilterTags.every(matchesTag)
							: normalizedFilterTags.some(matchesTag);
						if (!ok) {
							rejectedByFilter.add(path);
							continue;
						}
					}

					passedFilter.add(path);
				}

				allowedHits.push({ path, score: r.score });
			}

			// Collapse chunk hits into note-level scores. A note matching in several
			// sections outranks one that got a single lucky chunk — see
			// `chunkAggregation.ts` for why first-hit-wins was not good enough.
			const aggregated = aggregateChunksToNotes(allowedHits);

			const filteredResults: VectorSearchResult[] = [];
			for (const note of aggregated) {
				if (filteredResults.length >= topK) break;

				const file = this.plugin.app.vault.getAbstractFileByPath(note.path);
				const cache = file instanceof TFile ? metadataCache.getFileCache(file) : null;
				const docTags = cache ? (getAllTags(cache) ?? []) : [];

				filteredResults.push({
					path: note.path,
					name: file instanceof TFile ? file.basename : note.path.replace(/.*\//, "").replace(/\.[^.]+$/, ""),
					frontmatter: cache?.frontmatter,
					tags: docTags,
					matchBadges: ["semantic"],
					score: note.score,
					rankingDebug: {
						bestChunkScore: note.bestChunkScore,
						matchingChunks: note.matchingChunks,
					},
				});
			}

			return filteredResults;
		} catch (error) {
			Logger.error("[VectorStore] Search failed:", error);
			// Returning [] alone makes a dead provider indistinguishable from "no
			// matching notes": the user sees an empty result list and concludes their
			// vault has no answer, when in fact the embedding endpoint never replied.
			// Surface it once, cheaply — the caller still gets [] so hybrid search can
			// fall back to its lexical leg rather than failing outright.
			this.noticeSearchFailureOnce(error);
			return [];
		}
	}

	/**
	 * Timestamp of the last search-failure Notice, for rate limiting.
	 *
	 * Search runs on every keystroke in the modal (debounced), so an unreachable
	 * provider would otherwise stack a Notice per query and bury the UI.
	 */
	private lastSearchFailureNoticeAt = 0;

	private noticeSearchFailureOnce(error: unknown): void {
		const now = Date.now();
		if (now - this.lastSearchFailureNoticeAt < 30_000) return;
		this.lastSearchFailureNoticeAt = now;

		const reason = error instanceof Error ? error.message : String(error);
		const offline = /network|offline|fetch failed|timed out|ECONNREFUSED|ENOTFOUND/i.test(reason);
		showActionNotice(
			offline
				? "Semantic search unavailable — the embedding provider is not reachable. Showing no semantic results."
				: `Semantic search failed: ${reason.slice(0, 120)}`,
			settingsAction("search", "Open search settings"),
			8000,
		);
	}

	/**
	 * Simple hash function for content change detection.
	 */
	private hashContent(content: string): string {
		let hash = 5381;
		for (let i = 0; i < content.length; i++) {
			hash = (hash * 33) ^ (content.codePointAt(i) ?? 0);
		}
		return (hash >>> 0).toString(16);
	}

	/**
	 * Get the current index stats for a specific index or the search index.
	 */
	async getStats(indexId?: string): Promise<{
		documentCount: number;
		providerId: string | null;
		modelId: string | null;
		isReady: boolean;
	}> {
		const data = getData();
		const resolvedId = indexId ?? data.searchEmbedIndex;

		if (!resolvedId) {
			return {
				documentCount: 0,
				providerId: null,
				modelId: null,
				isReady: false,
			};
		}

		const inst = await this.getOrCreateInstance(resolvedId);

		const noteCount = await inst.store.countNotes();
		const metadata = await inst.store.getMetadata();
		const model = this.getModelForInstance(inst);
		const isReady = this.isInitialized && model !== null;

		return {
			documentCount: noteCount,
			providerId: metadata?.providerId ?? inst.currentProviderId,
			modelId: metadata?.modelId ?? inst.currentModelId,
			isReady,
		};
	}

	/**
	 * Get progress for a specific index.
	 */
	getProgress(indexId?: string): IndexingProgress {
		// Resolved into a local rather than written back onto the parameter, which keeps
		// the caller's argument meaningful ("no index requested") distinct from the
		// default that was substituted for it.
		const resolvedId = indexId ?? getData().searchEmbedIndex ?? undefined;
		if (!resolvedId) {
			return {
				isIndexing: false,
				total: 0,
				indexed: 0,
				skipped: 0,
				currentFile: null,
				percentage: 0,
				etaMs: null,
			};
		}
		const inst = this.instances.get(resolvedId);
		if (!inst) {
			return {
				isIndexing: false,
				total: 0,
				indexed: 0,
				skipped: 0,
				currentFile: null,
				percentage: 0,
				etaMs: null,
			};
		}
		return { ...inst.progress };
	}

	/**
	 * Get the indexing report for a specific index.
	 * If no report exists from the last build, generates one on-demand
	 * by comparing the current index against all vault files.
	 */
	async getReport(indexId?: string): Promise<IndexingReport | null> {
		const data = getData();
		const resolvedId = indexId ?? data.searchEmbedIndex;
		if (!resolvedId) return null;

		const inst = this.instances.get(resolvedId);
		if (!inst) return null;

		// Return cached report if available
		if (inst.report) return inst.report;

		// Generate report on-demand from current state
		return this.generateReport(inst);
	}

	/**
	 * Generate an indexing report by comparing the current index state
	 * against all vault files, classifying each by its status.
	 */
	private async generateReport(inst: IndexInstance): Promise<IndexingReport> {
		const { vault } = this.plugin.app;
		const allFiles = getEmbeddableVaultFiles(vault);
		const model = this.getModelForInstance(inst);
		const provider = model?.provider;

		// Paths only — read from the store's key index, never its vectors.
		const indexedPaths = new Set((await inst.store.listNoteMeta()).map((note) => note.path));

		const indexedFiles: string[] = [...indexedPaths];
		const skippedFiles: SkippedFile[] = [];

		for (const file of allFiles) {
			if (indexedPaths.has(file.path)) continue;

			const reason = this.getFileSkipReason(file, provider);
			if (reason) {
				skippedFiles.push({ path: file.path, reason });
			} else {
				// File passed filters but isn't indexed yet
				skippedFiles.push({ path: file.path, reason: "not-indexed" });
			}
		}

		const report: IndexingReport = { indexedFiles, skippedFiles, timestamp: Date.now() };
		inst.report = report;
		return report;
	}

	/**
	 * Check if indexing is in progress for any instance.
	 */
	get isIndexing(): boolean {
		for (const inst of this.instances.values()) {
			if (inst.isIndexing) return true;
		}
		return false;
	}

	/**
	 * Subscribe to progress updates for a specific index.
	 */
	onProgress(callback: (progress: IndexingProgress) => void, indexId?: string): () => void {
		// Resolved into a local rather than written back onto the parameter, which keeps
		// the caller's argument meaningful ("no index requested") distinct from the
		// default that was substituted for it.
		const resolvedId = indexId ?? getData().searchEmbedIndex ?? undefined;
		if (!resolvedId) {
			callback({
				isIndexing: false,
				total: 0,
				indexed: 0,
				skipped: 0,
				currentFile: null,
				percentage: 0,
				etaMs: null,
			});
			return () => {};
		}

		// Register at service level so subscriptions survive instance recreation.
		// Keyed by resolvedId, and the returned unsubscribe closes over the same value,
		// so subscribe and unsubscribe cannot land on different keys.
		if (!this.progressListeners.has(resolvedId)) {
			this.progressListeners.set(resolvedId, new Set());
		}
		this.progressListeners.get(resolvedId)?.add(callback);

		// Send initial progress from existing instance if available
		const inst = this.instances.get(resolvedId);
		callback(
			inst
				? { ...inst.progress }
				: {
						isIndexing: false,
						total: 0,
						indexed: 0,
						skipped: 0,
						currentFile: null,
						percentage: 0,
						etaMs: null,
					},
		);

		return () => {
			const listeners = this.progressListeners.get(resolvedId);
			if (listeners) {
				listeners.delete(callback);
				if (listeners.size === 0) this.progressListeners.delete(resolvedId);
			}
		};
	}

	/**
	 * Update progress state for a specific instance and notify listeners.
	 */
	private updateInstanceProgress(inst: IndexInstance, partial: Partial<IndexingProgress>): void {
		const wasIndexing = inst.progress.isIndexing;
		Object.assign(inst.progress, partial);

		// Track the start of an indexing run so ETA measures only this run's rate.
		if (inst.progress.isIndexing && !wasIndexing) {
			inst.indexingStartedAt = Date.now();
			inst.indexingStartCount = inst.progress.indexed;
		} else if (!inst.progress.isIndexing) {
			inst.indexingStartedAt = null;
			inst.indexingStartCount = 0;
		}

		if (inst.progress.total > 0) {
			inst.progress.percentage = Math.round((inst.progress.indexed / inst.progress.total) * 100);
		}
		inst.progress.etaMs = this.estimateEtaMs(inst);
		const progress = { ...inst.progress };
		const listeners = this.progressListeners.get(inst.indexId);
		if (listeners) {
			for (const listener of listeners) {
				listener(progress);
			}
		}
	}

	/**
	 * Estimate milliseconds remaining for the current indexing run based on the
	 * rate of files processed so far. Returns null until enough progress has been
	 * made to produce a stable estimate.
	 */
	private estimateEtaMs(inst: IndexInstance): number | null {
		const { isIndexing, indexed, total } = inst.progress;
		if (!isIndexing || inst.indexingStartedAt === null || total <= 0) return null;

		const doneThisRun = indexed - inst.indexingStartCount;
		const remaining = total - indexed;
		if (doneThisRun <= 0 || remaining <= 0) return null;

		const elapsed = Date.now() - inst.indexingStartedAt;
		if (elapsed <= 0) return null;

		const msPerFile = elapsed / doneThisRun;
		return Math.round(msPerFile * remaining);
	}

	/**
	 * Update the cached document count in pluginData after a file event.
	 */
	private async notifyStatsChanged(inst: IndexInstance): Promise<void> {
		const noteCount = await inst.store.countNotes();
		getData().updateEmbeddingIndexStats(inst.indexId, { documentCount: noteCount });
	}

	/**
	 * Empty an index's store and reset the stats the settings row renders.
	 *
	 * `lastBuiltAt` records a *completed* build of the rows currently stored. Once
	 * they are gone the date describes nothing, and leaving it in place made a
	 * rebuild that is cancelled part-way read as built on that date rather than
	 * "Build incomplete" (#466).
	 */
	private async clearStore(inst: IndexInstance): Promise<void> {
		await inst.store.clear();
		getData().updateEmbeddingIndexStats(inst.indexId, { lastBuiltAt: null, documentCount: 0 });
	}

	/**
	 * Cancel ongoing indexing for a specific index.
	 */
	cancelIndexing(indexId: string): void {
		const inst = this.instances.get(indexId);
		if (inst?.abortController) {
			inst.abortController.abort();
			// The in-flight embedding call is raced against this signal rather than
			// awaited (`embedWithCancellation`), so cancelling takes effect at once —
			// it no longer waits out a request that may never return.
			new Notice("Cancelling indexing…");
		}
	}

	/**
	 * Clear and rebuild a specific index.
	 */
	async rebuildIndex(indexId?: string): Promise<void> {
		const data = getData();
		const resolvedId = indexId ?? data.searchEmbedIndex;
		if (!resolvedId) return;

		const inst = await this.getOrCreateInstance(resolvedId);
		await this.clearStore(inst);
		await this.ensureIndex(resolvedId);
	}

	/**
	 * Export an index to a user-chosen file via the system save dialog.
	 * Opens a native file picker and writes the serialized index as MessagePack.
	 *
	 * @returns true if the export succeeded, false if cancelled or empty.
	 */
	async exportIndex(indexId: string): Promise<boolean> {
		const inst = await this.getOrCreateInstance(indexId);
		const docs = await inst.store.getAllSerialized();
		if (docs.length === 0) {
			new Notice("Index is empty — nothing to export.");
			return false;
		}

		const filePath = showSaveDialog({
			title: "Export Embedding Index",
			defaultPath: `s2b-embeddings-${sanitizeIndexId(...this.splitIndexId(indexId))}.msgpack`,
			filters: [{ name: "MessagePack", extensions: ["msgpack"] }],
		});
		if (!filePath) return false; // User cancelled

		const [provider, model] = this.splitIndexId(indexId);
		const serialized: SerializedIndex = {
			version: INDEX_VERSION,
			providerId: provider,
			modelId: model,
			documents: docs,
			lastUpdated: Date.now(),
		};

		try {
			const encoded = encode(serialized);
			const fs = requireNodeModule<typeof import("node:fs")>("fs");
			fs.writeFileSync(filePath, new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength));
			Logger.log(`[VectorStore] Exported ${docs.length} documents to ${filePath}`);
			new Notice(`Exported ${docs.length} embeddings.`);
			return true;
		} catch (error) {
			Logger.error("[VectorStore] Export failed:", error);
			new Notice("Failed to export index.");
			return false;
		}
	}

	/**
	 * Import an index from a user-chosen MessagePack file via the system open dialog.
	 * Reads provider/model metadata from the file, registers the index, and
	 * bulk-loads embeddings into IDB.
	 *
	 * @param purpose Which index the caller is importing into. Only used to aim the
	 *   "Re-index" link on a failure notice at the right setup modal — importing into
	 *   the graph index must not send the user to reconfigure search.
	 * @returns The index ID that was imported, or null on failure/cancel.
	 */
	async importIndex(purpose: "search" | "graph" = "search"): Promise<string | null> {
		const filePaths = showOpenDialog({
			title: "Import Embedding Index",
			filters: [{ name: "MessagePack", extensions: ["msgpack"] }],
			properties: ["openFile"],
		});
		if (!filePaths || filePaths.length === 0) return null; // User cancelled

		try {
			const fs = requireNodeModule<typeof import("node:fs")>("fs");
			const raw = fs.readFileSync(filePaths[0]);
			const decoded = decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)) as SerializedIndex;

			if (typeof decoded.version !== "number" || !Number.isInteger(decoded.version)) {
				showActionNotice(
					"Export file has an invalid or missing version field. Re-index to regenerate a compatible export.",
					configureEmbedIndexAction(purpose, "Re-index"),
				);
				return null;
			}
			if (decoded.version < INDEX_VERSION) {
				showActionNotice(
					`Export file schema v${decoded.version} is outdated (current: v${INDEX_VERSION}). Re-index to regenerate a compatible export.`,
					configureEmbedIndexAction(purpose, "Re-index"),
				);
				return null;
			}
			if (decoded.version > INDEX_VERSION) {
				new Notice(
					`Export file was created with a newer plugin version (schema v${decoded.version}). Update the plugin to import it.`,
				);
				return null;
			}

			const { providerId: provider, modelId: model } = decoded;
			if (!provider || !model) {
				new Notice("Export file is missing provider or model metadata.");
				return null;
			}

			const indexId = `${provider}:${model}`;
			const inst = await this.getOrCreateInstance(indexId);
			await this.clearStore(inst);

			const docs: DocumentVector[] = decoded.documents.map((d) => ({
				id: d.id,
				path: d.path,
				mtime: d.mtime,
				checksum: d.checksum,
				vector: new Float32Array(d.vector),
				chunkIndex: d.chunkIndex,
			}));

			await inst.store.bulkPut(docs);
			await inst.store.setMetadata(provider, model, INDEX_VERSION);
			inst.currentProviderId = provider;
			inst.currentModelId = model;

			// One update, one save: the count and the build date must land together.
			// An export is a complete index by construction, so the import is a build.
			getData().updateEmbeddingIndexStats(indexId, {
				documentCount: await inst.store.countNotes(),
				lastBuiltAt: Date.now(),
			});

			Logger.log(`[VectorStore] Imported ${docs.length} documents for ${indexId}`);
			new Notice(`Imported ${docs.length} embeddings (${model}).`);
			return indexId;
		} catch (error) {
			Logger.error("[VectorStore] Failed to import index:", error);
			new Notice("Failed to import index. The file may be corrupted.");
			return null;
		}
	}

	/**
	 * Split an indexId ("provider:model") into [provider, model].
	 */
	private splitIndexId(indexId: string): [string, string] {
		const [provider = "", ...modelParts] = indexId.split(":");
		return [provider, modelParts.join(":")];
	}

	/**
	 * Delete an index completely: clear IndexedDB and remove instance.
	 */
	async deleteIndex(indexId: string): Promise<void> {
		const inst = this.instances.get(indexId);
		if (inst) {
			// Abort any in-flight indexing run so it stops writing to the store
			// we're about to clear, and flip progress off so listeners (e.g. the
			// settings progress bar) hide immediately instead of lingering. Keep
			// the abortController set (don't null it) so the loop's own
			// `signal.aborted` checks fire and it breaks out on its next tick.
			inst.abortController?.abort();
			this.updateInstanceProgress(inst, { isIndexing: false, currentFile: null, etaMs: null });
			inst.isIndexing = false;
			await inst.store.clear();
			await inst.store.close();
			this.instances.delete(indexId);
		}

		// Delete IndexedDB databases (HNSW + HNSW internal index).
		//
		// Awaited: `deleteDatabase` is asynchronous and reports through events, so a bare
		// call observes nothing and this method would resolve as if the databases were gone
		// whatever happened.
		//
		// Note the vectors are already gone by this point: when an instance existed,
		// `store.clear()` above emptied every object store and dropped the persisted HNSW
		// graph. What survives an incomplete deletion is an empty shell, so the risk here is
		// not stale data being read back — it is the queued-deletion hazard described below.
		//
		// A `"blocked"` result is treated as a failure, even though the deletion itself will
		// eventually go through. Another connection holds the database (a second Obsidian
		// window on the same vault). The request cannot be cancelled, so it stays queued and
		// fires whenever that connection closes — and if the config record were removed now,
		// the user could recreate the same "provider:model" index in the meantime and the
		// queued request would delete the *replacement* database, destroying a freshly built
		// HNSW graph.
		//
		// Keeping the config record is what prevents that: the index stays addressable, the
		// caller reports the failure, and a retry once the other connection is gone deletes
		// it cleanly.
		//
		// `-hnsw-index` is the pre-v3 sidecar database the `hnsw` library used to own. Schema
		// v3 stores the graph inside the main database and deletes the sidecar on upgrade,
		// but an index that was never reopened since still has one; deleting a database that
		// does not exist is a no-op, so it stays in the list.
		const hnswDbName = getDbName("s2b-hnsw", this.vaultId, indexId);
		const dbNames = [hnswDbName, `${hnswDbName}-hnsw-index`];
		const results = await Promise.all(dbNames.map((dbName) => deleteDatabase(dbName)));

		const failures: string[] = [];
		results.forEach((result, idx) => {
			if (result.status === "error") {
				Logger.error(`[VectorStore] Failed to delete IndexedDB database ${dbNames[idx]}:`, result.error);
				failures.push(`${dbNames[idx]}: ${result.error.message}`);
			} else if (result.status === "blocked") {
				Logger.warn(
					`[VectorStore] Deletion of IndexedDB database ${dbNames[idx]} is blocked by an open connection.`,
				);
				failures.push(
					`${dbNames[idx]}: blocked by another open connection (close other Obsidian windows for this vault and try again)`,
				);
			}
		});

		if (failures.length > 0) {
			throw new Error(`Could not delete stored vectors for ${indexId}: ${failures.join("; ")}`);
		}

		// Remove from plugin data
		getData().removeEmbeddingIndex(indexId);

		Logger.log(`[VectorStore] Deleted index ${indexId}`);
	}

	/**
	 * Cleanup and save state for all instances.
	 */
	async cleanup(): Promise<void> {
		try {
			for (const timer of this.modifyTimers.values()) window.clearTimeout(timer);
			this.modifyTimers.clear();
			// Wait for any in-progress initialization before cleaning up
			if (this.initPromise) {
				await this.initPromise.catch(() => {});
			}
			for (const inst of this.instances.values()) {
				await inst.store.close();
			}
			this.instances.clear();

			Logger.log("[VectorStore] Cleanup complete");
		} catch (error) {
			Logger.error("[VectorStore] Cleanup failed:", error);
		}

		instance = null;
		pendingInstance = null;
	}
}
