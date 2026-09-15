import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { ContentBlock, ToolCallChunk } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";
import { type ReactAgent, createAgent, summarizationMiddleware } from "langchain";
import { createSubAgentMiddleware } from "deepagents/browser";
import { TFile } from "obsidian";

import { ProviderEndpointError } from "../providers/errors";
import type { ChatModelConfig } from "../providers/index";
import type { ProviderRegistry } from "../providers/registry";
import { getPlugin } from "../stores/state.svelte";
import type { VisibleNoteRef } from "../hooks/useVisibleNotes.svelte";
import type { SelectionRef } from "../hooks/useSelection.svelte";
import type { GraphNoteRef } from "../stores/chatTimeline";
import type { ChatAttachment, ReviewStatusRef, ThreadError } from "../types/shared";
import {
	AiTransportDowngradeRequiredError,
	bindAsyncIterableToTransportContext,
	createAiTransportContext,
	findAiTransportDowngradeRequiredError,
	runWithAiTransportContext,
} from "../lib/aiTransport";
import { toBase64, toBase64DataUri } from "../utils/attachments";
import { extractTextFromPdf } from "../utils/pdfExtractor";
import { Logger } from "../utils/logging";
import { normalizeMessages } from "./messageNormalization";
import { type ThreadSnapshot, type ThreadStore, createSnapshot } from "./memory/ThreadStore";
import {
	getSummarizationTriggerTokens,
	getTrimTokensToSummarize,
	guardSummarizationFailure,
	SUMMARY_KEEP_MESSAGE_COUNT,
	SUMMARY_PREFIX,
	SUMMARY_PROMPT,
} from "./summarization";
import type { Telemetry } from "./telemetry/Telemetry";

/**
 * Upper bound on memoized runnables. Sized well above the number of agent configs a
 * vault realistically runs concurrently (each open chat pins at most one), so steady-state
 * hit rate is unaffected — it only trims the trail of superseded entries left behind by
 * prompt/tool edits.
 */
const RUNNABLE_CACHE_MAX = 16;

const MAX_IMAGE_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_CHARS = 120_000;
const MAX_PDF_EXTRACT_CHARS = 180_000;

/** Providers whose APIs accept native PDF file content blocks. */
export const NATIVE_PDF_PROVIDERS = new Set(["anthropic", "openai", "openrouter"]);

function truncateContent(content: string, maxChars: number): string {
	if (content.length <= maxChars) return content;
	return `${content.slice(0, maxChars)}\n\n[...truncated ${content.length - maxChars} characters to fit context limits...]`;
}

export interface ChooseModelParams {
	provider: string;
	chatModel: string;
	options?: Partial<ChatModelConfig>;
	summarizationModel?: {
		provider: string;
		chatModel: string;
		options?: Partial<ChatModelConfig>;
	} | null;
	titleModel?: {
		provider: string;
		chatModel: string;
		options?: Partial<ChatModelConfig>;
	} | null;
}

/** Options for a normal query (new message in thread) */
export interface AgentRunOptions {
	query: string;
	/** Fully-resolved model + runnable for this run (per-run, never instance state). */
	resolved: ResolvedRun;
	threadId?: string;
	metadata?: Record<string, unknown>;
	configurable?: Record<string, unknown>;
	lcSource?: string;
	signal?: AbortSignal;
	/** Optional attachments (images, PDFs) to include in the message */
	attachments?: ChatAttachment[];
	/** Visible notes refs to persist alongside the message */
	visibleNotes?: VisibleNoteRef[];
	/** Snapshot of user-selected text to persist alongside the message */
	selection?: SelectionRef;
	/** Notes selected from the Smart Graph */
	graphNotes?: GraphNoteRef[];
	/** Review status of earlier staged note changes, appended as a context block
	 * to the query by chatStore; persisted here so the UI can strip it again. */
	reviewStatus?: ReviewStatusRef;
}

/** Options for editing a message (forks from checkpoint with new user message) */
export interface AgentEditOptions {
	query: string;
	resolved: ResolvedRun;
	threadId: string;
	checkpointId: string;
	lcSource?: string;
	signal?: AbortSignal;
	attachments?: ChatAttachment[];
	visibleNotes?: VisibleNoteRef[];
	metadata?: Record<string, unknown>;
	configurable?: Record<string, unknown>;
}

/** Options for regenerating a response from a checkpoint (no new user message) */
export interface AgentRegenerateOptions {
	resolved: ResolvedRun;
	threadId: string;
	checkpointId: string;
	signal?: AbortSignal;
	metadata?: Record<string, unknown>;
	configurable?: Record<string, unknown>;
}

export interface AgentResult {
	runId: string;
	threadId: string;
	durationMs: number;
	messages: BaseMessage[];
	response?: unknown;
	raw: unknown;
}

export interface ThreadHistory extends ThreadSnapshot {
	messages: BaseMessage[];
	/** If the last run errored, this will contain the error details */
	lastError?: ThreadError;
	/** Count of errors in the thread (for detecting multiple errored messages) */
	errorCount?: number;
}

export interface CheckpointHistoryItem {
	checkpointId: string;
	messages: BaseMessage[];
	step: number;
	/** Parent checkpoint ID for building branch trees */
	parentCheckpointId?: string;
	/** Optional checkpoint timestamp for deterministic ordering/tie-breaking */
	ts?: string;
}

export interface AgentOptions {
	registry: ProviderRegistry;
	telemetry?: Telemetry;
	threadStore?: ThreadStore;
	checkpointer?: BaseCheckpointSaver;
}

/**
 * Sanitizes a subagent display name into a value safe to stamp onto a message's
 * `name` field. OpenAI/Azure/OpenAI-compatible chat endpoints enforce the pattern
 * `^[^\s<|\\/>]+$` on `messages[N].name` (also used for LangGraph runnable names,
 * which leak into the subagent's `AIMessage.name`). Names with spaces or `()` —
 * e.g. "Default Agent (isolated)" — otherwise 400 the subagent's second turn.
 * Collapses every disallowed character to `_`; falls back to `subagent` if empty.
 */
export function sanitizeRunnableName(name: string): string {
	const cleaned = name
		.replace(/[\s<|\\/>()]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	return cleaned || "subagent";
}

/**
 * A fully-resolved subagent, ready to hand to deepagents' subagent middleware.
 * Carries instances (not IDs): each subagent runs with its own model, tools,
 * and prompt — resolved by AgentManager from a referenced agent's config.
 */
export interface SubAgentSpec {
	/** Selector name shown to the parent model in the `task` tool. */
	name: string;
	/** Short blurb the parent model uses to decide whether to delegate. */
	description: string;
	/** The referenced agent's assembled system prompt. */
	systemPrompt: string;
	/** The referenced agent's own model instance (may differ from the parent). */
	model: BaseChatModel;
	/** The referenced agent's own resolved tool instances. */
	tools: readonly unknown[];
}

type AgentRunnable = ReactAgent; // invoke(), stream(), etc.

export type AgentStreamOptions = AgentRunOptions;

export type AgentStreamChunk =
	| {
			type: "token";
			token: string;
			/** The id of the AI message producing this token (step boundary discriminator). */
			aiMessageId?: string;
			runId: string;
			threadId: string;
	  }
	| {
			/**
			 * The model has begun emitting a tool call, but its arguments are still
			 * streaming so the tool has NOT started executing yet. Emitted from the
			 * `messages` stream's `tool_call_chunks` as soon as a call's name is known.
			 *
			 * `on_tool_start` (→ `tool_start`) cannot fire until the arguments JSON is
			 * complete and schema-validated, because LangChain parses the args before
			 * invoking the callback. For a tool whose argument IS the payload — a
			 * `manage_notes` edit carries whole note bodies — that window is seconds
			 * long, during which the UI had nothing to show. This chunk fills it.
			 */
			type: "tool_pending";
			toolCallId: string;
			toolName: string;
			/**
			 * Text the model emitted before this call, as accumulated so far. Carried
			 * here (not left for `tool_start`) because the announcement is what moves
			 * the text out of the live answer spot: without it the preamble would
			 * vanish for the seconds the arguments take to stream.
			 */
			preamble?: string;
			/** The id of the AI message that produced this tool call. */
			aiMessageId?: string;
			/** Name of the subagent this tool is running inside (via `task`), if any. */
			subAgentName?: string;
			/** The id of the parent `task` tool call this is nested under, if any. */
			parentToolCallId?: string;
			runId: string;
			threadId: string;
	  }
	| {
			type: "tool_start";
			toolCallId: string;
			toolName: string;
			input: unknown;
			/** Preamble text the model emitted before this tool call in the same AI message. */
			preamble?: string;
			/** The id of the AI message that produced this tool call. */
			aiMessageId?: string;
			/** Name of the subagent this tool ran inside (via the `task` tool), if any. */
			subAgentName?: string;
			/** The id of the parent `task` tool call this is nested under, if any. */
			parentToolCallId?: string;
			runId: string;
			threadId: string;
	  }
	| {
			type: "tool_end";
			toolCallId: string;
			toolName: string;
			output: unknown;
			/** The id of the AI message that produced this tool call. */
			aiMessageId?: string;
			/** Name of the subagent this tool ran inside (via the `task` tool), if any. */
			subAgentName?: string;
			/** The id of the parent `task` tool call this is nested under, if any. */
			parentToolCallId?: string;
			runId: string;
			threadId: string;
	  }
	| {
			type: "result";
			result: AgentResult;
			runId: string;
			threadId: string;
	  }
	| {
			type: "checkpoint_message";
			message: BaseMessage;
			runId: string;
			threadId: string;
	  };

export interface SelectedModel {
	provider: string;
	name: string;
	instance: BaseChatModel;
	options?: Partial<ChatModelConfig>;
}

/**
 * Parameters for resolving a run. Unlike the old `chooseModel`, this carries the
 * agent's prompt/tools/subagents explicitly (per-run, not instance state) plus a
 * `cacheKey` (built by AgentManager over the full agent config) so the runnable
 * can be memoized per agent-config without any shared mutable state.
 */
export interface ResolveRunParams extends ChooseModelParams {
	/** Signature over the full agent config (model + prompt + tools + subagents). */
	cacheKey: string;
	systemPrompt: string;
	tools: readonly unknown[];
	subAgents: readonly SubAgentSpec[];
}

/**
 * A fully-resolved run: an immutable bundle handed into each run method. Nothing
 * model-related lives on the Agent instance between runs, so concurrent runs with
 * different models can never clobber each other. Same-config runs share one
 * (thread-stateless) cached runnable.
 */
export interface ResolvedRun {
	runnable: AgentRunnable;
	selectedModel: SelectedModel;
	/** Undefined → summarization falls back to `selectedModel`. */
	summarizationModel?: SelectedModel;
	/** Undefined → title generation falls back to `selectedModel`. */
	titleModel?: SelectedModel;
	supportsVision: boolean;
	currentProvider: string;
}

export class Agent {
	private readonly checkpointer: BaseCheckpointSaver;
	private readonly telemetry?: Telemetry;
	private readonly threadStore?: ThreadStore;
	private readonly registry: ProviderRegistry;
	/** Runnables memoized by agent-config cacheKey (built by AgentManager).
	 *  Insertion-ordered, and used as an LRU — see {@link RUNNABLE_CACHE_MAX}. */
	private readonly runnableCache = new Map<string, AgentRunnable>();

	constructor(options: AgentOptions) {
		this.registry = options.registry;
		this.telemetry = options.telemetry;
		this.threadStore = options.threadStore;
		this.checkpointer = this.wrapCheckpointer(options.checkpointer ?? new MemorySaver());
		Logger.debug("agent.init", {
			hasTelemetry: Boolean(this.telemetry),
			hasThreadStore: Boolean(this.threadStore),
			checkpointer: this.checkpointer.constructor?.name ?? "unknown",
		});
	}

	/**
	 * Drops any cached runnables built for the given agent config. Needed only for
	 * changes that the cacheKey can't see (async-loaded MCP tools); model/prompt/tool
	 * config changes are already covered by the key. Matches on the `agentId` field
	 * embedded in the JSON cacheKey.
	 */
	invalidateRunnable(agentId: string): void {
		const needle = `"agentId":${JSON.stringify(agentId)}`;
		for (const key of this.runnableCache.keys()) {
			if (key.includes(needle)) this.runnableCache.delete(key);
		}
	}

	/** Drops every cached runnable. Use when a global input to prompt assembly
	 *  (e.g. the set of loaded skills) changes and can affect any agent's prompt. */
	invalidateAllRunnables(): void {
		this.runnableCache.clear();
	}

	/**
	 * Drops cache entries whose credential generation is stale.
	 *
	 * The cacheKey carries an `authGen` term (see `AgentManager.buildRunnableCacheKey`)
	 * so a credential change can't be served a runnable holding the old key. That alone
	 * is correct but leaky: superseded entries would never be read again, yet each pins
	 * a LangGraph agent, a model instance, and a full tool array. Pruning on insert
	 * keeps the cache bounded by the number of live agent configs rather than by how
	 * many times the user has edited a key.
	 */
	private pruneStaleAuthGenerations(currentKey: string): void {
		const match = /"authGen":(\d+)/.exec(currentKey);
		if (!match) return;
		const currentGen = match[1];
		for (const key of this.runnableCache.keys()) {
			const keyGen = /"authGen":(\d+)/.exec(key)?.[1];
			if (keyGen !== undefined && keyGen !== currentGen) this.runnableCache.delete(key);
		}
	}

	/** Reads a cached runnable, marking it most-recently-used. */
	private getCachedRunnable(cacheKey: string): AgentRunnable | undefined {
		const cached = this.runnableCache.get(cacheKey);
		if (!cached) return undefined;
		// Map iterates in insertion order, so re-inserting moves this key to the end
		// (the MRU position) and keeps `evictLeastRecentlyUsed` honest.
		this.runnableCache.delete(cacheKey);
		this.runnableCache.set(cacheKey, cached);
		return cached;
	}

	/**
	 * Stores a runnable, evicting the least-recently-used entries past the cap.
	 *
	 * The cacheKey covers the whole agent config — system prompt, skills, per-tool
	 * overrides, subagent revisions — so every prompt edit or tool toggle mints a new
	 * key while the superseded entry stays resident, each pinning a LangGraph agent, a
	 * model instance and a full tool array. Nothing evicted it: `invalidateRunnable`
	 * only fires on explicit config-change hooks. An LRU bound is the cheap fix; a
	 * wrongly-evicted entry costs one rebuild, not a correctness bug.
	 */
	private setCachedRunnable(cacheKey: string, runnable: AgentRunnable): void {
		this.runnableCache.set(cacheKey, runnable);
		while (this.runnableCache.size > RUNNABLE_CACHE_MAX) {
			const oldest = this.runnableCache.keys().next();
			if (oldest.done) break;
			this.runnableCache.delete(oldest.value);
			Logger.debug("agent.runnableCache.evict", { evicted: oldest.value, size: this.runnableCache.size });
		}
	}
	/**
	 * Builds the message content for a HumanMessage, supporting multimodal attachments.
	 *
	 * - If no attachments: returns the plain query string
	 * - If attachments with vision support: returns an array of content blocks
	 *   (text + image_url for images, inline text for .md/.txt/.csv/.json)
	 * - PDFs via native providers (Anthropic, OpenAI, OpenRouter): sent as standardized
	 *   Data.Base64ContentBlock which LangChain auto-converts to each provider's native format
	 * - PDFs via other providers (Ollama, custom): text extracted locally via Obsidian's pdfjs
	 * - Images without vision: skipped with notice
	 */
	private async buildMessageContent(
		query: string,
		supportsVision: boolean,
		currentProvider: string,
		attachments?: ChatAttachment[],
	): Promise<string | ContentBlock[]> {
		if (!attachments || attachments.length === 0) {
			return query;
		}

		const contentParts: ContentBlock[] = [{ type: "text", text: query }];
		const hasImages = attachments.some((a) => a.mimeType.startsWith("image/"));
		const skipImagesForNonVisionModel = hasImages && !supportsVision;
		let addedImageSkipNotice = false;

		// For non-vision models, skip image attachments but continue processing other supported files.

		const app = getPlugin().app;

		for (const attachment of attachments) {
			if (attachment.mimeType.startsWith("image/")) {
				if (skipImagesForNonVisionModel) {
					if (!addedImageSkipNotice) {
						contentParts.push({
							type: "text",
							text: "[Image attachments were skipped because the selected model does not support vision. Switch to a vision-capable model to analyze images.]",
							s2b_attachment: true,
						});
						addedImageSkipNotice = true;
					}
					continue;
				}

				// Read image from vault and encode as base64 data URI
				const file = app.vault.getAbstractFileByPath(attachment.vaultPath);
				if (!(file instanceof TFile)) {
					contentParts.push({
						type: "text",
						text: `[Image "${attachment.name}" not found at ${attachment.vaultPath}]`,
					});
					continue;
				}
				const buffer = await app.vault.readBinary(file);
				if (buffer.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
					throw new Error(
						`Image attachment "${attachment.name}" exceeds the 15 MB size limit. Please attach a smaller image.`,
					);
				}
				const dataUri = toBase64DataUri(buffer, attachment.mimeType);
				contentParts.push({
					type: "image_url",
					image_url: { url: dataUri },
				});
			} else if (attachment.mimeType === "application/pdf") {
				const file = app.vault.getAbstractFileByPath(attachment.vaultPath);
				if (!(file instanceof TFile)) {
					contentParts.push({
						type: "text",
						text: `[PDF "${attachment.name}" not found at ${attachment.vaultPath}]`,
						s2b_attachment: true,
					});
					continue;
				}
				const buffer = await app.vault.readBinary(file);

				if (NATIVE_PDF_PROVIDERS.has(currentProvider)) {
					// Native PDF: use LangChain's standardized file content block.
					// LangChain auto-converts to each provider's native format:
					//   Anthropic → type: "document" with source.type: "base64"
					//   OpenAI    → type: "file" with file.file_data data URI
					//   OpenRouter → type: "file" (same as OpenAI, uses ChatOpenAI)
					contentParts.push({
						type: "file",
						source_type: "base64",
						data: toBase64(buffer),
						mime_type: "application/pdf",
						metadata: { filename: attachment.name },
					});
				} else {
					// Providers without native PDF support: extract text locally
					const data = new Uint8Array(buffer);
					try {
						const { text, totalPages } = await extractTextFromPdf(data);
						if (text.trim()) {
							const truncated = truncateContent(text, MAX_PDF_EXTRACT_CHARS);
							contentParts.push({
								type: "text",
								text: `--- PDF: ${attachment.name} (${totalPages} pages) ---\n${truncated}\n--- End PDF ---`,
								s2b_attachment: true,
							});
						} else {
							contentParts.push({
								type: "text",
								text: `[PDF "${attachment.name}" contains ${totalPages} page(s) but no extractable text. It may contain only images/scans.]`,
								s2b_attachment: true,
							});
						}
					} catch (error) {
						contentParts.push({
							type: "text",
							text: `[Error extracting text from PDF "${attachment.name}": ${error instanceof Error ? error.message : String(error)}]`,
							s2b_attachment: true,
						});
					}
				}
			} else {
				// For text/json files, read as text
				const file = app.vault.getAbstractFileByPath(attachment.vaultPath);
				if (!(file instanceof TFile)) {
					contentParts.push({
						type: "text",
						text: `[File "${attachment.name}" not found at ${attachment.vaultPath}]`,
						s2b_attachment: true,
					});
					continue;
				}
				try {
					const content = await app.vault.read(file);
					const truncated = truncateContent(content, MAX_TEXT_ATTACHMENT_CHARS);
					contentParts.push({
						type: "text",
						text: `--- File: ${attachment.name} ---\n${truncated}\n--- End File ---`,
						s2b_attachment: true,
					});
				} catch (error) {
					contentParts.push({
						type: "text",
						text: `[Error reading "${attachment.name}": ${error instanceof Error ? error.message : String(error)}]`,
						s2b_attachment: true,
					});
				}
			}
		}

		return contentParts;
	}

	/**
	 * Pure resolver: builds the model instances and the (memoized) runnable for a
	 * run WITHOUT mutating any instance state. Returns an immutable {@link ResolvedRun}
	 * bundle the caller threads into the run method. Concurrent runs with different
	 * models each get their own bundle, so they can never clobber each other.
	 *
	 * On `ProviderNotFoundError` it simply rethrows — the caller (AgentManager) owns
	 * the config side effect of clearing the offending agent's model, since only it
	 * knows WHICH agent config this run used.
	 */
	async resolveRun(params: ResolveRunParams): Promise<ResolvedRun> {
		const {
			provider,
			chatModel,
			options,
			summarizationModel,
			titleModel,
			cacheKey,
			systemPrompt,
			tools,
			subAgents,
		} = params;

		const instance = this.registry.createChatInstance(provider, chatModel, options);
		const selectedModel: SelectedModel = { provider, name: chatModel, instance, options };

		const resolvedSummarization: SelectedModel | undefined = summarizationModel
			? {
					provider: summarizationModel.provider,
					name: summarizationModel.chatModel,
					instance: this.registry.createChatInstance(
						summarizationModel.provider,
						summarizationModel.chatModel,
						summarizationModel.options,
					),
					options: summarizationModel.options,
				}
			: undefined;

		const resolvedTitle: SelectedModel | undefined = titleModel
			? {
					provider: titleModel.provider,
					name: titleModel.chatModel,
					instance: this.registry.createChatInstance(
						titleModel.provider,
						titleModel.chatModel,
						titleModel.options,
					),
					options: titleModel.options,
				}
			: undefined;

		let runnable = this.getCachedRunnable(cacheKey);
		if (!runnable) {
			runnable = createAgent({
				model: selectedModel.instance,
				tools: Array.isArray(tools) ? [...tools] : [],
				systemPrompt,
				checkpointer: this.checkpointer,
				middleware: [
					...this.buildSummarizationMiddleware(selectedModel, resolvedSummarization),
					...this.buildSubAgentMiddleware(selectedModel, subAgents, tools),
				] as never,
			});
			this.pruneStaleAuthGenerations(cacheKey);
			this.setCachedRunnable(cacheKey, runnable);
			Logger.debug("agent.resolveRun.build", { provider, chatModel, cacheKey });
		}

		return {
			runnable,
			selectedModel,
			summarizationModel: resolvedSummarization,
			titleModel: resolvedTitle,
			supportsVision: options?.supportsVision ?? false,
			currentProvider: provider,
		};
	}

	private buildSummarizationMiddleware(selectedModel: SelectedModel, summarizationModel?: SelectedModel) {
		const model = summarizationModel?.instance ?? selectedModel.instance;
		const contextWindow = selectedModel.options?.contextWindow;
		const triggerTokens = getSummarizationTriggerTokens(contextWindow);
		if (!triggerTokens) {
			Logger.warn(
				`[Agent] Summarization disabled: model "${selectedModel.name}" has no contextWindow configured. Long threads will not be summarized and may hit provider context limits.`,
			);
			return [];
		}

		const trimTokensToSummarize = getTrimTokensToSummarize(triggerTokens);

		return [
			// Guarded so a failed summary aborts the trim instead of replacing the
			// trimmed history with an error stub (#435).
			guardSummarizationFailure(
				summarizationMiddleware({
					model,
					trigger: { tokens: triggerTokens, messages: SUMMARY_KEEP_MESSAGE_COUNT + 2 },
					keep: { messages: SUMMARY_KEEP_MESSAGE_COUNT },
					summaryPrefix: SUMMARY_PREFIX,
					summaryPrompt: SUMMARY_PROMPT,
					trimTokensToSummarize,
				}),
			),
		] as const;
	}

	/**
	 * Builds deepagents' subagent middleware, which adds a `task` tool the model
	 * can call to delegate work to isolated-context subagents. Each subagent runs
	 * with its own model, tools, and prompt (resolved by AgentManager). Returns an
	 * empty array when no subagents are configured, so the `task` tool is only
	 * exposed when delegation is actually set up.
	 */
	private buildSubAgentMiddleware(
		selectedModel: SelectedModel,
		subAgents: readonly SubAgentSpec[],
		tools: readonly unknown[],
	) {
		if (subAgents.length === 0) {
			return [];
		}

		return [
			createSubAgentMiddleware({
				// Fallback only — every configured subagent overrides these.
				defaultModel: selectedModel.instance,
				defaultTools: [...tools] as never,
				// Expose only the explicitly-referenced subagents, not a generic one.
				generalPurposeAgent: false,
				subagents: subAgents.map((s) => {
					// Wrap the subagent's `invoke` so that every LangGraph-internal channel
					// that could reconnect it to the parent's checkpoint/history is stripped
					// before invocation. Without this the subagent inherits the parent's
					// checkpoint reader and reloads the parent's full message history (→
					// provider 400s from the dangling `task` tool-call assistant message).
					const subgraph = createAgent({
						model: s.model as never,
						systemPrompt: s.systemPrompt,
						tools: [...s.tools] as never,
						middleware: [] as never,
						// The runnable name is stamped onto the subagent's AIMessage.name,
						// which serializes into the OpenAI/Azure request as `messages[N].name`.
						// OpenAI-compatible endpoints enforce the pattern `^[^\s<|\\/>]+$`
						// (no whitespace, no `<|\/>`), so a display name like
						// "Default Agent (isolated)" makes the subagent's second turn (after
						// its first tool call) 400 with "Invalid 'messages[N].name'". Sanitize
						// to a pattern-safe slug; the human-facing selector name (the `task`
						// tool's `subagent_type`) stays untouched below.
						name: sanitizeRunnableName(s.name),
					});
					subgraph.invoke = (state: never, config?: never) => {
						const c = config as Record<string, unknown> | undefined;
						// Strip EVERY LangGraph-internal channel that could reconnect the
						// subgraph to the parent's checkpoint/history. Removing only
						// __pregel_read/__pregel_send/__pregel_scratchpad is not enough: the
						// parent also passes __pregel_checkpointer, __pregel_previous,
						// checkpoint_id, checkpoint_ns, checkpoint_map, __pregel_call,
						// __pregel_replay_state, __pregel_task_id and __pregel_abort_signals.
						// If any survive, the subgraph's model node reloads the parent's
						// messages (prepending the parent's user turn + the dangling `task`
						// tool-call assistant message), which Anthropic/LiteLLM reject with a
						// 400 "tool_use ids were found without tool_result blocks". Keep only
						// benign, non-pregel configurable keys.
						const cleanConfigurable = c?.configurable
							? Object.fromEntries(
									Object.entries(c.configurable as Record<string, unknown>).filter(
										([k]) => !k.startsWith("__pregel") && !k.startsWith("checkpoint"),
									),
								)
							: {};
						// Keep everything else on the config — crucially `callbacks`, which
						// carry the parent's streaming/tracing context. Nulling them would
						// stop the subagent's own tool events (search_notes, list_directory,
						// …) from bubbling into the parent stream, so the `task` card would
						// show no nested child branch. Only the checkpoint-read channels
						// above cause the message leak; callbacks are safe to keep.
						const cleanConfig = c
							? {
									...c,
									configurable: cleanConfigurable,
								}
							: {};
						// Call the compiled graph directly to bypass ReactAgent.invoke's
						// #initializeMiddlewareStates, which calls this.#graph.getState(config)
						// and would re-read the parent's checkpoint via __pregel_read.
						const compiledGraph = subgraph.graph as {
							invoke: (s: unknown, c: unknown) => Promise<unknown>;
						};
						// The parent graph node also sets an ambient AsyncLocalStorage config
						// that LangGraph's ensureLangGraphConfig merges back in via
						// getRunnableConfig() (re-injecting __pregel_read). runWithConfig
						// re-runs the subgraph in a fresh ALS context whose ambient config is
						// our clean config, so the parent's channels are no longer visible.
						return AsyncLocalStorageProviderSingleton.runWithConfig(cleanConfig, () =>
							compiledGraph.invoke(state, cleanConfig),
						) as Promise<never>;
					};
					return {
						name: s.name,
						description: s.description,
						runnable: subgraph,
					};
				}),
			}),
		];
	}

	/**
	 * Creates a HumanMessage with optional attachment metadata in additional_kwargs.
	 * Attachment metadata is stored so it can be reconstructed from checkpoints.
	 * Uses the object form so that multimodal content arrays (ContentBlock[])
	 * are correctly assigned to BaseMessage.content instead of being silently dropped.
	 */
	private createHumanMessage(
		content: string | ContentBlock[],
		attachments?: ChatAttachment[],
		visibleNotes?: VisibleNoteRef[],
		selection?: SelectionRef,
		graphNotes?: GraphNoteRef[],
		lcSource?: string,
		reviewStatus?: ReviewStatusRef,
	): HumanMessage {
		const additional_kwargs: Record<string, unknown> = {};
		if (attachments?.length) additional_kwargs.attachments = attachments;
		if (visibleNotes?.length) additional_kwargs.visibleNotes = visibleNotes;
		if (selection) additional_kwargs.selection = selection;
		if (graphNotes?.length) additional_kwargs.graphNotes = graphNotes;
		if (lcSource) additional_kwargs.lc_source = lcSource;
		if (reviewStatus) additional_kwargs.reviewStatus = reviewStatus;
		const hasKwargs = Object.keys(additional_kwargs).length > 0;
		// Cast content — the HumanMessage constructor handles both string and
		// ContentBlock[] at runtime, but the TS types are overly strict.
		return new HumanMessage({
			content: content as string,
			additional_kwargs: hasKwargs ? additional_kwargs : undefined,
		});
	}

	private async invokeBufferedFallback(
		agent: AgentRunnable,
		input: unknown,
		invokeConfig: RunnableConfig,
		runId: string,
		threadId: string,
		context: string,
		error: AiTransportDowngradeRequiredError,
	): Promise<unknown> {
		Logger.debug(`${context}.downgrade`, {
			runId,
			threadId,
			provider: error.providerId,
			url: error.url,
			message: error.cause instanceof Error ? error.cause.message : String(error.cause),
		});

		// Fresh buffered context scoped via run() — isolated from any other
		// concurrent stream's transport context.
		const bufferedContext = createAiTransportContext("buffered", `${context}:buffered:${runId}`);
		return runWithAiTransportContext(bufferedContext, async () => agent.invoke(input as never, invokeConfig));
	}

	async run(options: AgentRunOptions): Promise<AgentResult> {
		const { query, resolved } = options;
		const { runnable: agent, selectedModel } = resolved;
		const hasAttachments = Boolean(options.attachments?.length);

		if ((!query || query.trim().length === 0) && !hasAttachments) {
			throw new Error("Query must be a non-empty string when no attachments are provided.");
		}

		const runId = this.generateId();
		const threadId = options.threadId;
		if (!threadId) throw new Error("threadId is required");
		const startedAt = new Date();
		Logger.debug("agent.run.start", {
			runId,
			threadId,
			provider: selectedModel.provider,
			model: selectedModel.name,
			queryPreview: query.slice(0, 200),
		});

		const invokeConfig = this.buildRunnableConfig(options, threadId);

		const normalizedQuery = query.trim().length > 0 ? query : "Please analyze the attached files.";
		const messageContent = await this.buildMessageContent(
			normalizedQuery,
			resolved.supportsVision,
			resolved.currentProvider,
			options.attachments,
		);
		const humanMessage = this.createHumanMessage(
			messageContent,
			options.attachments,
			options.visibleNotes,
			options.selection,
			options.graphNotes,
			options.lcSource,
			options.reviewStatus,
		);

		const transportContext = createAiTransportContext("default", `agent.run:${runId}`);
		const rawResult = await runWithAiTransportContext(transportContext, async () =>
			agent.invoke({ messages: [humanMessage] }, invokeConfig),
		);

		const finishedAt = new Date();
		const messages = this.extractMessagesFromResult(rawResult);
		await this.finalizeThreadPersistence(threadId, runId, messages, selectedModel.name);

		const result: AgentResult = {
			runId,
			threadId,
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			messages,
			response: this.extractResponse(messages),
			raw: rawResult,
		};

		await this.telemetry?.onRunComplete?.(result);
		Logger.debug("agent.run.complete", {
			runId,
			durationMs: result.durationMs,
			responsePreview: typeof result.response === "string" ? result.response.slice(0, 200) : undefined,
		});

		return result;
	}

	/**
	 * The one streaming implementation behind {@link streamTokens},
	 * {@link editFromCheckpoint} and {@link regenerateFromCheckpoint}.
	 *
	 * Those three used to carry a verbatim copy of this ~200-line loop each. The
	 * copies were not free: `regenerateFromCheckpoint` silently lost its
	 * `flushThreadPersistence` call (a run's thread metadata could be dropped on
	 * quit), and two other cosmetic divergences accumulated. The methods differ in
	 * only three real ways, all parameters here:
	 *
	 *  - `input` — a fresh `{ messages: [humanMessage] }` for a query/edit, or `null`
	 *    to continue from a checkpoint without adding a message (regenerate);
	 *  - `checkpointId` — present to fork from a checkpoint, absent to append;
	 *  - `label` — the `agent.*` prefix for this run's debug logs, and the wording of
	 *    the "no final output" error.
	 */
	private async *runStream(params: {
		options: {
			resolved: ResolvedRun;
			signal?: AbortSignal;
			metadata?: Record<string, unknown>;
			configurable?: Record<string, unknown>;
		};
		threadId: string;
		runId: string;
		input: { messages: BaseMessage[] } | null;
		checkpointId?: string;
		label: string;
		noOutputError: string;
		logStart: Record<string, unknown>;
	}): AsyncGenerator<AgentStreamChunk> {
		const { options, threadId, runId, input, checkpointId, label, noOutputError, logStart } = params;
		const { resolved } = options;
		const { runnable: agent, selectedModel } = resolved;
		const startedAt = new Date();

		Logger.debug(`${label}.start`, { runId, threadId, ...logStart });

		const invokeConfig = this.buildRunnableConfig(options, threadId, checkpointId);
		const transportContext = createAiTransportContext("default", `${label}:${runId}`);

		// Bind the LangChain stream so each pull runs inside this run's transport
		// context (run()-scoped, concurrency-safe). Without this the fetch issued
		// deep inside the stream would read whichever context another concurrent
		// run last set.
		const stream = bindAsyncIterableToTransportContext(
			await agent.stream(input, {
				...invokeConfig,
				streamMode: ["messages", "tools", "values"] as const,
			}),
			transportContext,
		);

		let rawResult: unknown;
		// Track tool calls in progress to correlate start/end events
		const pendingToolCalls = new Map<string, { name: string; input: unknown }>();
		// Stack of open `task` tool call ids, for nesting subagent tool calls
		const taskCallStack: string[] = [];
		// The aiMessageId each open `task` call was stamped with, so its subagent
		// children can inherit the same timeline group (see resolveToolAttribution).
		const taskAiMessageIds = new Map<string, string | undefined>();
		// The subagent name (from task input.subagent_type) for each open task call.
		const taskSubAgentNames = new Map<string, string | undefined>();
		// Children-claimed count per open task, for FIFO round-robin attribution fallback.
		const taskChildCounts = new Map<string, number>();
		// Track the current AI message id from chat model stream chunks
		let lastAiMessageId: string | undefined;
		// Map toolCallId → preamble text: populated when a messages-mode AIMessage chunk
		// arrives with tool_calls. The messages stream delivers individual streaming deltas —
		// early deltas carry text content, the final delta carries tool_calls with no text.
		// We accumulate text per-message-id and index it when the tool_calls delta arrives.
		const toolCallPreambles = new Map<string, string>();
		// Running text accumulator for the current AI message (reset on new aiMessageId).
		let preambleAccumulator = "";
		// Tool call ids already announced via `tool_pending`, so a call whose args
		// stream across many deltas announces exactly once. Never cleared on a step
		// boundary: ids are globally unique per run, and `tool_start` reconciles by id.
		const announcedPendingToolCalls = new Set<string>();
		try {
			for await (const chunk of stream) {
				// Check if aborted before processing
				if (options.signal?.aborted) {
					Logger.debug(`${label}.aborted`, { runId, threadId });
					break;
				}

				const [mode, payload] = chunk as ["messages" | "tools" | "values", unknown];

				if (mode === "tools") {
					const tp = payload as
						| { event: "on_tool_start"; toolCallId?: string; name: string; input: unknown }
						| { event: "on_tool_end"; toolCallId?: string; name: string; output: unknown }
						| { event: string; toolCallId?: string; name: string };

					if (tp.event === "on_tool_start") {
						const toolCallId = tp.toolCallId ?? "";
						const toolName = tp.name;
						const rawToolInput = (tp as { event: "on_tool_start"; input: unknown }).input;
						const toolInput = this.normalizeStreamToolInput(rawToolInput);
						const attribution = this.resolveToolAttribution(
							"on_tool_start",
							toolInput,
							toolName,
							toolCallId,
							taskCallStack,
							taskAiMessageIds,
							taskSubAgentNames,
							taskChildCounts,
							lastAiMessageId,
						);
						const preamble = toolCallPreambles.get(toolCallId);
						toolCallPreambles.delete(toolCallId);
						pendingToolCalls.set(toolCallId, { name: toolName, input: toolInput });
						Logger.debug(`${label}.tool_start`, { runId, toolCallId, toolName });
						yield {
							type: "tool_start",
							toolCallId,
							toolName,
							input: toolInput,
							preamble,
							...attribution,
							runId,
							threadId,
						};
						continue;
					}

					if (tp.event === "on_tool_end") {
						const toolCallId = tp.toolCallId ?? "";
						const pending = pendingToolCalls.get(toolCallId);
						const toolName = pending?.name ?? tp.name;
						const output = this.normalizeStreamToolOutput(
							(tp as { event: "on_tool_end"; output: unknown }).output,
						);
						const attribution = this.resolveToolAttribution(
							"on_tool_end",
							undefined,
							toolName,
							toolCallId,
							taskCallStack,
							taskAiMessageIds,
							taskSubAgentNames,
							taskChildCounts,
							lastAiMessageId,
						);
						pendingToolCalls.delete(toolCallId);
						Logger.debug(`${label}.tool_end`, { runId, toolCallId, toolName });
						yield {
							type: "tool_end",
							toolCallId,
							toolName,
							output,
							...attribution,
							runId,
							threadId,
						};
						continue;
					}

					continue; // on_tool_event, on_tool_error: ignore
				}

				if (mode === "messages") {
					const [message, msgMeta] = payload as [BaseMessage, Record<string, unknown>];
					if (message.type === "ai") {
						// Tokens authored by a subagent carry `lc_agent_name` in their stream
						// metadata (set by deepagents' `task` tool). The subagent's answer is
						// delivered to the parent via the `task` ToolMessage (rendered under the
						// task card), so its streamed tokens must NOT append to the parent's main
						// content — otherwise the subagent's final answer leaks into the parent
						// message. Skip subagent tokens (and their preamble accounting) here.
						const isSubAgentToken = typeof msgMeta?.lc_agent_name === "string";
						if (isSubAgentToken) continue;
						// Reset accumulator when a new AI message starts.
						if (message.id && message.id !== lastAiMessageId) {
							lastAiMessageId = message.id;
							preambleAccumulator = "";
						}
						const token = this.normalizeContentToString(message.content);
						if (token && token.length > 0) {
							preambleAccumulator += token;
							yield {
								type: "token",
								token,
								aiMessageId: lastAiMessageId,
								runId,
								threadId,
							};
						}
						// Index accumulated text as preamble when this delta carries tool_calls.
						// The messages stream delivers individual deltas: text arrives in earlier
						// chunks, tool_calls arrive in a final chunk with no text. We track the
						// running text and stamp it onto each tool call id when the call ids appear.
						const msgToolCalls = (message as { tool_calls?: { id?: string }[] }).tool_calls;
						if (Array.isArray(msgToolCalls) && msgToolCalls.length > 0 && preambleAccumulator) {
							for (const tc of msgToolCalls) {
								if (tc.id && !toolCallPreambles.has(tc.id)) {
									toolCallPreambles.set(tc.id, preambleAccumulator);
								}
							}
						}

						// Announce each tool call as soon as its NAME is known, long before
						// its arguments finish streaming. `on_tool_start` cannot fire until
						// the args JSON is complete and schema-validated (LangChain parses
						// before invoking the callback), so a tool whose argument is itself
						// the payload — a `manage_notes` edit carrying whole note bodies —
						// left the UI blank for seconds. Streaming deltas carry partial calls
						// in `tool_call_chunks`; `name` and `id` land in the FIRST delta while
						// `args` accrues across later ones, which is exactly the early signal
						// we need. Announce once per id and let `tool_start` fill in the input.
						const chunkCalls = (message as { tool_call_chunks?: ToolCallChunk[] }).tool_call_chunks;
						if (Array.isArray(chunkCalls)) {
							for (const tc of chunkCalls) {
								if (!tc.id || !tc.name || announcedPendingToolCalls.has(tc.id)) continue;
								announcedPendingToolCalls.add(tc.id);
								// Attribution here is deliberately NOT resolved via
								// resolveToolAttribution: that call mutates the `task` bookkeeping
								// (pushes the call stack, bumps child counts) and must run exactly
								// once per call, at on_tool_start. Reading the open-task state
								// read-only keeps nesting correct without double-counting.
								const parentToolCallId = taskCallStack.at(-1);
								Logger.debug(`${label}.tool_pending`, { runId, toolCallId: tc.id, toolName: tc.name });
								yield {
									type: "tool_pending",
									toolCallId: tc.id,
									toolName: tc.name,
									// Whatever text preceded this call in the current AI message.
									// `tool_start` re-sends the same text (from toolCallPreambles,
									// stamped when tool_calls appeared) and the store dedupes, so
									// sending it early only makes it visible sooner.
									preamble: preambleAccumulator || undefined,
									aiMessageId: parentToolCallId
										? (taskAiMessageIds.get(parentToolCallId) ?? lastAiMessageId)
										: lastAiMessageId,
									subAgentName: parentToolCallId
										? taskSubAgentNames.get(parentToolCallId)
										: undefined,
									parentToolCallId,
									runId,
									threadId,
								};
							}
						}
					}
					continue;
				}

				if (mode === "values") {
					if (this.isAgentOutputCandidate(payload)) {
						rawResult = payload;
					}
				}
			}
		} catch (error) {
			// Don't log or rethrow abort errors - they're expected during cancellation
			if (error instanceof Error && error.name === "AbortError") {
				Logger.debug(`${label}.aborted`, { runId, threadId });
				return;
			}

			const downgradeError = findAiTransportDowngradeRequiredError(error);
			if (downgradeError) {
				rawResult = await this.invokeBufferedFallback(
					agent,
					input,
					invokeConfig,
					runId,
					threadId,
					label,
					downgradeError,
				);
			} else {
				// Wrap connection errors in ProviderEndpointError for consistent handling
				if (error instanceof TypeError && error.message.includes("fetch")) {
					const provider = selectedModel.provider;
					Logger.debug(`${label}.error`, { runId, message: `Connection failed to ${provider}` });
					throw new ProviderEndpointError(provider, "Connection refused - service may not be running");
				}

				Logger.debug(`${label}.error`, {
					runId,
					message: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		} finally {
			Logger.debug(`${label}.cleanup`, { runId, threadId });
		}

		// If aborted, don't process final result
		if (options.signal?.aborted) {
			return;
		}

		if (!rawResult) {
			throw new Error(noOutputError);
		}

		const finishedAt = new Date();
		const messages = this.extractMessagesFromResult(rawResult);
		await this.finalizeThreadPersistence(threadId, runId, messages, selectedModel.name);

		const result: AgentResult = {
			runId,
			threadId,
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			messages,
			response: this.extractResponse(messages),
			raw: rawResult,
		};

		await this.telemetry?.onRunComplete?.(result);
		Logger.debug(`${label}.complete`, {
			runId,
			durationMs: result.durationMs,
			responsePreview: typeof result.response === "string" ? result.response.slice(0, 200) : undefined,
		});

		yield {
			type: "result",
			result,
			runId,
			threadId,
		};

		// Read the latest checkpoint to get the final assistant message as persisted
		// This ensures UI stays in sync with the database
		const checkpointMessage = await this.getLastAssistantMessageFromCheckpoint(threadId);
		if (checkpointMessage) {
			Logger.debug(`${label}.checkpoint_message`, {
				runId,
				threadId,
				messageId: checkpointMessage.id,
			});
			yield {
				type: "checkpoint_message",
				message: checkpointMessage,
				runId,
				threadId,
			};
		}
	}

	async *streamTokens(options: AgentStreamOptions): AsyncGenerator<AgentStreamChunk> {
		const { query, resolved } = options;
		const hasAttachments = Boolean(options.attachments?.length);

		if ((!query || query.trim().length === 0) && !hasAttachments) {
			throw new Error("Query must be a non-empty string when no attachments are provided.");
		}

		const threadId = options.threadId;
		if (!threadId) throw new Error("threadId is required");

		const normalizedQuery = query.trim().length > 0 ? query : "Please analyze the attached files.";
		const messageContent = await this.buildMessageContent(
			normalizedQuery,
			resolved.supportsVision,
			resolved.currentProvider,
			options.attachments,
		);
		const humanMessage = this.createHumanMessage(
			messageContent,
			options.attachments,
			options.visibleNotes,
			options.selection,
			options.graphNotes,
			options.lcSource,
			options.reviewStatus,
		);

		yield* this.runStream({
			options,
			threadId,
			runId: this.generateId(),
			input: { messages: [humanMessage] },
			label: "agent.streamTokens",
			noOutputError: "Agent streaming completed without producing a final output.",
			logStart: {
				provider: resolved.selectedModel.provider,
				model: resolved.selectedModel.name,
				queryPreview: query.slice(0, 200),
			},
		});
	}

	/**
	 * Edit a message by forking from a checkpoint with a new user message.
	 * This creates a new branch from the given checkpoint.
	 */
	async *editFromCheckpoint(options: AgentEditOptions): AsyncGenerator<AgentStreamChunk> {
		const { query, threadId, checkpointId, resolved } = options;

		if (!query || query.trim().length === 0) {
			throw new Error("Query must be a non-empty string.");
		}

		if (!checkpointId) {
			throw new Error("checkpointId is required for editing.");
		}

		const messageContent = await this.buildMessageContent(
			query,
			resolved.supportsVision,
			resolved.currentProvider,
			options.attachments,
		);
		const humanMessage = this.createHumanMessage(
			messageContent,
			options.attachments,
			options.visibleNotes,
			undefined,
			undefined,
			options.lcSource,
		);

		yield* this.runStream({
			options,
			threadId,
			runId: this.generateId(),
			input: { messages: [humanMessage] },
			checkpointId,
			label: "agent.editFromCheckpoint",
			noOutputError: "Agent edit completed without producing a final output.",
			logStart: {
				checkpointId,
				provider: resolved.selectedModel.provider,
				model: resolved.selectedModel.name,
				queryPreview: query.slice(0, 200),
			},
		});
	}

	/**
	 * Regenerate an AI response from a checkpoint without adding a new user message.
	 * This forks from the given checkpoint and generates a new response.
	 */
	async *regenerateFromCheckpoint(options: AgentRegenerateOptions): AsyncGenerator<AgentStreamChunk> {
		const { threadId, checkpointId, resolved } = options;

		if (!checkpointId) {
			throw new Error("checkpointId is required for regeneration.");
		}

		yield* this.runStream({
			options,
			threadId,
			runId: this.generateId(),
			// null → continue from the checkpoint without adding a new message.
			input: null,
			checkpointId,
			label: "agent.regenerateFromCheckpoint",
			noOutputError: "Agent regeneration completed without producing a final output.",
			logStart: {
				checkpointId,
				provider: resolved.selectedModel.provider,
				model: resolved.selectedModel.name,
			},
		});
	}

	async getThreadHistory(threadId: string): Promise<ThreadHistory | undefined> {
		const [metadata, tuple] = await Promise.all([
			this.threadStore?.read(threadId),
			this.safeGetCheckpointTuple(threadId),
		]);

		if (!metadata && !tuple) {
			return undefined;
		}

		const checkpointTimestamp = tuple ? Date.parse(tuple.checkpoint.ts) || Date.now() : Date.now();
		const baseSnapshot = metadata
			? { ...metadata }
			: createSnapshot({
					threadId,
					updatedAt: checkpointTimestamp,
					createdAt: checkpointTimestamp,
				});
		const messages = tuple ? this.extractMessagesFromCheckpoint(tuple) : [];
		const { lastError, errorCount } = tuple
			? this.extractErrorsFromCheckpoint(tuple)
			: { lastError: undefined, errorCount: 0 };

		return {
			...baseSnapshot,
			updatedAt: metadata?.updatedAt ?? checkpointTimestamp,
			messages,
			lastError,
			errorCount,
		};
	}

	/**
	 * Gets all checkpoints for a thread with their messages and step numbers.
	 * Used for building the checkpoint-to-message mapping for regenerate/edit operations.
	 */
	async getCheckpointHistory(threadId: string): Promise<CheckpointHistoryItem[]> {
		const results: CheckpointHistoryItem[] = [];

		const config = { configurable: { thread_id: threadId } };

		for await (const tuple of this.checkpointer.list(config)) {
			const checkpointId = tuple.config.configurable?.checkpoint_id as string | undefined;
			if (!checkpointId) continue;

			const messages = this.extractMessagesFromCheckpoint(tuple);
			const step = (tuple.metadata?.step as number) ?? 0;
			const parentCheckpointId = tuple.parentConfig?.configurable?.checkpoint_id as string | undefined;
			const ts = tuple.checkpoint?.ts as string | undefined;

			results.push({ checkpointId, messages, step, parentCheckpointId, ts });
		}

		return results;
	}

	/**
	 * Gets messages for a specific checkpoint.
	 * Used for switching to a different branch.
	 */
	async getCheckpointMessages(threadId: string, checkpointId: string): Promise<BaseMessage[]> {
		const config = { configurable: { thread_id: threadId, checkpoint_id: checkpointId } };
		const tuple = await this.checkpointer.getTuple(config);
		if (!tuple) return [];
		return this.extractMessagesFromCheckpoint(tuple);
	}

	/**
	 * Gets the latest checkpoint ID for a thread.
	 * Used by UI reloads to stay on the branch that just finished streaming.
	 */
	async getLatestCheckpointId(threadId: string): Promise<string | undefined> {
		try {
			const tuple = await this.checkpointer.getTuple({
				configurable: { thread_id: threadId },
			});
			return tuple?.config?.configurable?.checkpoint_id as string | undefined;
		} catch (error) {
			Logger.debug("agent.getLatestCheckpointId.error", {
				threadId,
				message: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	/**
	 * Extracts error information from checkpoint's pendingWrites.
	 * Errors are stored with channel "__error__".
	 * Returns both the last error and total error count.
	 */
	private extractErrorsFromCheckpoint(tuple: CheckpointTuple): { lastError?: ThreadError; errorCount: number } {
		const pendingWrites = tuple.pendingWrites;
		Logger.debug("extractErrorsFromCheckpoint - pendingWrites:", pendingWrites);

		if (!Array.isArray(pendingWrites)) {
			Logger.debug("extractErrorsFromCheckpoint - pendingWrites is not an array");
			return { lastError: undefined, errorCount: 0 };
		}

		Logger.debug("extractErrorsFromCheckpoint - pendingWrites length:", pendingWrites.length);

		let lastError: ThreadError | undefined;
		let errorCount = 0;

		// pendingWrites can be either:
		// - [taskId, channel, value] tuples (3 elements) - standard LangGraph format
		// - [channel, value] tuples (2 elements) - some checkpoint implementations
		for (const write of pendingWrites) {
			Logger.debug("extractErrorsFromCheckpoint - checking write:", write);
			if (!Array.isArray(write)) continue;
			const writeLen = write.length as number;
			if (writeLen < 2) continue;

			let channel: unknown;
			let value: unknown;

			if (writeLen === 2) {
				// Format: [channel, value]
				[channel, value] = write;
			} else {
				// Format: [taskId, channel, value]
				[, channel, value] = write;
			}

			Logger.debug("extractErrorsFromCheckpoint - channel:", channel, "value:", value);
			if (channel === "__error__") {
				errorCount++;
				// Error value typically has { message: string, name?: string }
				if (value && typeof value === "object") {
					const errorObj = value as Record<string, unknown>;
					lastError = {
						message: String(errorObj.message ?? "Unknown error"),
						name: errorObj.name ? String(errorObj.name) : undefined,
					};
					Logger.debug(`extractErrorsFromCheckpoint - FOUND ERROR #${errorCount}:`, lastError);
				}
			}
		}

		Logger.debug("extractErrorsFromCheckpoint - total errors found:", errorCount);
		return { lastError, errorCount };
	}

	private buildRunnableConfig(
		options: { signal?: AbortSignal; metadata?: Record<string, unknown>; configurable?: Record<string, unknown> },
		threadId: string,
		checkpointId?: string,
	): RunnableConfig {
		const callbacks = this.telemetry?.getCallbacks?.();
		return {
			recursionLimit: 1000, // Effectively deactivated (default is 25)
			configurable: {
				thread_id: threadId,
				// If checkpointId is provided, include it to fork from that checkpoint
				...(checkpointId ? { checkpoint_id: checkpointId } : {}),
				...(options.configurable ?? {}),
			},
			metadata: options.metadata,
			callbacks: callbacks ?? undefined,
			signal: options.signal,
		} as RunnableConfig;
	}

	private wrapCheckpointer(checkpointer: BaseCheckpointSaver): BaseCheckpointSaver {
		// The async generator below is a `function*` (arrow generators do not exist),
		// so it cannot see the class `this`; hand it a bound normalizer instead.
		const normalizeTuple = (tuple: CheckpointTuple | undefined) => this.normalizeCheckpointTuple(tuple);
		return new Proxy(checkpointer, {
			get: (target, prop, receiver) => {
				if (prop === "getTuple") {
					return async (...args: unknown[]) => {
						const getTuple = Reflect.get(target, prop, receiver) as (
							...innerArgs: unknown[]
						) => Promise<CheckpointTuple | undefined>;
						const tuple = await getTuple.apply(target, args);
						return normalizeTuple(tuple);
					};
				}

				if (prop === "list") {
					return async function* (...args: unknown[]) {
						const list = Reflect.get(target, prop, receiver) as (
							...innerArgs: unknown[]
						) => AsyncIterable<CheckpointTuple>;
						for await (const tuple of list.apply(target, args)) {
							yield normalizeTuple(tuple) as CheckpointTuple;
						}
					};
				}

				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	private normalizeCheckpointTuple(tuple: CheckpointTuple | undefined): CheckpointTuple | undefined {
		if (!tuple?.checkpoint?.channel_values) {
			return tuple;
		}

		const channelValues = tuple.checkpoint.channel_values;
		const rawMessages = channelValues.messages;
		if (!Array.isArray(rawMessages)) {
			return tuple;
		}

		const normalizedMessages = normalizeMessages(rawMessages);
		return {
			...tuple,
			checkpoint: {
				...tuple.checkpoint,
				channel_values: {
					...channelValues,
					messages: normalizedMessages,
				},
			},
		};
	}

	private extractMessagesFromResult(result: unknown): BaseMessage[] {
		if (!result || typeof result !== "object" || !("messages" in result)) {
			return [];
		}
		const messages = (result as { messages?: unknown }).messages;
		if (!Array.isArray(messages)) {
			return [];
		}
		// Messages from agent.invoke() should be BaseMessage instances, but normalize just in case
		return normalizeMessages(messages);
	}

	private extractMessagesFromCheckpoint(tuple: CheckpointTuple): BaseMessage[] {
		const channelValues = tuple.checkpoint?.channel_values as Record<string, unknown> | undefined;
		if (!channelValues) {
			return [];
		}
		const messages = channelValues.messages;
		if (!Array.isArray(messages)) {
			return [];
		}
		// Convert serialized messages to BaseMessage instances
		return normalizeMessages(messages);
	}

	/**
	 * Resolves subagent nesting AND the timeline group (`aiMessageId`) for a tool
	 * event, using the per-stream `task` call stack. deepagents runs each subagent
	 * inside a `task` tool call, so any tool event while a `task` call is open may
	 * be a child of that call.
	 *
	 * Child attribution uses FIFO round-robin: each child is assigned to the open
	 * task with the fewest children so far, preferring the earliest-pushed task on
	 * ties. This matches deepagents' sequential execution order — children of task A
	 * arrive before children of task B even if both tasks' start events appear before
	 * any children. The `subagent_type` from each task's input (recorded on start) is
	 * used as the display name for attributed children.
	 *
	 * The `aiMessageId` normally follows `lastAiMessageId`. For children we force
	 * them to inherit the `aiMessageId` the parent `task` call was stamped with so
	 * parent and children land in the same timeline step.
	 */
	private resolveToolAttribution(
		eventType: "on_tool_start" | "on_tool_end" | "other",
		toolInput: unknown,
		toolName: string,
		toolCallId: string,
		taskCallStack: string[],
		taskAiMessageIds: Map<string, string | undefined>,
		taskSubAgentNames: Map<string, string | undefined>,
		taskChildCounts: Map<string, number>,
		lastAiMessageId: string | undefined,
	): { aiMessageId?: string; subAgentName?: string; parentToolCallId?: string } {
		const isTaskCall = toolName === "task";
		if (eventType === "on_tool_start" && isTaskCall) {
			taskCallStack.push(toolCallId);
			taskAiMessageIds.set(toolCallId, lastAiMessageId);
			taskChildCounts.set(toolCallId, 0);
			const input = toolInput as Record<string, unknown> | undefined;
			const subAgentName = typeof input?.subagent_type === "string" ? input.subagent_type : undefined;
			taskSubAgentNames.set(toolCallId, subAgentName);
			// Stamp the task call itself with its subagent name so the timeline card
			// shows the subagent label + badge during streaming (matching checkpoint
			// replay), not the bare "task" tool name.
			return { aiMessageId: lastAiMessageId, subAgentName };
		}
		if (eventType === "on_tool_end" && isTaskCall) {
			const groupId = taskAiMessageIds.has(toolCallId) ? taskAiMessageIds.get(toolCallId) : lastAiMessageId;
			const subAgentName = taskSubAgentNames.get(toolCallId);
			const idx = taskCallStack.lastIndexOf(toolCallId);
			if (idx !== -1) taskCallStack.splice(idx, 1);
			taskAiMessageIds.delete(toolCallId);
			taskSubAgentNames.delete(toolCallId);
			taskChildCounts.delete(toolCallId);
			return { aiMessageId: groupId, subAgentName };
		}
		// Assign each child to the open task with the fewest children (FIFO round-robin).
		// Only increment the child count on tool_start — tool_end events carry the same
		// parentToolCallId for correlation but should not count as a second child attribution.
		let parentToolCallId: string | undefined;
		if (taskCallStack.length > 0) {
			let bestParent: string | undefined;
			let bestCount = Number.MAX_SAFE_INTEGER;
			for (const taskId of taskCallStack) {
				const count = taskChildCounts.get(taskId) ?? 0;
				if (count < bestCount) {
					bestCount = count;
					bestParent = taskId;
				}
			}
			parentToolCallId = bestParent;
		}
		if (parentToolCallId) {
			if (eventType === "on_tool_start") {
				taskChildCounts.set(parentToolCallId, (taskChildCounts.get(parentToolCallId) ?? 0) + 1);
			}
			const resolvedSubAgentName = taskSubAgentNames.get(parentToolCallId);
			const parentAiMessageId = taskAiMessageIds.get(parentToolCallId) ?? lastAiMessageId;
			return { aiMessageId: parentAiMessageId, subAgentName: resolvedSubAgentName, parentToolCallId };
		}
		return { aiMessageId: lastAiMessageId };
	}

	private normalizeStreamToolInput(rawInput: unknown): unknown {
		let input = rawInput;

		if (input && typeof input === "object" && !Array.isArray(input)) {
			const wrapper = input as Record<string, unknown>;
			const hasRunnableMetadata =
				"config" in wrapper ||
				"kwargs" in wrapper ||
				"metadata" in wrapper ||
				"callbacks" in wrapper ||
				"tags" in wrapper;

			if ("input" in wrapper && (hasRunnableMetadata || Object.keys(wrapper).length === 1)) {
				input = wrapper.input;
			} else if ("args" in wrapper && Object.keys(wrapper).length === 1) {
				input = wrapper.args;
			} else if ("arguments" in wrapper && Object.keys(wrapper).length === 1) {
				input = wrapper.arguments;
			}
		}

		if (typeof input === "string") {
			try {
				return JSON.parse(input);
			} catch {
				return input;
			}
		}

		return input ?? {};
	}

	private normalizeStreamToolOutput(rawOutput: unknown): unknown {
		if (rawOutput === null || rawOutput === undefined) {
			return undefined;
		}

		if (rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput)) {
			const wrapper = rawOutput as Record<string, unknown>;

			// The `task` tool returns a LangGraph `Command` (returnCommandWithStateUpdate),
			// not a plain ToolMessage. Its `update.messages` array holds the ToolMessage
			// whose content is the subagent's final text. Unwrap it so the timeline shows
			// the subagent output during streaming (instead of dumping the raw Command's
			// lg_name/update/goto fields), matching checkpoint-replay rendering.
			if (wrapper.lg_name === "Command") {
				const update = wrapper.update as { messages?: unknown } | undefined;
				const messages = Array.isArray(update?.messages) ? (update?.messages as unknown[]) : undefined;
				const last = messages && messages.length > 0 ? messages[messages.length - 1] : undefined;
				return last && typeof last === "object" ? this.normalizeStreamToolOutput(last) : undefined;
			}

			// A live LangChain message instance (BaseMessage) — e.g. the ToolMessage the
			// `task` tool emits at on_tool_end during streaming. Its `content` holds the
			// text. Detect it by the `_getType` method (own-key checks are unreliable:
			// instances carry lc_* bookkeeping fields not in any fixed allowlist).
			if (typeof (wrapper as { _getType?: unknown })._getType === "function" && "content" in wrapper) {
				return wrapper.content;
			}

			const keys = Object.keys(wrapper);

			if (
				"content" in wrapper &&
				(keys.length === 1 ||
					keys.every((key) =>
						[
							"content",
							"artifact",
							"status",
							"tool_call_id",
							"name",
							"type",
							"id",
							"additional_kwargs",
							"response_metadata",
						].includes(key),
					))
			) {
				return wrapper.content;
			}

			if ("output" in wrapper && keys.length === 1) {
				return wrapper.output;
			}
		}

		return rawOutput;
	}

	private normalizeContentToString(value: unknown): string | undefined {
		if (typeof value === "string") {
			return value.length > 0 ? value : undefined;
		}
		if (Array.isArray(value)) {
			const combined = value
				.map((entry) => {
					if (typeof entry === "string") return entry;
					if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string") {
						return (entry as { text: string }).text;
					}
					return "";
				})
				.join("");
			return combined.length > 0 ? combined : undefined;
		}
		return undefined;
	}

	private isAgentOutputCandidate(value: unknown): value is { messages: unknown[] } {
		return Boolean(
			value &&
				typeof value === "object" &&
				"messages" in (value as Record<string, unknown>) &&
				Array.isArray((value as { messages?: unknown }).messages),
		);
	}

	private extractResponse(messages: BaseMessage[]): unknown {
		if (messages.length === 0) {
			return undefined;
		}
		const last = messages[messages.length - 1];
		// Use BaseMessage.text getter to extract text content
		return last.text || last.content;
	}

	private async persistThreadMetadata(
		threadId: string,
		runId: string,
		messages: BaseMessage[],
		modelName?: string,
	): Promise<void> {
		if (!this.threadStore) {
			return;
		}
		const existing = await this.threadStore.read(threadId);
		const metadata: Record<string, unknown> = { ...(existing?.metadata ?? {}) };
		metadata.lastRunId = runId;
		metadata.model = modelName;
		const lastMessage = messages[messages.length - 1];
		// Use BaseMessage.text getter to extract text content
		const preview = lastMessage?.text;
		if (preview) {
			metadata.lastMessagePreview = preview.slice(0, 200);
		}
		// Map LangChain type to role for metadata
		const lcType = lastMessage?.type;
		if (lcType) {
			metadata.lastMessageRole = lcType === "human" ? "user" : lcType === "ai" ? "assistant" : lcType;
		}
		await this.threadStore.write(
			createSnapshot({
				threadId,
				title: existing?.title,
				metadata,
				createdAt: existing?.createdAt,
			}),
		);
		Logger.debug("agent.threadStore.write", { threadId, lastRunId: runId });
	}

	private async flushThreadPersistence(threadId: string): Promise<void> {
		if (!this.threadStore?.flush) {
			return;
		}
		await this.threadStore.flush(threadId);
	}

	/**
	 * Records this run's thread metadata and forces it to disk.
	 *
	 * The two must stay paired: `threadStore.write` only marks the thread dirty and
	 * schedules a 2s debounced save, so without the flush a quit or crash inside that
	 * window loses the run's metadata. Every run-completion path calls this rather than
	 * the two methods separately — `regenerateFromCheckpoint` previously called only
	 * `persistThreadMetadata`, which is the kind of drift three near-identical
	 * stream loops invite.
	 */
	private async finalizeThreadPersistence(
		threadId: string,
		runId: string,
		messages: BaseMessage[],
		modelName?: string,
	): Promise<void> {
		await this.persistThreadMetadata(threadId, runId, messages, modelName);
		await this.flushThreadPersistence(threadId);
	}

	async generateTitle(userMessage: string, resolved: ResolvedRun): Promise<string | undefined> {
		const model = resolved.titleModel?.instance ?? resolved.selectedModel.instance;

		const prompt = `Generate a short, concise title (max 5 words) for the following user message. 
Rules:
- Use the same language as the user message.
- Do not use quotes, markdown, or a period at the end.
- Capture the core topic or intent.

User message:
${userMessage}`;

		// Use buffered transport mode for this non-streaming invoke call.
		// Electron net.fetch can produce responses that some providers
		// (e.g. OpenRouter) fail to parse, while the buffered requestUrl
		// path always returns a well-formed JSON body. Scoped via run() so a
		// concurrent stream's transport context is never disturbed.
		const transportContext = createAiTransportContext("buffered", "generateTitle");

		try {
			Logger.log(`[Agent] Generating title for message: "${userMessage.slice(0, 50)}..."`);
			const response = await runWithAiTransportContext(transportContext, async () =>
				model.invoke([{ role: "user", content: prompt }]),
			);

			const content = response.content;
			Logger.debug("[Agent] Title generation raw response:", content);

			let title = "";
			if (typeof content === "string") {
				title = content;
			} else if (Array.isArray(content)) {
				title = content
					.map((c) => (typeof c === "string" ? c : ((c as { text?: string }).text ?? "")))
					.join("");
			}

			const finalTitle = title.replace(/^["'#*:\s]+|["'#*:\s]+$/g, "").trim();
			Logger.log(`[Agent] Generated title: "${finalTitle}"`);
			return finalTitle;
		} catch (error) {
			Logger.error("[Agent] Title generation failed:", error);
			return undefined;
		}
	}

	private async safeGetCheckpointTuple(threadId: string): Promise<CheckpointTuple | undefined> {
		try {
			return await this.checkpointer.getTuple({
				configurable: { thread_id: threadId },
			});
		} catch (error) {
			Logger.debug("agent.checkpointer.getTuple.error", {
				threadId,
				message: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	private generateId(): string {
		if (typeof window.crypto !== "undefined" && "randomUUID" in window.crypto) {
			return window.crypto.randomUUID();
		}
		return `run_${Math.random().toString(36).slice(2, 10)}`;
	}

	/**
	 * Reads the latest checkpoint and extracts the last assistant message.
	 * Used to ensure UI stays in sync with persisted state after streaming.
	 */
	private async getLastAssistantMessageFromCheckpoint(threadId: string): Promise<BaseMessage | undefined> {
		const tuple = await this.safeGetCheckpointTuple(threadId);
		if (!tuple) {
			return undefined;
		}

		const messages = this.extractMessagesFromCheckpoint(tuple);
		if (messages.length === 0) {
			return undefined;
		}

		// Find the last AI message (assistant)
		for (let i = messages.length - 1; i >= 0; i--) {
			if (AIMessage.isInstance(messages[i])) {
				return messages[i];
			}
		}

		return undefined;
	}
}
