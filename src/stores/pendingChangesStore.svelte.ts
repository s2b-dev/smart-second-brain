import { type EventRef, normalizePath, TFile } from "obsidian";
import { type Change, diffLines } from "diff";
import { z } from "zod";
import type SecondBrainPlugin from "../main";
import type { PendingChange, PendingChangeEntry, ReviewOutcomeRef } from "../types/shared";
import { shouldProcessVaultPath } from "../utils/fileFiltering";
import { genUUIDv7 } from "../utils/uuid7Validator";
import { Logger } from "../utils/logging";
import { getData } from "./dataStore.svelte";

const SAVE_DEBOUNCE_MS = 1000;
const STORAGE_FILE = "data/pending-changes.json";

const pendingChangeSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("create"), path: z.string(), content: z.string() }),
	z.object({
		type: z.literal("update"),
		path: z.string(),
		originalContent: z.string(),
		newContent: z.string(),
		initialOriginalContent: z.string().optional(),
	}),
	z.object({ type: z.literal("delete"), path: z.string(), originalContent: z.string() }),
	z.object({ type: z.literal("move"), path: z.string(), newPath: z.string() }),
]);

const pendingChangeEntrySchema = z.object({
	id: z.string(),
	change: pendingChangeSchema,
	status: z.enum(["pending", "accepted", "rejected"]),
	toolCallId: z.string(),
	threadId: z.string(),
	createdAt: z.number(),
	reportedToModel: z.boolean().optional(),
	shortId: z.string().optional(),
});

const pendingChangesArraySchema = z.array(pendingChangeEntrySchema);

let _store: PendingChangesStore | null = null;

/**
 * Why a partially-applied note was not restored.
 *
 * - `conflict` — it changed after the group accept, so we left the user's work alone.
 * - `missing`  — nothing exists at that path any more (deleted, or moved while the
 *                plugin was unloaded); there is nothing to restore.
 * - `failed`   — the write itself threw.
 */
export interface RevertSkip {
	path: string;
	reason: "conflict" | "missing" | "failed";
}

/**
 * Determine whether to include a removed or added part in the output.
 */
function shouldIncludePart(part: Change, isTarget: boolean, targetUsesNew: boolean): boolean {
	const useNew = isTarget ? targetUsesNew : !targetUsesNew;
	if (part.removed) return !useNew;
	if (part.added) return useNew;
	return true;
}

/**
 * Build file content by applying only one group's changes.
 * Groups are contiguous sequences of removed/added parts in the line diff.
 *
 * - accept (targetUsesNew=true): target group uses new text, others keep original
 * - reject (targetUsesNew=false): target group keeps original, others use new text
 */
function buildPartialContent(changes: Change[], groupIndex: number, targetUsesNew: boolean): string {
	let currentGroup = -1;
	let inGroup = false;
	let result = "";

	for (const part of changes) {
		if (part.removed || part.added) {
			if (!inGroup) {
				currentGroup++;
				inGroup = true;
			}
			if (shouldIncludePart(part, currentGroup === groupIndex, targetUsesNew)) {
				result += part.value;
			}
		} else {
			inGroup = false;
			result += part.value;
		}
	}

	return result;
}
/** Characters in a freshly minted short id, before collision lengthening. */
const SHORT_ID_LENGTH = 6;

/**
 * A short handle for an entry, unique among `taken`.
 *
 * Derived from the END of the UUID, never the start: UUIDv7's leading bits are
 * a millisecond timestamp, so entries staged in one batch share a long prefix —
 * a leading 8-char slice collided on every member of a 12-entry burst in
 * testing. The trailing bits are random, but not collision-proof at scale
 * (~1 per 500 ids at 6 chars), so this lengthens on collision rather than
 * truncating blindly. Falls back to the full id if even that collides.
 */
function mintShortId(fullId: string, taken: ReadonlySet<string>): string {
	const compact = fullId.replace(/-/g, "");
	for (let length = SHORT_ID_LENGTH; length <= compact.length; length++) {
		const candidate = compact.slice(-length);
		if (!taken.has(candidate)) return candidate;
	}
	return fullId;
}

export function getPendingChangesStore(): PendingChangesStore {
	if (!_store) throw new Error("PendingChangesStore not initialized");
	return _store;
}

export function initPendingChangesStore(store: PendingChangesStore): void {
	_store = store;
}

export class PendingChangesStore {
	#entries: PendingChangeEntry[] = $state([]);
	#revision = $state(0);
	readonly #plugin: SecondBrainPlugin;
	#saveTimer: number | null = null;
	readonly #processingGroups = new Set<string>();
	readonly #fileLocks = new Map<string, Promise<void>>();
	readonly #batchProcessing = new Set<string>();
	#renameHandler: EventRef | null = null;

	constructor(plugin: SecondBrainPlugin) {
		this.#plugin = plugin;
	}

	async load(): Promise<void> {
		const path = this.storagePath;
		if (await this.#plugin.app.vault.adapter.exists(path)) {
			try {
				const raw = await this.#plugin.app.vault.adapter.read(path);
				const parsed = JSON.parse(raw);
				const result = pendingChangesArraySchema.safeParse(parsed);
				if (result.success) {
					this.#entries = result.data;
				} else {
					Logger.error(
						"[PendingChanges] Invalid data in pending-changes.json, discarding malformed entries",
						result.error,
					);
					// Salvage valid entries if the array itself parsed
					if (Array.isArray(parsed)) {
						this.#entries = parsed.filter(
							(item) => pendingChangeEntrySchema.safeParse(item).success,
						) as PendingChangeEntry[];
					} else {
						this.#entries = [];
					}
				}
			} catch (e) {
				Logger.error("[PendingChanges] Failed to parse pending-changes.json, starting with empty list", e);
				this.#entries = [];
			}
		}
		this.#backfillShortIds();
		await this.#pruneOrphanedThreads();
		this.#renameHandler = this.#plugin.app.vault.on("rename", (file, oldPath) => {
			this.#handleFileRename(oldPath, file.path);
		});
		this.#plugin.registerEvent(this.#renameHandler);

		// Trigger re-renders for any reading views already rendered before the store loaded
		if (this.#entries.length > 0) {
			this.notifyChange();
		}
	}

	/**
	 * Give every loaded entry a short id. Entries persisted before short ids
	 * existed have none, and without one the model has no way to name them — they
	 * would be permanently undiscardable while still sitting in the review queue.
	 * Minted against the ids already present so a backfilled entry cannot collide
	 * with one that was persisted.
	 */
	#backfillShortIds(): void {
		const taken = new Set(this.#entries.map((entry) => entry.shortId).filter((id): id is string => !!id));
		let changed = false;
		for (const entry of this.#entries) {
			if (entry.shortId) continue;
			entry.shortId = mintShortId(entry.id, taken);
			taken.add(entry.shortId);
			changed = true;
		}
		if (changed) this.scheduleSave();
	}

	private get storagePath(): string {
		return normalizePath(`${this.#plugin.manifest.dir}/${STORAGE_FILE}`);
	}

	/**
	 * Drop entries whose chat no longer exists. `removeThread` only runs through
	 * the in-app delete path, so a `.chat` file deleted externally (or while the
	 * plugin was unloaded) leaves orphans behind: invisible in every per-thread
	 * bar, yet still counted by `countOtherThreadsPendingUpdate` — a note banner
	 * claiming "another chat is editing this file" with no chat to resolve it
	 * from, forever.
	 *
	 * Scoped to threadIds that look like chat files. The api staging path can
	 * pass arbitrary thread keys that were never vault paths; existence checks
	 * against those would always "fail" and wrongly sweep live entries.
	 */
	async #pruneOrphanedThreads(): Promise<void> {
		const chatThreadIds = new Set(
			this.#entries.map((e) => e.threadId).filter((threadId) => threadId.endsWith(".chat")),
		);
		if (chatThreadIds.size === 0) return;

		const orphaned: string[] = [];
		for (const threadId of chatThreadIds) {
			if (!(await this.#plugin.app.vault.adapter.exists(normalizePath(threadId)))) {
				orphaned.push(threadId);
			}
		}
		if (orphaned.length === 0) return;

		Logger.warn(`[PendingChanges] Pruning entries for ${orphaned.length} deleted chat(s): ${orphaned.join(", ")}`);
		// removeThread carries the stranded-content warning and the save/notify.
		for (const threadId of orphaned) {
			this.removeThread(threadId);
		}
	}

	private scheduleSave(): void {
		if (this.#saveTimer) window.clearTimeout(this.#saveTimer);
		this.#saveTimer = window.setTimeout(
			() => void this.saveToDisk().catch((e) => Logger.error("[PendingChanges] Failed to save:", e)),
			SAVE_DEBOUNCE_MS,
		);
	}

	/**
	 * Persist immediately, cancelling any debounced save. Used after transitions
	 * that already wrote to the vault (accept, group accept, revert): the vault
	 * write is durable the moment it happens, so a crash inside the debounce
	 * window would resurrect the entry as `pending` on reload — and its next
	 * accept would then fail the conflict check against content we ourselves
	 * wrote. Staging bursts keep the debounce; they have no vault side effect.
	 */
	private flushSave(): void {
		if (this.#saveTimer) {
			window.clearTimeout(this.#saveTimer);
			this.#saveTimer = null;
		}
		void this.saveToDisk().catch((e) => Logger.error("[PendingChanges] Failed to save:", e));
	}

	private async saveToDisk(): Promise<void> {
		const path = this.storagePath;
		const dir = path.substring(0, path.lastIndexOf("/"));
		if (!(await this.#plugin.app.vault.adapter.exists(dir))) {
			await this.#plugin.app.vault.adapter.mkdir(dir);
		}
		const snapshot = $state.snapshot(this.#entries);
		await this.#plugin.app.vault.adapter.write(path, JSON.stringify(snapshot, null, 2));
	}

	/** Reactive revision counter – read this inside `$derived` to track store mutations. */
	get revision(): number {
		return this.#revision;
	}

	private notifyChange(): void {
		this.#revision++;
		document.dispatchEvent(new CustomEvent("s2b-pending-changes-updated"));
	}

	/** Check if a vault path is allowed by internal filtering rules. */
	isPathAllowed(filePath: string): boolean {
		return shouldProcessVaultPath(filePath, getData().targetFolder);
	}

	/**
	 * Check if a file is marked as private by the privacy filter.
	 */
	isFilePrivate(filePath: string): boolean {
		return getData().isFilePrivate(filePath);
	}

	/**
	 * Check if a file should be blocked from a provider.
	 * Returns true when the file is private AND the provider is NOT trusted.
	 */
	shouldBlockFile(filePath: string, providerId: string): boolean {
		if (!this.isFilePrivate(filePath)) return false;
		const pluginData = getData();
		return !pluginData.isProviderTrusted(providerId);
	}

	/**
	 * Whether applying this change would take a note out of a private location
	 * and into a non-private one.
	 *
	 * Deliberately independent of provider trust: a move exposes nothing to the
	 * model (it applies as a bare rename), but it does change how every later
	 * operation treats the note — a previously-private note stops being filtered
	 * from indexing, search and prompts. That is worth flagging whichever
	 * provider is selected, so this asks only about the privacy filter.
	 */
	isDeprivatizingMove(change: PendingChange): boolean {
		if (change.type !== "move") return false;
		return this.isFilePrivate(change.path) && !this.isFilePrivate(change.newPath);
	}

	/** Stage one or more pending changes. Returns the entry IDs in input order.
	 *  If a pending update already exists for the same path and thread, the older entry is
	 *  auto-rejected so only the latest proposal is active. */
	addChanges(changes: PendingChange[], toolCallId: string, threadId: string): string[] {
		for (const change of changes) {
			if (change.type !== "update") continue;

			for (const existing of this.#entries) {
				if (
					existing.status === "pending" &&
					existing.threadId === threadId &&
					existing.change.path === change.path &&
					existing.change.type === "update"
				) {
					existing.status = "rejected";
					// Any `initialOriginalContent` snapshot is deliberately LEFT SET here.
					// It means "applied content the user has not signed off on", and
					// superseding the proposal does not make that content reviewed — the
					// text is still in the note, so the undo path must stay reachable via
					// `getActionableForThread`. Clearing it strands the applied text with
					// its only undo record discarded. Pinned by "keeps an entry actionable
					// when superseded by a newer proposal" in the store's tests.
				}
			}
		}

		const createdAt = Date.now();
		// Seeded with every live short id and grown as we go, so a batch cannot
		// collide with existing entries OR within itself.
		const takenShortIds = new Set(this.#entries.map((entry) => entry.shortId).filter((id): id is string => !!id));
		const entries: PendingChangeEntry[] = changes.map((change) => {
			const id = genUUIDv7();
			const shortId = mintShortId(id, takenShortIds);
			takenShortIds.add(shortId);
			return {
				id,
				shortId,
				change,
				status: "pending",
				toolCallId,
				threadId,
				createdAt,
			};
		});

		this.#entries.push(...entries);
		this.scheduleSave();
		this.notifyChange();
		return entries.map((entry) => entry.id);
	}

	addChange(change: PendingChange, toolCallId: string, threadId: string): string {
		return this.addChanges([change], toolCallId, threadId)[0];
	}

	/** Accept a pending change and apply it to the vault. */
	async acceptChange(entryId: string): Promise<void> {
		const entry = this.#entries.find((e) => e.id === entryId);
		if (entry?.status !== "pending") return;

		const app = this.#plugin.app;
		const change = entry.change;
		const normalizedPath = normalizePath(change.path);

		await this.withFileLock(normalizedPath, async () => {
			if (change.type === "create") {
				// Re-check at apply time (like move below): the stage-time existence
				// check can pass for two tabs both staging the same new path, since
				// neither is applied yet. Surface a clean error rather than a raw
				// vault.create throw when the first one already created it.
				if (app.vault.getAbstractFileByPath(normalizedPath)) {
					throw new Error(`Cannot apply create — a file already exists at: ${change.path}`);
				}
				const dir = normalizedPath.substring(0, normalizedPath.lastIndexOf("/"));
				if (dir && !(await app.vault.adapter.exists(dir))) {
					await app.vault.createFolder(dir);
				}
				await app.vault.create(normalizedPath, change.content);
			} else if (change.type === "update") {
				const file = app.vault.getAbstractFileByPath(normalizedPath);
				if (!(file instanceof TFile)) {
					throw new TypeError(`Cannot apply update — file not found: ${change.path}`);
				}
				// Conflict detection inside `vault.process`: the compare-and-write is
				// atomic against other Vault API writers (sync, other plugins), so the
				// file can't change between the check and the write. On conflict the
				// callback returns the data unchanged and we surface the error.
				let conflict = false;
				await app.vault.process(file, (data) => {
					if (data !== change.originalContent) {
						conflict = true;
						return data;
					}
					return change.newContent;
				});
				if (conflict) {
					throw new Error(
						`File "${change.path}" was modified after the change was proposed. Please review and try again.`,
					);
				}
			} else if (change.type === "delete") {
				const file = app.vault.getAbstractFileByPath(normalizedPath);
				if (!(file instanceof TFile)) {
					throw new TypeError(`Cannot apply delete — file not found: ${change.path}`);
				}
				// Conflict detection, matching update: the review surfaces (bar preview,
				// hover) show the STAGED snapshot, so trashing whatever is there now
				// would delete content the user never reviewed. Trash is recoverable,
				// but the review step should not misrepresent what it destroys.
				const currentContent = await app.vault.read(file);
				if (currentContent !== change.originalContent) {
					throw new Error(
						`File "${change.path}" was modified after the delete was proposed. Review the note and re-stage the delete.`,
					);
				}
				// trashFile honours the user's "Deleted files" setting (system trash, vault
				// .trash, or permanent). `vault.trash(file, true)` hardcoded system trash and
				// ignored that choice.
				await app.fileManager.trashFile(file);
			} else if (change.type === "move") {
				const file = app.vault.getAbstractFileByPath(normalizedPath);
				if (!(file instanceof TFile)) {
					throw new TypeError(`Cannot apply move — file not found: ${change.path}`);
				}
				const normalizedNewPath = normalizePath(change.newPath);
				if (app.vault.getAbstractFileByPath(normalizedNewPath)) {
					throw new Error(`Cannot apply move — destination already exists: ${change.newPath}`);
				}
				const dir = normalizedNewPath.substring(0, normalizedNewPath.lastIndexOf("/"));
				if (dir && !(await app.vault.adapter.exists(dir))) {
					await app.vault.createFolder(dir);
				}
				await app.fileManager.renameFile(file, normalizedNewPath);
			}
		});

		entry.status = "accepted";
		// The whole proposal is applied with the user's approval, so any partial-write
		// snapshot from earlier group accepts is settled — see `hasUnrevertedApplication`.
		// Leaving it set would let `rejectAll` revert a change they just accepted.
		if (change.type === "update") change.initialOriginalContent = undefined;
		this.flushSave();
		this.notifyChange();
	}

	/** Reject a pending change (no vault modification). */
	rejectChange(entryId: string): void {
		const entry = this.#entries.find((e) => e.id === entryId);
		if (entry?.status !== "pending") return;
		entry.status = "rejected";
		this.scheduleSave();
		this.notifyChange();
	}

	/** Acquire a per-file lock to serialize vault writes for the same path.
	 *
	 * A FIFO queue, not a single-slot barrier: each caller chains onto the tail
	 * of the current chain for this path, so N concurrent ops on the same file
	 * run strictly one after another. (A previous version had every waiter await
	 * the same in-flight promise and then proceed together — two tabs editing one
	 * note could interleave read→modify and clobber each other.) The stored
	 * promise is the tail of the chain; the map entry is cleared only when this
	 * op is still the tail, so a later arrival that already chained onto us keeps
	 * the entry alive.
	 *
	 * The key is normalized here rather than at the call sites: `#fileLocks` is a
	 * plain string map, so `"a//b.md"` and `"a/b.md"` would occupy *different*
	 * chains for one file and let two ops interleave read→modify — exactly the
	 * clobbering the queue exists to prevent. Callers pass whatever path they hold;
	 * making the invariant structural means a future call site can't reintroduce
	 * the split by forgetting to normalize. */
	private async withFileLock<T>(rawPath: string, fn: () => Promise<T>): Promise<T> {
		const filePath = normalizePath(rawPath);
		const previous = this.#fileLocks.get(filePath) ?? Promise.resolve();

		// Run only after everything already queued for this path settles. Swallow
		// the predecessor's outcome so one op's failure doesn't reject the chain.
		const run = previous.then(
			() => fn(),
			() => fn(),
		);

		// Publish this op as the new tail. Ignore its result/rejection here — the
		// tail marker only needs to resolve; the real result flows out via `run`.
		const tail = run.then(
			() => {},
			() => {},
		);
		this.#fileLocks.set(filePath, tail);

		try {
			return await run;
		} finally {
			// Only clear if nobody chained after us; otherwise leave their tail in place.
			if (this.#fileLocks.get(filePath) === tail) {
				this.#fileLocks.delete(filePath);
			}
		}
	}

	/** Accept a single diff group within a pending update. */
	async acceptChangeGroup(entryId: string, groupIndex: number): Promise<void> {
		if (this.#processingGroups.has(entryId)) return;
		const entry = this.#entries.find((e) => e.id === entryId);
		if (entry?.status !== "pending") return;

		const change = entry.change;
		if (change.type !== "update") return;

		this.#processingGroups.add(entryId);
		try {
			await this.withFileLock(change.path, async () => {
				// Snapshot the original content before any group mutations
				change.initialOriginalContent ??= change.originalContent;

				const changes = diffLines(change.originalContent, change.newContent);
				const newVaultContent = buildPartialContent(changes, groupIndex, true);

				const file = this.#plugin.app.vault.getAbstractFileByPath(change.path);
				if (!(file instanceof TFile)) return;

				// Atomic compare-and-write via `vault.process` — see acceptChange.
				let conflict = false;
				await this.#plugin.app.vault.process(file, (data) => {
					if (data !== change.originalContent) {
						conflict = true;
						return data;
					}
					return newVaultContent;
				});
				if (conflict) {
					throw new Error(`File "${change.path}" was modified externally. Please review before accepting.`);
				}

				change.originalContent = newVaultContent;
				if (change.originalContent === change.newContent) {
					entry.status = "accepted";
					// Every group is now applied and the user approved each one, so the
					// note's content is theirs — not an unreviewed partial write. Drop the
					// pre-proposal snapshot: it exists to mark "there is applied content
					// here the user has not signed off on", and keeping it would make
					// `rejectAll` treat this completed acceptance as something to undo,
					// silently reverting a change they explicitly accepted.
					change.initialOriginalContent = undefined;
				}
			});

			this.flushSave();
			this.notifyChange();
		} finally {
			this.#processingGroups.delete(entryId);
		}
	}

	/** Reject a single diff group within a pending update. */
	rejectChangeGroup(entryId: string, groupIndex: number): void {
		if (this.#processingGroups.has(entryId)) return;
		const entry = this.#entries.find((e) => e.id === entryId);
		if (entry?.status !== "pending") return;

		const change = entry.change;
		if (change.type !== "update") return;

		const changes = diffLines(change.originalContent, change.newContent);
		const revertedContent = buildPartialContent(changes, groupIndex, false);

		change.newContent = revertedContent;
		if (change.originalContent === change.newContent) {
			entry.status = "rejected";
		}

		this.scheduleSave();
		this.notifyChange();
	}

	/** Accept all pending changes for a thread. Returns paths that failed.
	 *
	 * `excludeEntryIds` lets the caller skip entries it already knows can't be
	 * applied (the bar passes its stale set, so a batch reads "applied N,
	 * skipped M stale" instead of stale entries erroring into the failure
	 * list). Purely an optimization of the message — an outdated exclusion is
	 * harmless either way: a wrongly-included stale entry still fails its own
	 * conflict check, and a wrongly-excluded fresh one just stays pending. */
	async acceptAll(threadId: string, excludeEntryIds?: ReadonlySet<string>): Promise<string[]> {
		// Keyed by thread so concurrent chats accepting their own (disjoint) changes
		// don't spuriously block each other. Re-entry is a silent no-op — the first
		// run is still doing exactly what was asked; callers disable the button
		// while awaiting rather than reporting a phantom failure.
		if (this.#batchProcessing.has(threadId)) return [];
		this.#batchProcessing.add(threadId);
		try {
			// Snapshot the list before iterating to avoid picking up entries added mid-loop
			const pending = this.#entries.filter(
				(e) => e.threadId === threadId && e.status === "pending" && !excludeEntryIds?.has(e.id),
			);
			const failures: string[] = [];
			for (const entry of pending) {
				try {
					await this.acceptChange(entry.id);
				} catch (e) {
					Logger.error(`[PendingChanges] Failed to accept ${entry.change.path}:`, e);
					failures.push(entry.change.path);
				}
			}
			return failures;
		} finally {
			this.#batchProcessing.delete(threadId);
		}
	}

	/**
	 * Restore a note whose diff groups were partially accepted back to its
	 * pre-proposal content. No-op for anything with nothing applied.
	 *
	 * @returns a {@link RevertSkip} when the revert did NOT happen, else undefined.
	 *   The reason is carried so callers can say which it was — "we left your edits
	 *   alone" and "that note is gone" are very different messages to receive.
	 */
	private async revertAppliedGroups(entry: PendingChangeEntry): Promise<RevertSkip | undefined> {
		if (!this.hasUnrevertedApplication(entry)) return undefined;
		// Narrowed by hasUnrevertedApplication, which TS can't see through.
		const change = entry.change as Extract<PendingChange, { type: "update" }>;
		const initialOriginalContent = change.initialOriginalContent;
		if (initialOriginalContent === undefined) return undefined;

		try {
			return await this.withFileLock(change.path, async () => {
				const file = this.#plugin.app.vault.getAbstractFileByPath(change.path);
				if (!(file instanceof TFile)) {
					// Nothing at this path to restore. Reporting success would tell the
					// user the note was put back when it wasn't — and, because the
					// snapshot below is only cleared on an actual write, the entry would
					// stay actionable forever with no way to resolve it. Renames are now
					// tracked for these entries (see #handleFileRename), so reaching here
					// means the note was deleted, or moved while the plugin was unloaded.
					Logger.warn(
						`[PendingChanges] Cannot restore "${change.path}" — the note no longer exists at that path.`,
					);
					// Clear the snapshot: there is no file left to undo, so keeping it
					// would strand the entry as permanently unresolvable.
					change.initialOriginalContent = undefined;
					return { path: change.path, reason: "missing" as const };
				}

				// Conflict check, matching acceptChange/acceptChangeGroup. Rejecting
				// is not a licence to discard the user's own work: between the group
				// accept and this reject they may have edited the note by hand, and
				// this revert does not go through trash, so an unconditional
				// overwrite destroys those edits with no way back. `vault.process`
				// makes the compare-and-revert atomic against other writers.
				//
				// `originalContent` is the right baseline, not `initialOriginalContent`:
				// acceptChangeGroup advances `originalContent` to exactly what it wrote
				// (see its `change.originalContent = newVaultContent`), so it tracks what
				// we last put on disk. If the file still matches it, our writes are the
				// only ones there and undoing them is safe.
				let conflict = false;
				await this.#plugin.app.vault.process(file, (data) => {
					if (data !== change.originalContent) {
						conflict = true;
						return data;
					}
					return initialOriginalContent;
				});
				if (conflict) {
					Logger.warn(
						`[PendingChanges] Skipped reverting "${change.path}" — it was modified after the group accept; leaving the file as-is.`,
					);
					// Snapshot deliberately kept: the note is still there, so the user can
					// resolve the conflict and undo later.
					return { path: change.path, reason: "conflict" as const };
				}
				// The note is back to its pre-proposal state, so there is nothing left
				// to undo. Clearing this makes the revert idempotent: a later revert
				// (or one after the user edits the note again) must not re-apply this
				// stale snapshot over their newer content.
				change.originalContent = initialOriginalContent;
				change.initialOriginalContent = undefined;
				return undefined;
			});
		} catch (e) {
			Logger.error(`[PendingChanges] Failed to revert ${change.path}:`, e);
			return { path: change.path, reason: "failed" as const };
		}
	}

	/**
	 * Undo the partially-applied content of a single entry (the per-row counterpart
	 * of `rejectAll`'s revert), marking it rejected.
	 *
	 * @returns the path when the revert was skipped, else undefined.
	 */
	async undoAppliedGroups(entryId: string): Promise<RevertSkip | undefined> {
		const entry = this.#entries.find((e) => e.id === entryId);
		if (!entry) return undefined;

		const skipped = await this.revertAppliedGroups(entry);
		entry.status = "rejected";
		this.flushSave();
		this.notifyChange();
		return skipped;
	}

	/**
	 * Withdraw the pending proposals staged by specific tool calls — the
	 * edit/regenerate path. When the user replaces a turn, the proposals its
	 * response staged belong to an answer that no longer exists on the active
	 * branch; leaving them pending orphans them in the review bar and makes the
	 * rerun re-stage on top of them (duplicated creates, updates rebased onto an
	 * abandoned answer's content).
	 *
	 * Withdrawn entries are marked `reportedToModel`: the model on the NEW branch
	 * never made these proposals, so telling it "rejected by the user" in the next
	 * review-outcome block would be both noise and false — the user replaced the
	 * turn, they didn't review anything.
	 *
	 * Entries holding unreverted partially-applied content are left untouched
	 * (still pending/actionable): the user accepted part of them, that content is
	 * on disk, and this path must never discard their only undo record.
	 */
	withdrawForToolCalls(
		threadId: string,
		toolCallIds: ReadonlySet<string>,
	): { withdrawn: number; keptPartiallyApplied: number } {
		let withdrawn = 0;
		let keptPartiallyApplied = 0;
		for (const entry of this.#entries) {
			if (entry.threadId !== threadId || entry.status !== "pending") continue;
			if (!toolCallIds.has(entry.toolCallId)) continue;
			if (this.hasUnrevertedApplication(entry)) {
				keptPartiallyApplied++;
				continue;
			}
			entry.status = "rejected";
			entry.reportedToModel = true;
			withdrawn++;
		}
		if (withdrawn > 0) {
			this.scheduleSave();
			this.notifyChange();
		}
		return { withdrawn, keptPartiallyApplied };
	}

	/** Reject all pending changes for a thread, reverting any partially-applied group writes.
	 *
	 *  Returns the paths whose revert was skipped because the file no longer matched what
	 *  we wrote — the entries are still rejected (the proposal is dead either way), but the
	 *  file keeps its current content. Callers should surface these: a silent skip reads as
	 *  "everything was undone" when it wasn't. */
	async rejectAll(threadId: string): Promise<RevertSkip[]> {
		// Same per-thread guard as acceptAll — and the same Set, so an accept-all
		// and a reject-all for one thread can't interleave their vault writes.
		if (this.#batchProcessing.has(threadId)) return [];
		this.#batchProcessing.add(threadId);
		try {
			// Two distinct sets, deliberately:
			//
			//  - anything still `pending`, which must be marked rejected; and
			//  - anything with `initialOriginalContent` set, which has partially-applied
			//    content ON DISK that must be undone regardless of its status.
			//
			// The second set is not a subset of the first. Accepting one diff group and
			// then rejecting the remaining ones drives `newContent` back to
			// `originalContent`, so `rejectChangeGroup` already flipped the entry to
			// `rejected` — while the accepted group is still written to the note. Filtering
			// on `pending` alone skipped exactly those entries, leaving the applied text in
			// the vault while the UI reported that everything had been rejected.
			const targets = this.getActionableForThread(threadId);
			const skippedReverts: RevertSkip[] = [];
			for (const entry of targets) {
				const skipped = await this.revertAppliedGroups(entry);
				if (skipped) skippedReverts.push(skipped);
				entry.status = "rejected";
			}
			// Reverts are vault writes — flush like the other write paths.
			this.flushSave();
			this.notifyChange();
			return skippedReverts;
		} finally {
			this.#batchProcessing.delete(threadId);
		}
	}

	/** Get all entries for a thread. */
	getEntriesForThread(threadId: string): PendingChangeEntry[] {
		return this.#entries.filter((e) => e.threadId === threadId);
	}

	/** Get only pending entries for a thread. */
	getPendingForThread(threadId: string): PendingChangeEntry[] {
		return this.#entries.filter((e) => e.threadId === threadId && e.status === "pending");
	}

	/**
	 * Whether this entry has applied content in the note that the user has NOT
	 * signed off on.
	 *
	 * `initialOriginalContent` is the invariant: set on the first
	 * `acceptChangeGroup`, and cleared the moment the outcome is settled — either
	 * every group was accepted (the content is now theirs) or the applied text was
	 * reverted (there is nothing left on disk). So it means "unreviewed partial
	 * write present", not merely "a group was once accepted".
	 *
	 * Status alone cannot answer this. Resolving the last group individually flips
	 * the entry to `accepted`/`rejected` while partial text may still be on disk,
	 * which is why this is keyed on the snapshot rather than on status.
	 *
	 * Single source of truth for the callers that must agree: `rejectAll` (what to
	 * revert), `PendingChangesBar` (whether to stay visible), and `removeThread`
	 * (what is being discarded, so it can be reported).
	 */
	hasUnrevertedApplication(entry: PendingChangeEntry): boolean {
		return entry.change.type === "update" && entry.change.initialOriginalContent !== undefined;
	}

	/**
	 * Entries for a thread that still need the user: pending proposals, plus any
	 * entry holding partially-applied content that has not been reverted.
	 */
	getActionableForThread(threadId: string): PendingChangeEntry[] {
		return this.#entries.filter(
			(e) => e.threadId === threadId && (e.status === "pending" || this.hasUnrevertedApplication(e)),
		);
	}

	/**
	 * The review outcomes to surface to the model in the next user turn, plus the
	 * paths still awaiting review. Resolved entries are marked reported so each
	 * outcome reaches the model exactly once; pending paths are returned every
	 * call until they resolve (the model must keep treating them as not applied).
	 *
	 * Only consults entries the model itself staged in this thread — outcomes for
	 * other chats' proposals would be noise it has no proposal to correlate with.
	 */
	takeReviewOutcomesForThread(threadId: string): {
		outcomes: ReviewOutcomeRef[];
		pendingProposals: { path: string; shortId: string }[];
	} {
		const outcomes: ReviewOutcomeRef[] = [];
		const pendingProposals: { path: string; shortId: string }[] = [];
		let changed = false;
		for (const entry of this.#entries) {
			if (entry.threadId !== threadId) continue;
			if (entry.status === "pending") {
				// `shortId` is backfilled on load, so a pending entry without one
				// cannot normally exist; skip rather than emit an unusable id.
				if (entry.shortId) pendingProposals.push({ path: entry.change.path, shortId: entry.shortId });
				continue;
			}
			if (entry.reportedToModel) continue;
			outcomes.push({
				path: entry.change.path,
				// Rejected with applied text still on disk = some groups were
				// accepted first — the note DOES contain part of the proposal.
				outcome:
					entry.status === "accepted"
						? "accepted"
						: this.hasUnrevertedApplication(entry)
							? "partially"
							: "rejected",
			});
			entry.reportedToModel = true;
			changed = true;
		}
		if (changed) this.scheduleSave();
		return { outcomes, pendingProposals };
	}

	/** Mark entries as already surfaced to the model, so the next turn's outcome
	 * block skips them. Used for memory auto-applies, whose outcome the tool
	 * result itself already reported ("applied automatically"). */
	markReportedToModel(entryIds: string[]): void {
		let changed = false;
		for (const id of entryIds) {
			const entry = this.#entries.find((e) => e.id === id);
			if (entry && !entry.reportedToModel) {
				entry.reportedToModel = true;
				changed = true;
			}
		}
		if (changed) this.scheduleSave();
	}

	/** Get a single entry by ID. */
	getEntry(entryId: string): PendingChangeEntry | undefined {
		return this.#entries.find((e) => e.id === entryId);
	}

	/** All entries one tool call staged — the chat's `manage_notes` card uses
	 * this to show live review status for its own proposals. */
	getEntriesByToolCallId(toolCallId: string): PendingChangeEntry[] {
		return this.#entries.filter((e) => e.toolCallId === toolCallId);
	}

	/** Get count of pending changes for a thread. */
	getPendingCount(threadId: string): number {
		return this.#entries.filter((e) => e.threadId === threadId && e.status === "pending").length;
	}

	/** Get all pending update entries for a specific file path. */
	getPendingUpdatesForPath(filePath: string): PendingChangeEntry[] {
		return this.#entries.filter(
			(e) => e.status === "pending" && e.change.type === "update" && e.change.path === filePath,
		);
	}

	/**
	 * Withdraw one pending proposal by its short id — the agent's own retraction
	 * path (`manage_notes` `discard`), so it can take back a proposal it no
	 * longer stands behind instead of only ever stacking new ones on top.
	 *
	 * Keyed by id rather than path because a path is not identity: it can move
	 * with a rename, be reused by a different note, or name two proposals at once
	 * (a since-renamed one and whatever took its place). Every attempt to rank
	 * those cases picked wrong in some scenario; an id has none of that ambiguity.
	 *
	 * Scoped to `threadId` deliberately: another chat's proposal is not this
	 * agent's to drop, matching how the update-dedup refuses to reach across
	 * threads.
	 *
	 * An entry holding unreverted partially-applied content is REFUSED, not
	 * rejected. That content is on disk because the user accepted a diff group;
	 * silently resolving the entry while it sits there would discard their only
	 * undo record. The caller reports that so the model leaves it to the user.
	 */
	discardPendingById(shortId: string, threadId: string): "discarded" | "not_found" | "partially_applied" {
		const entry = this.#entries.find(
			(e) => e.shortId === shortId && e.threadId === threadId && e.status === "pending",
		);
		if (!entry) return "not_found";
		if (this.hasUnrevertedApplication(entry)) return "partially_applied";

		entry.status = "rejected";
		this.scheduleSave();
		this.notifyChange();
		return "discarded";
	}

	/** Look up a pending entry by the short id the model was given. Thread-scoped
	 * for the same reason as `discardPendingById`. */
	getPendingByShortId(shortId: string, threadId: string): PendingChangeEntry | undefined {
		return this.#entries.find((e) => e.shortId === shortId && e.threadId === threadId && e.status === "pending");
	}

	/** Count distinct OTHER threads that also have a pending update to `filePath`.
	 * `exceptThreadId` is the thread being viewed/staged; it's excluded so the
	 * result is "how many *other* chats are editing this same file". Used by the
	 * diff UI (banner) and manage_notes (stage-time warning) to surface the
	 * cross-thread collision the update-dedup deliberately doesn't collapse. */
	countOtherThreadsPendingUpdate(filePath: string, exceptThreadId: string): number {
		const threads = new Set<string>();
		for (const e of this.#entries) {
			if (
				e.status === "pending" &&
				e.change.type === "update" &&
				e.change.path === filePath &&
				e.threadId !== exceptThreadId
			) {
				threads.add(e.threadId);
			}
		}
		return threads.size;
	}

	/** Check if file was modified externally since change was staged. */
	async hasConflict(entryId: string): Promise<boolean> {
		const entry = this.#entries.find((e) => e.id === entryId);
		if (entry?.status !== "pending") return false;

		const change = entry.change;
		if (change.type === "create") return false;
		if (change.type === "move") {
			const source = this.#plugin.app.vault.getAbstractFileByPath(change.path);
			const destination = this.#plugin.app.vault.getAbstractFileByPath(change.newPath);
			return !(source instanceof TFile) || destination instanceof TFile;
		}

		const file = this.#plugin.app.vault.getAbstractFileByPath(change.path);
		if (!(file instanceof TFile)) return true; // File was deleted externally

		const currentContent = await this.#plugin.app.vault.read(file);
		return currentContent !== change.originalContent;
	}

	/**
	 * Remove all entries for a thread. Called when the chat is deleted.
	 *
	 * Drops everything, including entries still holding unreverted applied content:
	 * the chat is gone, so there is no surface left to review them on and keeping
	 * them would leak rows into a thread that no longer exists. But that content
	 * stays in the vault with its only undo record discarded, so warn rather than
	 * doing it silently — the note is left as the agent partially wrote it, and the
	 * user gets no other signal.
	 */
	removeThread(threadId: string): void {
		const beforeLength = this.#entries.length;
		const strandedPaths = this.#entries
			.filter((e) => e.threadId === threadId && this.hasUnrevertedApplication(e))
			.map((e) => e.change.path);
		if (strandedPaths.length > 0) {
			Logger.warn(
				`[PendingChanges] Discarding ${strandedPaths.length} partially-applied change(s) with the deleted thread. ` +
					`These notes keep the content that was already applied: ${strandedPaths.join(", ")}`,
			);
		}
		this.#entries = this.#entries.filter((e) => e.threadId !== threadId);
		this.scheduleSave();
		if (this.#entries.length !== beforeLength) {
			this.notifyChange();
		}
	}

	/** Update entry paths when a vault file is renamed. */
	#handleFileRename(oldPath: string, newPath: string): void {
		let changed = false;
		for (const entry of this.#entries) {
			// Track renames for pending proposals AND for anything still holding
			// unreverted applied content. The latter is not pending — its groups were
			// resolved individually — but its path is still a live pointer to text in
			// the vault that Undo Applied / Reject All must reach. Skipping it left a
			// stale path, so the revert looked up a file that no longer existed and
			// reported success while the applied content sat at the new path.
			if (entry.status !== "pending" && !this.hasUnrevertedApplication(entry)) continue;
			if (entry.change.path === oldPath) {
				entry.change.path = newPath;
				changed = true;
			}
			if (entry.change.type === "move" && entry.change.newPath === oldPath) {
				entry.change.newPath = newPath;
				changed = true;
			}
		}
		// Re-key threadId when a .chat file is renamed (threadId IS the file path)
		if (oldPath.endsWith(".chat")) {
			for (const entry of this.#entries) {
				if (entry.threadId === oldPath) {
					entry.threadId = newPath;
					changed = true;
				}
			}
		}
		if (changed) {
			this.scheduleSave();
			this.notifyChange();
		}
	}

	cleanup(): void {
		if (this.#saveTimer) {
			window.clearTimeout(this.#saveTimer);
			this.#saveTimer = null;
			// Flush any pending writes so data isn't lost on unload
			void this.saveToDisk().catch((e) => Logger.error("[PendingChanges] Failed to save on cleanup:", e));
		}
		_store = null;
	}
}
