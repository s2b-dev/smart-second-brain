import { describe, it, expect, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { countTokensApproximately } from "langchain";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import {
	countMessageTokens,
	estimateContextUsage,
	estimateContextUsageBreakdown,
	formatContextUsage,
	type UsageEstimate,
} from "../../src/utils/tokenEstimator";

function createConversation(userContent: string, assistantContent: string) {
	return [new HumanMessage(userContent), new AIMessage(assistantContent)];
}

function createConversationWithAttachments(userContent: string, assistantContent: string, attachmentCount: number) {
	return [
		new HumanMessage({
			content: userContent,
			additional_kwargs: {
				attachments: new Array(attachmentCount).fill({ size: 1000, name: "file.pdf" }),
			},
		}),
		new AIMessage(assistantContent),
	];
}

describe("tokenEstimator", () => {
	describe("estimateContextUsage", () => {
		it("should handle empty conversation and empty input", () => {
			const result = estimateContextUsage([], "", 128000);

			expect(result.estimatedUsedTokens).toBe(0);
			expect(result.contextWindow).toBe(128000);
			expect(result.usagePercent).toBe(0);
		});

		it("should estimate tokens from a single message pair", () => {
			const messages = createConversation("hello world", "goodbye world");
			const result = estimateContextUsage(messages, "", 128000);

			// "hello world" = 11 chars / 4 ≈ 3 tokens
			// "goodbye world" = 13 chars / 4 ≈ 4 tokens
			// Per-message overhead: 4 + 4 = 8
			// Total: 3 + 4 + 8 = 15
			expect(result.estimatedUsedTokens).toBe(15);
			expect(result.usagePercent).toBeCloseTo(0.0117, 4);
		});

		it("should include draft text in estimation", () => {
			const messages = createConversation("hello", "hi");
			const result = estimateContextUsage(messages, "what is this", 128000);

			// hello = 5 chars / 4 ≈ 2 tokens (rounded up)
			// hi = 2 chars / 4 ≈ 1 token (rounded up)
			// Message overheads: 8
			// Draft "what is this" = 12 chars / 4 = 3 tokens
			// Draft overhead: 20
			// Total: 2 + 1 + 8 + 3 + 20 = 34
			expect(result.estimatedUsedTokens).toBe(34);
			expect(result.usagePercent).toBeCloseTo(0.0266, 4);
		});

		it("should ignore empty draft text", () => {
			const messages = createConversation("hello", "hi");
			const result1 = estimateContextUsage(messages, "", 128000);
			const result2 = estimateContextUsage(messages, "   ", 128000);

			expect(result1.estimatedUsedTokens).toBe(result2.estimatedUsedTokens);
		});

		it("should account for attachment overhead", () => {
			const messages = createConversationWithAttachments("hello", "hi", 2);
			const result = estimateContextUsage(messages, "", 128000);

			// 2 attachments * 200 tokens each = 400
			// Plus other content: 11 (hello + hi + message overheads)
			// Expected: 411
			expect(result.estimatedUsedTokens).toBeGreaterThan(400);
			expect(result.estimatedUsedTokens).toBeLessThan(600);
		});

		it("should include visible notes overhead when present", () => {
			const messages = [
				new HumanMessage({
					content: "hello",
					additional_kwargs: { visibleNotes: [{ path: "note1.md", basename: "note1" }] },
				}),
				new AIMessage("hi"),
			];

			const resultWithoutNotes = estimateContextUsage(createConversation("hello", "hi"), "", 128000);
			const resultWithNotes = estimateContextUsage(messages, "", 128000);

			// Difference should be around 100 tokens for visible notes
			expect(resultWithNotes.estimatedUsedTokens - resultWithoutNotes.estimatedUsedTokens).toBe(100);
		});

		it("should include selection overhead when present", () => {
			const messages = [
				new HumanMessage({
					content: "hello",
					additional_kwargs: { selection: { text: "selected text", file: "note.md" } },
				}),
				new AIMessage("hi"),
			];

			const resultWithoutSelection = estimateContextUsage(createConversation("hello", "hi"), "", 128000);
			const resultWithSelection = estimateContextUsage(messages, "", 128000);

			// Difference should be around 50 tokens for selection
			expect(resultWithSelection.estimatedUsedTokens - resultWithoutSelection.estimatedUsedTokens).toBe(50);
		});

		it("should include graph notes overhead when present", () => {
			const messages = [
				new HumanMessage({
					content: "hello",
					additional_kwargs: { graphNotes: [{ path: "note1.md", basename: "note1" }] },
				}),
				new AIMessage("hi"),
			];

			const resultWithoutGraphNotes = estimateContextUsage(createConversation("hello", "hi"), "", 128000);
			const resultWithGraphNotes = estimateContextUsage(messages, "", 128000);

			// Difference should be around 100 tokens for graph notes
			expect(resultWithGraphNotes.estimatedUsedTokens - resultWithoutGraphNotes.estimatedUsedTokens).toBe(100);
		});

		it("should include summarized checkpoint messages in the normal human token bucket", () => {
			const messages = [
				new HumanMessage({
					content: "Previous conversation summary\n\nImportant prior decisions.",
					additional_kwargs: { lc_source: "summarization" },
				}),
				new HumanMessage("hello"),
				new AIMessage("hi"),
			];
			const breakdown = estimateContextUsageBreakdown(messages, "", {});

			expect(breakdown.humanTokens).toBeGreaterThan(0);
			expect(breakdown.totalTokens).toBe(
				breakdown.systemPromptTokens +
					breakdown.humanTokens +
					breakdown.assistantTokens +
					breakdown.toolTokens +
					breakdown.draftAndPendingTokens,
			);
		});

		it("should clamp usage percent to [0, 100]", () => {
			const messages = createConversation("hello world", "hi there");

			// Small context window to exceed 100%
			const resultOver = estimateContextUsage(messages, "", 100);
			expect(resultOver.usagePercent).toBeLessThanOrEqual(100);
			expect(resultOver.usagePercent).toBeGreaterThan(0);

			// Ensure it's not clamped when under 100%
			const resultUnder = estimateContextUsage(messages, "", 128000);
			expect(resultUnder.usagePercent).toBeLessThan(100);
		});

		it("should handle undefined context window", () => {
			const messages = createConversation("hello world", "hi there");
			const result = estimateContextUsage(messages, "", undefined);

			expect(result.contextWindow).toBeUndefined();
			expect(result.usagePercent).toBe(0);
			expect(result.estimatedUsedTokens).toBeGreaterThan(0);
		});

		it("should handle long conversations with multiple message pairs", () => {
			const messages = [
				...createConversation("first message", "first response"),
				...createConversation("second message", "second response"),
				...createConversation("third message", "third response"),
			];
			const result = estimateContextUsage(messages, "", 128000);

			// Should accumulate tokens from all three pairs
			expect(result.estimatedUsedTokens).toBeGreaterThan(30);
			expect(result.usagePercent).toBeGreaterThan(0);
		});

		it("should handle very long text content", () => {
			const longText = new Array(1000).fill("word").join(" ");
			const messages = createConversation(longText, "short response");
			const result = estimateContextUsage(messages, "", 128000);

			// long text (4999 chars) / 4 ≈ 1250 tokens + overhead
			expect(result.estimatedUsedTokens).toBeGreaterThan(1000);
		});

		it("should handle empty content strings gracefully", () => {
			const messages = createConversation("", "");
			const result = estimateContextUsage(messages, "", 128000);

			// Only message overhead: 4 + 4 = 8
			expect(result.estimatedUsedTokens).toBe(8);
		});

		it("should not double-count when messages and draft are both empty", () => {
			const result = estimateContextUsage([], "", 128000);

			expect(result.estimatedUsedTokens).toBe(0);
			expect(result.contextWindow).toBe(128000);
			expect(result.usagePercent).toBe(0);
		});

		it("should include system prompt tokens in the estimate", () => {
			const base = estimateContextUsage([], "", 128000);
			const withSystemPrompt = estimateContextUsage([], "", 128000, {
				systemPrompt: "You are a helpful assistant with strict formatting rules",
			});

			expect(withSystemPrompt.estimatedUsedTokens).toBeGreaterThan(base.estimatedUsedTokens);
		});

		it("should include pending draft contexts in the estimate", () => {
			const base = estimateContextUsage([], "", 128000);
			const withPendingContext = estimateContextUsage([], "", 128000, {
				pendingAttachmentsCount: 2,
				pendingVisibleNotesCount: 1,
				hasPendingSelection: true,
				pendingGraphNotesCount: 3,
			});

			expect(withPendingContext.estimatedUsedTokens).toBe(base.estimatedUsedTokens + 650);
		});

		it("should include additional text blocks in the estimate", () => {
			const base = estimateContextUsage([], "", 128000);
			const withAdditionalBlocks = estimateContextUsage([], "", 128000, {
				additionalTextBlocks: ["first block", "second context block"],
			});

			expect(withAdditionalBlocks.estimatedUsedTokens).toBeGreaterThan(base.estimatedUsedTokens);
		});

		it("should include assistant tool call payloads in the estimate", () => {
			const withoutToolCall = estimateContextUsage(createConversation("plan this", "working on it"), "", 128000);
			const withToolCall = estimateContextUsage(
				[
					new HumanMessage("plan this"),
					new AIMessage({
						content: "working on it",
						tool_calls: [
							{
								id: "tc-1",
								name: "read_content",
								args: { path: "note.md" },
							},
						],
					}),
				],
				"",
				128000,
			);

			expect(withToolCall.estimatedUsedTokens).toBeGreaterThan(withoutToolCall.estimatedUsedTokens);
		});

		it("counts tool result bodies under tool tokens (#545)", () => {
			const toolOutput = "x".repeat(4000);
			const breakdown = estimateContextUsageBreakdown(
				[
					new HumanMessage("read it"),
					new AIMessage({
						content: "",
						tool_calls: [{ id: "tc-1", name: "read_content", args: { path: "note.md" } }],
					}),
					new ToolMessage({ content: toolOutput, tool_call_id: "tc-1" }),
				],
				"",
			);

			// 4000 chars / 4 = 1000, plus the call payload and framing.
			expect(breakdown.toolTokens).toBeGreaterThanOrEqual(1000);
			expect(breakdown.toolTokens).toBeLessThan(1100);
		});
	});

	describe("countMessageTokens", () => {
		it("matches the meter's message payload, so meter and summarization trigger agree", () => {
			const messages = [
				new HumanMessage("hello there"),
				new AIMessage({
					content: "on it",
					tool_calls: [{ id: "tc-1", name: "read_content", args: { path: "a.md" } }],
				}),
				new ToolMessage({ content: "note body ".repeat(200), tool_call_id: "tc-1" }),
			];
			const breakdown = estimateContextUsageBreakdown(messages, "");

			expect(countMessageTokens(messages)).toBe(
				breakdown.humanTokens + breakdown.assistantTokens + breakdown.toolTokens,
			);
		});

		it("stays within a few percent of LangChain's chars/4 counter on text-heavy history", () => {
			const messages = [
				new HumanMessage("Summarize my notes about the project roadmap. ".repeat(40)),
				new AIMessage("Here is what the roadmap says about the next quarter. ".repeat(60)),
				new ToolMessage({ content: "A long note body with plenty of text. ".repeat(300), tool_call_id: "t" }),
			];
			const ours = countMessageTokens(messages);
			const langchain = countTokensApproximately(messages);

			expect(Math.abs(ours - langchain) / langchain).toBeLessThan(0.02);
		});
	});

	describe("formatContextUsage", () => {
		it("should format usage with known context window", () => {
			const estimate: UsageEstimate = {
				estimatedUsedTokens: 47000,
				contextWindow: 128000,
				usagePercent: 36.7,
			};

			const formatted = formatContextUsage(estimate);

			expect(formatted).toContain("37%");
			expect(formatted).toContain("47k");
			expect(formatted).toContain("128k");
			expect(formatted).toContain("(est.)");
		});

		it("should format usage with unknown context window", () => {
			const estimate: UsageEstimate = {
				estimatedUsedTokens: 47000,
				contextWindow: undefined,
				usagePercent: 0,
			};

			const formatted = formatContextUsage(estimate);

			expect(formatted).toContain("47k");
			expect(formatted).toContain("unknown");
			expect(formatted).toContain("(est.)");
		});

		it("should round tokens to nearest thousand", () => {
			const estimate: UsageEstimate = {
				estimatedUsedTokens: 47500,
				contextWindow: 128000,
				usagePercent: 37.1,
			};

			const formatted = formatContextUsage(estimate);

			expect(formatted).toContain("48k"); // 47500 rounds to 48k
		});

		it("should format percentage correctly", () => {
			const estimate: UsageEstimate = {
				estimatedUsedTokens: 50000,
				contextWindow: 128000,
				usagePercent: 39.0625,
			};

			const formatted = formatContextUsage(estimate);

			expect(formatted).toContain("39%"); // Should be rounded to nearest integer
		});
	});
});
