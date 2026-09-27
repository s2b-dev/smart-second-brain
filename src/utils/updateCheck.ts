/**
 * "A new version is available" check. Pure: the plugin supplies the fetched
 * manifest, the running versions and the stored check state.
 *
 * The source is the plugin's `manifest.json` on the default branch — the same
 * file Obsidian's own update check reads — so the notice fires exactly when
 * Obsidian would offer the update. Nothing about the user or the vault is sent.
 */
import { compareVersions, isPrerelease } from "./version";

export const UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/s2b-dev/smart-second-brain/HEAD/manifest.json";
/** This plugin's page in the community plugin browser; fallback when app.setting is unavailable. */
export const COMMUNITY_PLUGIN_URL = "obsidian://show-plugin?id=smart-second-brain";

/** At most one request a day, however often Obsidian starts. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RemoteManifest {
	version: string;
	minAppVersion?: string;
}

export function isUpdateCheckDue(now: number, lastCheckAt: number | null): boolean {
	return lastCheckAt === null || now - lastCheckAt >= UPDATE_CHECK_INTERVAL_MS || now < lastCheckAt;
}

/** Read `version`/`minAppVersion` from a fetched manifest, or null if it isn't one. */
export function parseRemoteManifest(json: unknown): RemoteManifest | null {
	if (typeof json !== "object" || json === null) return null;
	const { version, minAppVersion } = json as Record<string, unknown>;
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) return null;
	return typeof minAppVersion === "string" ? { version, minAppVersion } : { version };
}

/**
 * The version to announce, or null to stay quiet.
 *
 * - A pre-release build never announces: BRAT delivers its updates.
 * - Only a newer stable version the running Obsidian can install counts;
 *   Obsidian wouldn't offer one whose `minAppVersion` it doesn't meet.
 * - Each version is announced once (`lastNotified`).
 */
export function updateToAnnounce(
	current: string,
	appVersion: string,
	remote: RemoteManifest,
	lastNotified: string | null,
): string | null {
	if (isPrerelease(current) || isPrerelease(remote.version)) return null;
	if (compareVersions(remote.version, current) <= 0) return null;
	if (remote.minAppVersion && compareVersions(appVersion, remote.minAppVersion) < 0) return null;
	if (lastNotified !== null && compareVersions(remote.version, lastNotified) <= 0) return null;
	return remote.version;
}
