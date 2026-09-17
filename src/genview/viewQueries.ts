/**
 * Runs a view's declared queries on the host and turns the results into plain JSON
 * the frame can consume. The frame never sees the vault, Dataview, or `app`: it gets
 * exactly what these queries return, as structured-clone-safe data.
 *
 * Queries are Dataview DQL, run through the plugin's public `api.query`. Dataview
 * values (Link objects, luxon DateTime/Duration, DataArray proxies) are flattened
 * here because none of them survive `postMessage`.
 */

import type { App } from "obsidian";
import { resolvePluginApi } from "../agent/integrations/pluginIntegrations";

export type ViewQueryResult =
	| { type: "table"; headers: string[]; rows: unknown[][] }
	| { type: "list"; items: unknown[] }
	| { type: "task"; items: unknown[] }
	| { type: "calendar"; items: unknown[] }
	| { error: string };

export type ViewQueryResults = Record<string, ViewQueryResult>;

interface DataviewQueryApi {
	query(source: string, originFile?: string): Promise<{ successful: boolean; value?: unknown; error?: string }>;
}

export const DATAVIEW_PLUGIN_ID = "dataview";
export const DATAVIEW_MISSING_ERROR = "The Dataview plugin is not enabled, so this view's queries cannot run.";

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 1000;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 10_000;

/** Run every query in `queries`; a failed query yields `{ error }` rather than failing the set. */
export async function runViewQueries(
	app: App,
	queries: Record<string, string>,
	sourcePath: string,
): Promise<ViewQueryResults> {
	const names = Object.keys(queries);
	const results: ViewQueryResults = {};
	if (names.length === 0) return results;

	const api = resolvePluginApi(app, DATAVIEW_PLUGIN_ID) as DataviewQueryApi | null;
	if (!api || typeof api.query !== "function") {
		for (const name of names) results[name] = { error: DATAVIEW_MISSING_ERROR };
		return results;
	}

	for (const name of names) {
		try {
			const result = await api.query(queries[name], sourcePath);
			results[name] = result.successful
				? toViewResult(result.value)
				: { error: result.error?.trim() || "Query failed." };
		} catch (error) {
			results[name] = { error: error instanceof Error ? error.message : String(error) };
		}
	}
	return results;
}

function toViewResult(value: unknown): ViewQueryResult {
	if (typeof value !== "object" || value === null) return { error: "Query returned no result." };
	const result = value as { type?: unknown; headers?: unknown; values?: unknown };
	switch (result.type) {
		case "table":
			return {
				type: "table",
				headers: Array.isArray(result.headers) ? result.headers.map(String) : [],
				rows: (serializeDataviewValue(result.values) as unknown[][] | null) ?? [],
			};
		case "list":
		case "task":
		case "calendar":
			return { type: result.type, items: (serializeDataviewValue(result.values) as unknown[] | null) ?? [] };
		default:
			return { error: `Unsupported query result type: ${String(result.type)}` };
	}
}

/**
 * Flatten a Dataview value into JSON: Links → `{ path, display, subpath }`, luxon
 * DateTime/Duration → ISO strings, DataArrays → arrays. Depth and size are capped so a
 * pathological result can't stall the UI or exceed what `postMessage` can carry.
 */
export function serializeDataviewValue(value: unknown, depth = 0): unknown {
	if (value === null || value === undefined) return null;
	switch (typeof value) {
		case "string":
			return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
		case "number":
			return Number.isFinite(value) ? value : null;
		case "boolean":
			return value;
		case "bigint":
			return value.toString();
		case "function":
		case "symbol":
			return null;
	}
	if (depth >= MAX_DEPTH) return null;

	if (value instanceof Date) return value.toISOString();
	const record = value as Record<string, unknown>;

	if (record.isLuxonDateTime === true || record.isLuxonDuration === true) {
		const iso = typeof record.toISO === "function" ? (record.toISO as () => unknown)() : null;
		return typeof iso === "string" ? iso : null;
	}
	if (isDataviewLink(record)) {
		return {
			path: record.path,
			display: typeof record.display === "string" && record.display ? record.display : basenameOf(record.path),
			subpath: typeof record.subpath === "string" ? record.subpath : null,
		};
	}
	if (typeof record.array === "function" && typeof record.length === "number") {
		// Dataview's DataArray proxy: unwrap to a plain array first.
		return serializeDataviewValue((record.array as () => unknown[])(), depth);
	}
	if (Array.isArray(value)) {
		return value.slice(0, MAX_ARRAY_ITEMS).map((item) => serializeDataviewValue(item, depth + 1));
	}
	if (value instanceof Map) {
		return serializeDataviewValue(Object.fromEntries(value), depth);
	}
	if (value instanceof Set) {
		return serializeDataviewValue([...value], depth);
	}

	const out: Record<string, unknown> = {};
	let keys = 0;
	for (const key of Object.keys(record)) {
		if (typeof record[key] === "function") continue;
		if (keys++ >= MAX_OBJECT_KEYS) break;
		out[key] = serializeDataviewValue(record[key], depth + 1);
	}
	return out;
}

function isDataviewLink(record: Record<string, unknown>): record is Record<string, unknown> & { path: string } {
	return typeof record.path === "string" && "subpath" in record && "embed" in record;
}

function basenameOf(path: string): string {
	const last = path.split("/").pop() ?? path;
	return last.replace(/\.md$/i, "");
}
