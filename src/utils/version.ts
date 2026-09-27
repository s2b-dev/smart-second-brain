/** Version helpers for the `X.Y.Z` / `X.Y.Z-pre` versions this plugin ships. */

export function isPrerelease(version: string): boolean {
	return version.includes("-");
}

/**
 * Semver order. A pre-release sorts before its release; two pre-releases of
 * the same core compare by their dot-separated identifiers (numeric ones
 * numerically).
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
