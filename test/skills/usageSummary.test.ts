/**
 * The origin-and-usage line under a custom skill in the Agent editor. Its wording is the
 * only place a user sees what the counters mean, so it is pinned here.
 */

import { describe, expect, it } from "vitest";

import { describeAge, skillUsageSummary } from "../../src/skills/usageSummary";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("describeAge", () => {
	it("rounds to the coarsest unit that reads naturally", () => {
		expect(describeAge(NOW - 5_000, NOW)).toBe("just now");
		expect(describeAge(NOW - 3 * 60_000, NOW)).toBe("3 min ago");
		expect(describeAge(NOW - 60 * 60_000, NOW)).toBe("1 hour ago");
		expect(describeAge(NOW - DAY, NOW)).toBe("yesterday");
		expect(describeAge(NOW - 12 * DAY, NOW)).toBe("12 days ago");
		expect(describeAge(NOW - 45 * DAY, NOW)).toBe("2 months ago");
		expect(describeAge(NOW - 400 * DAY, NOW)).toBe("1 year ago");
	});
});

describe("skillUsageSummary", () => {
	it("names the origin from the author key", () => {
		expect(skillUsageSummary("agent", undefined, NOW)).toBe("Created by the agent · never used");
		expect(skillUsageSummary(undefined, undefined, NOW)).toBe("Your skill · never used");
		expect(skillUsageSummary("Leo", undefined, NOW)).toBe("Author: Leo · never used");
	});

	it("reads counts and ages in words", () => {
		const usage = { loadCount: 3, lastLoadedAt: NOW - 2 * DAY, revisionCount: 1, lastRevisedAt: NOW - 60_000 };
		expect(skillUsageSummary("agent", usage, NOW)).toBe(
			"Created by the agent · used 3 times, last 2 days ago · revised once (last 1 min ago)",
		);
	});

	it("omits the revision part when nothing was revised", () => {
		const usage = { loadCount: 1, lastLoadedAt: NOW, revisionCount: 0, lastRevisedAt: null };
		expect(skillUsageSummary(undefined, usage, NOW)).toBe("Your skill · used once, last just now");
	});
});
