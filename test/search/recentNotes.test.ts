import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRecentNotes: Array<{ path: string; lastOpenedAt: number }> = [];
let mockAgentFolder = "";

vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => ({ recentNotes: mockRecentNotes, agentFolder: mockAgentFolder }),
}));
import { installAgentPathSource } from "../../src/utils/agentPathSource";
installAgentPathSource({ agentFolder: () => mockAgentFolder, agentName: () => undefined });

import { type App, TFile } from "obsidian";
import { getRecentNoteBoost, getRecentNotes, MAX_RECENT_BOOST } from "../../src/search/recentNotes";
import { RECENT_NOTE_WINDOW_MS } from "../../src/types/plugin";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Minimal app whose vault resolves every requested path to a markdown file. */
function createApp(): App {
	return {
		vault: {
			getAbstractFileByPath(path: string) {
				const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
				return Object.assign(new TFile(), { path, extension: "md", basename });
			},
		},
		metadataCache: {
			getFileCache: () => undefined,
		},
	} as unknown as App;
}

/** Push notes most-recent-first, matching how `dataStore.recentNotes` is ordered. */
function setRecentNotes(entries: Array<{ path: string; ageMs: number }>): void {
	mockRecentNotes.length = 0;
	const now = Date.now();
	for (const entry of entries) {
		mockRecentNotes.push({ path: entry.path, lastOpenedAt: now - entry.ageMs });
	}
}

describe("getRecentNoteBoost", () => {
	it("gives full strength to notes opened within the plateau", () => {
		expect(getRecentNoteBoost(0)).toBe(MAX_RECENT_BOOST);
		expect(getRecentNoteBoost(HOUR)).toBe(MAX_RECENT_BOOST);
	});

	it("decays with age instead of holding a fixed value", () => {
		const oneDay = getRecentNoteBoost(DAY);
		const threeDays = getRecentNoteBoost(3 * DAY);
		const sixDays = getRecentNoteBoost(6 * DAY);

		expect(oneDay).toBeGreaterThan(threeDays);
		expect(threeDays).toBeGreaterThan(sixDays);
		expect(sixDays).toBeGreaterThan(0);
	});

	it("returns no boost at or beyond the window edge", () => {
		expect(getRecentNoteBoost(RECENT_NOTE_WINDOW_MS)).toBe(0);
		expect(getRecentNoteBoost(RECENT_NOTE_WINDOW_MS + 1)).toBe(0);
		expect(getRecentNoteBoost(365 * DAY)).toBe(0);
	});

	it("treats a future timestamp as freshly opened rather than stale", () => {
		// Guards against a clock adjustment producing a negative age.
		expect(getRecentNoteBoost(-HOUR)).toBe(MAX_RECENT_BOOST);
	});
});

describe("getRecentNotes", () => {
	beforeEach(() => {
		mockRecentNotes.length = 0;
		mockAgentFolder = "";
	});

	it("filters agent-machinery files even when they were recorded as opened", () => {
		// `file-open` records every file, including skill/prompt notes the user opened
		// from the agent editor. Those are excluded from search, so recency must not
		// resurface them.
		mockAgentFolder = "Agents";
		setRecentNotes([
			{ path: "Agents/Skills/web/SKILL.md", ageMs: HOUR },
			{ path: "Notes/fresh.md", ageMs: 2 * HOUR },
		]);

		const paths = getRecentNotes(createApp()).map((result) => result.path);

		expect(paths).toEqual(["Notes/fresh.md"]);
	});

	it("excludes notes opened outside the window", () => {
		setRecentNotes([
			{ path: "Notes/fresh.md", ageMs: 2 * HOUR },
			{ path: "Notes/stale.md", ageMs: 30 * DAY },
		]);

		const paths = getRecentNotes(createApp()).map((result) => result.path);

		expect(paths).toContain("Notes/fresh.md");
		expect(paths).not.toContain("Notes/stale.md");
	});

	it("keeps an older-but-in-window note that many newer notes precede", () => {
		// The regression this change targets: with a rank-decayed boost, a busy day
		// pushed the morning's note far enough down the list that it lost its boost
		// (and, past the storage cap, vanished). Age is what should decide.
		const entries = Array.from({ length: 40 }, (_, index) => ({
			path: `Notes/burst-${index}.md`,
			ageMs: HOUR,
		}));
		entries.push({ path: "Notes/this-morning.md", ageMs: 8 * HOUR });
		setRecentNotes(entries);

		const morning = getRecentNotes(createApp()).find((result) => result.path === "Notes/this-morning.md");

		expect(morning).toBeDefined();
		expect(morning?.score).toBe(MAX_RECENT_BOOST);
	});

	it("ranks a note opened an hour ago above one opened five days ago", () => {
		setRecentNotes([
			{ path: "Notes/five-days.md", ageMs: 5 * DAY },
			{ path: "Notes/an-hour.md", ageMs: HOUR },
		]);

		const results = getRecentNotes(createApp());

		// Sorted by score, so the fresher note leads despite being listed second.
		expect(results[0]?.path).toBe("Notes/an-hour.md");
		expect(results[1]?.path).toBe("Notes/five-days.md");
		expect(results[0]?.score ?? 0).toBeGreaterThan(results[1]?.score ?? 0);
	});

	it("scores two notes opened at the same time equally, regardless of list order", () => {
		setRecentNotes([
			{ path: "Notes/first.md", ageMs: 3 * HOUR },
			{ path: "Notes/second.md", ageMs: 3 * HOUR },
		]);

		const results = getRecentNotes(createApp());

		expect(results).toHaveLength(2);
		expect(results[0]?.score).toBe(results[1]?.score);
	});
});
