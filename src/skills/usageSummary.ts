/**
 * The one-line origin-and-usage summary shown under a skill in the Agent editor, e.g.
 * "Created by the agent · used 3 times, last 2 days ago · revised once". Pure, so the
 * wording is unit-tested rather than eyeballed.
 */

import type { SkillUsageEntry } from "../types/plugin";

const AGENT_AUTHOR = "agent";

/** Coarse relative age: the editor row is a glance, not a log. */
export function describeAge(timestamp: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
	const months = Math.round(days / 30);
	if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;
	const years = Math.round(days / 365);
	return years === 1 ? "1 year ago" : `${years} years ago`;
}

function times(count: number): string {
	return count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
}

/**
 * Summarize where a custom skill came from and how it has been used. `author` is the
 * frontmatter `metadata.author`; `usage` the plugin-data counters, absent when the skill was
 * never loaded or revised.
 */
export function skillUsageSummary(
	author: string | undefined,
	usage: SkillUsageEntry | undefined,
	now = Date.now(),
): string {
	const origin = author === AGENT_AUTHOR ? "Created by the agent" : author ? `Author: ${author}` : "Your skill";

	const parts = [origin];
	if (!usage || usage.loadCount === 0) {
		parts.push("never used");
	} else {
		const last = usage.lastLoadedAt === null ? "" : `, last ${describeAge(usage.lastLoadedAt, now)}`;
		parts.push(`used ${times(usage.loadCount)}${last}`);
	}
	if (usage && usage.revisionCount > 0) {
		const last = usage.lastRevisedAt === null ? "" : ` (last ${describeAge(usage.lastRevisedAt, now)})`;
		parts.push(`revised ${times(usage.revisionCount)}${last}`);
	}
	return parts.join(" · ");
}
