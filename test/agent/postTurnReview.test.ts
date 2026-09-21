/**
 * The pure half of the post-turn review: when a turn earns a review, what the reviewer is
 * shown, and how what it did is reported. The model call itself lives in AgentManager.
 */

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it } from "vitest";

import {
	buildReviewSystemPrompt,
	noteTurnForReview,
	renderTranscript,
	resetReviewCounters,
	summarizeReviewActions,
} from "../../src/agent/postTurnReview";

describe("noteTurnForReview", () => {
	beforeEach(() => resetReviewCounters());

	it("accumulates tool calls across turns and fires once the threshold is reached", () => {
		expect(noteTurnForReview("t", { toolCalls: 4, revisedSkills: false }, 10)).toBe(false);
		expect(noteTurnForReview("t", { toolCalls: 4, revisedSkills: false }, 10)).toBe(false);
		expect(noteTurnForReview("t", { toolCalls: 2, revisedSkills: false }, 10)).toBe(true);
		// Reset after firing.
		expect(noteTurnForReview("t", { toolCalls: 9, revisedSkills: false }, 10)).toBe(false);
	});

	it("keeps threads apart", () => {
		expect(noteTurnForReview("a", { toolCalls: 9, revisedSkills: false }, 10)).toBe(false);
		expect(noteTurnForReview("b", { toolCalls: 9, revisedSkills: false }, 10)).toBe(false);
		expect(noteTurnForReview("a", { toolCalls: 1, revisedSkills: false }, 10)).toBe(true);
	});

	// The review exists to prompt the revision the agent skipped; a turn that revised a
	// skill on its own has done that work, so it resets the count rather than adding to it.
	it("resets without firing when the turn revised a skill itself", () => {
		expect(noteTurnForReview("t", { toolCalls: 9, revisedSkills: false }, 10)).toBe(false);
		expect(noteTurnForReview("t", { toolCalls: 5, revisedSkills: true }, 10)).toBe(false);
		expect(noteTurnForReview("t", { toolCalls: 9, revisedSkills: false }, 10)).toBe(false);
	});

	it("never fires with a non-positive threshold", () => {
		expect(noteTurnForReview("t", { toolCalls: 100, revisedSkills: false }, 0)).toBe(false);
	});
});

describe("renderTranscript", () => {
	it("keeps user and assistant text, names tool calls, and clips tool results", () => {
		const long = "x".repeat(2000);
		const messages = [
			new HumanMessage("What is in my weekly review?"),
			new AIMessage({
				content: "",
				tool_calls: [{ id: "c1", name: "search_notes", args: { query: "weekly review" } }],
			}),
			new ToolMessage({ tool_call_id: "c1", name: "search_notes", content: long }),
			new AIMessage("It lists three habits."),
		];
		const out = renderTranscript(messages);
		expect(out).toContain("USER: What is in my weekly review?");
		expect(out).toContain('TOOL CALL search_notes({"query":"weekly review"})');
		expect(out).toContain("TOOL RESULT search_notes: xxx");
		expect(out).not.toContain("x".repeat(700));
		expect(out).toContain("ASSISTANT: It lists three habits.");
	});

	it("trims a long thread from the front, keeping the latest turns", () => {
		const messages = Array.from({ length: 200 }, (_, i) => new HumanMessage(`turn ${i} ${"y".repeat(400)}`));
		const out = renderTranscript(messages);
		expect(out.startsWith("…")).toBe(true);
		expect(out).toContain("turn 199");
		expect(out).not.toContain("USER: turn 0 ");
		expect(out.length).toBeLessThanOrEqual(40_010);
	});
});

describe("buildReviewSystemPrompt", () => {
	const base = {
		memoryIndex: "## Memory notes\n- `Agents/Memories/User.md` — who",
		memoryFolder: "Agents/Memories",
		skillsXml: "<available_skills>…</available_skills>",
	};

	it("teaches only the tools the reviewer actually holds", () => {
		const both = buildReviewSystemPrompt({ ...base, canRevise: true, canRemember: true });
		expect(both).toContain("save_memory");
		expect(both).toContain("manage_skills");
		expect(both).toContain("What is already remembered");
		expect(both).toContain("<available_skills>");

		const memoryOnly = buildReviewSystemPrompt({ ...base, canRevise: false, canRemember: true });
		expect(memoryOnly).not.toContain("manage_skills");
		expect(memoryOnly).not.toContain("<available_skills>");

		const skillsOnly = buildReviewSystemPrompt({ ...base, canRevise: true, canRemember: false });
		expect(skillsOnly).not.toContain("save_memory");
		expect(skillsOnly).not.toContain("What is already remembered");
	});

	it("names the empty outcome so the model has a way to do nothing", () => {
		expect(buildReviewSystemPrompt({ ...base, canRevise: true, canRemember: true })).toContain("Nothing to save.");
	});
});

describe("summarizeReviewActions", () => {
	it("reports saves from the tool calls that succeeded, deduplicated", () => {
		const messages = [
			new AIMessage({
				content: "",
				tool_calls: [
					{ id: "a", name: "load_skill", args: { skillName: "weekly-review" } },
					{
						id: "b",
						name: "manage_skills",
						args: { type: "patch", skillName: "weekly-review", oldText: "x", newText: "y" },
					},
					{ id: "c", name: "save_memory", args: { name: "User", content: "…" } },
					{
						id: "d",
						name: "manage_skills",
						args: { type: "patch", skillName: "weekly-review", oldText: "y", newText: "z" },
					},
				],
			}),
			new ToolMessage({ tool_call_id: "a", name: "load_skill", content: "# Skill: weekly-review" }),
			new ToolMessage({
				tool_call_id: "b",
				name: "manage_skills",
				content: 'Patched the "weekly-review" skill.',
			}),
			new ToolMessage({
				tool_call_id: "c",
				name: "save_memory",
				content: "Updated memory note Agents/Memories/User.md",
			}),
			new ToolMessage({
				tool_call_id: "d",
				name: "manage_skills",
				content: 'Patched the "weekly-review" skill.',
			}),
			new AIMessage("Revised skill: weekly-review\nSaved memory: User"),
		];
		expect(summarizeReviewActions(messages)).toEqual(["revised skill weekly-review", "saved memory User"]);
	});

	// The model's closing line can claim a save the tool refused; the report follows the tools.
	it("drops a revision the tool refused", () => {
		const messages = [
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "b",
						name: "manage_skills",
						args: { type: "patch", skillName: "dataview", oldText: "x", newText: "y" },
					},
				],
			}),
			new ToolMessage({
				tool_call_id: "b",
				name: "manage_skills",
				content: 'Load the "dataview" skill with load_skill first, then revise it.',
			}),
			new AIMessage("Revised skill: dataview"),
		];
		expect(summarizeReviewActions(messages)).toEqual([]);
	});

	it("drops a call whose tool result errored", () => {
		const messages = [
			new AIMessage({
				content: "",
				tool_calls: [{ id: "c", name: "save_memory", args: { name: "User", content: "" } }],
			}),
			new ToolMessage({ tool_call_id: "c", name: "save_memory", content: "boom", status: "error" }),
		];
		expect(summarizeReviewActions(messages)).toEqual([]);
	});
});
