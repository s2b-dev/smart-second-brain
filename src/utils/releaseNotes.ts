/**
 * Release notes bundled from the repo's CHANGELOG.md, and the rule for which of
 * them to announce after an update. Pure: the plugin supplies the stored
 * last-seen version and the running manifest version.
 */

export interface ReleaseNotesSection {
	version: string;
	/** Markdown body under the `## X.Y.Z` heading, trimmed. */
	body: string;
}

const REPO_URL = "https://github.com/s2b-dev/smart-second-brain";
export const RELEASES_URL = `${REPO_URL}/releases`;

const VERSION_HEADING = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/;

/** Split a changelog into its `## X.Y.Z` sections, in file order (newest first). */
export function parseChangelog(markdown: string): ReleaseNotesSection[] {
	const sections: ReleaseNotesSection[] = [];
	let current: { version: string; lines: string[] } | null = null;
	const flush = () => {
		if (current) sections.push({ version: current.version, body: current.lines.join("\n").trim() });
	};
	for (const line of markdown.split(/\r?\n/)) {
		const match = VERSION_HEADING.exec(line);
		if (match) {
			flush();
			current = { version: match[1], lines: [] };
		} else if (current) {
			current.lines.push(line);
		}
	}
	flush();
	return sections;
}

export function isPrerelease(version: string): boolean {
	return version.includes("-");
}

/**
 * Semver order for the `X.Y.Z` / `X.Y.Z-pre` versions this plugin ships. A
 * pre-release sorts before its release; two pre-releases of the same core
 * compare by their dot-separated identifiers (numeric ones numerically).
 */
export function compareVersions(a: string, b: string): number {
	const [coreA, preA] = splitVersion(a);
	const [coreB, preB] = splitVersion(b);
	for (let i = 0; i < 3; i++) {
		const diff = (coreA[i] ?? 0) - (coreB[i] ?? 0);
		if (diff !== 0) return Math.sign(diff);
	}
	if (preA === preB) return 0;
	if (preA === null) return 1;
	if (preB === null) return -1;
	const idsA = preA.split(".");
	const idsB = preB.split(".");
	for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
		if (idsA[i] === undefined) return -1;
		if (idsB[i] === undefined) return 1;
		const numA = /^\d+$/.test(idsA[i]) ? Number(idsA[i]) : null;
		const numB = /^\d+$/.test(idsB[i]) ? Number(idsB[i]) : null;
		if (numA !== null && numB !== null) {
			if (numA !== numB) return Math.sign(numA - numB);
		} else if (idsA[i] !== idsB[i]) {
			return idsA[i] < idsB[i] ? -1 : 1;
		}
	}
	return 0;
}

function splitVersion(version: string): [number[], string | null] {
	const dash = version.indexOf("-");
	const core = dash === -1 ? version : version.slice(0, dash);
	return [core.split(".").map((n) => Number.parseInt(n, 10) || 0), dash === -1 ? null : version.slice(dash + 1)];
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

/** Turn `#123` references into links; GitHub redirects issue URLs to PRs. */
export function linkifyReferences(markdown: string): string {
	return markdown.replace(/(^|[\s(,])#(\d+)\b/g, (_, before: string, n: string) => {
		return `${before}[#${n}](${REPO_URL}/issues/${n})`;
	});
}
