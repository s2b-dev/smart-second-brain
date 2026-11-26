import { BaseMessage } from "@langchain/core/messages";
import { DeltaChannel, DeltaValue, MessagesDeltaValue, StateSchema, messagesDeltaReducer } from "@langchain/langgraph";
import {
	type CheckpointPendingWrite,
	DeltaSnapshot,
	compareWritesSortKeys,
	isDeltaSnapshot,
	writesSortKey,
} from "@langchain/langgraph-checkpoint";
import { normalizeMessages } from "./messageNormalization";
import type { CheckpointEntry, StoredWrite, ThreadData } from "./threadDataCodec";

/**
 * Rebuilds each checkpoint's `messages` from a thread's stored checkpoints and
 * writes.
 *
 * The agent stores `messages` as a LangGraph `DeltaChannel`: most checkpoints
 * hold no messages at all, only the per-step writes that produced the next one,
 * and every so often a checkpoint stores a full `DeltaSnapshot`. Checkpoints
 * from before that change store a full list each, which reads as a seed the
 * same way. Replay walks the checkpoint tree once, parents before children:
 * a checkpoint with a stored value starts from it, any other one is its
 * parent's list with the parent's `messages` writes applied through the
 * channel's own reducer, so a rebuilt list is exactly what the run produced.
 *
 * Each stored message object is revived once and the resulting `BaseMessage`
 * is shared by every checkpoint that holds it; a checkpoint whose step wrote no
 * messages reuses its parent's array outright.
 *
 * Pure module: no Obsidian dependency (the search indexer's `.chat` extractor
 * in `utils/fileFiltering.ts` uses it too).
 */

export const MESSAGES_CHANNEL = "messages";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Wire form of LangGraph's `Overwrite`: `{ __overwrite__: v }` or `{ type: "__overwrite__", value: v }`. */
function overwriteKey(value: Record<string, unknown>): "__overwrite__" | "value" | undefined {
	if ("__overwrite__" in value) return "__overwrite__";
	if (value.type === "__overwrite__" && "value" in value) return "value";
	return undefined;
}

function isSingleMessage(value: Record<string, unknown>): boolean {
	if (BaseMessage.isInstance(value)) return true;
	return isPlainRecord(value.kwargs) || (typeof value.type === "string" && isPlainRecord(value.data));
}

/**
 * The message list inside a stored `messages` value, whatever wraps it: a bare
 * list, a `DeltaSnapshot`, an `Overwrite`, or a single message (returned as a
 * one-element list that aliases it). `undefined` for anything else.
 */
export function messageListOf(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) return value;
	if (!isPlainRecord(value)) return undefined;
	if (isDeltaSnapshot(value)) return Array.isArray(value.value) ? value.value : undefined;
	const key = overwriteKey(value);
	if (key) return messageListOf(value[key]);
	if (isSingleMessage(value)) return [value];
	return undefined;
}

export type MessageReviver = (raw: unknown) => BaseMessage | undefined;

/**
 * A reviver that turns a stored message into a `BaseMessage` once per object:
 * thread files share one object per distinct message (`threadDataCodec`), so
 * this normalizes each distinct message once however many checkpoints hold it.
 */
export function createMessageReviver(): MessageReviver {
	const cache = new WeakMap<object, BaseMessage>();
	return (raw) => {
		if (!raw || typeof raw !== "object") return undefined;
		if (BaseMessage.isInstance(raw)) return raw;
		let message = cache.get(raw);
		if (!message) {
			message = normalizeMessages([raw])[0];
			if (message) cache.set(raw, message);
		}
		return message;
	};
}

/** Revive the messages inside a stored `messages` value, keeping its wrapper. */
export function reviveMessagesValue(value: unknown, revive: MessageReviver = createMessageReviver()): unknown {
	const reviveList = (list: unknown[]) =>
		list.map((raw) => revive(raw)).filter((message): message is BaseMessage => message !== undefined);
	if (Array.isArray(value)) return reviveList(value);
	if (!isPlainRecord(value)) return value;
	if (isDeltaSnapshot(value)) {
		return new DeltaSnapshot(Array.isArray(value.value) ? reviveList(value.value) : value.value);
	}
	const key = overwriteKey(value);
	if (key) return { ...value, [key]: reviveMessagesValue(value[key], revive) };
	if (isSingleMessage(value)) return revive(value) ?? value;
	return value;
}

/**
 * A checkpoint's stored writes in LangGraph's `writesSortKey` order, the order
 * live execution applied them in and the order a `DeltaChannel` must replay.
 */
export function orderedStoredWrites(data: ThreadData, checkpointId: string): StoredWrite[] {
	const stored = data.writes?.[checkpointId];
	if (!Array.isArray(stored) || stored.length === 0) return [];
	return [...stored].sort((a, b) =>
		compareWritesSortKeys(writesSortKey(a[3] ?? "", a[0], a[4]), writesSortKey(b[3] ?? "", b[0], b[4])),
	);
}

export function parentCheckpointIdOf(entry: CheckpointEntry | undefined): string | undefined {
	const parentId = entry?.parentConfig?.configurable?.checkpoint_id;
	return typeof parentId === "string" && parentId.length > 0 ? parentId : undefined;
}

/** One checkpoint as replay needs it: its stored `messages` value (if any) and the writes made from it. */
export interface ReplayNode {
	parentId?: string;
	/** The checkpoint's own `messages` value; `undefined` when it stores none (a delta step). */
	seed?: unknown;
	/** `messages` writes made from this checkpoint, in replay order. */
	writes: CheckpointPendingWrite[];
}

function storedSeed(entry: CheckpointEntry): unknown {
	const values = entry.checkpoint?.channel_values as Record<string, unknown> | undefined;
	if (!values || !Object.prototype.hasOwnProperty.call(values, MESSAGES_CHANNEL)) return undefined;
	return values[MESSAGES_CHANNEL];
}

function storedMessageWrites(data: ThreadData, checkpointId: string): CheckpointPendingWrite[] {
	return orderedStoredWrites(data, checkpointId)
		.filter((write) => write[1] === MESSAGES_CHANNEL)
		.map(([taskId, channel, value]) => [taskId, channel, value]);
}

/** Replay inputs for every checkpoint of a loaded (inflated) thread. */
export function replayNodesFromThreadData(data: ThreadData): Map<string, ReplayNode> {
	const nodes = new Map<string, ReplayNode>();
	for (const [id, entry] of Object.entries(data.checkpoints ?? {})) {
		nodes.set(id, {
			parentId: parentCheckpointIdOf(entry),
			seed: storedSeed(entry),
			writes: storedMessageWrites(data, id),
		});
	}
	return nodes;
}

const deltaPrototype = new DeltaChannel(messagesDeltaReducer);

/** `base` with `writes` applied the way LangGraph's DeltaChannel applies them (Overwrite included). */
function applyMessageWrites(
	base: BaseMessage[],
	writes: CheckpointPendingWrite[],
	revive: MessageReviver,
): BaseMessage[] {
	if (writes.length === 0) return base;
	const channel = deltaPrototype.fromCheckpoint(base);
	channel.replayWrites(writes.map(([taskId, ch, value]) => [taskId, ch, reviveMessagesValue(value, revive)]));
	return channel.isAvailable() ? channel.get() : base;
}

function seedMessages(seed: unknown, revive: MessageReviver): BaseMessage[] {
	const list = messageListOf(seed);
	if (!list) return [];
	return list.map((raw) => revive(raw)).filter((message): message is BaseMessage => message !== undefined);
}

/**
 * Every checkpoint's message list. One pass over the tree (iterative, so a deep
 * thread can't overflow the stack); a node whose parent is missing replays from
 * an empty list, like LangGraph treats a walk that reaches the root.
 */
export function replayMessages(
	nodes: Map<string, ReplayNode>,
	revive: MessageReviver = createMessageReviver(),
): Map<string, BaseMessage[]> {
	const children = new Map<string, string[]>();
	const roots: string[] = [];
	for (const [id, node] of nodes) {
		if (node.parentId && nodes.has(node.parentId)) {
			const siblings = children.get(node.parentId);
			if (siblings) siblings.push(id);
			else children.set(node.parentId, [id]);
		} else {
			roots.push(id);
		}
	}

	const result = new Map<string, BaseMessage[]>();
	const stack = [...roots];
	while (stack.length > 0) {
		const id = stack.pop() as string;
		if (result.has(id)) continue; // malformed cycle guard
		const node = nodes.get(id);
		if (!node) continue;
		let messages: BaseMessage[];
		if (node.seed !== undefined) {
			messages = seedMessages(node.seed, revive);
		} else {
			const parent = node.parentId ? nodes.get(node.parentId) : undefined;
			const parentMessages = node.parentId ? result.get(node.parentId) : undefined;
			messages = parent && parentMessages ? applyMessageWrites(parentMessages, parent.writes, revive) : [];
		}
		result.set(id, messages);
		for (const child of children.get(id) ?? []) stack.push(child);
	}
	return result;
}

/** Every checkpoint's message list for a loaded (inflated) thread. */
export function replayThreadMessages(data: ThreadData): Map<string, BaseMessage[]> {
	return replayMessages(replayNodesFromThreadData(data));
}

/**
 * One checkpoint's message list, replaying only its own branch: from the
 * nearest checkpoint at or above it that stores a value, down to it.
 */
export function replayPathMessages(
	data: ThreadData,
	checkpointId: string,
	revive: MessageReviver = createMessageReviver(),
): BaseMessage[] {
	const path: string[] = [];
	const visited = new Set<string>();
	let base: BaseMessage[] = [];
	let cursor: string | undefined = checkpointId;
	while (cursor && !visited.has(cursor)) {
		visited.add(cursor);
		const entry: CheckpointEntry | undefined = data.checkpoints?.[cursor];
		if (!entry) break;
		const seed = storedSeed(entry);
		if (seed !== undefined) {
			base = seedMessages(seed, revive);
			break;
		}
		path.push(cursor);
		cursor = parentCheckpointIdOf(entry);
	}

	// `path` runs target → oldest delta step; each step applies its parent's writes.
	for (let i = path.length - 1; i >= 0; i--) {
		const parentId = parentCheckpointIdOf(data.checkpoints[path[i]]);
		if (parentId && data.checkpoints[parentId]) {
			base = applyMessageWrites(base, storedMessageWrites(data, parentId), revive);
		}
	}
	return base;
}

/**
 * A checkpoint's message list from what any `BaseCheckpointSaver` returns: its
 * own stored value if it has one, otherwise the saver's delta history
 * (`getDeltaChannelHistory`: nearest seed plus the on-path writes) replayed.
 */
export function rebuildMessages(
	ownValue: unknown,
	history: { seed?: unknown; writes: CheckpointPendingWrite[] } | undefined,
	revive: MessageReviver = createMessageReviver(),
): BaseMessage[] {
	if (ownValue !== undefined) return seedMessages(ownValue, revive);
	if (!history) return [];
	return applyMessageWrites(seedMessages(history.seed, revive), history.writes, revive);
}

/**
 * Updates between full `messages` snapshots. Matches deepagents' `createDeepAgent`
 * (#1058): replay depth stays bounded while the per-checkpoint reference lists
 * shrink about 50x.
 */
export const MESSAGES_SNAPSHOT_FREQUENCY = 50;

/**
 * Agent state whose `messages` is a LangGraph `DeltaChannel`: each checkpoint
 * stores only the messages its step wrote, plus a full snapshot every
 * `snapshotFrequency` updates, instead of the whole conversation every step
 * (#540). Same value, input and reducer as LangGraph's `MessagesDeltaValue`.
 */
export function createDeltaMessagesStateSchema(snapshotFrequency = MESSAGES_SNAPSHOT_FREQUENCY) {
	return new StateSchema({
		messages: new DeltaValue(MessagesDeltaValue.valueSchema, {
			inputSchema: MessagesDeltaValue.inputSchema,
			reducer: MessagesDeltaValue.reducer,
			snapshotFrequency,
			jsonSchemaExtra: MessagesDeltaValue.jsonSchemaExtra,
		}),
	});
}
