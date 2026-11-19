import { describe, expect, it } from "vitest";
import changelog from "../../CHANGELOG.md?raw";
import manifest from "../../manifest.json";
import { linkifyReferences, parseChangelog, planUpdateAnnouncement } from "../../src/utils/releaseNotes";
import { compareVersions, isPrerelease } from "../../src/utils/version";

const SAMPLE = `# Changelog

Intro text that belongs to no version.

## 2.3.0 (2026-10-01)

Big release.

### Chat
- Thing (#12).

## 2.2.0

Widgets.

## 2.1.2

Fix.
`;

const sections = parseChangelog(SAMPLE);
const versions = (lastSeen: string | null, current: string) =>
	planUpdateAnnouncement(lastSeen, current, sections).sections.map((s) => s.version);

describe("parseChangelog", () => {
	it("splits on version headings and ignores the preamble", () => {
		expect(sections.map((s) => s.version)).toEqual(["2.3.0", "2.2.0", "2.1.2"]);
		expect(sections[0].body).toBe("Big release.\n\n### Chat\n- Thing (#12).");
		expect(sections[0].date).toBe("2026-10-01");
		expect(sections[1].date).toBeUndefined();
	});

	it("parses the bundled CHANGELOG.md, newest first, with a section for the manifest version", () => {
		const bundled = parseChangelog(changelog);
		expect(bundled.length).toBeGreaterThan(0);
		for (const section of bundled) expect(section.body).not.toBe("");
		const ordered = [...bundled].sort((a, b) => compareVersions(b.version, a.version));
		expect(bundled.map((s) => s.version)).toEqual(ordered.map((s) => s.version));
		if (!isPrerelease(manifest.version)) {
			expect(bundled.map((s) => s.version)).toContain(manifest.version);
		}
	});
});

describe("compareVersions", () => {
	it("orders cores numerically and pre-releases before their release", () => {
		expect(compareVersions("2.10.0", "2.9.9")).toBe(1);
		expect(compareVersions("2.3.0-beta.9", "2.3.0")).toBe(-1);
		expect(compareVersions("2.3.0-beta.10", "2.3.0-beta.9")).toBe(1);
		expect(compareVersions("2.3.0-beta.1", "2.3.0-beta.1.1")).toBe(-1);
		expect(compareVersions("2.2.0", "2.2.0")).toBe(0);
	});
});

describe("planUpdateAnnouncement", () => {
	it("rolls up every skipped release", () => {
		expect(versions("2.1.2", "2.3.0")).toEqual(["2.3.0", "2.2.0"]);
		expect(planUpdateAnnouncement("2.1.2", "2.3.0", sections).record).toBe("2.3.0");
	});

	it("shows only the running version when the last-seen version is unknown", () => {
		expect(versions(null, "2.3.0")).toEqual(["2.3.0"]);
	});

	it("stays quiet and records nothing on a pre-release", () => {
		expect(planUpdateAnnouncement("2.2.0", "2.3.0-beta.9", sections)).toEqual({ sections: [], record: null });
	});

	it("gives a beta tester the stable notes when the release lands", () => {
		expect(versions("2.3.0-beta.9", "2.3.0")).toEqual(["2.3.0"]);
	});

	it("does nothing when unchanged and records a downgrade silently", () => {
		expect(planUpdateAnnouncement("2.3.0", "2.3.0", sections)).toEqual({ sections: [], record: null });
		expect(planUpdateAnnouncement("2.3.0", "2.2.0", sections)).toEqual({ sections: [], record: "2.2.0" });
	});

	it("records a version without notes but announces nothing", () => {
		expect(planUpdateAnnouncement("2.3.0", "2.3.1", sections)).toEqual({ sections: [], record: "2.3.1" });
	});
});

describe("linkifyReferences", () => {
	it("links issue and PR references but not headings or anchors", () => {
		expect(linkifyReferences("Fixed (#503), fixes #478, #481.")).toBe(
			"Fixed ([#503](https://github.com/s2b-dev/smart-second-brain/issues/503)), fixes [#478](https://github.com/s2b-dev/smart-second-brain/issues/478), [#481](https://github.com/s2b-dev/smart-second-brain/issues/481).",
		);
		expect(linkifyReferences("### Chat\nsee url#12")).toBe("### Chat\nsee url#12");
	});

	it("leaves code spans and fenced blocks untouched", () => {
		const code = "Run `gh pr view #12` then:\n```\ngh pr checkout #12\n```\nDone (#7).";
		expect(linkifyReferences(code)).toBe(
			"Run `gh pr view #12` then:\n```\ngh pr checkout #12\n```\nDone ([#7](https://github.com/s2b-dev/smart-second-brain/issues/7)).",
		);
	});
});
