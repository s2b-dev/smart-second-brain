import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

const TOKENS_PER_WORD = 1.3; // Conservative estimate for English text
const PER_MESSAGE_OVERHEAD = 80; // Separators, metadata, framing
const SYSTEM_PROMPT_OVERHEAD = 120;
const ATTACHMENT_OVERHEAD = 200;
const VISIBLE_NOTES_OVERHEAD = 100;
const SELECTION_OVERHEAD = 50;
const GRAPH_NOTES_OVERHEAD = 100;
const TOOL_CALL_OVERHEAD = 60;
const DRAFT_OVERHEAD = 20;

/**
 * Estimated context usage breakdown.
 * All token counts are approximations based on word counts.
 */
export interface UsageEstimate {
	/** Estimated tokens used by the entire conversation (messages + draft) */
	estimatedUsedTokens: number;
	/** Model's context window in tokens (undefined if unknown) */
	contextWindow: number | undefined;
	/** Usage percentage (0-100, clamped) */
	usagePercent: number;
}

/**
 * Estimated token distribution across payload categories.
 */
export interface ContextUsageBreakdown {
	systemPromptTokens: number;
	humanTokens: number;
	assistantTokens: number;
	toolTokens: number;
	draftAndPendingTokens: number;
	totalTokens: number;
}

/**
 * Optional payload elements that are sent to the LLM but not represented
 * directly in chat message pairs yet.
 */
export interface ContextUsageOptions {
	/** Full assembled system prompt sent with model requests */
	systemPrompt?: string;
	/** Extra text blocks included in the request payload */
	additionalTextBlocks?: string[];
	/** Pending attachments on the draft message */
	pendingAttachmentsCount?: number;
	/** Pending visible notes on the draft message */
	pendingVisibleNotesCount?: number;
	/** Whether there is a pending selection on the draft message */
	hasPendingSelection?: boolean;
	/** Pending graph notes on the draft message */
	pendingGraphNotesCount?: number;
}

/**
 * Options used to estimate the stable (non-typing) portion of context usage.
 */
export interface BaseContextOptions {
	systemPrompt?: string;
	additionalTextBlocks?: string[];
}

/**
 * Options used to estimate the live draft portion that changes while typing.
 */
export interface LiveContextOptions {
	pendingAttachmentsCount?: number;
	pendingVisibleNotesCount?: number;
	hasPendingSelection?: boolean;
	pendingGraphNotesCount?: number;
}

/**
 * Estimates context usage for a conversation thread including the current draft.
 *
 * Estimation logic:
 * - Word count approximation: ~1.3 tokens per word (conservative for English)
 * - Per-message overhead: 80 tokens (for separators, metadata, etc.)
 * - Attachments: +200 tokens per attachment (conservative approximation)
 * - Visible notes context: +100 tokens total if present
 * - Selection context: +50 tokens if present
 * - Graph notes: +100 tokens total if present
 *
 * All counts are marked as estimated in the UI tooltip and should not be
 * treated as authoritative. Serves as a live indicator during draft composition.
 *
 * @param messages - Array of message pairs from the chat session
 * @param inputValue - Current draft text in the input
 * @param contextWindow - Model's context window size (undefined = unknown)
 * @returns Estimated usage breakdown
 */
export function estimateContextUsage(
	messages: BaseMessage[],
	inputValue: string,
	contextWindow: number | undefined,
	options: ContextUsageOptions = {},
): UsageEstimate {
	const breakdown = estimateContextUsageBreakdown(messages, inputValue, options);
	return buildUsageEstimate(breakdown.totalTokens, contextWindow);
}

export function estimateContextUsageBreakdown(
	messages: BaseMessage[],
	inputValue: string,
	options: ContextUsageOptions = {},
): ContextUsageBreakdown {
	const { humanTokens, assistantTokens, toolTokens } = estimateBaseMessagePayloadTokens(messages);

	const systemPromptTokens =
		estimateSystemPromptTokens(options.systemPrompt) +
		estimateAdditionalTextBlockTokens(options.additionalTextBlocks);

	const draftAndPendingTokens = estimateLiveDraftTokens(inputValue, {
		pendingAttachmentsCount: options.pendingAttachmentsCount,
		pendingVisibleNotesCount: options.pendingVisibleNotesCount,
		hasPendingSelection: options.hasPendingSelection,
		pendingGraphNotesCount: options.pendingGraphNotesCount,
	});

	const totalTokens = systemPromptTokens + humanTokens + assistantTokens + toolTokens + draftAndPendingTokens;

	return {
		systemPromptTokens,
		humanTokens,
		assistantTokens,
		toolTokens,
		draftAndPendingTokens,
		totalTokens,
	};
}

/**
 * Estimates stable context usage that does not change on every keystroke.
 */
export function estimateConversationBaseTokens(messages: BaseMessage[], options: BaseContextOptions = {}): number {
	const { humanTokens, assistantTokens, toolTokens } = estimateBaseMessagePayloadTokens(messages);
	return (
		humanTokens +
		assistantTokens +
		toolTokens +
		estimateSystemPromptTokens(options.systemPrompt) +
		estimateAdditionalTextBlockTokens(options.additionalTextBlocks)
	);
}

/**
 * Estimates the live draft-side context that can change while typing.
 */
export function estimateLiveDraftTokens(inputValue: string, options: LiveContextOptions = {}): number {
	let totalTokens = 0;

	if (inputValue.trim()) {
		totalTokens += estimateTextTokens(inputValue, DRAFT_OVERHEAD);
	}

	const pendingAttachmentsCount = options.pendingAttachmentsCount ?? 0;
	const pendingVisibleNotesCount = options.pendingVisibleNotesCount ?? 0;
	const pendingGraphNotesCount = options.pendingGraphNotesCount ?? 0;

	if (pendingAttachmentsCount > 0) totalTokens += pendingAttachmentsCount * ATTACHMENT_OVERHEAD;
	if (pendingVisibleNotesCount > 0) totalTokens += VISIBLE_NOTES_OVERHEAD;
	if (options.hasPendingSelection) totalTokens += SELECTION_OVERHEAD;
	if (pendingGraphNotesCount > 0) totalTokens += GRAPH_NOTES_OVERHEAD;

	return totalTokens;
}

/**
 * Builds a usage estimate object from a total token count.
 */
export function buildUsageEstimate(totalTokens: number, contextWindow: number | undefined): UsageEstimate {
	let usagePercent = 0;
	if (contextWindow && contextWindow > 0) {
		usagePercent = (totalTokens / contextWindow) * 100;
	}

	usagePercent = Math.min(Math.max(usagePercent, 0), 100);

	return {
		estimatedUsedTokens: totalTokens,
		contextWindow,
		usagePercent,
	};
}

/**
 * Simple word count approximation.
 * Splits on whitespace and filters out empty strings.
 */
function countWords(text: string): number {
	if (!text) return 0;
	return text.split(/\s+/).filter((word) => word.length > 0).length;
}

function stringifyForTokenEstimate(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return Object.prototype.toString.call(value);
	}
}

function estimateTextTokens(text: string, fixedOverhead = 0): number {
	if (!text.trim()) return 0;
	const wordCount = countWords(text);
	return Math.ceil(wordCount * TOKENS_PER_WORD) + fixedOverhead;
}

function estimateSystemPromptTokens(systemPrompt: string | undefined): number {
	if (!systemPrompt?.trim()) return 0;
	return estimateTextTokens(systemPrompt, SYSTEM_PROMPT_OVERHEAD);
}

function estimateAdditionalTextBlockTokens(additionalTextBlocks: string[] | undefined): number {
	if (!additionalTextBlocks?.length) return 0;

	let totalTokens = 0;
	for (const block of additionalTextBlocks) {
		if (!block?.trim()) continue;
		totalTokens += estimateTextTokens(block, DRAFT_OVERHEAD);
	}
	return totalTokens;
}

function estimateBaseMessagePayloadTokens(messages: BaseMessage[]): {
	humanTokens: number;
	assistantTokens: number;
	toolTokens: number;
} {
	let humanTokens = 0;
	let assistantTokens = 0;
	let toolTokens = 0;

	for (const message of messages) {
		if (HumanMessage.isInstance(message)) {
			humanTokens += estimateTextTokens(message.text || "");
			const attachments = message.additional_kwargs?.attachments;
			if (Array.isArray(attachments)) {
				humanTokens += attachments.length * ATTACHMENT_OVERHEAD;
			}
			if (
				Array.isArray(message.additional_kwargs?.visibleNotes) &&
				message.additional_kwargs.visibleNotes.length > 0
			) {
				humanTokens += VISIBLE_NOTES_OVERHEAD;
			}
			if (message.additional_kwargs?.selection) {
				humanTokens += SELECTION_OVERHEAD;
			}
			if (
				Array.isArray(message.additional_kwargs?.graphNotes) &&
				message.additional_kwargs.graphNotes.length > 0
			) {
				humanTokens += GRAPH_NOTES_OVERHEAD;
			}
			humanTokens += PER_MESSAGE_OVERHEAD;
			continue;
		}

		if (AIMessage.isInstance(message)) {
			assistantTokens += estimateTextTokens(message.text || "");
			assistantTokens += PER_MESSAGE_OVERHEAD;

			if (message.tool_calls?.length) {
				for (const toolCall of message.tool_calls) {
					const payload = [
						toolCall.name,
						stringifyForTokenEstimate(toolCall.args),
						stringifyForTokenEstimate(toolCall.id),
					]
						.filter((part): part is string => Boolean(part))
						.join(" ");
					toolTokens += estimateTextTokens(payload, TOOL_CALL_OVERHEAD);
				}
			}
		}
	}

	return { humanTokens, assistantTokens, toolTokens };
}

/**
 * Format context usage for display in tooltips.
 * Example: "Context usage (est.): 37% (47k / 128k)"
 */
export function formatContextUsage(estimate: UsageEstimate): string {
	const percent = estimate.usagePercent.toFixed(0);

	if (estimate.contextWindow === undefined) {
		const tokensK = Math.round(estimate.estimatedUsedTokens / 1000);
		return `Context usage (est.): ${tokensK}k tokens (limit unknown)`;
	}

	const usedK = Math.round(estimate.estimatedUsedTokens / 1000);
	const limitK = Math.round(estimate.contextWindow / 1000);

	return `Context usage (est.): ${percent}% (${usedK}k / ${limitK}k)`;
}
