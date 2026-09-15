/**
 * Chat timeline derivation — the pure half of the chat store.
 *
 * Everything here turns LangGraph checkpoint history into what the chat UI renders:
 * the checkpoint graph and its active branch, `MessagePair`s with their tool timelines,
 * branch metadata, summarization markers, and the context blocks appended to a user
 * turn. None of it holds reactive state; `ChatSession` / `SessionRegistry` in
 * chatStore.svelte.ts own that and call in here.
 */
import { AIMessage, type BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { CheckpointHistoryItem } from "../agent/Agent";
import type { ChatModelConfig } from "../providers/index";
import type { ChatAttachment, ReviewStatusRef } from "../types/shared";
import { type UUIDv7, genUUIDv7 } from "../utils/uuid7Validator";
import { formatVisibleNotesContext, type VisibleNoteRef } from "../hooks/useVisibleNotes.svelte";
import { formatSelectionContext, type SelectionRef } from "../hooks/useSelection.svelte";
import { getPendingChangesStore } from "./pendingChangesStore.svelte";
import { Logger } from "../utils/logging";

const CHECKPOINT_DEBUG = false;

export function checkpointDebug(event: string, details: Record<string, unknown>): void {
	if (!CHECKPOINT_DEBUG) return;
	Logger.log(`[chatStore.checkpoint] ${event}`, details);
}

/* -----------------------------------------------------------------------------
 * Shared Types
 * ---------------------------------------------------------------------------*/

export enum AssistantState {
	idle = 0,
	streaming = 1,
	success = 2,
	error = 3,
	cancelled = 4,
}

export enum MessageState {
	idle = 0,
	answering = 1,
}

const HIDDEN_HUMAN_MESSAGE_SOURCES = new Set(["summarization", "manual_summarization"]);
type HiddenHumanSource = "summarization" | "manual_summarization";
export const MANUAL_SUMMARIZATION_PROMPT =
	"Summarize older conversation history now to reduce context usage while preserving important facts, decisions, and user preferences. Do not call tools. Reply with exactly: Context compacted.";

function isHiddenHumanSource(source: unknown): source is HiddenHumanSource {
	return typeof source === "string" && HIDDEN_HUMAN_MESSAGE_SOURCES.has(source);
}

/**
 * `pending` means the model is still streaming the call's arguments — the tool
 * has not started executing and its `input` is not yet known. Only reachable
 * live: a settled/checkpoint-replayed call is never pending.
 */
export type ToolCallStatus = "pending" | "running" | "completed" | "failed";

export interface ToolCallState {
	id: string;
	name: string;
	/** Absent while `status` is `pending` — the arguments are still streaming. */
	input?: Record<string, unknown>;
	status: ToolCallStatus;
	output?: unknown;
	preamble?: string;
	/** Name of the subagent this tool ran inside (via the `task` tool), if any. */
	subAgentName?: string;
	/** The id of the parent `task` tool call this is nested under, if any. */
	parentToolCallId?: string;
}

type AssistantTimelineEventType = "preamble" | "tool_pending" | "tool_start" | "tool_end";

export interface AssistantTimelineEvent {
	id: string;
	type: AssistantTimelineEventType;
	toolCallId?: string;
	toolName?: string;
	content?: string;
	input?: Record<string, unknown>;
	output?: unknown;
	status?: ToolCallStatus;
	/** The id of the AI message that produced this event. Groups events from the same AI message. */
	aiMessageId?: string;
	/** Name of the subagent this tool ran inside (via the `task` tool), if any. */
	subAgentName?: string;
	/** The id of the parent `task` tool call this is nested under, if any. */
	parentToolCallId?: string;
}

interface UserMessage {
	content: string;
	attachments?: ChatAttachment[];
	visibleNotes?: VisibleNoteRef[];
	selection?: SelectionRef;
	graphNotes?: GraphNoteRef[];
}

/** Serializable reference to a note selected from the Smart Graph. */
export interface GraphNoteRef {
	path: string;
	basename: string;
}

export interface AssistantMessage {
	state: AssistantState;
	content: string;
	toolCalls?: ToolCallState[];
	assistantTimeline?: AssistantTimelineEvent[];
	// Wall-clock time the assistant spent producing this turn (thinking + tool
	// calls), in milliseconds. Stamped live in the store when the stream ends and
	// persisted onto the final AI message's response_metadata so the "Thought for
	// Ns" label survives reload. Absent for turns predating this / restored history
	// with no stored duration (the UI falls back to the step count).
	thinkingDurationMs?: number;
	// Wall-clock epoch ms at which the CURRENT run began, present only while this
	// message is streaming (cleared when the run settles, is cancelled, or errors).
	// The live "Running… Ns" timer is computed from this rather than from a
	// component-local anchor, because `syncGraphAfterRun` replaces every pair object
	// mid-flight and `MessagePair.id` is a fresh UUID on each rebuild — a remount of
	// the header would otherwise restart the timer from 0 in the middle of a run.
	// Stamped on the pair AND re-stamped after the rebuild, exactly as
	// `thinkingDurationMs` is, so it survives that replacement.
	runStartedAtMs?: number;
	// The aiMessageId of the text currently in `content` (streaming only). The UI uses
	// this to decide when the last tool step folds into the thinking process: the step
	// stays "current" (rendered below the label with its tools) until live content
	// carries a DIFFERENT aiMessageId — i.e. the model has begun the next AI message
	// (the "first token of the next message" fold trigger). Cleared whenever `content`
	// is cleared (tool_start / step boundary) so an empty spot never drives a fold.
	contentAiMessageId?: string;
	nerd_stats?: {
		tokensPerSecond: number;
		retrievedDocsNum: number;
		chatModelConfig: ChatModelConfig;
	};
	errorCode?: string;
}

interface TranscriptEvent {
	type: "summarization_marker";
	label: string;
	source: "summarization" | "manual_summarization";
}

/**
 * Information about branches at a given checkpoint.
 * Used for navigating between alternative conversation paths.
 */
export interface BranchInfo {
	/** 1-based index of the current branch */
	currentIndex: number;
	/** Total number of sibling branches at this fork point */
	totalBranches: number;
	/** Ordered list of sibling checkpoint IDs (the leaf/tip of each branch to navigate to) */
	siblingCheckpointIds: string[];
	/** The checkpoint ID where the fork occurred */
	forkPointId: string;
	/** The immediate child checkpoint of the fork point (first checkpoint in this branch after fork) */
	forkChildId: string;
}

export interface MessagePair {
	id: UUIDv7;
	/**
	 * Stable identity for this turn that survives the settle rebuild. `id` is a
	 * fresh UUID on every `rebuildMessagePairs()` pass, so keying UI lists on it
	 * tears down and recreates every row when a stream settles (losing scroll
	 * position). This key is derived from the persisted human message id instead,
	 * so a turn keeps the same identity across rebuilds. Falls back to `id` for
	 * pairs with no human message (orphaned assistant, summary markers).
	 */
	stableKey?: string;
	userMessage: UserMessage;
	assistantMessage: AssistantMessage;
	transcriptEvent?: TranscriptEvent;
	/** Epoch ms when this message pair was created (persisted via checkpoint ts) */
	createdAt?: number;
	/** The model used to generate the assistant response */
	model?: ChatModel;
	/** Generation metadata persisted with the assistant message */
	generation?: MessageGeneration;

	/**
	 * Checkpoint ID where this HumanMessage is the last message.
	 * Fork from here to REGENERATE the AI response.
	 */
	regenerateFromCheckpointId?: string;

	/**
	 * Checkpoint ID where the PREVIOUS AI message is the last message.
	 * Fork from here to EDIT the user message.
	 * Undefined for the first message pair (no ancestor).
	 */
	editFromCheckpointId?: string;

	/**
	 * Branch info for the human message (edit branches).
	 * Shows how many times this user turn was edited.
	 */
	userBranchInfo?: BranchInfo;

	/**
	 * Branch info for the AI response (regenerate branches).
	 * Shows how many times this response was regenerated.
	 */
	assistantBranchInfo?: BranchInfo;
}

export interface ChatModel {
	model: string;
	provider: string;
	modelConfig: Partial<ChatModelConfig>;
}

export interface MessageGeneration {
	agentId?: string;
	agentName?: string;
	provider?: string;
	model?: string;
}

/**
 * In-memory representation of a chat with messages.
 */
export interface ChatRecord {
	id: string;
	messages: MessagePair[];
}

/* -----------------------------------------------------------------------------
 * Canonical Checkpoint Graph Model
 * ---------------------------------------------------------------------------*/

export interface CheckpointNode {
	checkpointId: string;
	parentCheckpointId?: string;
	step: number;
	messages: BaseMessage[];
	children: string[];
	ts?: string;
}

export interface CheckpointGraphState {
	nodes: Map<string, CheckpointNode>;
	rootCheckpointId?: string;
	activeCheckpointId?: string;
	lastPersistedActiveCheckpointId?: string;
}

interface ActiveCheckpointResolution {
	checkpointId?: string;
	source: "session" | "persisted" | "explicit" | "fallback" | "none";
}

interface PostRunResolution {
	newIds: string[];
	parentCheckpointId?: string;
	newActiveCheckpointId?: string;
}

interface CheckpointSortShape {
	checkpointId: string;
	step: number;
	ts?: string;
}

function parseCheckpointTs(ts?: string): number {
	if (!ts) return 0;
	const value = Date.parse(ts);
	return Number.isFinite(value) ? value : 0;
}

function comparePathOrder(a: CheckpointSortShape, b: CheckpointSortShape): number {
	if (a.step !== b.step) return a.step - b.step;
	const tsA = parseCheckpointTs(a.ts);
	const tsB = parseCheckpointTs(b.ts);
	if (tsA !== tsB) return tsA - tsB;
	return a.checkpointId.localeCompare(b.checkpointId);
}

function compareNewest(a: CheckpointSortShape, b: CheckpointSortShape): number {
	const tsA = parseCheckpointTs(a.ts);
	const tsB = parseCheckpointTs(b.ts);
	if (tsA !== tsB) return tsB - tsA;
	if (a.step !== b.step) return b.step - a.step;
	return a.checkpointId.localeCompare(b.checkpointId);
}

function getPathToRoot(graph: CheckpointGraphState, checkpointId: string): string[] {
	const path: string[] = [];
	const visited = new Set<string>();
	let current: string | undefined = checkpointId;

	while (current && !visited.has(current)) {
		path.push(current);
		visited.add(current);
		current = graph.nodes.get(current)?.parentCheckpointId;
	}

	return path.reverse();
}

function isCheckpointValid(graph: CheckpointGraphState, checkpointId?: string): checkpointId is string {
	return !!checkpointId && graph.nodes.has(checkpointId);
}

function getCheckpointDepth(graph: CheckpointGraphState, checkpointId: string): number {
	let depth = 0;
	let current: string | undefined = checkpointId;
	const visited = new Set<string>();

	while (current && !visited.has(current)) {
		visited.add(current);
		current = graph.nodes.get(current)?.parentCheckpointId;
		if (current) depth += 1;
	}

	return depth;
}

function isDescendantOf(graph: CheckpointGraphState, checkpointId: string, ancestorId: string): boolean {
	let current: string | undefined = checkpointId;
	const visited = new Set<string>();

	while (current && !visited.has(current)) {
		if (current === ancestorId) return true;
		visited.add(current);
		current = graph.nodes.get(current)?.parentCheckpointId;
	}

	return false;
}

function getAllDescendants(graph: CheckpointGraphState, startId: string): string[] {
	const result: string[] = [];
	const queue: string[] = [startId];
	const visited = new Set<string>();

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || visited.has(current)) continue;
		visited.add(current);
		result.push(current);
		const node = graph.nodes.get(current);
		if (!node) continue;
		queue.push(...node.children);
	}

	return result;
}

function findFirstHumanInBranch(graph: CheckpointGraphState, startId: string): string | undefined {
	const queue: string[] = [startId];
	const visited = new Set<string>();

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || visited.has(current)) continue;
		visited.add(current);

		const node = graph.nodes.get(current);
		if (!node) continue;
		const lastMessage = node.messages.at(-1);
		if (lastMessage && HumanMessage.isInstance(lastMessage)) {
			return current;
		}

		const sortedChildren = [...node.children].sort((a, b) => a.localeCompare(b));
		queue.push(...sortedChildren);
	}

	return undefined;
}

function findDeterministicTipFrom(graph: CheckpointGraphState, startId: string): string {
	let current = startId;
	const visited = new Set<string>();

	while (true) {
		if (visited.has(current)) {
			checkpointDebug("cycle.detected.tip_traversal", { checkpointId: current, startId });
			return current;
		}
		visited.add(current);

		const node = graph.nodes.get(current);
		if (!node || node.children.length === 0) {
			return current;
		}

		const bestChild = [...node.children]
			.filter((id) => !visited.has(id))
			.map((id) => graph.nodes.get(id))
			.filter((child): child is CheckpointNode => !!child)
			.sort(compareNewest)
			.at(0);

		if (!bestChild) {
			return current;
		}

		current = bestChild.checkpointId;
	}
}

export function buildCheckpointGraph(checkpoints: CheckpointHistoryItem[]): CheckpointGraphState {
	const nodes = new Map<string, CheckpointNode>();

	for (const checkpoint of checkpoints) {
		nodes.set(checkpoint.checkpointId, {
			checkpointId: checkpoint.checkpointId,
			parentCheckpointId: checkpoint.parentCheckpointId,
			step: checkpoint.step,
			messages: checkpoint.messages,
			children: [],
			ts: checkpoint.ts,
		});
	}

	// Some stored histories can contain multiple first-turn checkpoints with no parent.
	// Treat them as siblings branching from a single canonical root to keep lineage connected.
	const detachedRoots = [...nodes.values()].filter((node) => !node.parentCheckpointId);
	const canonicalRoot = [...detachedRoots].sort(comparePathOrder)[0];
	if (canonicalRoot && detachedRoots.length > 1) {
		for (const node of detachedRoots) {
			if (node.checkpointId === canonicalRoot.checkpointId) continue;
			node.parentCheckpointId = canonicalRoot.checkpointId;
		}
	}

	for (const node of nodes.values()) {
		const parentId = node.parentCheckpointId;
		if (!parentId) continue;
		const parent = nodes.get(parentId);
		if (!parent) continue;
		parent.children.push(node.checkpointId);
	}

	for (const node of nodes.values()) {
		node.children.sort((a, b) => a.localeCompare(b));
	}

	let rootCheckpointId: string | undefined;
	const rootCandidates = [...nodes.values()].filter(
		(node) => !node.parentCheckpointId || !nodes.has(node.parentCheckpointId),
	);

	if (rootCandidates.length > 0) {
		rootCheckpointId = [...rootCandidates].sort(comparePathOrder)[0]?.checkpointId;
	} else if (nodes.size > 0) {
		rootCheckpointId = [...nodes.values()].sort(comparePathOrder)[0]?.checkpointId;
	}

	return {
		nodes,
		rootCheckpointId,
	};
}

function resolveFallbackCheckpoint(graph: CheckpointGraphState, fromCheckpointId?: string): string | undefined {
	if (graph.nodes.size === 0) return undefined;

	if (fromCheckpointId && graph.nodes.has(fromCheckpointId)) {
		return findDeterministicTipFrom(graph, fromCheckpointId);
	}

	if (graph.rootCheckpointId && graph.nodes.has(graph.rootCheckpointId)) {
		return findDeterministicTipFrom(graph, graph.rootCheckpointId);
	}

	const first = [...graph.nodes.values()].sort(comparePathOrder)[0];
	return first?.checkpointId;
}

export function resolveActiveCheckpointId(
	graph: CheckpointGraphState,
	options: {
		sessionActiveCheckpointId?: string;
		persistedCheckpointId?: string;
		explicitTargetCheckpointId?: string;
	},
): ActiveCheckpointResolution {
	if (graph.nodes.size === 0) {
		return { source: "none" };
	}

	const { sessionActiveCheckpointId, persistedCheckpointId, explicitTargetCheckpointId } = options;

	if (isCheckpointValid(graph, sessionActiveCheckpointId)) {
		return { checkpointId: sessionActiveCheckpointId, source: "session" };
	}

	if (isCheckpointValid(graph, persistedCheckpointId)) {
		return { checkpointId: persistedCheckpointId, source: "persisted" };
	}

	if (isCheckpointValid(graph, explicitTargetCheckpointId)) {
		return { checkpointId: explicitTargetCheckpointId, source: "explicit" };
	}

	const fallbackSeed = sessionActiveCheckpointId ?? persistedCheckpointId ?? explicitTargetCheckpointId;
	const fallbackCheckpointId = resolveFallbackCheckpoint(graph, fallbackSeed);
	return {
		checkpointId: fallbackCheckpointId,
		source: fallbackCheckpointId ? "fallback" : "none",
	};
}

export function resolvePostRunCheckpointSelection(
	graph: CheckpointGraphState,
	beforeSet: Set<string>,
	parentCheckpointId?: string,
): PostRunResolution {
	const newIds = [...graph.nodes.keys()].filter((id) => !beforeSet.has(id));

	const eligible =
		parentCheckpointId && graph.nodes.has(parentCheckpointId)
			? newIds.filter((id) => isDescendantOf(graph, id, parentCheckpointId))
			: newIds;

	if (eligible.length === 0) {
		return {
			newIds,
			parentCheckpointId,
		};
	}

	const sorted = [...eligible]
		.map((id) => graph.nodes.get(id))
		.filter((node): node is CheckpointNode => !!node)
		.sort((a, b) => {
			const depthDiff = getCheckpointDepth(graph, b.checkpointId) - getCheckpointDepth(graph, a.checkpointId);
			if (depthDiff !== 0) return depthDiff;
			const tsDiff = parseCheckpointTs(b.ts) - parseCheckpointTs(a.ts);
			if (tsDiff !== 0) return tsDiff;
			return a.checkpointId.localeCompare(b.checkpointId);
		});

	return {
		newIds,
		parentCheckpointId,
		newActiveCheckpointId: sorted[0]?.checkpointId,
	};
}

/* -----------------------------------------------------------------------------
 * Checkpoint Mapping for Branching (Derived Utility)
 * ---------------------------------------------------------------------------*/

export interface CheckpointMessageMapping {
	/**
	 * LangChain HumanMessage ID -> checkpoint where this human message is LAST
	 * Used for: REGENERATE
	 */
	humanLastCheckpoints: Map<string, string>;

	/**
	 * LangChain HumanMessage ID -> checkpoint where the PREVIOUS AI message is LAST
	 * Used for: EDIT
	 */
	aiBeforeHumanCheckpoints: Map<string, string>;

	/**
	 * LangChain HumanMessage ID -> checkpoint where the AI response to this human message is LAST
	 * Used for: Looking up branch info for regenerate branches
	 */
	aiAfterHumanCheckpoints: Map<string, string>;

	/**
	 * Checkpoint ID -> BranchInfo for navigation between sibling branches
	 */
	branchInfoMap: Map<string, BranchInfo>;

	/**
	 * Set of checkpoint IDs that are the first human message in a branch (edit fork entry points).
	 * Only these checkpoints should show user branch navigation.
	 */
	editForkEntryCheckpoints: Set<string>;

	/**
	 * The root/initial checkpoint ID (step -1 or earliest checkpoint)
	 * Used for editing the first message
	 */
	rootCheckpointId?: string;

	/**
	 * LangChain HumanMessage ID -> checkpoint timestamp (ISO string).
	 * Used to derive a stable createdAt for each MessagePair.
	 */
	humanTimestamps: Map<string, string>;
}

function buildDerivedBranchInfo(graph: CheckpointGraphState): {
	branchInfoMap: Map<string, BranchInfo>;
	editForkEntryCheckpoints: Set<string>;
} {
	const branchInfoMap = new Map<string, BranchInfo>();
	const editForkEntryCheckpoints = new Set<string>();

	const forkPoints = [...graph.nodes.values()].filter((node) => node.children.length > 1).sort(comparePathOrder);

	for (const forkPoint of forkPoints) {
		const sortedChildren = [...forkPoint.children].sort((a, b) => a.localeCompare(b));
		const branchTips = sortedChildren.map((childId) => findDeterministicTipFrom(graph, childId));
		const forkLastMessage = forkPoint.messages.at(-1);
		const isEditFork = !forkLastMessage || !HumanMessage.isInstance(forkLastMessage);

		for (let index = 0; index < sortedChildren.length; index++) {
			const childId = sortedChildren[index];
			const branchInfo: BranchInfo = {
				currentIndex: index + 1,
				totalBranches: sortedChildren.length,
				siblingCheckpointIds: branchTips,
				forkPointId: forkPoint.checkpointId,
				forkChildId: childId,
			};

			if (isEditFork) {
				const firstHumanCheckpointId = findFirstHumanInBranch(graph, childId);
				if (firstHumanCheckpointId) {
					editForkEntryCheckpoints.add(firstHumanCheckpointId);
				}
			}

			const descendants = getAllDescendants(graph, childId);
			for (const checkpointId of descendants) {
				branchInfoMap.set(checkpointId, branchInfo);
			}
		}
	}

	return { branchInfoMap, editForkEntryCheckpoints };
}

function buildCheckpointMessageMappingFromGraph(
	graph: CheckpointGraphState,
	activeCheckpointId?: string,
): CheckpointMessageMapping {
	const humanLastCheckpoints = new Map<string, string>();
	const aiBeforeHumanCheckpoints = new Map<string, string>();
	const aiAfterHumanCheckpoints = new Map<string, string>();
	const humanTimestamps = new Map<string, string>();

	const { branchInfoMap, editForkEntryCheckpoints } = buildDerivedBranchInfo(graph);

	if (!activeCheckpointId || !graph.nodes.has(activeCheckpointId)) {
		return {
			humanLastCheckpoints,
			aiBeforeHumanCheckpoints,
			aiAfterHumanCheckpoints,
			branchInfoMap,
			editForkEntryCheckpoints,
			rootCheckpointId: graph.rootCheckpointId,
			humanTimestamps,
		};
	}

	const activePath = getPathToRoot(graph, activeCheckpointId)
		.map((checkpointId) => graph.nodes.get(checkpointId))
		.filter((node): node is CheckpointNode => !!node)
		.sort(comparePathOrder);

	let lastAiCheckpointId: string | undefined;
	let pendingHumanMessageId: string | undefined;

	for (const node of activePath) {
		const lastMessage = node.messages.at(-1);

		if (!lastMessage || AIMessage.isInstance(lastMessage)) {
			lastAiCheckpointId = node.checkpointId;

			if (pendingHumanMessageId && lastMessage && AIMessage.isInstance(lastMessage)) {
				aiAfterHumanCheckpoints.set(pendingHumanMessageId, node.checkpointId);
				pendingHumanMessageId = undefined;
			}
			continue;
		}

		if (!HumanMessage.isInstance(lastMessage)) {
			continue;
		}

		const humanMessageId = lastMessage.id;
		if (!humanMessageId) {
			continue;
		}

		humanLastCheckpoints.set(humanMessageId, node.checkpointId);
		if (node.ts) {
			humanTimestamps.set(humanMessageId, node.ts);
		}
		if (lastAiCheckpointId) {
			aiBeforeHumanCheckpoints.set(humanMessageId, lastAiCheckpointId);
		}
		pendingHumanMessageId = humanMessageId;
	}

	return {
		humanLastCheckpoints,
		aiBeforeHumanCheckpoints,
		aiAfterHumanCheckpoints,
		branchInfoMap,
		editForkEntryCheckpoints,
		rootCheckpointId: graph.rootCheckpointId,
		humanTimestamps,
	};
}

/**
 * Rebuild the full visible history for a branch whose context was summarized.
 *
 * Summarization trims the LangGraph `messages` channel (summary + last few
 * messages survive), so the active checkpoint no longer contains the earlier
 * turns — but the checkpoint *tree* still does: every pre-summarization
 * checkpoint on the active path keeps the messages that were removed (#434).
 * Walk the path root→tip and collect each message the first time it appears;
 * because the channel only ever grows except at summarization steps, this
 * reproduces the conversation in order with the trimmed turns restored.
 * Messages that survived into the tip keep the tip's copy, so the live window
 * renders exactly as before.
 *
 * Marker placement: automatic summarization runs *mid-turn* (before the model
 * answers the message that overflowed the context), so its summary message is
 * moved in front of that turn's human message — otherwise the badge would
 * split a turn between question and answer. Manual compaction runs between
 * turns and stays at its chronological position.
 *
 * Only the rendered transcript changes; what the model sees on the next turn
 * is still the tip's trimmed channel.
 */
function recoverSummarizedHistory(
	graph: CheckpointGraphState,
	activeCheckpointId: string,
	tipMessages: BaseMessage[],
): BaseMessage[] {
	const hasSummary = tipMessages.some(
		(msg) => HumanMessage.isInstance(msg) && isHiddenHumanSource(msg.additional_kwargs?.lc_source),
	);
	if (!hasSummary) return tipMessages;

	const path = getPathToRoot(graph, activeCheckpointId)
		.map((id) => graph.nodes.get(id))
		.filter((node): node is CheckpointNode => !!node)
		.sort(comparePathOrder);

	const tipById = new Map<string, BaseMessage>();
	for (const msg of tipMessages) {
		if (msg.id) tipById.set(msg.id, msg);
	}

	const seen = new Set<string>();
	const display: BaseMessage[] = [];
	for (const node of path) {
		for (const msg of node.messages) {
			// Every message that went through LangGraph's reducer carries an id.
			// If one doesn't, occurrences can't be deduplicated across
			// checkpoints — bail out to the plain tip rather than risk
			// rendering duplicated turns.
			if (!msg.id) return tipMessages;
			if (seen.has(msg.id)) continue;
			seen.add(msg.id);

			const rendered = tipById.get(msg.id) ?? msg;
			if (HumanMessage.isInstance(msg) && msg.additional_kwargs?.lc_source === "summarization") {
				let insertAt = display.length;
				for (let i = display.length - 1; i >= 0; i--) {
					if (HumanMessage.isInstance(display[i])) {
						insertAt = i;
						break;
					}
				}
				display.splice(insertAt, 0, rendered);
				continue;
			}
			display.push(rendered);
		}
	}
	return display;
}

export function deriveMessagePairsFromActiveCheckpoint(
	graph: CheckpointGraphState,
	activeCheckpointId: string | undefined,
	errorCount = 0,
	bootstrapMessages: BaseMessage[] = [],
	lastErrorMessage?: string,
): MessagePair[] {
	if (!activeCheckpointId || !graph.nodes.has(activeCheckpointId)) {
		return baseMessagesToMessagePairs(bootstrapMessages, errorCount, undefined, lastErrorMessage);
	}

	const activeNode = graph.nodes.get(activeCheckpointId);
	if (!activeNode) {
		return baseMessagesToMessagePairs(bootstrapMessages, errorCount, undefined, lastErrorMessage);
	}

	const checkpointMapping = buildCheckpointMessageMappingFromGraph(graph, activeCheckpointId);
	const displayMessages = recoverSummarizedHistory(graph, activeCheckpointId, activeNode.messages);
	return baseMessagesToMessagePairs(displayMessages, errorCount, checkpointMapping, lastErrorMessage);
}

/* -----------------------------------------------------------------------------
 * BaseMessage to MessagePair conversion
 * ---------------------------------------------------------------------------*/

/**
 * Extracts the user-facing query text from a BaseMessage.
 *
 * `Agent.buildMessageContent` inlines text/md/csv/json attachments (and non-native
 * PDFs) as text content blocks tagged with `s2b_attachment: true`, appended after
 * the untagged query block. That tag keeps the content array from being collapsed
 * to a string on read, so here we split structurally: join only the untagged text
 * blocks (the query) and drop the tagged attachment blocks. The attachments still
 * render separately as chips. A plain-string content (no attachments) is returned
 * as-is.
 */
function extractTextContent(message: BaseMessage): string {
	const content = message.content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(block): block is { type: "text"; text: string } =>
					typeof block === "object" &&
					block !== null &&
					(block as { type?: unknown }).type === "text" &&
					(block as { s2b_attachment?: unknown }).s2b_attachment !== true,
			)
			.map((block) => block.text)
			.join("");
	}
	return message.text || "";
}

/** Formats graph-selected notes into a context block for the agent. */
export function formatGraphNotesContext(notes: GraphNoteRef[]): string {
	if (notes.length === 0) return "";
	const links = notes.map((n) => `- [[${n.path.replace(/\.md$/, "")}]]`);
	return `[Graph-selected notes]\n${links.join("\n")}`;
}

/**
 * Formats staged-change review outcomes into a context block for the agent.
 * Without this the model never learns what the user decided: its tool result
 * said "will be reviewed", and every later turn it would keep assuming its
 * edits were (or will be) applied — including ones the user rejected.
 */
export function formatReviewOutcomesContext(status: ReviewStatusRef): string {
	const pendingProposals = status.pendingProposals ?? [];
	// Messages persisted before proposals carried ids kept only paths. Their block
	// is reconstructed here to be stripped by exact match, so it has to render the
	// way it originally did — hence reading the legacy field rather than migrating.
	const legacyPendingPaths = pendingProposals.length === 0 ? (status.pendingPaths ?? []) : [];
	if (status.outcomes.length === 0 && pendingProposals.length === 0 && legacyPendingPaths.length === 0) return "";
	const lines = ["[Status of your proposed note changes]"];
	for (const o of status.outcomes) {
		if (o.outcome === "accepted") {
			lines.push(`- "${o.path}": accepted by the user and applied.`);
		} else if (o.outcome === "rejected") {
			lines.push(`- "${o.path}": rejected by the user — NOT applied. Do not assume this edit exists.`);
		} else {
			lines.push(
				`- "${o.path}": partially applied — the user accepted some of the proposed changes and rejected the rest. Read the note if you need its exact current content.`,
			);
		}
	}
	if (pendingProposals.length > 0) {
		lines.push(
			"- Still awaiting the user's review (NOT applied yet). Use the id with a `discard` operation to withdraw one:",
		);
		for (const proposal of pendingProposals) {
			lines.push(`  - "${proposal.path}" (id: ${proposal.shortId})`);
		}
	} else if (legacyPendingPaths.length > 0) {
		lines.push(
			`- Still awaiting the user's review (NOT applied yet): ${legacyPendingPaths.map((p) => `"${p}"`).join(", ")}`,
		);
	}
	return lines.join("\n");
}

/** Strips the augmented context suffix (visible notes + selection + graph notes) from a message.
 * Reconstructs the exact suffix that was appended by augmentWithVisibleNotes()
 * and removes it by exact string match from the end. This is safe even when user
 * content or selected text contains bracket patterns like "[Selected text from".
 */
export function stripAugmentedSuffix(
	content: string,
	visibleNotes?: VisibleNoteRef[],
	selection?: SelectionRef,
	graphNotes?: GraphNoteRef[],
	reviewStatus?: ReviewStatusRef,
): string {
	// Reconstruct the exact suffix in the same order it was appended
	let suffix = "";
	if (visibleNotes?.length) {
		const ctx = formatVisibleNotesContext(visibleNotes);
		if (ctx) suffix += `\n\n${ctx}`;
	}
	if (selection) {
		suffix += `\n\n${formatSelectionContext(selection)}`;
	}
	if (graphNotes?.length) {
		const ctx = formatGraphNotesContext(graphNotes);
		if (ctx) suffix += `\n\n${ctx}`;
	}
	if (reviewStatus) {
		const ctx = formatReviewOutcomesContext(reviewStatus);
		if (ctx) suffix += `\n\n${ctx}`;
	}
	if (suffix && content.endsWith(suffix)) {
		return content.slice(0, -suffix.length);
	}
	return content;
}

/**
 * Parses tool call arguments into a normalized object format.
 * NOTE: LangChain envelope unwrapping (e.g. single-key `{ input: … }`) is handled
 * upstream by Agent.normalizeStreamToolInput — this function only coerces types.
 */
export function normalizeToolInput(raw: unknown): Record<string, unknown> {
	if (raw === undefined || raw === null) return {};
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			return { value: parsed };
		} catch {
			return { input: raw };
		}
	}
	if (Array.isArray(raw)) return { value: raw };
	if (typeof raw === "object") return raw as Record<string, unknown>;
	return { value: raw };
}

function readGenerationField(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractGenerationFromMetadata(rawMetadata: unknown): MessageGeneration | undefined {
	if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
		return undefined;
	}
	const metadata = rawMetadata as Record<string, unknown>;
	const generation: MessageGeneration = {
		agentId: readGenerationField(metadata, "agent_id"),
		agentName: readGenerationField(metadata, "agent_name"),
		provider: readGenerationField(metadata, "model_provider"),
		model: readGenerationField(metadata, "model"),
	};
	if (!generation.agentId && !generation.agentName && !generation.provider && !generation.model) {
		return undefined;
	}
	return generation;
}

function extractGenerationFromAssistantMessage(msg: BaseMessage): MessageGeneration | undefined {
	if (!AIMessage.isInstance(msg)) return undefined;
	return extractGenerationFromMetadata(msg.response_metadata);
}

/**
 * Reads the persisted thinking duration (ms) off an AI message's response_metadata,
 * written by ObsidianChatManager on save (mirrors the generation-metadata pattern).
 * Returns undefined for non-AI messages or turns with no stored duration.
 */
function extractThinkingDurationFromMessage(msg: BaseMessage): number | undefined {
	if (!AIMessage.isInstance(msg)) return undefined;
	const meta: unknown = msg.response_metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
	const value = (meta as Record<string, unknown>).thinking_duration_ms;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function mergeGeneration(
	current: MessageGeneration | undefined,
	next: MessageGeneration | undefined,
): MessageGeneration | undefined {
	if (!current) return next;
	if (!next) return current;
	return {
		agentId: next.agentId ?? current.agentId,
		agentName: next.agentName ?? current.agentName,
		provider: next.provider ?? current.provider,
		model: next.model ?? current.model,
	};
}

function deriveGenerationFromAssistantMessages(messages: BaseMessage[]): MessageGeneration | undefined {
	let generation: MessageGeneration | undefined;
	for (const msg of messages) {
		generation = mergeGeneration(generation, extractGenerationFromAssistantMessage(msg));
	}
	return generation;
}

/**
 * Ids of tool calls that were announced but never started, and so must be removed
 * from the timeline.
 *
 * A `pending` entry comes from `tool_call_chunks` (the model naming a call before
 * its arguments finish streaming) and is resolved by `on_tool_start`. LangChain
 * validates arguments against the tool schema BEFORE firing that callback, so a
 * call whose arguments don't match throws `ToolInputParsingException` and fires
 * NEITHER tool callback — leaving the announcement with nothing to resolve it,
 * shimmering as "running" indefinitely.
 *
 * Such calls are dropped rather than marked failed: the rejected call produces no
 * ToolMessage and never reaches the checkpoint, the error is fed back to the model,
 * and the model normally retries successfully within the same turn (appearing as
 * its own card). A phantom "failed" row would report a failure the turn didn't
 * actually suffer.
 *
 * `beforeToolCallId` scopes the sweep to calls announced before that call, which is
 * what makes mid-stream cleanup sound: tool execution is ordered, so a call that has
 * just ended proves every earlier announcement without a `tool_start` is dead. Omit
 * it to sweep everything once the stream is over.
 */
export function selectUnresolvedPendingIds(calls: ToolCallState[], beforeToolCallId?: string): Set<string> {
	const cutoff = beforeToolCallId ? calls.findIndex((t) => t.id === beforeToolCallId) : calls.length;
	// findIndex returning -1 (unknown id) must not sweep the whole list, and a cutoff
	// of 0 means the ending call is first, so there is nothing earlier to sweep.
	if (cutoff <= 0) return new Set();
	return new Set(
		calls
			.slice(0, cutoff)
			.filter((t) => t.status === "pending")
			.map((t) => t.id),
	);
}

export function buildTimelineFromToolCalls(
	toolCalls: ToolCallState[] | undefined,
	aiMessageId?: string,
): AssistantTimelineEvent[] | undefined {
	if (!toolCalls || toolCalls.length === 0) return undefined;

	const events: AssistantTimelineEvent[] = [];
	// Track preamble texts already emitted for this message so that when multiple
	// tool calls share the same flat-string preamble (checkpoint replay collapses
	// the content to a single string), the preamble event is only emitted once —
	// for the first tool call that carries it.
	const emittedPreambles = new Set<string>();
	for (const toolCall of toolCalls) {
		const preambleText = toolCall.preamble?.trim();
		if (preambleText && !emittedPreambles.has(preambleText)) {
			emittedPreambles.add(preambleText);
			events.push({
				id: `preamble-${toolCall.id}`,
				type: "preamble",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: preambleText,
				aiMessageId,
			});
		}

		events.push({
			id: `start-${toolCall.id}`,
			type: "tool_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			input: toolCall.input,
			status: "running",
			aiMessageId,
			subAgentName: toolCall.subAgentName,
			parentToolCallId: toolCall.parentToolCallId,
		});

		events.push({
			id: `end-${toolCall.id}`,
			type: "tool_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			output: toolCall.output,
			status: toolCall.status,
			aiMessageId,
			subAgentName: toolCall.subAgentName,
			parentToolCallId: toolCall.parentToolCallId,
		});
	}

	return events.length > 0 ? events : undefined;
}

/**
 * Builds a map of AIMessage id → parent task call id for subagent AIMessages.
 *
 * deepagents injects subagent AIMessages into the parent thread's checkpoint.  These
 * appear after the ToolMessages that completed the parent's `task` calls — i.e. an
 * AIMessage with non-task tool calls that follows a ToolMessage closing a `task` call
 * is a subagent's internal turn.  Parent-agent AIMessages (those that have `task` calls
 * themselves) pass through without clearing the accumulated closed-task list, so
 * sequential task dispatch (one task at a time) is handled correctly alongside
 * parallel dispatch (multiple tasks per LLM turn).
 *
 * Each subagent AIMessage is attributed to the closed `task` call with the fewest
 * children assigned so far (FIFO round-robin — same heuristic as live streaming).
 */
function buildSubAgentParentMap(messages: BaseMessage[]): Map<string, string> {
	// messageId → parentTaskCallId
	const parentMap = new Map<string, string>();
	// task call IDs registered from AIMessages (name === "task")
	const registeredTaskCallIds = new Set<string>();
	// task call IDs closed by ToolMessages, available for attribution; grows across
	// multiple parent-agent turns within a single user turn (sequential task dispatch)
	const closedTaskCallIds: string[] = [];
	// How many subagent AIMessages have been assigned per closed task (round-robin counter)
	const taskChildCounts = new Map<string, number>();

	for (const msg of messages) {
		if (HumanMessage.isInstance(msg)) {
			registeredTaskCallIds.clear();
			closedTaskCallIds.length = 0;
			taskChildCounts.clear();
			continue;
		}

		if (ToolMessage.isInstance(msg)) {
			const tcId = msg.tool_call_id;
			if (tcId && registeredTaskCallIds.has(tcId)) {
				closedTaskCallIds.push(tcId);
				taskChildCounts.set(tcId, 0);
			}
			continue;
		}

		if (AIMessage.isInstance(msg)) {
			const aiMsg = msg;
			const tc = aiMsg.tool_calls ?? [];
			const hasTaskCalls = tc.some((c) => c.name === "task");
			const hasAnyToolCalls = tc.length > 0;

			if (!hasTaskCalls && hasAnyToolCalls && closedTaskCallIds.length > 0) {
				// Subagent AIMessage: has tool calls, none are `task`, and task calls
				// have been closed upstream.  Assign to the closed task with the fewest
				// children (FIFO round-robin).
				let bestParent = closedTaskCallIds[0];
				let bestCount = taskChildCounts.get(bestParent) ?? 0;
				for (const tid of closedTaskCallIds) {
					const c = taskChildCounts.get(tid) ?? 0;
					if (c < bestCount) {
						bestCount = c;
						bestParent = tid;
					}
				}
				if (msg.id) parentMap.set(msg.id, bestParent);
				taskChildCounts.set(bestParent, bestCount + 1);
			}
			// Parent-agent turns (hasTaskCalls) and final-answer turns (no tool calls)
			// intentionally do NOT reset closedTaskCallIds — sequential task dispatch
			// interleaves parent turns between subagent turns within the same user turn.

			// Register new `task` tool calls for future ToolMessage matching
			for (const call of tc) {
				if (call.name === "task" && call.id) {
					registeredTaskCallIds.add(call.id);
				}
			}
		}
	}

	return parentMap;
}

/**
 * Builds a map of tool outputs from tool messages.
 */
function buildToolOutputsMap(messages: BaseMessage[]): Map<string, { content: unknown; status: ToolCallStatus }> {
	const toolOutputs = new Map<string, { content: unknown; status: ToolCallStatus }>();
	for (const msg of messages) {
		if (ToolMessage.isInstance(msg)) {
			const toolMsg = msg;
			const toolCallId = toolMsg.tool_call_id;
			if (toolCallId) {
				toolOutputs.set(toolCallId, {
					content: toolMsg.content,
					status: toolMsg.status === "error" ? "failed" : "completed",
				});
			}
		}
	}
	return toolOutputs;
}

/**
 * Converts a single AI BaseMessage to an AssistantMessage.
 * Used to sync UI with checkpoint state after streaming, and reused in batch conversion.
 */
export function baseMessageToAssistantMessage(
	msg: BaseMessage,
	toolOutputs?: Map<string, { content: unknown; status: ToolCallStatus }>,
	stateOverride?: AssistantState,
): AssistantMessage {
	const textContent = extractTextContent(msg);

	// Extract tool calls if present (only on AIMessage)
	let toolCalls: ToolCallState[] | undefined;

	if (AIMessage.isInstance(msg)) {
		const aiMsg = msg;
		const rawToolCalls = aiMsg.tool_calls;

		if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
			// Extract per-tool-call preamble text.
			// Live responses (Anthropic): content is an array of ordered blocks —
			// text blocks that precede a tool_use block are the preamble for that call.
			// Replayed checkpoints: LangGraph collapses AIMessageChunk content to a
			// flat string; that string is the preamble shared by all tool calls in
			// the message.
			const preambleByToolId = new Map<string, string>();
			if (Array.isArray(aiMsg.content)) {
				let pendingText = "";
				for (const block of aiMsg.content as Array<{ type: string; text?: string; id?: string }>) {
					if (block.type === "text") {
						pendingText += block.text ?? "";
					} else if (block.type === "tool_use" && block.id) {
						if (pendingText.trim()) preambleByToolId.set(block.id, pendingText.trim());
						pendingText = "";
					} else {
						pendingText = "";
					}
				}
			} else if (typeof aiMsg.content === "string" && aiMsg.content.trim()) {
				// Flat string from a replayed checkpoint — assign to all tool calls.
				const sharedPreamble = aiMsg.content.trim();
				for (const tc of rawToolCalls) {
					if (tc.id) preambleByToolId.set(tc.id, sharedPreamble);
				}
			}

			toolCalls = rawToolCalls.map((tc) => {
				const toolOutput = toolOutputs?.get(tc.id || "");
				const input = normalizeToolInput(tc.args);
				// On reload the subagent's own tool calls are not persisted (deepagents
				// returns only the `task` ToolMessage to the parent), so we cannot
				// reconstruct nested children. We can still label the `task` call with
				// the subagent it delegated to, recovered from its `subagent_type` arg.
				const subAgentName =
					tc.name === "task" && typeof input.subagent_type === "string" ? input.subagent_type : undefined;
				return {
					id: tc.id || "",
					name: tc.name,
					input,
					status: toolOutput?.status ?? "completed",
					output: toolOutput?.content,
					preamble: preambleByToolId.get(tc.id || "") ?? undefined,
					subAgentName,
				};
			});
		}
	}

	return {
		state: stateOverride ?? AssistantState.success,
		content: textContent,
		toolCalls,
		assistantTimeline: buildTimelineFromToolCalls(toolCalls, msg.id),
		thinkingDurationMs: extractThinkingDurationFromMessage(msg),
	};
}

/**
 * Merges multiple AI BaseMessages into a single AssistantMessage.
 * Combines tool calls from all messages and uses the last non-empty text content.
 */
function mergeAssistantMessages(
	assistantMessages: BaseMessage[],
	toolOutputs: Map<string, { content: unknown; status: ToolCallStatus }>,
	stateOverride?: AssistantState,
	subAgentParentMap?: Map<string, string>,
): AssistantMessage {
	if (assistantMessages.length === 0) {
		return {
			state: stateOverride ?? AssistantState.success,
			content: "",
		};
	}

	// Merge multiple assistant messages — each AI message identified by its native id
	let finalContent = "";
	let finalDuration: number | undefined;
	const allToolCalls: ToolCallState[] = [];
	const allTimelineEvents: AssistantTimelineEvent[] = [];

	for (const msg of assistantMessages) {
		const converted = baseMessageToAssistantMessage(msg, toolOutputs);
		// If this AIMessage was produced by a subagent (deepagents injects its internal
		// turns into the parent checkpoint), patch its tool calls with parentToolCallId
		// so foldSubAgentChildren can nest them under the correct `task` step.
		const parentTaskCallId = msg.id ? subAgentParentMap?.get(msg.id) : undefined;
		if (parentTaskCallId && converted.toolCalls) {
			for (const tc of converted.toolCalls) {
				tc.parentToolCallId = parentTaskCallId;
			}
			if (converted.assistantTimeline) {
				for (const event of converted.assistantTimeline) {
					event.parentToolCallId = parentTaskCallId;
				}
			}
		}

		// Use the last non-empty content — but skip subagent messages entirely;
		// their text is intermediate subagent reasoning, not the parent answer.
		if (!parentTaskCallId && converted.content.trim()) {
			finalContent = converted.content;
			// The duration is written onto the same final answer message, so carry it
			// from whichever message supplies finalContent (last top-level non-empty).
			if (converted.thinkingDurationMs !== undefined) {
				finalDuration = converted.thinkingDurationMs;
			}
		}

		// Collect all tool calls and timeline events.
		// Use the converted.assistantTimeline directly (which already has parentToolCallId
		// patched in above and preambles extracted) rather than rebuilding from toolCalls,
		// so preamble events inherit the correct parentToolCallId for folding.
		if (converted.toolCalls) {
			allToolCalls.push(...converted.toolCalls);
			if (converted.assistantTimeline) {
				allTimelineEvents.push(...converted.assistantTimeline);
			}
		}
	}

	return {
		state: stateOverride ?? AssistantState.success,
		content: finalContent,
		toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
		assistantTimeline: allTimelineEvents.length > 0 ? allTimelineEvents : undefined,
		thinkingDurationMs: finalDuration,
	};
}

function createSummarizationMarker(source: HiddenHumanSource): MessagePair {
	return {
		id: genUUIDv7(),
		userMessage: { content: "" },
		assistantMessage: { state: AssistantState.success, content: "" },
		transcriptEvent: {
			type: "summarization_marker",
			label:
				source === "manual_summarization"
					? "Conversation compacted here"
					: "Earlier messages were summarized here",
			source,
		},
	};
}

function updateSummarizationMarker(pair: MessagePair, source: HiddenHumanSource): void {
	if (!pair.transcriptEvent || pair.transcriptEvent.type !== "summarization_marker") {
		return;
	}

	pair.transcriptEvent.source = source;
	pair.transcriptEvent.label =
		source === "manual_summarization" ? "Conversation compacted here" : "Earlier messages were summarized here";
}

/**
 * Converts an array of BaseMessage (from LangGraph) into MessagePair[] for UI rendering.
 *
 * This function:
 * 1. Pairs user messages with their corresponding assistant responses
 * 2. Attaches tool outputs to their parent assistant message's tool calls
 * 3. Merges consecutive assistant messages (tool calls + final response)
 * 4. Uses UUIDv7 for message pair IDs (with timestamp extraction capability)
 * 5. Uses errorCount to distinguish error state from cancelled state
 * 6. Populates branching checkpoint IDs and branch info when checkpointMapping is provided
 */
export function baseMessagesToMessagePairs(
	messages: BaseMessage[],
	errorCount = 0,
	checkpointMapping?: CheckpointMessageMapping,
	lastErrorMessage?: string,
): MessagePair[] {
	if (!messages || messages.length === 0) return [];

	const messagePairs: MessagePair[] = [];
	const toolOutputs = buildToolOutputsMap(messages);
	const subAgentParentMap = buildSubAgentParentMap(messages);

	// Filter to just user (human) and assistant (ai) messages
	const conversationMessages = messages.filter((msg) => HumanMessage.isInstance(msg) || AIMessage.isInstance(msg));

	// Track remaining errors locally to avoid reassigning parameter
	let remainingErrors = errorCount;

	let i = 0;
	while (i < conversationMessages.length) {
		const msg = conversationMessages[i];

		if (HumanMessage.isInstance(msg)) {
			const lcSource = msg.additional_kwargs?.lc_source;
			if (isHiddenHumanSource(lcSource)) {
				const lastPair = messagePairs.at(-1);
				if (lastPair?.transcriptEvent?.type === "summarization_marker") {
					updateSummarizationMarker(lastPair, lcSource);
				} else {
					messagePairs.push(createSummarizationMarker(lcSource));
				}
				let j = i + 1;
				while (j < conversationMessages.length && AIMessage.isInstance(conversationMessages[j])) {
					j++;
				}
				i = j;
				continue;
			}

			// Start a new pair with user message
			let userContent = extractTextContent(msg);
			const humanMessageId = msg.id;
			const attachments = (msg.additional_kwargs?.attachments as ChatAttachment[] | undefined) ?? undefined;
			const visibleNotes = (msg.additional_kwargs?.visibleNotes as VisibleNoteRef[] | undefined) ?? undefined;
			const selection = (msg.additional_kwargs?.selection as SelectionRef | undefined) ?? undefined;
			const graphNotes = (msg.additional_kwargs?.graphNotes as GraphNoteRef[] | undefined) ?? undefined;
			const reviewStatus = (msg.additional_kwargs?.reviewStatus as ReviewStatusRef | undefined) ?? undefined;

			// Strip the augmented context blocks by reconstructing the exact suffix
			// that was appended, then removing it from the end. This is safe even when
			// user content or selected text contains bracket patterns like "[Selected text from".
			userContent = stripAugmentedSuffix(userContent, visibleNotes, selection, graphNotes, reviewStatus);

			const pairId = genUUIDv7();

			// Look ahead for assistant response(s)
			const assistantMessages: BaseMessage[] = [];
			let j = i + 1;
			while (j < conversationMessages.length && AIMessage.isInstance(conversationMessages[j])) {
				assistantMessages.push(conversationMessages[j]);
				j++;
			}

			// Determine state for the message pair
			const hasNoResponse = assistantMessages.length === 0;
			let state: AssistantState;

			if (hasNoResponse && remainingErrors > 0) {
				state = AssistantState.error;
				remainingErrors--;
			} else if (hasNoResponse) {
				state = AssistantState.cancelled;
			} else {
				state = AssistantState.success;
			}

			// Build checkpoint IDs and branch info from mapping
			let regenerateFromCheckpointId: string | undefined;
			let editFromCheckpointId: string | undefined;
			let userBranchInfo: BranchInfo | undefined;
			let assistantBranchInfo: BranchInfo | undefined;

			if (checkpointMapping) {
				if (humanMessageId) {
					// Checkpoint where this human message is last -> fork from here to REGENERATE
					regenerateFromCheckpointId = checkpointMapping.humanLastCheckpoints.get(humanMessageId);

					// Checkpoint where previous AI message is last -> fork from here to EDIT
					// For first message, use rootCheckpointId since there's no previous AI
					editFromCheckpointId =
						checkpointMapping.aiBeforeHumanCheckpoints.get(humanMessageId) ??
						checkpointMapping.rootCheckpointId;

					// Branch info for user message (edit branches)
					// Only show on the FIRST human message in a branch (the one right after the fork)
					if (
						regenerateFromCheckpointId &&
						checkpointMapping.editForkEntryCheckpoints.has(regenerateFromCheckpointId)
					) {
						const humanBranchInfo = checkpointMapping.branchInfoMap.get(regenerateFromCheckpointId);
						if (humanBranchInfo) {
							// Update editFromCheckpointId to the actual fork point
							editFromCheckpointId = humanBranchInfo.forkPointId;
							userBranchInfo = humanBranchInfo;
						}
					}

					// Branch info for AI response (regenerate branches)
					// Show only if the AI checkpoint is in a branch that forked from regenerateFromCheckpointId
					const aiCheckpointId = checkpointMapping.aiAfterHumanCheckpoints.get(humanMessageId);
					if (aiCheckpointId && regenerateFromCheckpointId) {
						const aiBranchInfo = checkpointMapping.branchInfoMap.get(aiCheckpointId);
						// Only show if the fork happened at the human message checkpoint (regenerate fork)
						if (aiBranchInfo && aiBranchInfo.forkPointId === regenerateFromCheckpointId) {
							assistantBranchInfo = aiBranchInfo;
						}
					}
				} else {
					// No humanMessageId - this is the first message, use rootCheckpointId for edit
					editFromCheckpointId = checkpointMapping.rootCheckpointId;
				}
			}

			// Derive createdAt from the checkpoint timestamp for this human message
			let createdAt: number | undefined;
			if (humanMessageId && checkpointMapping?.humanTimestamps) {
				const ts = checkpointMapping.humanTimestamps.get(humanMessageId);
				if (ts) {
					const parsed = Date.parse(ts);
					if (Number.isFinite(parsed)) createdAt = parsed;
				}
			}

			const assistantMessage = mergeAssistantMessages(assistantMessages, toolOutputs, state, subAgentParentMap);

			messagePairs.push({
				id: pairId,
				stableKey: humanMessageId ?? pairId,
				userMessage: { content: userContent, attachments, visibleNotes, selection, graphNotes },
				assistantMessage,
				generation: deriveGenerationFromAssistantMessages(assistantMessages),
				createdAt,
				regenerateFromCheckpointId,
				editFromCheckpointId,
				userBranchInfo,
				assistantBranchInfo,
			});

			i = j;
		} else {
			// Orphaned assistant message (no preceding user message)
			const pairId = genUUIDv7();

			messagePairs.push({
				id: pairId,
				userMessage: { content: "" },
				assistantMessage: baseMessageToAssistantMessage(msg, toolOutputs),
				generation: extractGenerationFromAssistantMessage(msg),
			});
			i++;
		}
	}

	// Surface the recovered error message on the newest error pair. `errorCount`
	// is thread-wide (counts errors across all branches), so it can exceed the
	// number of error pairs on the active path — that's why we attach by finding
	// the last error pair here rather than during the count-down loop above.
	if (lastErrorMessage) {
		const lastErrorPair = messagePairs.findLast((pair) => pair.assistantMessage.state === AssistantState.error);
		if (lastErrorPair) {
			lastErrorPair.assistantMessage.errorCode = lastErrorMessage;
		}
	}

	return messagePairs;
}

/**
 * Tool-call ids present in `tipMessages` but not in `forkMessages` — the calls
 * made by the turns an edit/regenerate is about to abandon.
 *
 * Both lists are full checkpoint channels (the channel is cumulative), so the
 * fork checkpoint contains every call up to the fork and the difference is
 * exactly the segment being replaced. Summarization can only TRIM messages from
 * the later tip, which keeps this conservative: a call trimmed from the tip is
 * absent from the diff and its proposals are left alone rather than withdrawn.
 */
export function collectAbandonedToolCallIds(forkMessages: BaseMessage[], tipMessages: BaseMessage[]): Set<string> {
	const keptIds = new Set<string>();
	for (const msg of forkMessages) {
		if (!AIMessage.isInstance(msg)) continue;
		for (const tc of msg.tool_calls ?? []) {
			if (tc.id) keptIds.add(tc.id);
		}
	}

	const abandoned = new Set<string>();
	for (const msg of tipMessages) {
		if (!AIMessage.isInstance(msg)) continue;
		for (const tc of msg.tool_calls ?? []) {
			if (tc.id && !keptIds.has(tc.id)) abandoned.add(tc.id);
		}
	}
	return abandoned;
}

/**
 * Get the timestamp for when this message pair was created.
 * Returns the stable createdAt (derived from checkpoint ts), or null if unavailable.
 */
export function getMessagePairTimestamp(pair: MessagePair): Date | null {
	if (pair.createdAt != null) {
		return new Date(pair.createdAt);
	}
	return null;
}

/**
 * Detect whether the chat history contains references to private notes.
 * Scans tool call inputs/outputs and user attachments for file paths
 * that match the privacy list.
 */
export function chatHistoryContainsPrivateNotes(messages: MessagePair[]): boolean {
	const store = getPendingChangesStore();
	const FILE_TOOLS = new Set(["read_content", "manage_notes", "get_properties"]);

	for (const pair of messages) {
		// Check user attachments
		if (pair.userMessage.attachments) {
			for (const attachment of pair.userMessage.attachments) {
				if (store.isFilePrivate(attachment.vaultPath)) return true;
			}
		}

		// Check tool calls in assistant messages
		if (pair.assistantMessage.toolCalls) {
			for (const tc of pair.assistantMessage.toolCalls) {
				if (!FILE_TOOLS.has(tc.name)) continue;

				// Check input paths
				const inputPath = tc.input?.path ?? tc.input?.note_name;
				if (typeof inputPath === "string" && store.isFilePrivate(inputPath)) return true;

				// Check output for file paths referenced in tool results
				if (typeof tc.output === "string") {
					// Match paths like 'Content of "folder/note.md"' in tool output
					const pathMatch = tc.output.match(/Content of "([^"]+)"/);
					if (pathMatch?.[1] && store.isFilePrivate(pathMatch[1])) return true;
				}
			}
		}
	}
	return false;
}
