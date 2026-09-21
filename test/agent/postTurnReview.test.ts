/**
 * The pure half of the post-turn review: when a turn earns a review, what the reviewer is
 * shown, and how what it did is reported. The model call itself lives in AgentManager.
 */

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
	buildReviewSystemPrompt,
	noteTurnForReview,
	readCallsSinceReview,
	renderTranscript,
	summarizeReviewActions,
	TOOL_CALLS_SINCE_REVIEW_KEY,
} from "../../src/agent/postTurnReview";

describe("noteTurnForReview", () => {
	const turn = (toolCalls: number, revisedSkills = false) => ({ toolCalls, revisedSkills });

	it("accumulates tool calls across turns and is due once the threshold is reached", () => {
		let calls = 0;
		let step = noteTurnForReview(calls, turn(4), 10);
		expect(step).toEqual({ due: false, callsSinceReview: 4 });
		step = noteTurnForReview(step.callsSinceReview, turn(4), 10);
		expect(step).toEqual({ due: false, callsSinceReview: 8 });
		step = noteTurnForReview(step.callsSinceReview, turn(2), 10);
		expect(step).toEqual({ due: true, callsSinceReview: 0 });
		// Starts over after firing.
		calls = step.callsSinceReview;
		expect(noteTurnForReview(calls, turn(9), 10)).toEqual({ due: false, callsSinceReview: 9 });
	});

	// The review exists to prompt the revision the agent skipped; a turn that revised a
	// skill on its own has done that work, so it resets the count rather than adding to it.
	it("resets without firing when the turn revised a skill itself", () => {
		expect(noteTurnForReview(9, turn(5, true), 10)).toEqual({ due: false, callsSinceReview: 0 });
	});

	it("is never due with a non-positive threshold", () => {
		expect(noteTurnForReview(50, turn(100), 0).due).toBe(false);
	});
});

describe("readCallsSinceReview", () => {
	it("reads the persisted count and treats anything else as zero", () => {
		expect(readCallsSinceReview({ [TOOL_CALLS_SINCE_REVIEW_KEY]: 7 })).toBe(7);
		expect(readCallsSinceReview({ [TOOL_CALLS_SINCE_REVIEW_KEY]: 7.9 })).toBe(7);
		expect(readCallsSinceReview({ [TOOL_CALLS_SINCE_REVIEW_KEY]: "7" })).toBe(0);
		expect(readCallsSinceReview({ [TOOL_CALLS_SINCE_REVIEW_KEY]: -3 })).toBe(0);
		expect(readCallsSinceReview({})).toBe(0);
		expect(readCallsSinceReview(undefined)).toBe(0);
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

	// A refused first attempt followed by a load and a successful retry is one revision.
	it("reports a successful retry after a refusal, matching each call to its own result", () => {
		const patch = { type: "patch", skillName: "dataview", oldText: "x", newText: "y" };
		const messages = [
			new AIMessage({ content: "", tool_calls: [{ id: "b1", name: "manage_skills", args: patch }] }),
			new ToolMessage({
				tool_call_id: "b1",
				name: "manage_skills",
				content: 'Load the "dataview" skill with load_skill first, then revise it.',
			}),
			new AIMessage({
				content: "",
				tool_calls: [{ id: "l", name: "load_skill", args: { skillName: "dataview" } }],
			}),
			new ToolMessage({ tool_call_id: "l", name: "load_skill", content: "# Skill: dataview" }),
			new AIMessage({ content: "", tool_calls: [{ id: "b2", name: "manage_skills", args: patch }] }),
			new ToolMessage({ tool_call_id: "b2", name: "manage_skills", content: 'Patched the "dataview" skill.' }),
		];
		expect(summarizeReviewActions(messages)).toEqual(["revised skill dataview"]);
	});

	it("does not report a refused or no-op memory save", () => {
		const messages = [
			new AIMessage({
				content: "",
				tool_calls: [
					{ id: "s1", name: "save_memory", args: { name: "../x", content: "" } },
					{ id: "s2", name: "save_memory", args: { name: "User", content: "" } },
				],
			}),
			new ToolMessage({
				tool_call_id: "s1",
				name: "save_memory",
				content: 'Refused: "../x" is not a plain note name.',
			}),
			new ToolMessage({
				tool_call_id: "s2",
				name: "save_memory",
				content: "Updated memory note Agents/Memories/User.md (applied, no review needed).",
			}),
		];
		expect(summarizeReviewActions(messages)).toEqual(["saved memory User"]);
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
