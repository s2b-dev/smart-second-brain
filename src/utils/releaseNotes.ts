/**
 * Release notes bundled from the repo's CHANGELOG.md, and the rule for which of
 * them to announce after an update. Pure: the plugin supplies the stored
 * last-seen version and the running manifest version.
 */
import { compareVersions, isPrerelease } from "./version";

export interface ReleaseNotesSection {
	version: string;
	/** Release day as `YYYY-MM-DD`, from `## X.Y.Z (YYYY-MM-DD)`; absent until it is known. */
	date?: string;
	/** Markdown body under the `## X.Y.Z` heading, trimmed. */
	body: string;
}

const REPO_URL = "https://github.com/s2b-dev/smart-second-brain";
export const RELEASES_URL = `${REPO_URL}/releases`;

const VERSION_HEADING = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?: \((\d{4}-\d{2}-\d{2})\))?\s*$/;

/** Split a changelog into its `## X.Y.Z (YYYY-MM-DD)` sections, in file order (newest first). */
export function parseChangelog(markdown: string): ReleaseNotesSection[] {
	const sections: ReleaseNotesSection[] = [];
	let current: { version: string; date?: string; lines: string[] } | null = null;
	const flush = () => {
		if (!current) return;
		const section: ReleaseNotesSection = { version: current.version, body: current.lines.join("\n").trim() };
		if (current.date) section.date = current.date;
		sections.push(section);
	};
	for (const line of markdown.split(/\r?\n/)) {
		const match = VERSION_HEADING.exec(line);
		if (match) {
			flush();
			current = { version: match[1], date: match[2], lines: [] };
		} else if (current) {
			current.lines.push(line);
		}
	}
	flush();
	return sections;
}

export interface UpdateAnnouncement {
	/** Sections to show, newest first. Empty means stay quiet. */
	sections: ReleaseNotesSection[];
	/** Version to store as last seen, or null to leave the stored value alone. */
	record: string | null;
}

/**
 * Decide what to announce on load.
 *
 * - Pre-release builds announce nothing and record nothing, so a beta tester
 *   still gets the stable notes when the release lands.
 * - An unknown last-seen version (data from before this feature) announces
 *   only the running version's section.
 * - Otherwise every section newer than last-seen, up to the running version,
 *   so skipped releases roll up.
 * - A downgrade is recorded silently.
 */
export function planUpdateAnnouncement(
	lastSeen: string | null,
	current: string,
	sections: ReleaseNotesSection[],
): UpdateAnnouncement {
	if (isPrerelease(current) || lastSeen === current) return { sections: [], record: null };
	if (lastSeen !== null && compareVersions(current, lastSeen) < 0) return { sections: [], record: current };
	const due = sections.filter((section) =>
		lastSeen === null
			? section.version === current
			: compareVersions(section.version, lastSeen) > 0 && compareVersions(section.version, current) <= 0,
	);
	return { sections: due, record: current };
}

/**
 * Turn `#123` references into links; GitHub redirects issue URLs to PRs. Code is
 * left verbatim: fenced blocks and inline code spans are skipped.
 */
export function linkifyReferences(markdown: string): string {
	let inFence = false;
	return markdown
		.split("\n")
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence;
				return line;
			}
			if (inFence) return line;
			// Odd-indexed parts are inline code spans (the capture group keeps them).
			return line
				.split(/(`+[^`]*`+)/)
				.map((part, index) => (index % 2 === 1 ? part : linkifyText(part)))
				.join("");
		})
		.join("\n");
}

function linkifyText(text: string): string {
	return text.replace(/(^|[\s(,])#(\d+)\b/g, (_, before: string, n: string) => {
		return `${before}[#${n}](${REPO_URL}/issues/${n})`;
	});
}
