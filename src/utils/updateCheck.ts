/**
 * "A new version is available" check. Pure: the plugin supplies the fetched
 * manifest, the running versions and the stored check state.
 *
 * The source is the plugin's `manifest.json` on the default branch — the same
 * file Obsidian's own update check reads — so the notice fires exactly when
 * Obsidian would offer the update. Nothing about the user or the vault is sent.
 */
import { Logger } from "./logging";
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

/** What {@link runUpdateCheck} reads and does, injected so the flow is testable. */
export interface UpdateCheckDeps {
	/** The user's "Check for updates" setting, read live (it can flip mid-request). */
	isEnabled(): boolean;
	/** Obsidian's own automatic plugin-update check is on, so this one steps aside. */
	obsidianChecksUpdates(): boolean;
	/** False once the plugin has unloaded; a late response must not act. */
	isActive(): boolean;
	now(): number;
	currentVersion: string;
	appVersion: string;
	getLastCheckAt(): number | null;
	setLastCheckAt(at: number): void;
	getLastNotified(): string | null;
	setLastNotified(version: string): void;
	/** Parsed JSON of the remote manifest, or null on a non-200; may throw offline. */
	fetchManifest(): Promise<unknown>;
	notify(version: string): void;
}

/**
 * One run of the update check: gate, fetch (recording the attempt first, so a
 * failure also waits a day), and announce at most once per version. Returns the
 * announced version, or null. Never throws: offline is normal.
 */
export async function runUpdateCheck(deps: UpdateCheckDeps): Promise<string | null> {
	if (!deps.isEnabled() || deps.obsidianChecksUpdates()) return null;
	if (!isUpdateCheckDue(deps.now(), deps.getLastCheckAt())) return null;
	deps.setLastCheckAt(deps.now());
	let remote: RemoteManifest | null;
	try {
		remote = parseRemoteManifest(await deps.fetchManifest());
	} catch (error) {
		Logger.debug("[UpdateCheck] Could not reach GitHub; next attempt in a day:", error);
		return null;
	}
	if (!remote || !deps.isActive() || !deps.isEnabled()) return null;
	const version = updateToAnnounce(deps.currentVersion, deps.appVersion, remote, deps.getLastNotified());
	if (!version) return null;
	deps.setLastNotified(version);
	deps.notify(version);
	return version;
}
