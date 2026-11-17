import type { RunnableConfig } from "@langchain/core/runnables";
import {
	BaseCheckpointSaver,
	type Checkpoint,
	type CheckpointListOptions,
	type CheckpointMetadata,
	type CheckpointPendingWrite,
	type CheckpointTuple,
	type DeltaChannelHistory,
	type PendingWrite,
	WRITES_IDX_MAP,
} from "@langchain/langgraph-checkpoint";
import { type DataAdapter, TFile, debounce, normalizePath } from "obsidian";
import type SecondBrainPlugin from "../main";
import { getData } from "../stores/dataStore.svelte";
import type { CheckpointHistoryItem } from "./Agent";
import type { ThreadSnapshot, ThreadStore } from "./memory/ThreadStore";
import { Logger } from "../utils/logging";
import { toBase64, toBase64DataUri } from "../utils/attachments";
import { gunzipToString, gzipString, toArrayBuffer } from "../utils/gzip";
import { isDefaultChatTitle } from "../utils/chatTitle";
import type { ChatAttachment } from "../types/shared";
import {
	type CheckpointEntry,
	type StoredWrite,
	THREAD_DATA_VERSION,
	type ThreadData,
	adoptEqualMessages,
	deflateThreadData,
	inflateThreadData,
} from "./threadDataCodec";
import {
	MESSAGES_CHANNEL,
	messageListOf,
	orderedStoredWrites,
	parentCheckpointIdOf,
	replayPathMessages,
	replayThreadMessages,
	reviveMessagesValue,
} from "./threadReplay";

export class ObsidianChatManager extends BaseCheckpointSaver {
	private plugin: SecondBrainPlugin;
	private adapter: DataAdapter;

	// In-memory cache: file path -> ThreadData (Loaded on demand)
	private storage: Map<string, ThreadData> = new Map();

	// Index cache: file path -> ThreadSnapshot (Loaded on startup)
	private threadIndex: Map<string, ThreadSnapshot> = new Map();

	private indexLoaded = false;
	private dirtyThreadVersions: Map<string, number> = new Map();
	private persistedThreadVersions: Map<string, number> = new Map();
	private inFlightThreadSaves: Map<string, Promise<void>> = new Map();
	/** Thread IDs loaded from a file whose version exceeds THREAD_DATA_VERSION. We must
	 *  not overwrite them — doing so would downgrade a newer-format file to an older schema. */
	private newerVersionThreadIds: Set<string> = new Set();

	constructor(plugin: SecondBrainPlugin) {
		super();
		this.plugin = plugin;
		this.adapter = plugin.app.vault.adapter;

		// When a .chat file is deleted externally, clean up in-memory caches.
		plugin.registerEvent(
			plugin.app.vault.on("delete", (file) => {
				if (file instanceof TFile && file.extension === "chat") {
					this.onChatFileDeleted(file.path);
				}
			}),
		);

		// When a .chat file is renamed externally, re-key in-memory caches.
		plugin.registerEvent(
			plugin.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && file.extension === "chat") {
					this.onChatFileRenamed(oldPath, file.path);
				}
			}),
		);
	}

	/**
	 * Handle external deletion of a .chat file (e.g., via Obsidian file explorer).
	 * Cleans up in-memory caches so stale threads don't appear in the UI.
	 */
	private onChatFileDeleted(filePath: string): void {
		const data = this.storage.get(filePath);
		if (data) this.newerVersionThreadIds.delete(data.threadId);
		this.storage.delete(filePath);
		this.threadIndex.delete(filePath);
		this.dirtyThreadVersions.delete(filePath);
		this.persistedThreadVersions.delete(filePath);
	}

	/**
	 * Handle external rename of a .chat file.
	 * Re-keys all in-memory caches from old path to new path.
	 */
	private onChatFileRenamed(oldPath: string, newPath: string): void {
		this.rekeyThread(oldPath, newPath);
	}

	/**
	 * Re-key all in-memory maps from oldPath to newPath.
	 */
	private rekeyThread(oldPath: string, newPath: string): void {
		const data = this.storage.get(oldPath);
		if (data) {
			if (this.newerVersionThreadIds.has(data.threadId)) {
				this.newerVersionThreadIds.delete(data.threadId);
				this.newerVersionThreadIds.add(newPath);
			}
			data.threadId = newPath;
			this.storage.delete(oldPath);
			this.storage.set(newPath, data);
		}

		const snapshot = this.threadIndex.get(oldPath);
		if (snapshot) {
			snapshot.threadId = newPath;
			this.threadIndex.delete(oldPath);
			this.threadIndex.set(newPath, snapshot);
		}

		const dirtyVersion = this.dirtyThreadVersions.get(oldPath);
		if (dirtyVersion !== undefined) {
			this.dirtyThreadVersions.delete(oldPath);
			this.dirtyThreadVersions.set(newPath, dirtyVersion);
		}

		const persistedVersion = this.persistedThreadVersions.get(oldPath);
		if (persistedVersion !== undefined) {
			this.persistedThreadVersions.delete(oldPath);
			this.persistedThreadVersions.set(newPath, persistedVersion);
		}

		const inFlight = this.inFlightThreadSaves.get(oldPath);
		if (inFlight) {
			this.inFlightThreadSaves.delete(oldPath);
			this.inFlightThreadSaves.set(newPath, inFlight);
		}
	}

	// --- File System Helpers ---

	private async readThreadFile(path: string): Promise<ThreadData> {
		const raw = await this.adapter.readBinary(path);
		const decompressed = await gunzipToString(raw);
		// Yield after decompression so JSON.parse doesn't block the same frame.
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
		const parsed = JSON.parse(decompressed) as ThreadData;
		if ((parsed.version ?? 0) > THREAD_DATA_VERSION) {
			Logger.warn(
				`[ChatManager] Thread file version ${parsed.version} is newer than supported ${THREAD_DATA_VERSION}. Some data may not display correctly.`,
			);
			this.newerVersionThreadIds.add(parsed.threadId);
		}
		return inflateThreadData(parsed);
	}

	private stripBase64FromChannelValues(channelValues: Record<string, unknown> | undefined): void {
		if (!channelValues) return;
		for (const value of Object.values(channelValues)) {
			this.stripBase64FromWriteValue(value);
		}
	}

	private stripBase64FromWriteValue(value: unknown): void {
		const list = messageListOf(value);
		if (list) {
			this.stripBase64FromMessages(list);
		} else if (value && typeof value === "object") {
			const msgs = (value as Record<string, unknown>).messages;
			if (Array.isArray(msgs)) this.stripBase64FromMessages(msgs);
		}
	}

	/**
	 * Turn a stored `messages` value back into what LangGraph wrote: a deep copy
	 * (callers may mutate it), base64 attachments rehydrated from the vault, and
	 * serialized messages revived as `BaseMessage` instances. Handles every shape
	 * the channel stores: a full list (legacy checkpoints), a `DeltaSnapshot`, an
	 * `Overwrite`, a single message, or a per-step write list.
	 */
	private async materializeMessagesValue(value: unknown, rehydrate = true): Promise<unknown> {
		if (value === undefined || value === null) return value;
		const copy = JSON.parse(JSON.stringify(value)) as unknown;
		const list = messageListOf(copy);
		if (list && rehydrate) await this.rehydrateBase64InMessages(list);
		return reviveMessagesValue(copy);
	}

	private stripBase64FromMessages(messages: unknown[]): void {
		for (const msg of messages) {
			const kwargs = (msg as Record<string, unknown>).kwargs as Record<string, unknown> | undefined;
			if (!kwargs) continue;
			const content = kwargs.content;
			if (!Array.isArray(content)) continue;
			const attachments = (kwargs.additional_kwargs as Record<string, unknown> | undefined)?.attachments as
				| ChatAttachment[]
				| undefined;
			if (!attachments?.length) continue;

			const imageAttachments = attachments.filter((a) => a.mimeType.startsWith("image/"));
			const pdfAttachments = attachments.filter((a) => a.mimeType === "application/pdf");
			let imageIdx = 0;
			let pdfIdx = 0;

			for (let i = 0; i < content.length; i++) {
				const block = content[i] as Record<string, unknown>;
				if (block.type === "image_url") {
					const url = (block.image_url as Record<string, unknown> | undefined)?.url as string | undefined;
					if (url?.startsWith("data:")) {
						const att = imageAttachments[imageIdx++];
						if (att) content[i] = { type: "image_url", image_url: { url: `vault://${att.vaultPath}` } };
					}
				} else if (block.type === "file" && block.source_type === "base64") {
					const att = pdfAttachments[pdfIdx++];
					if (att) {
						content[i] = {
							type: "file",
							source_type: "vault",
							vault_path: att.vaultPath,
							mime_type: att.mimeType,
							metadata: block.metadata,
						};
					}
				}
			}
		}
	}

	private async rehydrateBase64InMessages(messages: unknown[]): Promise<void> {
		const vault = this.plugin.app.vault;
		for (const msg of messages) {
			const kwargs = (msg as Record<string, unknown>).kwargs as Record<string, unknown> | undefined;
			if (!kwargs) continue;
			const content = kwargs.content;
			if (!Array.isArray(content)) continue;
			const attachments = (kwargs.additional_kwargs as Record<string, unknown> | undefined)?.attachments as
				| ChatAttachment[]
				| undefined;

			for (let i = 0; i < content.length; i++) {
				const block = content[i] as Record<string, unknown>;
				if (block.type === "image_url") {
					const url = (block.image_url as Record<string, unknown> | undefined)?.url as string | undefined;
					if (url?.startsWith("vault://")) {
						const vaultPath = url.slice("vault://".length);
						const file = vault.getAbstractFileByPath(vaultPath);
						if (file instanceof TFile) {
							const buffer = await vault.readBinary(file);
							const mimeType =
								attachments?.find((a) => a.vaultPath === vaultPath)?.mimeType ?? "image/png";
							content[i] = { type: "image_url", image_url: { url: toBase64DataUri(buffer, mimeType) } };
						} else {
							content[i] = { type: "text", text: `[Image at "${vaultPath}" is no longer available]` };
						}
					}
				} else if (block.type === "file" && block.source_type === "vault") {
					const vaultPath = block.vault_path as string;
					const file = vault.getAbstractFileByPath(vaultPath);
					if (file instanceof TFile) {
						const buffer = await vault.readBinary(file);
						content[i] = {
							type: "file",
							source_type: "base64",
							data: toBase64(buffer),
							mime_type: block.mime_type,
							metadata: block.metadata,
						};
					} else {
						content[i] = { type: "text", text: `[File at "${vaultPath}" is no longer available]` };
					}
				}
			}
		}
	}

	private getCheckpointTimestamp(entry: CheckpointEntry): number {
		const ts = entry.checkpoint?.ts;
		if (typeof ts !== "string") return 0;
		const parsed = Date.parse(ts);
		return Number.isNaN(parsed) ? 0 : parsed;
	}

	private getCheckpointStep(entry: CheckpointEntry): number {
		const step = entry.metadata?.step;
		return typeof step === "number" ? step : Number.NEGATIVE_INFINITY;
	}

	private getSortedCheckpointIds(threadData: ThreadData): string[] {
		return Object.entries(threadData.checkpoints)
			.sort((a, b) => {
				const tsDiff = this.getCheckpointTimestamp(b[1]) - this.getCheckpointTimestamp(a[1]);
				if (tsDiff !== 0) return tsDiff;

				const stepDiff = this.getCheckpointStep(b[1]) - this.getCheckpointStep(a[1]);
				if (stepDiff !== 0) return stepDiff;

				return b[0].localeCompare(a[0]);
			})
			.map(([id]) => id);
	}

	private getChatFolder(): string {
		const data = getData();
		return data.targetFolder;
	}

	/**
	 * Validate that a threadId resolves to a `.chat` file directly inside the
	 * configured chat folder before it is used as a filesystem path for a write
	 * or delete. A thread_id can arrive from an untrusted source (a crafted
	 * `.chat` embed, a hand-edited config, a malicious skill/tool), so a value
	 * like `../../../.obsidian/plugins/foo/main.js` must never reach
	 * `writeBinary`/`remove`. Returns the normalized path, or throws.
	 */
	private assertContainedThreadPath(threadId: string): string {
		const normalized = normalizePath(threadId);
		const folder = normalizePath(this.getChatFolder());
		const prefix = folder === "/" ? "" : `${folder}/`;

		const escapesFolder = !normalized.startsWith(prefix) || normalized.slice(prefix.length).includes("/");
		if (escapesFolder || !normalized.endsWith(".chat") || normalized.length <= prefix.length + ".chat".length - 1) {
			throw new Error(`Refusing to access thread outside chat folder: ${threadId}`);
		}
		return normalized;
	}

	private markThreadDirty(threadId: string): void {
		this.dirtyThreadVersions.set(threadId, (this.dirtyThreadVersions.get(threadId) ?? 0) + 1);
	}

	private async ensureFolder(): Promise<void> {
		const folder = this.getChatFolder();
		if (!(await this.adapter.exists(folder))) {
			await this.adapter.mkdir(folder);
		}
	}

	// --- Index Management ---

	async load(): Promise<void> {
		if (this.indexLoaded) return;
		await this.ensureFolder();
		await this.rebuildIndex();
	}

	async rebuildIndex(): Promise<void> {
		const folder = this.getChatFolder();
		if (!(await this.adapter.exists(folder))) return;

		const result = await this.adapter.list(folder);
		this.threadIndex.clear();
		this.storage.clear();

		for (const file of result.files) {
			if (!file.endsWith(".chat")) continue;

			try {
				const stat = await this.adapter.stat(file);
				if (!stat) continue;

				// Derive title from filename (strip .chat extension and folder)
				const basename =
					file
						.split("/")
						.pop()
						?.replace(/\.chat$/, "") ?? "";

				this.threadIndex.set(file, {
					threadId: file,
					title: basename || undefined,
					createdAt: stat.ctime,
					updatedAt: stat.mtime,
				});
			} catch (e) {
				Logger.error(`Failed to stat ${file} during index rebuild:`, e);
			}
		}

		this.indexLoaded = true;
	}

	// --- Thread Loading / Saving ---

	async ensureThreadLoaded(threadId: string): Promise<ThreadData | undefined> {
		if (this.storage.has(threadId)) return this.storage.get(threadId);

		try {
			if (await this.adapter.exists(threadId)) {
				const data = await this.readThreadFile(threadId);
				data.threadId = threadId; // Ensure threadId matches the file path
				this.storage.set(threadId, data);
				// Migrate pre-dedup files (quadratic full-history-per-checkpoint
				// encoding, issue #431): rewriting in the current format shrinks
				// them by orders of magnitude. Saving is a no-op content-wise, so
				// scheduling it here is safe even for read-only consumers.
				if ((data.version ?? 0) < THREAD_DATA_VERSION && Object.keys(data.checkpoints).length > 0) {
					data.version = THREAD_DATA_VERSION;
					this.markThreadDirty(threadId);
					this.saveDebounced(threadId);
				}
				return data;
			}
		} catch (e) {
			Logger.error(`Error loading thread ${threadId}:`, e);
		}
		return undefined;
	}

	/**
	 * Whether a thread has no checkpoints yet (a brand-new, unsubmitted chat).
	 * Cheap enough to call before loading a session so the UI can skip the
	 * loading skeleton for empty chats. Missing threads are treated as empty.
	 */
	async isThreadEmpty(threadId: string): Promise<boolean> {
		const data = await this.ensureThreadLoaded(threadId);
		if (!data) return true;
		return Object.keys(data.checkpoints).length === 0;
	}

	/**
	 * Reads a thread's checkpoints directly from its `.chat` file and returns them
	 * as `CheckpointHistoryItem[]` — the same shape `Agent.getCheckpointHistory`
	 * produces — so read-only consumers (e.g. the `.chat` embed preview) can build
	 * the branch graph without spinning up a live agent/session.
	 *
	 * Messages are rebuilt by `threadReplay` (delta-stored checkpoints included) as
	 * `BaseMessage` instances shared across checkpoints. Base64 blobs are NOT
	 * rehydrated (history views render attachments from their metadata), keeping
	 * this cheap.
	 */
	async readCheckpointHistory(path: string): Promise<CheckpointHistoryItem[]> {
		const data = await this.ensureThreadLoaded(normalizePath(path));
		if (!data) return [];

		// Replay rebuilds delta-stored checkpoints and normalizes each distinct
		// message once, instead of once per checkpoint that holds it.
		const replayed = replayThreadMessages(data);
		const results: CheckpointHistoryItem[] = [];
		for (const [checkpointId, entry] of Object.entries(data.checkpoints)) {
			const messages = replayed.get(checkpointId) ?? [];
			const step = typeof entry.metadata?.step === "number" ? entry.metadata.step : 0;
			const parentCheckpointId = entry.parentConfig?.configurable?.checkpoint_id as string | undefined;
			const ts = (entry.checkpoint as { ts?: unknown })?.ts;
			results.push({
				checkpointId,
				messages,
				step,
				parentCheckpointId,
				ts: typeof ts === "string" ? ts : undefined,
			});
		}
		return results;
	}

	private createThreadData(threadId: string): ThreadData {
		return {
			threadId,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			checkpoints: {},
			writes: {},
		};
	}

	/**
	 * Register a newly created thread in all in-memory caches.
	 * Call this after creating a new .chat file.
	 */
	registerNewThread(path: string): void {
		const data = this.createThreadData(path);
		this.storage.set(path, data);
		this.threadIndex.set(path, {
			threadId: path,
			createdAt: data.createdAt,
			updatedAt: data.updatedAt,
		});
		this.indexLoaded = true;
	}

	/**
	 * Find an existing empty "New Chat" thread (title still "New Chat" and no
	 * checkpoints yet), if any. Used to avoid creating duplicate new chats — a
	 * new chat stops being "new" once the user submits their first query, which
	 * renames the file away from "New Chat".
	 */
	async findEmptyNewChatThread(): Promise<string | undefined> {
		const threads = await this.listThreads();
		for (const thread of threads) {
			if (!isDefaultChatTitle(thread.threadId)) continue;

			const data = await this.ensureThreadLoaded(thread.threadId);
			if (data && Object.keys(data.checkpoints).length === 0) {
				return thread.threadId;
			}
		}
		return undefined;
	}

	private async saveThread(threadId: string) {
		const existingSave = this.inFlightThreadSaves.get(threadId);
		if (existingSave) {
			await existingSave;
			if ((this.persistedThreadVersions.get(threadId) ?? 0) >= (this.dirtyThreadVersions.get(threadId) ?? 0)) {
				return;
			}
		}

		const data = this.storage.get(threadId);
		if (!data) return;

		// Never overwrite a file that was written by a newer plugin version — doing so
		// would downgrade its schema and corrupt data the older plugin can't interpret.
		if (this.newerVersionThreadIds.has(threadId)) {
			Logger.warn(
				`[ChatManager] Skipping save of thread ${threadId} — file was created by a newer plugin version.`,
			);
			return;
		}

		let safePath: string;
		try {
			safePath = this.assertContainedThreadPath(threadId);
		} catch (e) {
			Logger.error(`Refusing to save thread with unsafe path: ${threadId}`, e);
			return;
		}

		await this.ensureFolder();
		const targetVersion = this.dirtyThreadVersions.get(threadId) ?? 0;

		let savePromise: Promise<void> | null = null;
		savePromise = (async () => {
			try {
				const compressed = await gzipString(JSON.stringify(deflateThreadData(data)));
				await this.adapter.writeBinary(safePath, toArrayBuffer(compressed));
				if ((this.dirtyThreadVersions.get(threadId) ?? 0) === targetVersion) {
					this.persistedThreadVersions.set(threadId, targetVersion);
				}

				// Update index
				this.threadIndex.set(threadId, {
					threadId: data.threadId,
					title: data.title,
					metadata: data.metadata,
					createdAt: data.createdAt,
					updatedAt: data.updatedAt,
				});
			} catch (e) {
				Logger.error(`Error saving thread ${threadId}:`, e);
			} finally {
				if (this.inFlightThreadSaves.get(threadId) === savePromise) {
					this.inFlightThreadSaves.delete(threadId);
				}
			}
		})();
		this.inFlightThreadSaves.set(threadId, savePromise);
		await savePromise;
	}

	private saveDebounced = debounce(
		(threadId: string) => {
			void this.saveThread(threadId);
		},
		2000,
		true,
	);

	// --- ThreadStore Implementation ---

	async read(threadId: string, forceReload = false): Promise<ThreadSnapshot | undefined> {
		if (!forceReload && this.threadIndex.has(threadId)) {
			return this.threadIndex.get(threadId);
		}

		const data = await this.ensureThreadLoaded(threadId);
		if (!data) return undefined;

		const snapshot: ThreadSnapshot = {
			threadId: data.threadId,
			title: data.title,
			metadata: data.metadata,
			createdAt: data.createdAt,
			updatedAt: data.updatedAt,
		};

		if (!this.threadIndex.has(threadId) || forceReload) {
			this.threadIndex.set(threadId, snapshot);
		}

		return snapshot;
	}

	async write(snapshot: ThreadSnapshot): Promise<void> {
		let data = await this.ensureThreadLoaded(snapshot.threadId);

		if (!data) {
			data = this.createThreadData(snapshot.threadId);
			data.createdAt = snapshot.createdAt;
			this.storage.set(snapshot.threadId, data);
		}

		data.title = snapshot.title;
		data.metadata = snapshot.metadata;
		data.updatedAt = snapshot.updatedAt;

		this.markThreadDirty(snapshot.threadId);
		this.saveDebounced(snapshot.threadId);
	}

	async delete(threadId: string): Promise<void> {
		await this.deleteThread(threadId);
	}

	async listThreads(): Promise<ThreadSnapshot[]> {
		await this.load();
		return Array.from(this.threadIndex.values()).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	asThreadStore(): ThreadStore {
		return {
			read: this.read.bind(this),
			write: this.write.bind(this),
			delete: this.delete.bind(this),
			list: this.listThreads.bind(this),
			clear: this.clear.bind(this),
			flush: this.flush.bind(this),
		};
	}

	async flush(threadId?: string): Promise<void> {
		if (threadId) {
			await this.saveThread(threadId);
		} else {
			const threadIds = new Set<string>([
				...this.storage.keys(),
				...this.dirtyThreadVersions.keys(),
				...this.inFlightThreadSaves.keys(),
			]);
			await Promise.all(Array.from(threadIds, (id) => this.saveThread(id)));
		}
	}

	async clear(): Promise<void> {
		await this.load();
		const ids = Array.from(this.threadIndex.keys()); // Use index keys as source of truth
		for (const id of ids) {
			await this.deleteThread(id);
		}
	}

	// --- CheckpointSaver Implementation ---

	async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
		const threadId = config.configurable?.thread_id;
		if (!threadId) return undefined;

		const threadData = await this.ensureThreadLoaded(threadId);
		if (!threadData) return undefined;

		const checkpointId = config.configurable?.checkpoint_id;

		if (checkpointId) {
			const entry = threadData.checkpoints[checkpointId];
			if (!entry) return undefined;

			const pendingWrites = await this.collectWritesWithErrors(threadData, checkpointId);
			const checkpoint = await this.materializeCheckpoint(entry.checkpoint);

			return {
				config,
				checkpoint,
				metadata: entry.metadata,
				parentConfig: entry.parentConfig,
				pendingWrites,
			};
		}

		const checkpoints = Object.values(threadData.checkpoints);
		if (checkpoints.length === 0) return undefined;

		const sortedCheckpointIds = this.getSortedCheckpointIds(threadData);
		const latestId = sortedCheckpointIds[0];
		if (!latestId) return undefined;
		const entry = threadData.checkpoints[latestId];

		const pendingWrites = await this.collectWritesWithErrors(threadData, latestId);
		const checkpoint = await this.materializeCheckpoint(entry.checkpoint);

		return {
			config: {
				...config,
				configurable: { ...config.configurable, checkpoint_id: latestId },
			},
			checkpoint,
			metadata: entry.metadata,
			parentConfig: entry.parentConfig,
			pendingWrites,
		};
	}

	/**
	 * A deep copy of a stored checkpoint with its `messages` channel value
	 * materialized (see {@link materializeMessagesValue}); other channels are
	 * plain JSON, as before.
	 */
	private async materializeCheckpoint(stored: Checkpoint, rehydrate = true): Promise<Checkpoint> {
		const checkpoint = JSON.parse(JSON.stringify(stored)) as Checkpoint;
		const values = checkpoint.channel_values as Record<string, unknown> | undefined;
		if (values && Object.prototype.hasOwnProperty.call(values, MESSAGES_CHANNEL)) {
			values[MESSAGES_CHANNEL] = await this.materializeMessagesValue(values[MESSAGES_CHANNEL], rehydrate);
		}
		return checkpoint;
	}

	private orderedWrites(threadData: ThreadData, checkpointId: string): StoredWrite[] {
		return orderedStoredWrites(threadData, checkpointId);
	}

	/** A stored write as LangGraph's `[taskId, channel, value]`, `messages` values materialized. */
	private async toPendingWrite(write: StoredWrite, rehydrate = true): Promise<CheckpointPendingWrite> {
		const [taskId, channel, value] = write;
		return [
			taskId,
			channel,
			channel === MESSAGES_CHANNEL ? await this.materializeMessagesValue(value, rehydrate) : value,
		];
	}

	/**
	 * Collects pending writes for a checkpoint, including error writes from child checkpoints.
	 * This is needed because errors are written to a child checkpoint that may not exist in the checkpoints map.
	 */
	private async collectWritesWithErrors(
		threadData: ThreadData,
		checkpointId: string,
	): Promise<CheckpointPendingWrite[]> {
		const writes: CheckpointPendingWrite[] = [];

		// Add writes from the specific checkpoint, in replay order
		for (const write of this.orderedWrites(threadData, checkpointId)) {
			writes.push(await this.toPendingWrite(write));
		}

		// Collect ALL error writes from the entire thread
		// This is needed because each errored user message has its own error in a subsequent checkpoint
		const allWriteKeys = Object.keys(threadData.writes).sort();
		for (const writeKey of allWriteKeys) {
			// Skip the checkpoint we already added
			if (writeKey === checkpointId) continue;

			for (const write of threadData.writes[writeKey]) {
				if (write[1] === "__error__") writes.push([write[0], write[1], write[2]]);
			}
		}

		return writes;
	}

	async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
		const threadId = config.configurable?.thread_id;
		if (!threadId) return;

		const threadData = await this.ensureThreadLoaded(threadId);
		if (!threadData) return;

		const sortedCheckpointIds = this.getSortedCheckpointIds(threadData);
		if (sortedCheckpointIds.length === 0) return;

		const beforeId = options?.before?.configurable?.checkpoint_id;
		let keysToIterate = sortedCheckpointIds;
		if (typeof beforeId === "string") {
			const beforeIndex = sortedCheckpointIds.indexOf(beforeId);
			if (beforeIndex < 0) {
				return;
			}
			keysToIterate = sortedCheckpointIds.slice(beforeIndex + 1);
		}

		for (const key of keysToIterate) {
			const entry = threadData.checkpoints[key];
			// Listing is for history views: revive messages but skip the vault reads
			// that rehydrating attachments would cost on every checkpoint.
			const pendingWrites: CheckpointPendingWrite[] = [];
			for (const write of this.orderedWrites(threadData, key)) {
				pendingWrites.push(await this.toPendingWrite(write, false));
			}

			yield {
				config: {
					...config,
					configurable: { ...config.configurable, checkpoint_id: key },
				},
				checkpoint: await this.materializeCheckpoint(entry.checkpoint, false),
				metadata: entry.metadata,
				parentConfig: entry.parentConfig,
				pendingWrites,
			};

			if (options?.limit && --options.limit <= 0) break;
		}
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	private isAiSerializedMessage(message: Record<string, unknown>): boolean {
		if (typeof message.role === "string" && message.role.toLowerCase() === "assistant") {
			return true;
		}

		if (typeof message.type === "string") {
			const type = message.type.toLowerCase();
			if (type === "ai" || type === "aimessage" || type === "aimessagechunk") {
				return true;
			}
		}

		const identifier = message.id;
		if (Array.isArray(identifier) && typeof identifier[identifier.length - 1] === "string") {
			const className = (identifier[identifier.length - 1] as string).toLowerCase();
			return className === "aimessage" || className === "aimessagechunk";
		}

		if (typeof identifier === "string") {
			const className = identifier.split(":").pop()?.toLowerCase();
			return className === "aimessage" || className === "aimessagechunk";
		}

		return false;
	}

	/**
	 * The payload of a serialized message, which lives under `kwargs` (LangChain's
	 * Serializable form), `data` (the older envelope), or on the record itself.
	 * Mirrors the shapes `getOrCreateResponseMetadata` writes through.
	 */
	private getSerializedPayload(message: Record<string, unknown>): Record<string, unknown> {
		if (this.isRecord(message.kwargs)) return message.kwargs;
		if (this.isRecord(message.data)) return message.data;
		return message;
	}

	/** True when a serialized AI message carries tool calls (dispatch/subagent turn). */
	private hasSerializedToolCalls(message: Record<string, unknown>): boolean {
		const payload = this.getSerializedPayload(message);
		if (Array.isArray(payload.tool_calls) && payload.tool_calls.length > 0) return true;
		// Anthropic-style block content records the call as a `tool_use` block.
		const content = payload.content;
		if (Array.isArray(content)) {
			return content.some((block) => this.isRecord(block) && block.type === "tool_use");
		}
		return false;
	}

	/**
	 * True when a serialized AI message has non-whitespace text, matching the read
	 * side's `converted.content.trim()` test. Content is either a flat string (a
	 * replayed checkpoint) or an array of blocks (a live Anthropic response), in
	 * which case only `text` blocks count.
	 */
	private hasSerializedTextContent(message: Record<string, unknown>): boolean {
		const content = this.getSerializedPayload(message).content;
		if (typeof content === "string") return content.trim().length > 0;
		if (Array.isArray(content)) {
			return content.some(
				(block) =>
					this.isRecord(block) &&
					block.type === "text" &&
					typeof block.text === "string" &&
					block.text.trim().length > 0,
			);
		}
		return false;
	}

	/**
	 * The last AI message the reader would accept as the answer: non-empty
	 * content, and no tool calls (which mark a dispatch or a subagent turn
	 * rather than the final answer). Works on stored (serialized) messages.
	 */
	private findAnswerMessage(messages: unknown[]): Record<string, unknown> | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (!this.isRecord(message) || !this.isAiSerializedMessage(message)) continue;
			if (this.hasSerializedToolCalls(message)) continue;
			if (!this.hasSerializedTextContent(message)) continue;
			return message;
		}
		return undefined;
	}

	private getOrCreateResponseMetadata(message: Record<string, unknown>): Record<string, unknown> | undefined {
		if (this.isRecord(message.kwargs)) {
			const kwargs = message.kwargs;
			if (!this.isRecord(kwargs.response_metadata)) {
				kwargs.response_metadata = {};
			}
			return this.isRecord(kwargs.response_metadata) ? kwargs.response_metadata : undefined;
		}

		if (this.isRecord(message.data)) {
			const data = message.data;
			if (!this.isRecord(data.response_metadata)) {
				data.response_metadata = {};
			}
			return this.isRecord(data.response_metadata) ? data.response_metadata : undefined;
		}

		if (!this.isRecord(message.response_metadata)) {
			message.response_metadata = {};
		}
		return this.isRecord(message.response_metadata) ? message.response_metadata : undefined;
	}

	/**
	 * Stamps the wall-clock thinking duration (ms) for a finished turn onto the
	 * final AI message of the given checkpoint, so the "Thought for Ns" label
	 * survives reload. Mirrors annotateCheckpointMessagesWithGeneration: writes a
	 * scalar into the message's response_metadata, which round-trips through the
	 * NDJSON checkpoint. Called post-completion from ChatSession (the duration isn't
	 * known during the graph's own `put`).
	 *
	 * The target must be the message the READ side will look at, which is the last
	 * top-level AI message with NON-EMPTY content (`mergeAssistantMessages` skips
	 * empty turns, since their text is not the answer, and subagent turns, whose
	 * text is intermediate reasoning). Targeting the last AI message outright — as
	 * this did — disagreed with that rule whenever the checkpoint ended with a
	 * tool-calling turn that had no prose, or with a subagent's own turn. The write
	 * then landed on a message the reader ignores, the duration came back undefined
	 * on reload, and the UI fell to its 1s floor: a long run redisplayed as
	 * "Thought for 1s" after a restart.
	 *
	 * A subagent turn is identified the same way the reader identifies it: an AI
	 * message carrying tool calls, none of which are `task`, that follows a closed
	 * `task` call. Rather than duplicate that state machine here, we approximate it
	 * conservatively — skip trailing AI messages that carry tool calls — which lands
	 * on the same message for every shape the reader accepts, because any AI message
	 * the reader treats as the answer carries prose and no pending tool calls.
	 */
	async annotateThinkingDuration(threadId: string, checkpointId: string, durationMs: number): Promise<void> {
		if (!threadId || !checkpointId || !Number.isFinite(durationMs) || durationMs < 0) return;
		const threadData = await this.ensureThreadLoaded(threadId);
		const entry = threadData?.checkpoints[checkpointId];
		if (!entry) return;

		// A checkpoint that stores its own full list (every checkpoint before
		// `messages` became a delta channel) is stamped directly.
		const ownValues = entry.checkpoint.channel_values as Record<string, unknown> | undefined;
		const ownList = Array.isArray(ownValues?.[MESSAGES_CHANNEL])
			? (ownValues[MESSAGES_CHANNEL] as unknown[])
			: undefined;
		let changed = false;
		const stampRaw = (raw: Record<string, unknown>) => {
			const responseMetadata = this.getOrCreateResponseMetadata(raw);
			if (!responseMetadata || responseMetadata.thinking_duration_ms === durationMs) return;
			responseMetadata.thinking_duration_ms = durationMs;
			changed = true;
		};

		if (ownList) {
			const target = this.findAnswerMessage(ownList);
			if (target) stampRaw(target);
		} else {
			// A delta step stores no messages: find the answer in the replayed list,
			// then stamp every stored copy of it the branch reads from — the
			// `messages` writes along the path and the snapshot the path starts
			// from. Later snapshots are taken from state loaded through these
			// copies, so they carry the stamp too.
			const replayed = replayPathMessages(threadData, checkpointId);
			const serialized = replayed.map((message) => message.toJSON() as unknown);
			const answer = this.findAnswerMessage(serialized);
			const targetId = answer ? replayed[serialized.indexOf(answer)]?.id : undefined;
			if (!targetId) return;
			const stampCopy = (raw: unknown) => {
				if (this.isRecord(raw) && storedMessageId(raw) === targetId) stampRaw(raw);
			};
			const visited = new Set<string>();
			let cursor: string | undefined = checkpointId;
			while (cursor && !visited.has(cursor)) {
				visited.add(cursor);
				const current: CheckpointEntry | undefined = threadData.checkpoints[cursor];
				if (!current) break;
				const values = current.checkpoint.channel_values as Record<string, unknown> | undefined;
				if (values && values[MESSAGES_CHANNEL] !== undefined) {
					for (const raw of messageListOf(values[MESSAGES_CHANNEL]) ?? []) stampCopy(raw);
					break;
				}
				const parentId = parentCheckpointIdOf(current);
				for (const write of parentId ? (threadData.writes[parentId] ?? []) : []) {
					if (write[1] === MESSAGES_CHANNEL) for (const raw of messageListOf(write[2]) ?? []) stampCopy(raw);
				}
				cursor = parentId;
			}
		}
		if (!changed) return;

		this.markThreadDirty(threadId);
		this.saveDebounced(threadId);
	}

	async put(
		config: RunnableConfig,
		checkpoint: Checkpoint,
		metadata: CheckpointMetadata,
		_newVersions: Record<string, number | string>,
	): Promise<RunnableConfig> {
		const threadId = config.configurable?.thread_id;
		const checkpointId = checkpoint.id;
		if (!threadId || !checkpointId) return config;

		let threadData = await this.ensureThreadLoaded(threadId);
		if (!threadData) {
			threadData = this.createThreadData(threadId);
			this.storage.set(threadId, threadData);
		}

		// Sanitize to plain JSON
		const plainCheckpoint = JSON.parse(JSON.stringify(checkpoint));
		const plainMetadata = JSON.parse(JSON.stringify(metadata));
		this.stripBase64FromChannelValues(plainCheckpoint.channel_values);

		// Share unchanged history with the parent checkpoint so a live session
		// holds each message once instead of one deep copy per step (#431).
		const parentCheckpointId = config.configurable?.checkpoint_id;
		if (typeof parentCheckpointId === "string") {
			adoptEqualMessages(plainCheckpoint, threadData.checkpoints[parentCheckpointId]?.checkpoint);
		}

		// A thread's first checkpoint has no parent. Storing the id-less run config
		// as its parent would make `getTuple(parentConfig)` resolve to the latest
		// checkpoint, so a walk up the ancestors (LangGraph's own delta replay
		// included) would loop back down another branch.
		threadData.checkpoints[checkpointId] = {
			checkpoint: plainCheckpoint,
			metadata: plainMetadata,
			...(typeof parentCheckpointId === "string" && parentCheckpointId.length > 0
				? { parentConfig: config }
				: {}),
		};

		threadData.updatedAt = Date.now();
		this.markThreadDirty(threadId);
		this.saveDebounced(threadId);

		// Update index cache immediately
		if (this.threadIndex.has(threadId)) {
			const snap = this.threadIndex.get(threadId);
			if (snap) {
				snap.updatedAt = threadData.updatedAt;
			}
		} else {
			this.threadIndex.set(threadId, {
				threadId: threadData.threadId,
				title: threadData.title,
				metadata: threadData.metadata,
				createdAt: threadData.createdAt,
				updatedAt: threadData.updatedAt,
			});
		}

		return {
			...config,
			configurable: {
				...config.configurable,
				checkpoint_id: checkpointId,
			},
		};
	}

	/**
	 * Store a task's writes on the checkpoint it ran from, keyed like LangGraph's
	 * own savers: `(taskId, idx)`, where special channels (error, interrupt,
	 * resume, scheduled) take a fixed negative index and replace an earlier write
	 * of the same kind, and a regular write is never stored twice. The task path
	 * is kept for `writesSortKey` ordering.
	 */
	async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string): Promise<void> {
		const threadId = config.configurable?.thread_id;
		const checkpointId = config.configurable?.checkpoint_id;

		if (!threadId || !checkpointId) return;

		let threadData = await this.ensureThreadLoaded(threadId);
		if (!threadData) {
			threadData = this.createThreadData(threadId);
			this.storage.set(threadId, threadData);
		}

		if (!threadData.writes[checkpointId]) {
			threadData.writes[checkpointId] = [];
		}

		const stored = threadData.writes[checkpointId];
		const plainWrites = JSON.parse(JSON.stringify(writes)) as PendingWrite[];
		plainWrites.forEach(([channel, value], position) => {
			const idx = WRITES_IDX_MAP[channel] ?? position;
			const existing = stored.findIndex((write) => write[0] === taskId && write[4] === idx);
			if (existing >= 0 && idx >= 0) return;
			this.stripBase64FromWriteValue(value);
			const record: StoredWrite = [taskId, channel, value, taskPath ?? "", idx];
			if (existing >= 0) stored[existing] = record;
			else stored.push(record);
		});
		threadData.updatedAt = Date.now();
		this.markThreadDirty(threadId);
		this.saveDebounced(threadId);

		if (this.threadIndex.has(threadId)) {
			const snapshot = this.threadIndex.get(threadId);
			if (!snapshot) return;
			snapshot.updatedAt = threadData.updatedAt;
		}
	}

	/**
	 * Rebuild `DeltaChannel` inputs straight from the loaded thread: walk the
	 * parent chain of the target checkpoint once, collecting each ancestor's
	 * writes for the requested channels until a checkpoint that stores the
	 * channel's value (a `DeltaSnapshot`, or a full list in a pre-delta
	 * checkpoint) seeds it. Same contract as the base implementation, which
	 * would deep-copy every ancestor through `getTuple` instead.
	 */
	override async getDeltaChannelHistory(options: {
		config: RunnableConfig;
		channels: string[];
	}): Promise<Record<string, DeltaChannelHistory>> {
		const { config, channels } = options;
		const result: Record<string, DeltaChannelHistory> = {};
		if (channels.length === 0) return result;
		for (const channel of channels) result[channel] = { writes: [] };

		const threadId = config.configurable?.thread_id;
		const threadData = threadId ? await this.ensureThreadLoaded(threadId) : undefined;
		if (!threadData) return result;

		const configuredId = config.configurable?.checkpoint_id;
		const targetId = typeof configuredId === "string" ? configuredId : this.getSortedCheckpointIds(threadData)[0];
		if (!targetId) return result;

		const collected: Record<string, CheckpointPendingWrite[]> = {};
		for (const channel of channels) collected[channel] = [];
		const remaining = new Set(channels);
		const visited = new Set<string>();
		let cursor = parentCheckpointIdOf(threadData.checkpoints[targetId]);

		while (cursor && remaining.size > 0 && !visited.has(cursor)) {
			visited.add(cursor);
			const entry = threadData.checkpoints[cursor];
			if (!entry) break;

			const ordered = this.orderedWrites(threadData, cursor);
			for (let i = ordered.length - 1; i >= 0; i--) {
				const write = ordered[i];
				if (remaining.has(write[1])) collected[write[1]].push(await this.toPendingWrite(write));
			}

			const values = entry.checkpoint.channel_values as Record<string, unknown> | undefined;
			for (const channel of [...remaining]) {
				if (
					!values ||
					!Object.prototype.hasOwnProperty.call(values, channel) ||
					values[channel] === undefined
				) {
					continue;
				}
				result[channel].seed =
					channel === MESSAGES_CHANNEL
						? await this.materializeMessagesValue(values[channel])
						: JSON.parse(JSON.stringify(values[channel]));
				remaining.delete(channel);
			}
			cursor = parentCheckpointIdOf(entry);
		}

		for (const channel of channels) result[channel].writes = collected[channel].reverse();
		return result;
	}

	async deleteThread(threadId: string): Promise<void> {
		// Remove from memory
		this.storage.delete(threadId);
		this.threadIndex.delete(threadId);
		this.dirtyThreadVersions.delete(threadId);
		this.persistedThreadVersions.delete(threadId);
		let safePath: string;
		try {
			safePath = this.assertContainedThreadPath(threadId);
		} catch (e) {
			Logger.error(`Refusing to delete thread with unsafe path: ${threadId}`, e);
			return;
		}
		try {
			if (await this.adapter.exists(safePath)) {
				await this.adapter.remove(safePath);
			}
		} catch (e) {
			Logger.error(`Error deleting thread ${threadId}:`, e);
		}
	}

	// --- Utilities ---

	private sanitizeFileName(title: string): string {
		return title
			.replace(/[<>:"/\\|?*]/g, "-")
			.replace(/\s+/g, " ")
			.trim()
			.substring(0, 100);
	}

	getAttachmentDirectory(): string {
		return getData().resolvedAttachmentFolder;
	}

	async getUniqueTitlePath(
		folder: string,
		baseTitle: string,
		currentPath: string,
	): Promise<{
		title: string;
		path: string;
		fileName: string;
	}> {
		let index = 1;
		while (true) {
			const title = index === 1 ? baseTitle : `${baseTitle} (${index})`;
			const fileName = `${title}.chat`;
			const path = normalizePath(`${folder}/${fileName}`);

			if (path === currentPath) {
				return { title, path, fileName };
			}

			if (!(await this.adapter.exists(path))) {
				return { title, path, fileName };
			}

			index += 1;
		}
	}

	async renameChatFile(threadId: string, title: string): Promise<string | undefined> {
		if (!title || !title.trim()) return undefined;

		try {
			const file = this.plugin.app.vault.getAbstractFileByPath(threadId);

			if (!file || !(file instanceof TFile)) {
				Logger.warn(`renameChatFile: File not found: ${threadId}`);
				return undefined;
			}

			const sanitizedTitle = this.sanitizeFileName(title) || "Chat";
			const folder = this.getChatFolder();
			const currentPath = normalizePath(threadId);
			const uniqueTarget = await this.getUniqueTitlePath(folder, sanitizedTitle, currentPath);
			const newPath = uniqueTarget.path;

			if (newPath === currentPath) return threadId; // no rename needed

			// Rename on disk — this triggers vault.on("rename") which calls rekeyThread()
			await this.plugin.app.fileManager.renameFile(file, newPath);

			// Update title + timestamp in the re-keyed data
			const now = Date.now();
			const loaded = this.storage.get(newPath);
			if (loaded) {
				loaded.title = uniqueTarget.title;
				loaded.updatedAt = now;
				this.markThreadDirty(newPath);
				this.saveDebounced(newPath);
			}

			const indexed = this.threadIndex.get(newPath);
			if (indexed) {
				indexed.title = uniqueTarget.title;
				indexed.updatedAt = now;
			}

			Logger.log(`renameChatFile: Successfully renamed to ${newPath}`);
			return newPath;
		} catch (error) {
			Logger.error(`Error renaming chat file for thread ${threadId}:`, error);
			return undefined;
		}
	}
}

/** A stored (serialized) message's id: `kwargs.id` / `data.id` / top-level `id` when it is a string. */
function storedMessageId(message: Record<string, unknown>): string | undefined {
	const payload = (message.kwargs ?? message.data ?? message) as Record<string, unknown>;
	return typeof payload.id === "string" ? payload.id : undefined;
}
