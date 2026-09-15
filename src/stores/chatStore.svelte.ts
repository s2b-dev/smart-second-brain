import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { Notice, type TFile } from "obsidian";
import { SvelteMap } from "svelte/reactivity";
import type { AgentStreamChunk, ThreadHistory } from "../agent/Agent";
import type { AgentManager } from "../agent/AgentManager";
import { DEFAULT_AGENT_PROMPT } from "../agent/prompts";
import type { ChatModelConfig } from "../providers/index";
import type { ChatAttachment, ReviewStatusRef, ThreadError } from "../types/shared";
import type { AgentConfig } from "../types/plugin";
import { getPendingChangesStore } from "./pendingChangesStore.svelte";
import { formatVisibleNotesContext, type VisibleNoteRef } from "../hooks/useVisibleNotes.svelte";
import { formatSelectionContext, type SelectionRef } from "../hooks/useSelection.svelte";
import { type UUIDv7, genUUIDv7 } from "../utils/uuid7Validator";
import { DEFAULT_AGENT_ID } from "./agentDefaults";
import { getData } from "./dataStore.svelte";
import { getPlugin } from "./state.svelte";
import { Logger } from "../utils/logging";
import { shouldSummarizeForEstimatedTokens } from "../agent/summarization";
import { estimateConversationBaseTokens, estimateLiveDraftTokens } from "../utils/tokenEstimator";
import { extractErrorMessage } from "../utils/errorMessage";
import {
	MANUAL_SUMMARIZATION_PROMPT,
	MessageState,
	baseMessageToAssistantMessage,
	buildCheckpointGraph,
	buildTimelineFromToolCalls,
	checkpointDebug,
	collectAbandonedToolCallIds,
	deriveMessagePairsFromActiveCheckpoint,
	formatGraphNotesContext,
	formatReviewOutcomesContext,
	normalizeToolInput,
	resolveActiveCheckpointId,
	resolvePostRunCheckpointSelection,
	selectUnresolvedPendingIds,
	type AssistantMessage,
	AssistantState,
	type AssistantTimelineEvent,
	type ChatModel,
	type ChatRecord,
	type CheckpointGraphState,
	type CheckpointNode,
	type GraphNoteRef,
	type MessageGeneration,
	type MessagePair,
	type ToolCallStatus,
} from "./chatTimeline";
export type { ThreadError };

/* -----------------------------------------------------------------------------
 * ChatSession
 *  - Canonical source: checkpoint graph + one active checkpoint ID
 *  - MessagePair[] is always derived from the active checkpoint branch
 * ---------------------------------------------------------------------------*/

interface ChatSessionOptions {
	graphState: CheckpointGraphState;
	errorCount: number;
	lastErrorMessage?: string;
	bootstrapMessages?: BaseMessage[];
	/** Agent selected for this session's runs. Defaults to the global
	 * `selectedAgentId`; restored per-thread from generation metadata on load. */
	selectedAgentId?: string;
	onNeedReload?: () => Promise<void>;
	/** Fires when this.id changes (title rename). Used by SessionRegistry to rekey
	 * the session map so the new path stays addressable. */
	onThreadIdChange?: (oldPath: string, newPath: string) => void;
}

export class ChatSession {
	id = $state<string>("");
	messages: MessagePair[] = $state<MessagePair[]>([]);

	/** Agent whose model/prompt/tools this session's runs resolve against.
	 * Per-session so concurrent tabs can run different agents/models. */
	selectedAgentId = $state<string>("");

	// Streaming / lifecycle
	private abortController: AbortController | null = null;
	private cancelled = false;
	// Reactive mirror of "a stream is in flight". `abortController` is an
	// imperative handle (not $state), so UI that reacts to running state — the
	// status-bar RunningIndicator, input disable — reads THIS instead. Flip it
	// in lockstep wherever abortController is set/cleared.
	private running = $state(false);

	// Reactive UI state
	messageState = $state<MessageState>(MessageState.idle);
	summarizingHistory = $state(false);

	/** Id of the user message pair currently being edited in the composer, or
	 * null when not editing. Lives per-session (not on SessionRegistry) so one
	 * tab's edit can never leak into another. The composer (Input.svelte) is
	 * the only thing that holds the actual draft text, so it also owns
	 * stashing/restoring it around an edit — this is just the on/off switch
	 * and target id, shared with MessageContainer.svelte so both react to it. */
	editingPairId = $state<UUIDv7 | null>(null);

	/** The in-flight run's identity + wall-clock start, held outside `messages` so
	 * it survives the pair-object replacement a rebuild performs. Set when a run
	 * starts, cleared in the run's `finally`. See `restoreLiveRunAnchor`. */
	private liveRun: { pairId: UUIDv7; stableKey?: string; startedAtMs: number } | null = null;

	private graphState: CheckpointGraphState;
	private errorCount: number;
	private lastErrorMessage: string | undefined;
	private bootstrapMessages: BaseMessage[];
	private onNeedReload: (() => Promise<void>) | undefined;
	private onThreadIdChange: ((oldPath: string, newPath: string) => void) | undefined;

	/** Wall-clock of the last time this session was surfaced or ran; used by the
	 * SessionRegistry to evict the least-recently-used parked idle sessions. */
	lastTouchedAt = Date.now();

	constructor(id: string, options: ChatSessionOptions) {
		this.id = id;
		this.selectedAgentId = options.selectedAgentId ?? getData().selectedAgentId;
		this.graphState = options.graphState;
		this.errorCount = options.errorCount;
		this.lastErrorMessage = options.lastErrorMessage;
		this.bootstrapMessages = options.bootstrapMessages ?? [];
		this.onNeedReload = options.onNeedReload;
		this.onThreadIdChange = options.onThreadIdChange;
		this.rebuildMessagePairs();
	}

	/** True while a stream (query/edit/regenerate/summarization) is in flight.
	 * Reads the reactive `running` flag so $derived consumers (RunningIndicator)
	 * update when a stream starts/stops. */
	get isRunning(): boolean {
		return this.running;
	}

	touch(): void {
		this.lastTouchedAt = Date.now();
	}

	/** Public snapshot (immutable-ish) */
	get snapshot(): ChatRecord {
		return {
			id: this.id,
			messages: this.messages.slice(),
		};
	}

	getActiveCheckpointId(): string | undefined {
		return this.graphState.activeCheckpointId;
	}

	getActiveCheckpointMessages(): BaseMessage[] {
		const activeCheckpointId = this.graphState.activeCheckpointId;
		if (activeCheckpointId && this.graphState.nodes.has(activeCheckpointId)) {
			return this.graphState.nodes.get(activeCheckpointId)?.messages ?? this.bootstrapMessages;
		}
		return this.bootstrapMessages;
	}

	setLastPersistedActiveCheckpointId(checkpointId?: string): void {
		this.graphState.lastPersistedActiveCheckpointId = checkpointId;
	}

	applyGraphState(
		graphState: CheckpointGraphState,
		errorCount: number,
		bootstrapMessages?: BaseMessage[],
		lastErrorMessage?: string,
	): void {
		this.graphState = graphState;
		this.errorCount = errorCount;
		this.lastErrorMessage = lastErrorMessage;
		if (bootstrapMessages) {
			this.bootstrapMessages = bootstrapMessages;
		}
		this.rebuildMessagePairs();
	}

	private rebuildMessagePairs(): void {
		this.messages = deriveMessagePairsFromActiveCheckpoint(
			this.graphState,
			this.graphState.activeCheckpointId,
			this.errorCount,
			this.bootstrapMessages,
			this.lastErrorMessage,
		);
		this.restoreLiveRunAnchor();
	}

	/**
	 * Re-apply the in-flight run's start anchor onto the freshly derived pair.
	 *
	 * A rebuild replaces every `MessagePair` with a new object derived from the
	 * checkpoint graph, which knows nothing about a run still in flight. That can
	 * happen mid-stream — `switchToBranch` is explicitly allowed while streaming,
	 * and a reload can land at any time — so without this the live timer's anchor
	 * is dropped and the header restarts counting from 0 in the middle of a run.
	 * Re-derived pairs also carry fresh `id`s, so the anchor is keyed on the run's
	 * own pair id, resolved through `stableKey` when the rebuild renumbered it.
	 */
	private restoreLiveRunAnchor(): void {
		const live = this.liveRun;
		if (!live) return;
		const pair = this.findPairAcrossRebuild(live.pairId, live.stableKey);
		if (!pair) return;
		pair.assistantMessage.runStartedAtMs = live.startedAtMs;
	}

	/** Find a message pair by id */
	private findPair(id: UUIDv7): MessagePair | undefined {
		return this.messages.find((m) => m.id === id);
	}

	/**
	 * Find a message pair that may have been re-derived since its id was captured.
	 *
	 * `rebuildMessagePairs()` mints a fresh `MessagePair.id` for every pair, so a
	 * plain `findPair(id)` silently returns undefined for any id captured before a
	 * rebuild — and callers that stamp post-run state onto the pair then no-op
	 * without a sound. `stableKey` survives the rebuild, so prefer it, and only
	 * compare it when the caller actually has one: an undefined key would otherwise
	 * match the first pair that also lacks one, stamping an unrelated turn.
	 */
	private findPairAcrossRebuild(id: UUIDv7, stableKey: string | undefined): MessagePair | undefined {
		return this.messages.find((m) => m.id === id || (stableKey !== undefined && m.stableKey === stableKey));
	}

	private cloneGraphState(): CheckpointGraphState {
		const nodes = new Map<string, CheckpointNode>();
		for (const [checkpointId, node] of this.graphState.nodes.entries()) {
			nodes.set(checkpointId, {
				...node,
				children: [...node.children],
				messages: [...node.messages],
			});
		}
		return {
			nodes,
			rootCheckpointId: this.graphState.rootCheckpointId,
			activeCheckpointId: this.graphState.activeCheckpointId,
			lastPersistedActiveCheckpointId: this.graphState.lastPersistedActiveCheckpointId,
		};
	}

	private applyOptimisticFork(parentCheckpointId: string, messages: BaseMessage[]): MessagePair {
		const parentNode = this.graphState.nodes.get(parentCheckpointId);
		if (!parentNode) {
			throw new Error("Cannot create optimistic fork: parent checkpoint not found");
		}

		const optimisticCheckpointId = `optimistic-${genUUIDv7()}`;
		const nextGraph = this.cloneGraphState();

		const optimisticNode: CheckpointNode = {
			checkpointId: optimisticCheckpointId,
			parentCheckpointId,
			step: parentNode.step + 1,
			messages,
			children: [],
			ts: new Date().toISOString(),
		};

		nextGraph.nodes.set(optimisticCheckpointId, optimisticNode);
		const nextParent = nextGraph.nodes.get(parentCheckpointId);
		if (nextParent && !nextParent.children.includes(optimisticCheckpointId)) {
			nextParent.children.push(optimisticCheckpointId);
			nextParent.children.sort((a, b) => a.localeCompare(b));
		}
		nextGraph.activeCheckpointId = optimisticCheckpointId;

		this.applyGraphState(nextGraph, this.errorCount, undefined, this.lastErrorMessage);
		const optimisticPair = this.messages.at(-1);
		if (!optimisticPair) {
			throw new Error("Optimistic fork failed: no message pair derived");
		}
		return optimisticPair;
	}

	/**
	 * Send a user message:
	 *  - Create MessagePair with idle assistant
	 *  - Kick off streaming process
	 */
	async sendMessage(
		content: string,
		attachments?: ChatAttachment[],
		visibleNotes?: VisibleNoteRef[],
		selection?: SelectionRef,
		graphNotes?: GraphNoteRef[],
	): Promise<UUIDv7> {
		const pairId = genUUIDv7();

		// Capture the current model at send time
		const selectedAgent = getData().getSelectedAgent();
		const currentModel = selectedAgent.chatModel ?? undefined;

		const pair: MessagePair = {
			id: pairId,
			userMessage: { content, attachments, visibleNotes, selection, graphNotes },
			assistantMessage: { state: AssistantState.idle, content: "" },
			createdAt: Date.now(),
			model: currentModel,
			generation: {
				agentId: selectedAgent.id,
				agentName: selectedAgent.name,
				provider: currentModel?.provider,
				model: currentModel?.model,
			},
		};

		this.messages.push(pair);

		// Stream assistant reply (pass attachments and visible notes so they reach the agent)
		void this.processAssistantReply(pairId, content, attachments, visibleNotes, selection, graphNotes);

		return pairId;
	}

	/** Abort current streaming (if any) */
	stopStreaming(): void {
		if (!this.abortController) {
			throw new Error("No active stream to abort");
		}
		this.cancelled = true;
		this.abortController.abort();
	}

	private resolveEditAttachments(pair: MessagePair): ChatAttachment[] | undefined {
		if (pair.userMessage.attachments?.length) {
			return pair.userMessage.attachments;
		}

		const checkpointId = pair.regenerateFromCheckpointId;
		if (!checkpointId) {
			return undefined;
		}

		const node = this.graphState.nodes.get(checkpointId);
		const lastMessage = node?.messages.at(-1);
		if (!lastMessage || !HumanMessage.isInstance(lastMessage)) {
			return undefined;
		}

		const recovered = (lastMessage.additional_kwargs?.attachments as ChatAttachment[] | undefined)?.filter((att) =>
			Boolean(att?.name && att?.mimeType && att?.vaultPath),
		);

		return recovered?.length ? recovered : undefined;
	}

	/** The attachments an edit of this pair starts from — what the message being
	 * edited carried. The composer seeds its tray with these so they're visible
	 * and removable during the edit instead of riding along invisibly. */
	getEditAttachments(pairId: UUIDv7): ChatAttachment[] {
		const pair = this.findPair(pairId);
		if (!pair) return [];
		return this.resolveEditAttachments(pair) ?? [];
	}

	/**
	 * Withdraw pending note proposals staged by the turns this fork abandons.
	 *
	 * Called by editMessage/regenerateResponse BEFORE the fork: the proposals
	 * belong to an answer the user is replacing, and leaving them pending is what
	 * produced orphaned review-bar rows, duplicated creates on rerun, and reruns
	 * rebasing their updates onto the abandoned answer's content. Deliberately
	 * NOT called on switchToBranch — switching is reversible navigation, so the
	 * other branch's proposals stay reviewable.
	 *
	 * Partially-applied entries are kept (see the store method); a Notice tells
	 * the user what was withdrawn so proposals never vanish silently.
	 */
	private withdrawAbandonedPendingChanges(forkCheckpointId: string): void {
		const forkNode = this.graphState.nodes.get(forkCheckpointId);
		if (!forkNode) return;
		const abandoned = collectAbandonedToolCallIds(forkNode.messages, this.getActiveCheckpointMessages());
		if (abandoned.size === 0) return;

		try {
			const { withdrawn, keptPartiallyApplied } = getPendingChangesStore().withdrawForToolCalls(
				String(this.id),
				abandoned,
			);
			if (withdrawn > 0) {
				const kept =
					keptPartiallyApplied > 0
						? ` ${keptPartiallyApplied} partially applied change(s) were kept — resolve them in the review bar.`
						: "";
				new Notice(`Withdrew ${withdrawn} pending note change(s) proposed by the replaced response.${kept}`);
			}
		} catch {
			// store not initialized (e.g. very early in startup) — nothing staged yet
		}
	}

	/** Enter edit mode for a message pair. The composer reacts to
	 * `editingPairId` changing to stash its draft and seed the message's text. */
	beginEdit(pairId: UUIDv7): void {
		this.editingPairId = pairId;
	}

	/** Leave edit mode without submitting. The composer is responsible for
	 * restoring whatever draft it stashed when the edit began. */
	cancelEdit(): void {
		this.editingPairId = null;
	}

	/** The pair currently being edited, or undefined if edit state is stale
	 * (e.g. the pair was dropped by a branch switch mid-edit). */
	getEditingPair(): MessagePair | undefined {
		return this.editingPairId ? this.findPair(this.editingPairId) : undefined;
	}

	/**
	 * Edit a user message and get a new AI response.
	 * This creates a new branch from the checkpoint before the original message.
	 *
	 * `attachments` is what the edited message should carry. The composer always
	 * passes it (the tray's contents at save time, `[]` meaning the user removed
	 * them all); `undefined` means the caller doesn't manage attachments, so the
	 * original message's own attachments are restored from the checkpoint.
	 */
	async editMessage(pairId: UUIDv7, newContent: string, attachments?: ChatAttachment[]): Promise<void> {
		const pair = this.findPair(pairId);
		if (!pair) {
			throw new Error("Message pair not found");
		}

		// Same guard runStream applies, but BEFORE the withdrawal and the
		// optimistic fork: reaching it only there would first withdraw pending
		// proposals and mutate the graph for a run that is then refused.
		if (this.running) {
			throw new Error("A response is already in progress for this chat.");
		}

		const resolvedAttachments =
			attachments === undefined
				? this.resolveEditAttachments(pair)
				: attachments.length > 0
					? attachments
					: undefined;

		// Get the checkpoint to fork from for editing
		const checkpointId = pair.editFromCheckpointId;
		if (!checkpointId) {
			throw new Error(
				"Cannot edit: no checkpoint available for this message. Checkpoint graph may not be loaded.",
			);
		}

		this.withdrawAbandonedPendingChanges(checkpointId);

		const parentMessages = this.graphState.nodes.get(checkpointId)?.messages ?? [];
		const optimisticMessages = [
			...parentMessages,
			new HumanMessage({
				content: newContent,
				id: genUUIDv7(),
				additional_kwargs: resolvedAttachments?.length ? { attachments: resolvedAttachments } : undefined,
			}),
		];
		const optimisticPair = this.applyOptimisticFork(checkpointId, optimisticMessages);
		optimisticPair.userMessage.content = newContent;
		optimisticPair.userMessage.attachments = resolvedAttachments;
		optimisticPair.assistantMessage.state = AssistantState.idle;
		optimisticPair.assistantMessage.content = "";
		optimisticPair.assistantMessage.toolCalls = undefined;
		optimisticPair.userBranchInfo = undefined;
		optimisticPair.assistantBranchInfo = undefined;
		optimisticPair.regenerateFromCheckpointId = undefined;

		// Stream the edited response
		await this.processEditReply(optimisticPair.id, newContent, checkpointId, resolvedAttachments);
	}

	/**
	 * Regenerate the AI response for a message without re-sending the user message.
	 * This creates a new branch from the checkpoint after the user message.
	 */
	async regenerateResponse(pairId: UUIDv7): Promise<void> {
		const pair = this.findPair(pairId);
		if (!pair) {
			throw new Error("Message pair not found");
		}

		// Before the withdrawal/fork, for the same reason as editMessage: the
		// regenerate affordance stays visible on earlier turns while a run streams.
		if (this.running) {
			throw new Error("A response is already in progress for this chat.");
		}

		// Get the checkpoint to fork from for regeneration
		const checkpointId = pair.regenerateFromCheckpointId;
		if (!checkpointId) {
			throw new Error(
				"Cannot regenerate: no checkpoint available for this message. Checkpoint graph may not be loaded.",
			);
		}

		this.withdrawAbandonedPendingChanges(checkpointId);

		const parentMessages = this.graphState.nodes.get(checkpointId)?.messages ?? [];
		const optimisticPair = this.applyOptimisticFork(checkpointId, [...parentMessages]);
		optimisticPair.assistantMessage.state = AssistantState.idle;
		optimisticPair.assistantMessage.content = "";
		optimisticPair.assistantMessage.toolCalls = undefined;
		optimisticPair.assistantBranchInfo = undefined;

		// Stream the regenerated response
		await this.processRegenerateReply(optimisticPair.id, checkpointId);
	}

	/**
	 * Retry a failed turn: re-run the model for a user message whose response
	 * errored out. Unlike {@link regenerateResponse}, this tolerates a missing
	 * `regenerateFromCheckpointId` — immediately after a live error the graph is
	 * still stale (the failed run skips `syncGraphAfterRun`), so we reload the
	 * session from the persisted checkpoints first to recover the checkpoint that
	 * holds the failed user message, then regenerate from it.
	 */
	async retryLastError(pairId: UUIDv7): Promise<void> {
		const pair = this.findPair(pairId);
		if (!pair || pair.assistantMessage.state !== AssistantState.error) {
			throw new Error("Cannot retry: message pair is not in an error state.");
		}

		// Fast path: the checkpoint is already known (e.g. after a reload).
		if (pair.regenerateFromCheckpointId) {
			await this.regenerateResponse(pairId);
			return;
		}

		// Slow path: sync from persisted checkpoints so the failed user message's
		// checkpoint becomes addressable, then regenerate the now-resolved pair.
		if (!this.onNeedReload) {
			throw new Error("Cannot retry: no checkpoint available and session reload is unavailable.");
		}
		await this.onNeedReload();

		const reloadedPair = this.messages.findLast(
			(p) => p.assistantMessage.state === AssistantState.error && p.regenerateFromCheckpointId,
		);
		if (!reloadedPair?.regenerateFromCheckpointId) {
			throw new Error("Cannot retry: failed message could not be recovered from history.");
		}

		await this.regenerateResponse(reloadedPair.id);
	}

	/* -----------------------------------------------------------------------
	 * Streaming logic
	 * ---------------------------------------------------------------------*/

	private normalizeToolInput(raw: unknown): Record<string, unknown> {
		return normalizeToolInput(raw);
	}

	private async persistLastViewedCheckpoint(checkpointId?: string): Promise<void> {
		if (!checkpointId) return;
		await getPlugin().agentManager.setLastViewedCheckpoint(this.id, checkpointId);
		this.graphState.lastPersistedActiveCheckpointId = checkpointId;
	}

	private async syncGraphAfterRun(parentCheckpointId: string | undefined, beforeSet: Set<string>): Promise<void> {
		const agentManager = getPlugin().agentManager;
		const checkpointHistory = await agentManager.getCheckpointHistory(this.id);
		const nextGraph = buildCheckpointGraph(checkpointHistory);
		nextGraph.lastPersistedActiveCheckpointId = this.graphState.lastPersistedActiveCheckpointId;

		const postRunResolution = resolvePostRunCheckpointSelection(nextGraph, beforeSet, parentCheckpointId);
		let resolvedActiveCheckpointId = postRunResolution.newActiveCheckpointId;

		if (!resolvedActiveCheckpointId) {
			const fallbackResolution = resolveActiveCheckpointId(nextGraph, {
				sessionActiveCheckpointId: this.graphState.activeCheckpointId,
				persistedCheckpointId: this.graphState.lastPersistedActiveCheckpointId,
			});
			resolvedActiveCheckpointId = fallbackResolution.checkpointId;
		}

		nextGraph.activeCheckpointId = resolvedActiveCheckpointId;

		checkpointDebug("post_run_selection", {
			parentCheckpointId,
			beforeCount: beforeSet.size,
			newIds: postRunResolution.newIds,
			newActiveCheckpointId: postRunResolution.newActiveCheckpointId,
			resolvedActiveCheckpointId,
		});

		this.applyGraphState(nextGraph, this.errorCount, undefined, this.lastErrorMessage);
		await this.persistLastViewedCheckpoint(resolvedActiveCheckpointId);
	}

	/**
	 * Core streaming handler - processes any stream and updates the message pair.
	 */
	private async runStream(
		pairId: UUIDv7,
		getStream: (signal: AbortSignal) => AsyncIterable<AgentStreamChunk>,
		options: {
			generateTitle?: string;
			reloadAfter?: boolean;
			parentCheckpointId?: string;
			beforeCheckpointIds: Set<string>;
			predictedSummarization?: boolean;
		},
	) {
		const pair = this.findPair(pairId);
		if (!pair) return;

		if (this.abortController) {
			throw new Error("A response is already in progress for this chat.");
		}

		this.abortController = new AbortController();
		this.running = true;
		const signal = this.abortController.signal;
		this.touch();

		// Marks the point past which the answer is durable: the stream completed
		// and the checkpointer wrote it. Post-success bookkeeping (graph sync,
		// reload, duration persistence) can still throw, but must degrade the
		// view rather than retract a turn the user has already read.
		let streamSucceeded = false;

		try {
			this.messageState = MessageState.answering;
			this.summarizingHistory = options.predictedSummarization ?? false;
			pair.assistantMessage.state = AssistantState.streaming;

			// Wall-clock start of the turn — used to compute the run duration stamped on
			// the message (live) and persisted onto the checkpoint below, and stamped on
			// the message itself so the live timer has a remount-proof anchor.
			const runStartedAtMs = Date.now();
			pair.assistantMessage.runStartedAtMs = runStartedAtMs;
			this.liveRun = { pairId, stableKey: pair.stableKey, startedAtMs: runStartedAtMs };

			await this.consumeStream(pair.assistantMessage, getStream(signal));
			pair.assistantMessage.state = AssistantState.success;
			// The turn has succeeded and the checkpointer has persisted the answer.
			// Everything below is bookkeeping over that already-durable result, so
			// from here on a throw must not be reported as a failed turn — see the
			// post-success block after this try.
			streamSucceeded = true;

			// Stamp the elapsed time so the "Thought for Ns" label shows immediately
			// (before any reload) and reads back from persistence later. This is the
			// FULL-run duration (turn start → stream end): the whole turn is the
			// "thinking process" — all streamed text renders under the header until the
			// stream ends, at which point the final answer drops into place below.
			const thinkingDurationMs = Date.now() - runStartedAtMs;
			pair.assistantMessage.thinkingDurationMs = thinkingDurationMs;

			// Generate chat title after stream completes for the first user message.
			// Must be sequential because rename changes this.id (the thread path).
			if (options.generateTitle && this.messages.length === 1) {
				try {
					const plugin = getPlugin();
					const newPath = await plugin.agentManager.generateThreadTitleFromUserMessage(
						String(this.id),
						this.selectedAgentId,
						options.generateTitle,
					);
					if (newPath) {
						const oldPath = String(this.id);
						this.id = newPath;
						this.onThreadIdChange?.(oldPath, newPath);
					}
				} catch (err) {
					Logger.warn("[ChatSession] Failed to generate chat title:", err);
				}
			}

			await this.syncGraphAfterRun(options.parentCheckpointId, options.beforeCheckpointIds);

			// syncGraphAfterRun rebuilds this.messages from the checkpoint graph, which
			// replaces the pair object we stamped above with a fresh one whose
			// thinkingDurationMs is read from response_metadata — not yet written (that
			// happens below). Without this re-stamp the label flips from "Thought for Ns"
			// back to the 1s floor the instant the stream settles.
			//
			// The lookup must tolerate the rebuild: it also mints a fresh `MessagePair.id`,
			// so matching on the pre-run `pairId` alone found nothing and this re-stamp
			// silently no-opped — which is exactly how a long run came to report
			// "Thought for 1s" (undefined duration → the UI's `Math.max(1, runningSeconds)`
			// fallback, with runningSeconds already back to 0).
			const rebuiltPair = this.findPairAcrossRebuild(pairId, pair.stableKey);
			if (rebuiltPair) {
				rebuiltPair.assistantMessage.thinkingDurationMs = thinkingDurationMs;
			}

			// Persist the thinking duration onto the just-created checkpoint's final
			// AI message (response_metadata) so "Thought for Ns" survives reload. Done
			// after syncGraphAfterRun, when the active checkpoint id for this turn is
			// resolved. Best-effort: a failure here only loses the persisted label,
			// not the answer, so it must never break the run.
			const settledCheckpointId = this.graphState.activeCheckpointId;
			if (settledCheckpointId) {
				try {
					await getPlugin().agentManager.annotateThinkingDuration(
						String(this.id),
						settledCheckpointId,
						thinkingDurationMs,
					);
				} catch (err) {
					Logger.warn("[ChatSession] Failed to persist thinking duration:", err);
				}
			}

			if (options.reloadAfter && this.onNeedReload) {
				await this.onNeedReload();
			}
		} catch (_err) {
			if (this.cancelled) {
				pair.assistantMessage.state = AssistantState.cancelled;
			} else if (streamSucceeded) {
				// Post-success bookkeeping failed. The answer streamed to completion
				// and the checkpointer persisted it, so the turn stands: marking it
				// `error` here would retract a reply the user is already reading and
				// offer a pointless "retry" of work that actually succeeded. That is
				// exactly what a rename-invalidated `onNeedReload` used to do.
				//
				// What is lost is view freshness (the checkpoint graph may not reflect
				// this turn until the next load), not content — so log and move on.
				Logger.error("[ChatSession] Post-run bookkeeping failed (answer preserved):", _err);
			} else {
				pair.assistantMessage.state = AssistantState.error;
				pair.assistantMessage.errorCode = extractErrorMessage(_err);
				Logger.error("[ChatSession] Run failed:", _err);
			}
		} finally {
			// Drop the live anchor on every exit path — success, cancel and error
			// alike. A stale anchor left on a cancelled/errored pair would make a
			// later retry count from the abandoned run's start.
			this.liveRun = null;
			const settledPair = this.findPairAcrossRebuild(pairId, pair.stableKey);
			if (settledPair) {
				settledPair.assistantMessage.runStartedAtMs = undefined;
			}
			this.abortController = null;
			this.running = false;
			this.cancelled = false;
			this.summarizingHistory = false;
			this.messageState = MessageState.idle;
			this.touch();
		}
	}

	private async shouldPredictSummarization(
		inputValue: string,
		options: {
			attachmentsCount?: number;
			visibleNotesCount?: number;
			hasSelection?: boolean;
			graphNotesCount?: number;
		} = {},
	): Promise<boolean> {
		const selectedAgent = getData().getSelectedAgent();
		const contextWindow = selectedAgent.chatModel?.modelConfig?.contextWindow;
		let systemPrompt = DEFAULT_AGENT_PROMPT;
		try {
			systemPrompt = await getPlugin().agentManager.assembleSystemPrompt();
		} catch {
			// Fall back to the default prompt if assembly fails.
		}
		const estimatedTokens =
			estimateConversationBaseTokens(this.getActiveCheckpointMessages(), {
				systemPrompt,
			}) +
			estimateLiveDraftTokens(inputValue, {
				pendingAttachmentsCount: options.attachmentsCount,
				pendingVisibleNotesCount: options.visibleNotesCount,
				hasPendingSelection: options.hasSelection,
				pendingGraphNotesCount: options.graphNotesCount,
			});

		return shouldSummarizeForEstimatedTokens(estimatedTokens, contextWindow);
	}

	/** Augments the user query with visible notes context from the provided refs.
	 * Order must match stripAugmentedSuffix exactly — the UI strips by exact
	 * suffix reconstruction. */
	private augmentWithVisibleNotes(
		userContent: string,
		visibleNotes?: VisibleNoteRef[],
		selection?: SelectionRef,
		graphNotes?: GraphNoteRef[],
		reviewStatus?: ReviewStatusRef,
	): string {
		let result = userContent;
		if (visibleNotes?.length) {
			const ctx = formatVisibleNotesContext(visibleNotes);
			if (ctx) result = `${result}\n\n${ctx}`;
		}
		if (selection) {
			result = `${result}\n\n${formatSelectionContext(selection)}`;
		}
		if (graphNotes?.length) {
			const ctx = formatGraphNotesContext(graphNotes);
			if (ctx) result = `${result}\n\n${ctx}`;
		}
		if (reviewStatus) {
			const ctx = formatReviewOutcomesContext(reviewStatus);
			if (ctx) result = `${result}\n\n${ctx}`;
		}
		return result;
	}

	/** Process assistant reply for a normal query (new message in thread). */
	private async processAssistantReply(
		pairId: UUIDv7,
		userContent: string,
		attachments?: ChatAttachment[],
		visibleNotes?: VisibleNoteRef[],
		selection?: SelectionRef,
		graphNotes?: GraphNoteRef[],
	) {
		const plugin = getPlugin();
		const beforeCheckpointIds = new Set(this.graphState.nodes.keys());
		const parentCheckpointId = this.graphState.activeCheckpointId ?? this.graphState.rootCheckpointId;
		// Review outcomes for changes the model staged earlier in this thread —
		// collected at send time so the model stops assuming rejected edits exist.
		// `take` marks resolved entries reported; if this send then fails before
		// the checkpoint persists, those outcomes are lost to the model (it can
		// still read the notes) — accepted over re-reporting them forever.
		let reviewStatus: ReviewStatusRef | undefined;
		try {
			const { outcomes, pendingProposals } = getPendingChangesStore().takeReviewOutcomesForThread(
				String(this.id),
			);
			if (outcomes.length > 0 || pendingProposals.length > 0) reviewStatus = { outcomes, pendingProposals };
		} catch {
			// store not initialized — send without the block
		}
		const augmented = this.augmentWithVisibleNotes(userContent, visibleNotes, selection, graphNotes, reviewStatus);

		checkpointDebug("send.parent", {
			threadId: this.id,
			parentCheckpointId,
			activeCheckpointId: this.graphState.activeCheckpointId,
		});

		await this.runStream(
			pairId,
			(signal) =>
				plugin.agentManager.streamQuery(
					augmented,
					String(this.id),
					this.selectedAgentId,
					this.graphState.activeCheckpointId,
					signal,
					attachments,
					visibleNotes,
					selection,
					graphNotes,
					undefined,
					reviewStatus,
				) as AsyncIterable<AgentStreamChunk>,
			{
				generateTitle: userContent,
				reloadAfter: true,
				parentCheckpointId,
				beforeCheckpointIds,
				predictedSummarization: await this.shouldPredictSummarization(userContent, {
					attachmentsCount: attachments?.length,
					visibleNotesCount: visibleNotes?.length,
					hasSelection: Boolean(selection),
					graphNotesCount: graphNotes?.length,
				}),
			},
		);
	}

	/** Process assistant reply for an edit (forks from checkpoint with new user message). */
	private async processEditReply(
		pairId: UUIDv7,
		userContent: string,
		checkpointId: string,
		attachments?: ChatAttachment[],
	) {
		const plugin = getPlugin();
		const beforeCheckpointIds = new Set(this.graphState.nodes.keys());
		const augmented = this.augmentWithVisibleNotes(userContent);

		checkpointDebug("edit.parent", {
			threadId: this.id,
			parentCheckpointId: checkpointId,
		});

		await this.runStream(
			pairId,
			(signal) =>
				plugin.agentManager.editFromCheckpoint(
					augmented,
					String(this.id),
					this.selectedAgentId,
					checkpointId,
					signal,
					attachments,
				) as AsyncIterable<AgentStreamChunk>,
			{
				reloadAfter: true,
				parentCheckpointId: checkpointId,
				beforeCheckpointIds,
				predictedSummarization: await this.shouldPredictSummarization(userContent, {
					attachmentsCount: attachments?.length,
				}),
			},
		);
	}

	/** Process assistant reply for regeneration (no new user message, continues from checkpoint). */
	private async processRegenerateReply(pairId: UUIDv7, checkpointId: string) {
		const plugin = getPlugin();
		const beforeCheckpointIds = new Set(this.graphState.nodes.keys());

		checkpointDebug("regenerate.parent", {
			threadId: this.id,
			parentCheckpointId: checkpointId,
		});

		await this.runStream(
			pairId,
			(signal) =>
				plugin.agentManager.regenerateFromCheckpoint(
					String(this.id),
					this.selectedAgentId,
					checkpointId,
					signal,
				) as AsyncIterable<AgentStreamChunk>,
			{
				reloadAfter: true,
				parentCheckpointId: checkpointId,
				beforeCheckpointIds,
				predictedSummarization: await this.shouldPredictSummarization(""),
			},
		);
	}

	/**
	 * Shared stream consumption logic for both normal queries and regeneration.
	 */
	private async consumeStream(
		assistantMsg: AssistantMessage,
		stream: AsyncIterable<AgentStreamChunk>,
	): Promise<void> {
		let tokenBuffer = "";
		let hasSeenToolCall = false;
		// Track preamble texts already emitted during streaming so that parallel tool
		// calls sharing the same preambleAccumulator text only get one preamble event.
		const emittedStreamPreambles = new Set<string>();
		let currentTokenAiMessageId: string | undefined;
		// True after a tool_end — signals that the next token starts a new LangGraph step.
		// We reset the display content then to avoid stacking inter-step AI texts.
		let pendingStepReset = false;

		if (!assistantMsg.assistantTimeline) assistantMsg.assistantTimeline = [];

		const dropUnresolvedPending = (beforeToolCallId?: string) => {
			const calls = assistantMsg.toolCalls;
			if (!calls?.length) return;
			const orphaned = selectUnresolvedPendingIds(calls, beforeToolCallId);
			if (orphaned.size === 0) return;
			Logger.debug("chatStore.consumeStream.dropped_unresolved_pending", {
				toolCallIds: [...orphaned],
			});
			assistantMsg.toolCalls = calls.filter((t) => !orphaned.has(t.id));
			if (assistantMsg.assistantTimeline) {
				assistantMsg.assistantTimeline = assistantMsg.assistantTimeline.filter(
					(e) => !(e.toolCallId && orphaned.has(e.toolCallId) && e.type !== "preamble"),
				);
			}
		};

		for await (const chunk of stream) {
			if (chunk.type === "token") {
				this.summarizingHistory = false;
				if (!chunk.token) continue;

				// Detect step boundary via aiMessageId change (preferred), or via
				// pendingStepReset (fallback when aiMessageId doesn't change between steps).
				const aiIdChanged =
					hasSeenToolCall && chunk.aiMessageId && chunk.aiMessageId !== currentTokenAiMessageId;
				if (aiIdChanged || pendingStepReset) {
					tokenBuffer = "";
					assistantMsg.content = "";
					assistantMsg.contentAiMessageId = undefined;
					pendingStepReset = false;
					emittedStreamPreambles.clear();
				}
				if (chunk.aiMessageId) currentTokenAiMessageId = chunk.aiMessageId;

				tokenBuffer += chunk.token;
				assistantMsg.content = hasSeenToolCall ? tokenBuffer.trimStart() : tokenBuffer;
				// Stamp the aiMessageId of the text now in `content` so the UI can tell
				// when the model has moved to a NEW message (fold trigger). See the field
				// docs on AssistantMessage.
				assistantMsg.contentAiMessageId = currentTokenAiMessageId;
				continue;
			}

			// The model has begun a tool call but is still streaming its arguments, so
			// the tool hasn't started and we have no input yet. Show the call now rather
			// than leaving the turn blank for however long the arguments take — for a
			// `manage_notes` edit the arguments ARE the note body, so that wait is
			// seconds. The matching `tool_start` upgrades this entry in place below.
			if (chunk.type === "tool_pending") {
				this.summarizingHistory = false;
				hasSeenToolCall = true;
				pendingStepReset = false;

				// Commit the preamble AS WE CLEAR the live answer spot. Clearing without
				// committing (leaving it for tool_start) blanked the text for the whole
				// argument-streaming window — seconds for a `manage_notes` edit — so the
				// user watched their preamble appear, vanish, then reappear. The two must
				// happen in the same step: the text moves, it never disappears.
				const pendingPreamble = (chunk.preamble ?? "").trim();
				const pendingHasNewPreamble = !!pendingPreamble && !emittedStreamPreambles.has(pendingPreamble);
				if (pendingHasNewPreamble) emittedStreamPreambles.add(pendingPreamble);
				tokenBuffer = "";
				assistantMsg.content = "";
				assistantMsg.contentAiMessageId = undefined;

				if (!assistantMsg.toolCalls) assistantMsg.toolCalls = [];
				if (!assistantMsg.toolCalls.some((t) => t.id === chunk.toolCallId)) {
					assistantMsg.toolCalls.push({
						id: chunk.toolCallId,
						name: chunk.toolName,
						status: "pending",
						preamble: pendingHasNewPreamble ? pendingPreamble : undefined,
						subAgentName: chunk.subAgentName,
						parentToolCallId: chunk.parentToolCallId,
					});
				}

				if (pendingHasNewPreamble) {
					assistantMsg.assistantTimeline.push({
						id: `preamble-${chunk.toolCallId}-${assistantMsg.assistantTimeline.length}`,
						type: "preamble",
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						content: pendingPreamble,
						aiMessageId: chunk.aiMessageId,
					});
				}

				if (
					!assistantMsg.assistantTimeline.some(
						(e) => e.type !== "preamble" && e.toolCallId === chunk.toolCallId,
					)
				) {
					assistantMsg.assistantTimeline.push({
						id: `pending-${chunk.toolCallId}-${assistantMsg.assistantTimeline.length}`,
						type: "tool_pending",
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						status: "pending",
						aiMessageId: chunk.aiMessageId,
						subAgentName: chunk.subAgentName,
						parentToolCallId: chunk.parentToolCallId,
					});
				}
				continue;
			}

			if (chunk.type === "tool_start") {
				this.summarizingHistory = false;
				hasSeenToolCall = true;
				pendingStepReset = false;
				// Use the preamble carried on the chunk (indexed by Agent.ts from the
				// messages stream before tool callbacks fire) rather than tokenBuffer.
				// tokenBuffer may contain text from earlier steps or be empty if messages
				// arrived out of order relative to tool callbacks.
				const preamble = chunk.preamble ?? "";
				const preambleTrimmed = preamble.trim();
				const isFirstWithPreamble = !!preambleTrimmed && !emittedStreamPreambles.has(preambleTrimmed);
				if (isFirstWithPreamble) emittedStreamPreambles.add(preambleTrimmed);
				tokenBuffer = "";
				assistantMsg.content = "";
				assistantMsg.contentAiMessageId = undefined;

				if (!assistantMsg.toolCalls) assistantMsg.toolCalls = [];
				// A `tool_pending` for this id already created the entry; upgrade it in
				// place so the card doesn't duplicate or jump position when execution
				// actually begins. Attribution stays as announced (tool_start's is
				// authoritative, but identical here); only input/status/preamble fill in.
				const announced = assistantMsg.toolCalls.find((t) => t.id === chunk.toolCallId);
				if (announced) {
					announced.name = chunk.toolName;
					announced.input = this.normalizeToolInput(chunk.input);
					announced.status = "running";
					if (isFirstWithPreamble) announced.preamble = preambleTrimmed;
					if (chunk.subAgentName) announced.subAgentName = chunk.subAgentName;
					if (chunk.parentToolCallId) announced.parentToolCallId = chunk.parentToolCallId;
				} else {
					assistantMsg.toolCalls.push({
						id: chunk.toolCallId,
						name: chunk.toolName,
						input: this.normalizeToolInput(chunk.input),
						status: "running",
						preamble: isFirstWithPreamble ? preambleTrimmed : undefined,
						subAgentName: chunk.subAgentName,
						parentToolCallId: chunk.parentToolCallId,
					});
				}

				// The announced `tool_pending` event is already positioned in the timeline,
				// so upgrade it in place. Pushing a second event would render the tool
				// twice; and the preamble must be INSERTED BEFORE it (not appended) so the
				// reasoning text still reads above the card it belongs to.
				const announcedEventIdx = assistantMsg.assistantTimeline.findIndex(
					(e) => e.type === "tool_pending" && e.toolCallId === chunk.toolCallId,
				);

				if (isFirstWithPreamble) {
					const preambleEvent: AssistantTimelineEvent = {
						id: `preamble-${chunk.toolCallId}-${assistantMsg.assistantTimeline.length}`,
						type: "preamble",
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						content: preambleTrimmed,
						aiMessageId: chunk.aiMessageId,
					};
					if (announcedEventIdx >= 0) {
						assistantMsg.assistantTimeline.splice(announcedEventIdx, 0, preambleEvent);
					} else {
						assistantMsg.assistantTimeline.push(preambleEvent);
					}
				}

				const startedEvent = assistantMsg.assistantTimeline.find(
					(e) => e.type === "tool_pending" && e.toolCallId === chunk.toolCallId,
				);
				if (startedEvent) {
					startedEvent.type = "tool_start";
					startedEvent.toolName = chunk.toolName;
					startedEvent.input = this.normalizeToolInput(chunk.input);
					startedEvent.status = "running";
					if (chunk.aiMessageId) startedEvent.aiMessageId = chunk.aiMessageId;
					if (chunk.subAgentName) startedEvent.subAgentName = chunk.subAgentName;
					if (chunk.parentToolCallId) startedEvent.parentToolCallId = chunk.parentToolCallId;
				} else {
					assistantMsg.assistantTimeline.push({
						id: `start-${chunk.toolCallId}-${assistantMsg.assistantTimeline.length}`,
						type: "tool_start",
						toolCallId: chunk.toolCallId,
						toolName: chunk.toolName,
						input: this.normalizeToolInput(chunk.input),
						status: "running",
						aiMessageId: chunk.aiMessageId,
						subAgentName: chunk.subAgentName,
						parentToolCallId: chunk.parentToolCallId,
					});
				}
				continue;
			}

			if (chunk.type === "tool_end") {
				this.summarizingHistory = false;
				// A call that finished proves any call announced BEFORE it never started:
				// tool execution is ordered, so an earlier announcement that still has no
				// tool_start was rejected at schema validation. Clearing it here rather
				// than only at stream end matters — the turn can run for tens of seconds
				// afterwards, and the dead card would shimmer for all of it.
				dropUnresolvedPending(chunk.toolCallId);
				// Determine tool completion status up-front so both ToolCallState
				// and the timeline event use the same value.  During streaming the
				// on_tool_end event does not carry a status flag, so we default to
				// "completed".  The checkpoint_message handler below reconciles the
				// final status from ToolMessage.status (which does distinguish errors).
				const resolvedStatus: ToolCallStatus = "completed";

				if (assistantMsg.toolCalls) {
					const tc = assistantMsg.toolCalls.find((t) => t.id === chunk.toolCallId);
					if (tc) {
						tc.status = resolvedStatus;
						tc.output = chunk.output;
						// Attribution (subagent name + parent task) is authoritative from the
						// tool_start event. Do NOT overwrite it here: the on_tool_end attribution
						// is recomputed by a FIFO round-robin that can pick a different open
						// `task` when several run in parallel, which would re-parent an already
						// nested child onto the wrong task card. Only fill gaps.
						if (chunk.subAgentName && !tc.subAgentName) tc.subAgentName = chunk.subAgentName;
						if (chunk.parentToolCallId && !tc.parentToolCallId)
							tc.parentToolCallId = chunk.parentToolCallId;
					} else {
						assistantMsg.toolCalls.push({
							id: chunk.toolCallId,
							name: chunk.toolName,
							input: {},
							status: resolvedStatus,
							output: chunk.output,
							subAgentName: chunk.subAgentName,
							parentToolCallId: chunk.parentToolCallId,
						});
					}
				} else {
					assistantMsg.toolCalls = [
						{
							id: chunk.toolCallId,
							name: chunk.toolName,
							input: {},
							status: resolvedStatus,
							output: chunk.output,
							subAgentName: chunk.subAgentName,
							parentToolCallId: chunk.parentToolCallId,
						},
					];
				}

				assistantMsg.assistantTimeline.push({
					id: `end-${chunk.toolCallId}-${assistantMsg.assistantTimeline.length}`,
					type: "tool_end",
					toolCallId: chunk.toolCallId,
					toolName: chunk.toolName,
					output: chunk.output,
					status: resolvedStatus,
					aiMessageId: chunk.aiMessageId,
					subAgentName: chunk.subAgentName,
					parentToolCallId: chunk.parentToolCallId,
				});
				// Signal that the next token starts a new LangGraph step — we reset the
				// display buffer then so inter-step AI texts don't stack in the answer area.
				pendingStepReset = true;
				continue;
			}

			if (chunk.type === "result") {
				this.summarizingHistory = false;
				assistantMsg.content = hasSeenToolCall ? tokenBuffer.trim() : tokenBuffer;
				assistantMsg.contentAiMessageId = currentTokenAiMessageId;
				continue;
			}

			if (chunk.type === "checkpoint_message") {
				this.summarizingHistory = false;
				const checkpointAssistant = baseMessageToAssistantMessage(chunk.message);
				// Content and final tool statuses/outputs are authoritative from the
				// checkpoint. But the checkpoint never contains the subagent's own
				// tool calls (deepagents persists only the `task` ToolMessage), so if
				// we captured them live keep the richer streamed timeline and only
				// reconcile final statuses/outputs onto it — otherwise the nested
				// subagent branch would collapse the instant streaming ends.
				assistantMsg.content = checkpointAssistant.content;

				const streamedHasToolCalls = (assistantMsg.toolCalls?.length ?? 0) > 0;

				if (streamedHasToolCalls) {
					const finalById = new Map((checkpointAssistant.toolCalls ?? []).map((tc) => [tc.id, tc]));
					// Keep the streamed timeline (which has preamble text and subagent
					// children); only patch in authoritative final status/output from the
					// checkpoint, since streaming always defaults status to "completed"
					// and cannot observe error state.
					for (const event of assistantMsg.assistantTimeline ?? []) {
						if (event.type !== "tool_end") continue;
						const final = event.toolCallId ? finalById.get(event.toolCallId) : undefined;
						if (!final) continue;
						event.status = final.status;
						event.output = final.output;
					}
					for (const tc of assistantMsg.toolCalls ?? []) {
						const final = finalById.get(tc.id);
						if (!final) continue;
						tc.status = final.status;
						tc.output = final.output;
					}
				} else {
					assistantMsg.toolCalls = checkpointAssistant.toolCalls;
					assistantMsg.assistantTimeline = checkpointAssistant.assistantTimeline;
				}
				break;
			}
		}

		// Sweep any call still pending once the stream is over — the run may have ended
		// (or been aborted) before a superseding tool_end could clear it.
		dropUnresolvedPending();

		if (!assistantMsg.content) {
			assistantMsg.content = hasSeenToolCall ? tokenBuffer.trim() : tokenBuffer;
		}

		if (!assistantMsg.assistantTimeline?.length) {
			assistantMsg.assistantTimeline = buildTimelineFromToolCalls(assistantMsg.toolCalls);
		}
	}

	async summarizeHistoryNow(): Promise<void> {
		if (this.messageState !== MessageState.idle) {
			throw new Error("Cannot summarize while another response is in progress.");
		}

		const plugin = getPlugin();
		const beforeCheckpointIds = new Set(this.graphState.nodes.keys());
		const parentCheckpointId = this.graphState.activeCheckpointId ?? this.graphState.rootCheckpointId;
		const assistantMessage: AssistantMessage = { state: AssistantState.streaming, content: "" };

		this.abortController = new AbortController();
		this.running = true;
		const signal = this.abortController.signal;
		this.touch();

		try {
			this.messageState = MessageState.answering;
			this.summarizingHistory = true;

			await this.consumeStream(
				assistantMessage,
				plugin.agentManager.streamQuery(
					MANUAL_SUMMARIZATION_PROMPT,
					String(this.id),
					this.selectedAgentId,
					this.graphState.activeCheckpointId,
					signal,
					undefined,
					undefined,
					undefined,
					undefined,
					"manual_summarization",
				) as AsyncIterable<AgentStreamChunk>,
			);

			await this.syncGraphAfterRun(parentCheckpointId, beforeCheckpointIds);

			if (this.onNeedReload) {
				await this.onNeedReload();
			}
		} finally {
			this.abortController = null;
			this.running = false;
			this.cancelled = false;
			this.summarizingHistory = false;
			this.messageState = MessageState.idle;
			this.touch();
		}
	}
}

/* -----------------------------------------------------------------------------
 * SessionRegistry
 * ---------------------------------------------------------------------------*/

/** Maximum number of parked (non-active, non-running) idle sessions kept in memory. */
const MAX_PARKED_SESSIONS = 3;

/* -----------------------------------------------------------------------------
 * SessionRegistry
 *  - Owns the global set of live ChatSessions keyed by thread path.
 *  - Loads/reloads/rekeys/evicts sessions; derives the running set.
 *  - Does NOT hold a single "active" pointer: each view (ChatView) binds to its
 *    own thread path and reads its session via `sessionFor(threadPath)`. Actions
 *    (send/edit/regenerate/summarize/switchToBranch) are called directly on the
 *    ChatSession the view resolved, so an action from one tab can never leak into
 *    another. Running state is read per-session (`ChatSession.isRunning`).
 * ---------------------------------------------------------------------------*/
/**
 * Narrows a generation to one that names both a provider and a model.
 *
 * Written as a type guard rather than an inline `gen?.provider && gen?.model` check because
 * optional chaining on the properties does not narrow the object itself — the call that
 * follows would still need a cast, which is exactly what this avoids.
 */
function hasProviderAndModel(
	generation: MessageGeneration | undefined,
): generation is MessageGeneration & { provider: string; model: string } {
	return !!generation?.provider && !!generation.model;
}

export class SessionRegistry {
	/** All live sessions keyed by thread path. A running session is parked here
	 * (not destroyed) when the user navigates away, so it can be reattached. */
	sessions = new SvelteMap<string, ChatSession>();
	isLoadingSession: boolean = $state(false);
	pendingInput: string | null = $state(null);
	pendingGraphNotes: string[] | null = $state(null);
	/** The live graph selection, shared across all chats. Unlike the one-shot
	 * `pendingGraphNotes` (which focuses a specific chat), this ambient state is
	 * read reactively by every open chat's context tray, so a graph selection
	 * shows up in whichever chat the user switches to while it stays selected.
	 * Per-chat exclusions are tracked locally in each ContextTray. */
	graphSelection: string[] = $state([]);
	/** Name of the topic(s) `graphSelection` exactly matches, or null if the
	 * selection isn't a whole topic (lasso, panel row, or a topic selection
	 * the user has since edited by hand). Mirrors `graphSelection`'s ambient
	 * scope — set alongside it everywhere it's assigned. */
	graphSelectionTopicLabel: string | null = $state(null);
	/** True when the current `graphSelection` value was republished by background
	 * vault maintenance (a live patch pruning deleted notes out of the existing
	 * selection) rather than a new user gesture. A chat tray's per-note dismissals
	 * must survive maintenance pruning but reset on every real selection change —
	 * and that distinction can't be inferred from the paths alone, since a user
	 * picking a smaller selection also shrinks the path set. */
	graphSelectionIsMaintenance: boolean = $state(false);
	pendingAttachmentPaths: string[] | null = $state(null);
	pendingAutoSubmit: boolean = $state(false);
	/** When set, only the Input bound to this thread path consumes the pending
	 * input/attachments/auto-submit above. Prevents a stale chat tab from eating a
	 * submission meant for a freshly opened chat (e.g. "Ask agent" from search). */
	pendingSubmitThreadPath: string | null = $state(null);
	#agentManager: AgentManager;

	/**
	 * Monotonically increasing token identifying the most recent `loadSession`
	 * call. Switching threads quickly fires overlapping async loads; without a
	 * guard, a slower earlier load can resolve last and clobber a session
	 * with the previous chat's checkpoints. Each load captures the token at
	 * start and only commits its result if it is still the latest.
	 */
	#loadToken = 0;

	constructor(agentManager: AgentManager) {
		this.#agentManager = agentManager;
	}

	/** The session for a specific thread path — the only session accessor.
	 * Each view passes its own pinned threadPath. */
	sessionFor(threadPath: string | null): ChatSession | null {
		return threadPath ? (this.sessions.get(threadPath) ?? null) : null;
	}

	/** All sessions currently streaming. Concurrency-ready: derived from each
	 * session's own `isRunning`, not a single shared slot. */
	get runningSessions(): ChatSession[] {
		return [...this.sessions.values()].filter((s) => s.isRunning);
	}

	/** Stop every running stream. */
	stopAll(): void {
		for (const s of this.runningSessions) s.stopStreaming();
	}

	/** Wires session callbacks: map rekeying on rename. Run-state is read
	 * per-session (no registry slot to push into). */
	private buildSessionOptions(
		base: Pick<
			ChatSessionOptions,
			"graphState" | "errorCount" | "lastErrorMessage" | "bootstrapMessages" | "onNeedReload" | "selectedAgentId"
		>,
	): ChatSessionOptions {
		return {
			...base,
			onThreadIdChange: (oldPath, newPath) => {
				// `id` is deliberately not reassigned here. Nothing in this closure reads
				// it after construction, so the old `id = newPath` was a dead write that
				// only looked like it kept state in sync; rekeySession does the real work.
				this.rekeySession(oldPath, newPath);
			},
		};
	}

	/** Rekey a session in the map after its thread path changes (title rename).
	 * Views bind by their own threadPath (updated via ChatView's rename handling),
	 * so there is no registry-level active/running pointer to repoint here. */
	private rekeySession(oldPath: string, newPath: string): void {
		if (oldPath === newPath) return;
		const s = this.sessions.get(oldPath);
		if (!s) return;
		this.sessions.delete(oldPath);
		this.sessions.set(newPath, s);
	}

	/** Drop least-recently-used idle parked sessions, keeping at most
	 * MAX_PARKED_SESSIONS idle ones. Never evicts a running session (concurrency:
	 * protects ALL running sessions, not a single slot). Sessions currently
	 * mounted in a view stay in the MRU window because loading touches them. */
	private evictParkedSessions(): void {
		const parked = [...this.sessions.values()].filter((s) => !s.isRunning);
		if (parked.length <= MAX_PARKED_SESSIONS) return;
		parked.sort((a, b) => b.lastTouchedAt - a.lastTouchedAt);
		for (const s of parked.slice(MAX_PARKED_SESSIONS)) {
			this.sessions.delete(s.id);
		}
	}

	private deriveThreadId(file: TFile): string {
		return file.path;
	}

	private getLastViewedCheckpointId(history: ThreadHistory | null): string | undefined {
		const candidate = history?.metadata?.lastViewedCheckpointId;
		return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
	}

	private async persistLastViewedCheckpoint(
		threadId: string,
		checkpointId: string | undefined,
		session: ChatSession | null,
	): Promise<void> {
		if (!checkpointId) return;
		await this.#agentManager.setLastViewedCheckpoint(threadId, checkpointId);
		session?.setLastPersistedActiveCheckpointId(checkpointId);
	}

	private getDefaultAgentForFallback() {
		const data = getData();
		return data.getAgent(data.defaultAgentId) ?? data.getAgent(DEFAULT_AGENT_ID) ?? data.getSelectedAgent();
	}

	private getModelConfigForSelection(
		agentChatModel: ChatModel | null,
		provider: string,
		model: string,
	): Partial<ChatModelConfig> {
		if (agentChatModel && agentChatModel.provider === provider && agentChatModel.model === model) {
			return agentChatModel.modelConfig;
		}
		return agentChatModel?.modelConfig ?? { contextWindow: 128000 };
	}

	/**
	 * The parameter type requires provider/model rather than asserting them non-null in the
	 * body: the caller gates via {@link hasProviderAndModel}, so this states that
	 * precondition where the compiler can enforce it for future callers.
	 */
	private resolveAgentFromGeneration(
		generation: MessageGeneration & { provider: string; model: string },
		fallbackAgent: AgentConfig,
	): { agentId: string; model: ChatModel | null } {
		const data = getData();
		const provider = generation.provider;
		const model = generation.model;

		// Try to find the agent by ID first
		let generatedAgent = generation.agentId ? data.getAgent(generation.agentId) : undefined;

		// Fall back to matching by provider+model
		if (!generatedAgent) {
			const candidates = Object.values(data.agents).filter(
				(agent) => agent.chatModel?.provider === provider && agent.chatModel?.model === model,
			);
			if (candidates.length === 1) {
				generatedAgent = candidates[0];
			} else if (candidates.length > 1) {
				generatedAgent = candidates.find((agent) => agent.id === data.defaultAgentId) ?? candidates[0];
			}
		}

		if (generatedAgent) {
			return {
				agentId: generatedAgent.id,
				model: generatedAgent.chatModel ?? null,
			};
		}

		if (data.getConfiguredProviders().includes(provider)) {
			return {
				agentId: fallbackAgent.id,
				model: {
					provider,
					model,
					modelConfig: this.getModelConfigForSelection(fallbackAgent.chatModel, provider, model),
				},
			};
		}

		return { agentId: fallbackAgent.id, model: fallbackAgent.chatModel ?? null };
	}

	private async restoreSelectionFromLoadedMessages(
		graph: CheckpointGraphState,
		activeCheckpointId: string | undefined,
		errorCount: number,
		bootstrapMessages: BaseMessage[],
	): Promise<string> {
		const data = getData();
		const messagePairs = deriveMessagePairsFromActiveCheckpoint(
			graph,
			activeCheckpointId,
			errorCount,
			bootstrapMessages,
		);
		const lastPair = messagePairs.at(-1);
		const generation = lastPair?.generation;

		const fallbackAgent = this.getDefaultAgentForFallback();
		let nextAgentId = fallbackAgent.id;
		let nextModel: ChatModel | null = fallbackAgent.chatModel ?? null;

		if (hasProviderAndModel(generation)) {
			const resolved = this.resolveAgentFromGeneration(generation, fallbackAgent);
			nextAgentId = resolved.agentId;
			nextModel = resolved.model;
		}

		const selectedAgent = data.getAgent(nextAgentId);
		if (selectedAgent) {
			const currentModel = selectedAgent.chatModel;
			const modelChanged =
				(currentModel?.provider ?? null) !== (nextModel?.provider ?? null) ||
				(currentModel?.model ?? null) !== (nextModel?.model ?? null);

			if (modelChanged) {
				data.updateAgent(nextAgentId, { chatModel: nextModel });
				this.#agentManager.invalidateAgentRunnable(nextAgentId);
			}
		}

		return nextAgentId;
	}

	/* ---------------- Chat Creation / Metadata ---------------- */

	async loadSession(file: TFile, targetCheckpointId?: string) {
		// Claim the latest-load token synchronously, before any await, so
		// overlapping loads are ordered by call order rather than by whichever
		// async fetch happens to resolve last.
		const token = ++this.#loadToken;
		const isLatest = () => this.#loadToken === token;

		const id = this.deriveThreadId(file);
		if (!id) throw new Error("Invalid thread ID");

		// Reattach: if a live (running) session already exists for this thread,
		// re-surface it instead of rebuilding from checkpoints — rebuilding would
		// discard the in-flight streaming state (partial tokens, abortController).
		// The view is already pinned to this thread path, so no pointer to move.
		const existing = this.sessions.get(id);
		if (existing?.isRunning && !targetCheckpointId) {
			existing.touch();
			this.evictParkedSessions();
			return;
		}

		// Show the skeleton immediately, synchronously (before any await) so
		// Svelte paints it at least once even when the thread is already cached
		// and every fetch below resolves within the same microtask flush.
		this.isLoadingSession = true;

		// Skip the loading skeleton for brand-new, empty chats: there is no
		// history to fetch, so show the empty state + input immediately. Clear
		// the flag we just set before any meaningful history work happens.
		const isEmpty = await this.#agentManager.isThreadEmpty(id);
		if (!isLatest()) return; // A newer switch superseded this load.
		if (isEmpty) this.isLoadingSession = false;
		// Forward-declared so callbacks wired below can hold the session instance
		// rather than the load-time path. `id` stops being a valid map key the
		// moment the auto-title rename rekeys this session.
		let session: ChatSession | undefined;
		try {
			const [history, checkpointHistory] = await Promise.all([
				this.#agentManager.getThreadHistory(id),
				this.#agentManager.getCheckpointHistory(id),
			]);

			// A newer thread switch started while we were fetching — discard this
			// result so it can't overwrite the newer session's checkpoints.
			if (!isLatest()) return;

			// If the agent wasn't initialized yet, checkpoint history came back empty.
			// Schedule a reload for once the deferred init completes so the view
			// shows the real history without the user having to intervene.
			if (checkpointHistory.length === 0 && !isEmpty) {
				this.#agentManager.onNextInitialized(() => {
					// Only reload if this thread's session is still around (its view
					// may have closed and the session been evicted meanwhile). Checked
					// by identity, not by the load-time path: an auto-title rename in
					// the meantime rekeys the map, and a path-keyed lookup would find
					// nothing and silently skip the reload the user is waiting on.
					if (!session || this.sessions.get(session.id) !== session) return;
					void this.reloadSessionInstance(session);
				});
			}

			const savedCheckpointId = this.getLastViewedCheckpointId(history);
			const graph = buildCheckpointGraph(checkpointHistory);
			const resolution = resolveActiveCheckpointId(graph, {
				persistedCheckpointId: savedCheckpointId,
				explicitTargetCheckpointId: targetCheckpointId,
			});

			graph.activeCheckpointId = resolution.checkpointId;
			graph.lastPersistedActiveCheckpointId = savedCheckpointId;

			checkpointDebug("load.resolve", {
				threadId: id,
				source: resolution.source,
				resolvedCheckpointId: resolution.checkpointId,
				sessionCheckpointId: undefined,
				savedCheckpointId,
				targetCheckpointId,
			});

			const historyWithError = history;
			const bootstrapMessages = historyWithError?.messages || [];
			const errorCount = historyWithError?.errorCount || 0;
			const lastErrorMessage = historyWithError?.lastError?.message;

			const restoredAgentId = await this.restoreSelectionFromLoadedMessages(
				graph,
				resolution.checkpointId,
				errorCount,
				bootstrapMessages,
			);

			if (!isLatest()) return;

			session = new ChatSession(
				id,
				this.buildSessionOptions({
					graphState: graph,
					errorCount,
					lastErrorMessage,
					bootstrapMessages,
					selectedAgentId: restoredAgentId,
					// Reload against this specific session, not whatever is active
					// when a backgrounded run finishes later — and not via the
					// load-time path, which the auto-title rename invalidates
					// mid-run (the rename happens inside `runStream`, just before
					// this callback fires for `reloadAfter`).
					onNeedReload: async () => {
						if (session) await this.reloadSessionInstance(session);
					},
				}),
			);
			this.sessions.set(id, session);

			await this.persistLastViewedCheckpoint(id, resolution.checkpointId, session);
			this.evictParkedSessions();
		} finally {
			// Only the latest load owns the loading flag; a superseded load must
			// not clear the skeleton out from under the newer one.
			if (isLatest()) this.isLoadingSession = false;
		}
	}

	/** Reload a specific session (by thread path) while preserving valid
	 * in-memory active checkpoint precedence. */
	async reloadSession(threadId: string, targetCheckpointId?: string): Promise<void> {
		const session = this.sessions.get(threadId) ?? null;
		if (!session) {
			throw new Error("No session to reload");
		}
		await this.reloadSessionInstance(session, targetCheckpointId);
	}

	/** Reload a session identified by object rather than by map key.
	 *
	 * Callbacks handed to a ChatSession outlive its registry key: the auto-title
	 * rename after the first message rekeys the map (`rekeySession`) and updates
	 * `session.id` in place, so any closure that captured the load-time path is
	 * pointing at a key that no longer exists. Holding the instance keeps those
	 * callbacks correct across renames; `session.id` is read live below for the
	 * thread-scoped fetches. */
	private async reloadSessionInstance(session: ChatSession, targetCheckpointId?: string): Promise<void> {
		// Capture load token: a thread switch during the awaits below can replace
		// this session; applying stale history to a newer session would show
		// the wrong chat's checkpoints.
		const id = session.id;
		const loadToken = this.#loadToken;
		const sessionCheckpointId = session.getActiveCheckpointId();

		const [history, checkpointHistory] = await Promise.all([
			this.#agentManager.getThreadHistory(id),
			this.#agentManager.getCheckpointHistory(id),
		]);

		// Bail if a newer load started, OR if the session was evicted/replaced.
		if (this.sessions.get(id) !== session || this.#loadToken !== loadToken) return;

		const savedCheckpointId = this.getLastViewedCheckpointId(history);
		const graph = buildCheckpointGraph(checkpointHistory);
		const resolution = resolveActiveCheckpointId(graph, {
			sessionActiveCheckpointId: sessionCheckpointId,
			persistedCheckpointId: savedCheckpointId,
			explicitTargetCheckpointId: targetCheckpointId,
		});

		graph.activeCheckpointId = resolution.checkpointId;
		graph.lastPersistedActiveCheckpointId = savedCheckpointId;

		checkpointDebug("reload.resolve", {
			threadId: id,
			source: resolution.source,
			resolvedCheckpointId: resolution.checkpointId,
			sessionCheckpointId,
			savedCheckpointId,
			targetCheckpointId,
		});

		const historyWithError = history;
		session.applyGraphState(
			graph,
			historyWithError?.errorCount || 0,
			historyWithError?.messages || [],
			historyWithError?.lastError?.message,
		);

		await this.persistLastViewedCheckpoint(id, resolution.checkpointId, session);
	}

	/** Switch a specific thread to a different branch by activating a checkpoint.
	 * Read-only navigation — allowed even while a chat is streaming. Takes an
	 * explicit threadPath so the calling view targets its own session, never a
	 * global active pointer. */
	async switchToBranch(threadPath: string, checkpointId: string): Promise<void> {
		const session = this.sessions.get(threadPath) ?? null;
		if (!session) {
			throw new Error("No session for thread");
		}

		const threadId = session.id;
		const [history, checkpointHistory] = await Promise.all([
			this.#agentManager.getThreadHistory(threadId),
			this.#agentManager.getCheckpointHistory(threadId),
		]);

		const graph = buildCheckpointGraph(checkpointHistory);
		if (!graph.nodes.has(checkpointId)) {
			throw new Error("Cannot switch branch: checkpoint does not exist");
		}

		graph.activeCheckpointId = checkpointId;
		graph.lastPersistedActiveCheckpointId = this.getLastViewedCheckpointId(history);

		const historyWithError = history;
		session.applyGraphState(
			graph,
			historyWithError?.errorCount || 0,
			historyWithError?.messages || [],
			historyWithError?.lastError?.message,
		);

		await this.persistLastViewedCheckpoint(threadId, checkpointId, session);
	}
}

/* -----------------------------------------------------------------------------
 * Singleton helpers
 * ---------------------------------------------------------------------------*/
let sessionRegistrySingleton: SessionRegistry | null = null;

export function createSessionRegistry(agentManager?: AgentManager): SessionRegistry {
	if (!sessionRegistrySingleton) {
		if (!agentManager) {
			throw new Error("AgentManager is required for first SessionRegistry creation");
		}
		sessionRegistrySingleton = new SessionRegistry(agentManager);
	}
	return sessionRegistrySingleton;
}

export function getSessionRegistry(): SessionRegistry | null {
	return sessionRegistrySingleton;
}
