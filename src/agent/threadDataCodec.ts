import type { RunnableConfig } from "@langchain/core/runnables";
import type { Checkpoint, CheckpointMetadata, PendingWrite } from "@langchain/langgraph-checkpoint";

/**
 * On-disk codec for `.chat` thread files.
 *
 * LangGraph persists a checkpoint per step, and every checkpoint's
 * `channel_values.messages` carries the *entire* message history up to that
 * point — the naive encoding of the checkpoint tree is therefore O(N²) in
 * content for a thread with N turns (issue #431: one real thread reached
 * 72 MB gzipped). `metadata.writes` and pending writes duplicate the same
 * message payloads again.
 *
 * Version 2 of the file format deduplicates messages content-addressed:
 * every message object is stored once in a flat `messageTable`, and each
 * occurrence inside a checkpoint (or write) is replaced by a `{"$msg": n}`
 * reference. Deduplication is byte-exact — two copies collapse only when
 * their JSON serialization is identical — so inflating restores precisely
 * the structure that was saved (divergent copies, e.g. an annotated vs.
 * unannotated variant of the same message, are kept as separate entries).
 *
 * Inflation resolves every reference to the *same* table object, so a loaded
 * thread also shares message content in memory: O(N) content plus cheap
 * per-checkpoint pointer arrays, instead of O(N²) materialized copies.
 *
 * Pure module: no Obsidian dependency (also consumed by the search indexer's
 * `.chat` extractor in `utils/fileFiltering.ts`).
 */

/**
 * Bump when the ThreadData/CheckpointEntry schema changes. Absent in
 * pre-versioning files → treated as 0.
 *
 * **Forward-compatibility contract:** older plugins decode newer files with
 * v2 semantics as a best effort (they warn and refuse to overwrite — see
 * `newerVersionThreadIds` in `ObsidianChatManager` — but still display and
 * index what they can). Every future version must therefore keep the v2
 * invariants intact: `version` stays the first JSON key, `messageTable`
 * stays a flat array of messages, and a single-key `{"$msg": n}` record
 * outside the table always means "table entry n". A change that can't keep
 * those invariants must use *new* key names (e.g. a differently named marker
 * or table) so v2 decoding degrades to partial display instead of misreading.
 */
export const THREAD_DATA_VERSION = 2;

/**
 * First version with content-addressed message dedup. Files at or above this
 * are O(unique content) rather than O(N²), which is what the mobile indexing
 * gate cares about — a property every later version keeps, so consumers must
 * compare against this constant, not {@link THREAD_DATA_VERSION}.
 */
export const THREAD_DATA_DEDUP_VERSION = 2;

export interface CheckpointEntry {
	checkpoint: Checkpoint;
	metadata: CheckpointMetadata;
	parentConfig?: RunnableConfig;
}

export interface ThreadData {
	/** Schema version written on save; absent (0) on files predating versioning. */
	version?: number;
	// Metadata (ThreadSnapshot)
	threadId: string;
	title?: string;
	metadata?: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;

	// Checkpoint data
	checkpoints: Record<string, CheckpointEntry>;
	writes: Record<string, PendingWrite[]>; // checkpoint_id -> writes

	/** v2+: deduplicated message objects referenced via `{"$msg": n}` markers. Present only on disk. */
	messageTable?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface MessageRef {
	$msg: number;
}

function isMessageRef(value: unknown): value is MessageRef {
	return isRecord(value) && typeof value.$msg === "number" && Object.keys(value).length === 1;
}

/**
 * Assigns each distinct object a stable index in a flat table. Identity hits
 * are free (checkpoints that share message objects in memory — see
 * `adoptEqualMessages` — skip re-serialization); otherwise exact JSON content
 * decides, so byte-identical copies from different checkpoints collapse.
 */
class MessageInterner {
	readonly table: unknown[] = [];
	private byIdentity = new Map<unknown, number>();
	private byContent = new Map<string, number>();

	intern(value: Record<string, unknown>): MessageRef {
		let index = this.byIdentity.get(value);
		if (index === undefined) {
			const content = JSON.stringify(value);
			index = this.byContent.get(content);
			if (index === undefined) {
				index = this.table.length;
				this.table.push(value);
				this.byContent.set(content, index);
			}
			this.byIdentity.set(value, index);
		}
		return { $msg: index };
	}
}

/**
 * A record that carries message payload and should be interned wholesale.
 * Matches the serialized LangChain constructor format (`kwargs` record) and
 * the StoredMessage format (`type` + `data` record). Messages don't only live
 * in `channel_values.messages`: LangGraph `Send` payloads (`__pregel_tasks`
 * channel and pending writes) nest the full history under `args.messages`,
 * which is why detection is by shape at any depth rather than by position.
 * A false positive is harmless — interning is content-preserving either way.
 */
function isSerializedMessage(value: Record<string, unknown>): boolean {
	if (isRecord(value.kwargs)) return true;
	return typeof value.type === "string" && isRecord(value.data);
}

/**
 * Recursively replace message objects with table references. Genuine records
 * that happen to look like a `{"$msg": n}` marker are interned too — that IS
 * the escape mechanism: after deflation, every marker-shaped record outside
 * the table is one of ours. Interned records are taken wholesale (their
 * interior is never walked), so nothing nested inside message content can be
 * misread on inflate.
 */
function deflateNode(value: unknown, interner: MessageInterner): unknown {
	if (Array.isArray(value)) {
		return value.map((element) => deflateNode(element, interner));
	}
	if (isRecord(value)) {
		if (isSerializedMessage(value) || isMessageRef(value)) return interner.intern(value);
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = deflateNode(entry, interner);
		}
		return result;
	}
	return value;
}

/**
 * Exact inverse of {@link deflateNode}: resolve refs in place, never walking
 * into a resolved replacement (or the table itself), so message interiors are
 * left untouched.
 */
function inflateNode(value: unknown, table: unknown[]): unknown {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) value[i] = inflateNode(value[i], table);
		return value;
	}
	if (isRecord(value)) {
		if (isMessageRef(value)) return table[value.$msg] ?? value;
		for (const key of Object.keys(value)) {
			value[key] = inflateNode(value[key], table);
		}
		return value;
	}
	return value;
}

/**
 * Drop runtime-only fields from a checkpoint entry's `parentConfig` before it is
 * written to disk. LangChain populates `parentConfig` with `callbacks` (the live
 * `StreamMessagesHandler` and its ever-growing `seen` map) and `tags` — objects
 * re-created every session, never read back on load, but previously serialized
 * into EVERY checkpoint (~1.5 MB each). That is the dominant driver of
 * hundreds-of-MB `.chat` files and the resulting Obsidian OOM crashes. Only
 * `configurable` (the parent link LangGraph needs to resolve the checkpoint
 * tree) is persisted. Because this runs on every save, it also shrinks files
 * written by older builds the next time they are saved.
 */
function stripRuntimeConfig(entry: CheckpointEntry): CheckpointEntry {
	const pc = entry.parentConfig;
	// Persist only the parent link; drop callbacks/tags/any other runtime config so
	// the on-disk invariant is consistently "configurable-only". Skip the copy only
	// when parentConfig is already exactly `{ configurable }` (nothing to strip).
	if (!pc || (Object.keys(pc).length === 1 && pc.configurable !== undefined)) return entry;
	return { ...entry, parentConfig: { configurable: pc.configurable } };
}

/**
 * Produce the JSON-ready v2 representation of a thread: messages interned into
 * `messageTable`, occurrences replaced by refs. Does not mutate `data` — the
 * in-memory thread keeps its inflated shape (table entries are shared with it,
 * not copied).
 */
export function deflateThreadData(data: ThreadData): Record<string, unknown> {
	const interner = new MessageInterner();

	const checkpoints: Record<string, unknown> = {};
	for (const [id, entry] of Object.entries(data.checkpoints ?? {})) {
		checkpoints[id] = deflateNode(stripRuntimeConfig(entry), interner);
	}

	const writes: Record<string, unknown> = {};
	for (const [id, checkpointWrites] of Object.entries(data.writes ?? {})) {
		writes[id] = deflateNode(checkpointWrites, interner);
	}

	// `version` deliberately comes first: it lets consumers identify the format
	// from the first few decompressed bytes (see `sniffThreadDataVersion`)
	// without materializing the whole file — mobile indexing gates legacy
	// quadratic files this way. A spread of `data` would place `checkpoints`/
	// `writes` at their original (early) key positions, so exclude and re-add.
	const { version: _version, checkpoints: _checkpoints, writes: _writes, messageTable: _table, ...rest } = data;
	return {
		version: THREAD_DATA_VERSION,
		...rest,
		checkpoints,
		writes,
		messageTable: interner.table,
	};
}

/**
 * Read the schema version from the leading bytes of a thread file's JSON.
 * Only v2+ files (written by {@link deflateThreadData}) start with a
 * `version` key; anything else — legacy files, truncated prefixes, non-thread
 * JSON — reads as 0.
 */
export function sniffThreadDataVersion(jsonPrefix: string): number {
	const match = /^\s*\{\s*"version"\s*:\s*(\d+)/.exec(jsonPrefix);
	return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Resolve `{"$msg": n}` references in a freshly parsed thread back to the
 * table objects, in place. Every occurrence of a message resolves to the
 * *same* object, so checkpoints share content in memory. Pre-v2 data (which
 * stores messages inline) passes through unchanged.
 *
 * Versions newer than {@link THREAD_DATA_VERSION} are also decoded with v2
 * semantics, deliberately: that's the best-effort read the manager promises
 * for files written by a newer plugin (display what we can, never save), and
 * the forward-compatibility contract on {@link THREAD_DATA_VERSION} makes it
 * safe — future versions keep the `$msg`/`messageTable` invariants, and
 * anything this decoder doesn't understand is left in place rather than
 * misread.
 */
export function inflateThreadData(data: ThreadData): ThreadData {
	if ((data.version ?? 0) < THREAD_DATA_DEDUP_VERSION) return data;

	const table = Array.isArray(data.messageTable) ? data.messageTable : [];
	if (isRecord(data.checkpoints)) {
		for (const [id, entry] of Object.entries(data.checkpoints)) {
			data.checkpoints[id] = inflateNode(entry, table) as (typeof data.checkpoints)[string];
		}
	}
	if (isRecord(data.writes)) {
		for (const [id, checkpointWrites] of Object.entries(data.writes)) {
			data.writes[id] = inflateNode(checkpointWrites, table) as (typeof data.writes)[string];
		}
	}

	data.messageTable = undefined;
	return data;
}

function getCheckpointMessages(checkpoint: unknown): unknown[] | undefined {
	if (!isRecord(checkpoint)) return undefined;
	const channelValues = checkpoint.channel_values;
	if (!isRecord(channelValues)) return undefined;
	const messages = channelValues.messages;
	return Array.isArray(messages) ? messages : undefined;
}

/**
 * Share message objects between a new checkpoint and its parent: any message
 * whose JSON serialization equals the parent's message at the same index is
 * replaced by the parent's object. Messages are append-only along a branch, so
 * this makes the shared history prefix one set of objects in memory instead of
 * a fresh deep copy per step — the live-session counterpart of the on-disk
 * dedup (and it lets the save-path interner hit its identity fast path).
 * Copies that diverged (e.g. the parent's copy carries annotations written
 * post-hoc) simply stay separate.
 */
export function adoptEqualMessages(childCheckpoint: unknown, parentCheckpoint: unknown): void {
	const childMessages = getCheckpointMessages(childCheckpoint);
	const parentMessages = getCheckpointMessages(parentCheckpoint);
	if (!childMessages || !parentMessages) return;

	const shared = Math.min(childMessages.length, parentMessages.length);
	for (let i = 0; i < shared; i++) {
		const child = childMessages[i];
		const parent = parentMessages[i];
		if (child === parent || !isRecord(child) || !isRecord(parent)) continue;
		if (JSON.stringify(child) === JSON.stringify(parent)) {
			childMessages[i] = parent;
		}
	}
}
