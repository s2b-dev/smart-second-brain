import { describe, expect, it, vi } from "vitest";
import {
	UPDATE_CHECK_INTERVAL_MS,
	type UpdateCheckDeps,
	isUpdateCheckDue,
	parseRemoteManifest,
	runUpdateCheck,
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

describe("runUpdateCheck", () => {
	const DAY = UPDATE_CHECK_INTERVAL_MS;

	function setup(overrides: Partial<UpdateCheckDeps> = {}) {
		const state = { lastCheckAt: null as number | null, lastNotified: null as string | null, clock: 10 * DAY };
		const notify = vi.fn();
		const fetchManifest = vi.fn(async (): Promise<unknown> => ({ version: "2.3.0", minAppVersion: "1.11.4" }));
		const deps: UpdateCheckDeps = {
			isEnabled: () => true,
			obsidianChecksUpdates: () => false,
			isActive: () => true,
			now: () => state.clock,
			currentVersion: "2.2.0",
			appVersion: "1.14.2",
			getLastCheckAt: () => state.lastCheckAt,
			setLastCheckAt: (at) => {
				state.lastCheckAt = at;
			},
			getLastNotified: () => state.lastNotified,
			setLastNotified: (version) => {
				state.lastNotified = version;
			},
			fetchManifest,
			notify,
			...overrides,
		};
		return { deps, state, notify, fetchManifest };
	}

	it("announces a newer version once, and fetches at most daily", async () => {
		const { deps, state, notify, fetchManifest } = setup();
		expect(await runUpdateCheck(deps)).toBe("2.3.0");
		expect(notify).toHaveBeenCalledWith("2.3.0");
		expect(state).toMatchObject({ lastCheckAt: 10 * DAY, lastNotified: "2.3.0" });

		state.clock += DAY / 2;
		expect(await runUpdateCheck(deps)).toBeNull();
		expect(fetchManifest).toHaveBeenCalledTimes(1);

		state.clock += DAY;
		expect(await runUpdateCheck(deps)).toBeNull();
		expect(fetchManifest).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("makes no request when turned off or while Obsidian checks for updates itself", async () => {
		for (const overrides of [{ isEnabled: () => false }, { obsidianChecksUpdates: () => true }]) {
			const { deps, state, fetchManifest } = setup(overrides);
			expect(await runUpdateCheck(deps)).toBeNull();
			expect(fetchManifest).not.toHaveBeenCalled();
			expect(state.lastCheckAt).toBeNull();
		}
	});

	it("stays quiet if the plugin unloads during the request", async () => {
		let active = true;
		const { deps, notify, state } = setup({
			isActive: () => active,
			fetchManifest: async () => {
				active = false;
				return { version: "2.3.0" };
			},
		});
		expect(await runUpdateCheck(deps)).toBeNull();
		expect(notify).not.toHaveBeenCalled();
		expect(state.lastNotified).toBeNull();
	});

	it("stays quiet if the user turns it off during the request", async () => {
		let enabled = true;
		const { deps, notify } = setup({
			isEnabled: () => enabled,
			fetchManifest: async () => {
				enabled = false;
				return { version: "2.3.0" };
			},
		});
		expect(await runUpdateCheck(deps)).toBeNull();
		expect(notify).not.toHaveBeenCalled();
	});

	it("records the attempt but never throws when offline or the response is not a manifest", async () => {
		for (const fetchManifest of [
			async () => {
				throw new Error("offline");
			},
			async () => null,
		]) {
			const { deps, state, notify } = setup({ fetchManifest });
			await expect(runUpdateCheck(deps)).resolves.toBeNull();
			expect(state.lastCheckAt).toBe(10 * DAY);
			expect(notify).not.toHaveBeenCalled();
		}
	});
});
