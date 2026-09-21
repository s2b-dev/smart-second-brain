/**
 * Guards the shipped agent-prompt history (`SHIPPED_AGENT_PROMPTS`) against the failure that hit
 * the bundled skills: bumping a version without retaining the body that version replaced.
 *
 * The reconcile machinery itself is covered by promptFilesReconcile.test.ts, but that suite
 * substitutes *mocked* histories to exercise the state transitions, so nothing there asserts
 * anything about the real one.
 *
 * Why this matters: the agent prompt is assembled into every agent's system prompt, so an
 * orphaned version misclassifies every install at once — each gets a "your customized version
 * was kept" notice for a file the user never touched, and never receives the new prompt.
 */

import { describe, expect, it } from "vitest";

import agentPrompt1 from "../../src/agent/history/agent-prompt-1.md?raw";
import { AGENT_PROMPT_VERSION, DEFAULT_AGENT_PROMPT, SHIPPED_AGENT_PROMPTS } from "../../src/agent/prompts";
import { type ShippedHistory, currentShippedVersion, fingerprint } from "../../src/utils/shippedDefaults";

/**
 * Fingerprint of the history's newest text — stored as a literal, on purpose.
 *
 * This is the one check that cannot be structural. Every other assertion compares a history
 * against the constants it is built from, so editing a prompt without bumping its version keeps
 * everything self-consistent: `history.get(n)` is recomputed from the edited text and still
 * matches. That is exactly the bug that shipped in `dataview`/`tasknotes` — new body, unchanged
 * version, so the version no longer identified a body and every install read as customized.
 *
 * WHEN THIS FAILS: you changed DEFAULT_AGENT_PROMPT (or one of its building blocks). Either bump
 * AGENT_PROMPT_VERSION and retain the old text as a new constant (see the doc in prompts.ts), or
 * — if the edit is genuinely cosmetic and no shipped build carries the old text — update the
 * literal below.
 */
const CURRENT_FINGERPRINT = "064765504106e6f9"; // DEFAULT_AGENT_PROMPT at v2

const history: ShippedHistory = SHIPPED_AGENT_PROMPTS;
const version = AGENT_PROMPT_VERSION;

describe("agent prompt shipped history", () => {
	it("registers the newest text under the current version", () => {
		expect(history.get(version)).toBe(fingerprint(DEFAULT_AGENT_PROMPT));
		expect(history.get(version)).toBe(CURRENT_FINGERPRINT);
	});

	/**
	 * The load-bearing one, and the exact shape of the `edit-notes` bug: bumping the version
	 * while leaving history holding only the new entry. Every version from 1 to the current
	 * one must be present, so an untouched copy of any of them still resolves.
	 */
	it("covers every version from 1 to the current one", () => {
		const missing = Array.from({ length: version }, (_, i) => i + 1).filter((v) => !history.has(v));

		expect(
			missing,
			`no retained body for version(s) ${missing.join(", ")} — bumping the version means keeping the text it replaced`,
		).toEqual([]);
	});

	it("is ordered oldest to newest, so the current version reads as current", () => {
		// currentShippedVersion trusts insertion order rather than sorting; an out-of-order
		// entry would silently make an older version look like the live one.
		expect(currentShippedVersion(history)).toBe(version);
		expect([...history.keys()]).toEqual([...history.keys()].sort((a, b) => Number(a) - Number(b)));
	});

	/**
	 * Two versions sharing a fingerprint means one of the retained constants was never
	 * actually updated (copy-paste), so the version it claims to represent has no real body
	 * in history — the same orphaning as a missing entry, just harder to see.
	 */
	it("has a distinct body per version", () => {
		expect(new Set(history.values()).size).toBe(history.size);
	});
});

/**
 * The combined default must actually contain the sections the rest of the system reasons about:
 * assembly substitutes both placeholders, and "delete the `# Memory` section to disable memory"
 * is the only way a user can turn memory off now that the toggle is gone.
 */
describe("default agent prompt composition", () => {
	it("carries every runtime placeholder", () => {
		expect(DEFAULT_AGENT_PROMPT).toContain("{{memoryFolder}}");
		expect(DEFAULT_AGENT_PROMPT).toContain("{{date}}");
		expect(DEFAULT_AGENT_PROMPT).toContain("{{memoryIndex}}");
	});

	// The v1 body is retained as a file rather than recomputed, so guard the one thing a stale
	// copy could get wrong: it must still fingerprint as v1 (see `history/agent-prompt-1.md`).
	it("retains the v1 body without its later placeholder", () => {
		expect(agentPrompt1).toContain("{{memoryFolder}}");
		expect(agentPrompt1).not.toContain("{{memoryIndex}}");
	});

	it("orders the sections base → date → memory", () => {
		const headings = DEFAULT_AGENT_PROMPT.split("\n").filter((line) => line.startsWith("# "));
		expect(headings).toEqual(["# Role", "# User Context", "# Tools", "# Formatting", "# Current Date", "# Memory"]);
	});
});
