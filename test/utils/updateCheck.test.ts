import { describe, expect, it } from "vitest";
import {
	UPDATE_CHECK_INTERVAL_MS,
	isUpdateCheckDue,
	parseRemoteManifest,
	updateToAnnounce,
} from "../../src/utils/updateCheck";
import { compareVersions } from "../../src/utils/version";

describe("compareVersions", () => {
	it("orders cores numerically and pre-releases before their release", () => {
		expect(compareVersions("2.10.0", "2.9.9")).toBe(1);
		expect(compareVersions("2.3.0-beta.9", "2.3.0")).toBe(-1);
		expect(compareVersions("2.3.0-beta.10", "2.3.0-beta.9")).toBe(1);
		expect(compareVersions("2.3.0-beta.1", "2.3.0-beta.1.1")).toBe(-1);
		expect(compareVersions("2.2.0", "2.2.0")).toBe(0);
	});
});

describe("isUpdateCheckDue", () => {
	const now = 1_000_000_000_000;
	it("runs when never checked, once a day, and after a clock jump backwards", () => {
		expect(isUpdateCheckDue(now, null)).toBe(true);
		expect(isUpdateCheckDue(now, now - UPDATE_CHECK_INTERVAL_MS + 1)).toBe(false);
		expect(isUpdateCheckDue(now, now - UPDATE_CHECK_INTERVAL_MS)).toBe(true);
		expect(isUpdateCheckDue(now, now + 60_000)).toBe(true);
	});
});

describe("parseRemoteManifest", () => {
	it("reads version and minAppVersion, rejecting anything else", () => {
		expect(parseRemoteManifest({ id: "x", version: "2.3.0", minAppVersion: "1.12.0" })).toEqual({
			version: "2.3.0",
			minAppVersion: "1.12.0",
		});
		expect(parseRemoteManifest({ version: "2.3.0" })).toEqual({ version: "2.3.0" });
		expect(parseRemoteManifest({ version: "latest" })).toBeNull();
		expect(parseRemoteManifest("404: Not Found")).toBeNull();
		expect(parseRemoteManifest(null)).toBeNull();
	});
});

describe("updateToAnnounce", () => {
	const remote = { version: "2.3.0", minAppVersion: "1.11.4" };

	it("announces a newer stable version once", () => {
		expect(updateToAnnounce("2.2.0", "1.12.0", remote, null)).toBe("2.3.0");
		expect(updateToAnnounce("2.2.0", "1.12.0", remote, "2.3.0")).toBeNull();
		expect(updateToAnnounce("2.2.0", "1.12.0", { version: "2.3.1" }, "2.3.0")).toBe("2.3.1");
	});

	it("stays quiet when up to date or ahead", () => {
		expect(updateToAnnounce("2.3.0", "1.12.0", remote, null)).toBeNull();
		expect(updateToAnnounce("2.4.0", "1.12.0", remote, null)).toBeNull();
	});

	it("skips a version the running Obsidian cannot install", () => {
		expect(updateToAnnounce("2.2.0", "1.11.0", remote, null)).toBeNull();
	});

	it("never announces on a pre-release build", () => {
		expect(updateToAnnounce("2.3.0-beta.9", "1.12.0", { version: "2.3.0" }, null)).toBeNull();
	});
});
