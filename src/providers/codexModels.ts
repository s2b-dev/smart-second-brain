/**
 * The model catalogue ChatGPT sign-in (Codex) serves: `GET /backend-api/codex/models`.
 *
 * This is the list the Codex CLI itself loads (and caches as `~/.codex/models_cache.json`):
 * `{ models: [...] }`, one entry per model with `slug`, `display_name`, `context_window`,
 * `input_modalities`, `supported_reasoning_levels: [{ effort }]`, `visibility` ("list" for the
 * picker, "hide" for models kept for old sessions) and `supported_in_api`. The server filters
 * the list by the `client_version` query parameter, dropping models a client that old can't run.
 *
 * Cached at module level per provider instance, filled by model discovery and read
 * synchronously by hydration, like the other provider catalogues.
 */

/** One entry of the Codex models response (only the fields we read). */
export interface CodexModelEntry {
	slug?: unknown;
	display_name?: unknown;
	context_window?: unknown;
	input_modalities?: unknown;
	supported_reasoning_levels?: unknown;
	visibility?: unknown;
	supported_in_api?: unknown;
}

export interface CodexModelInfo {
	id: string;
	displayName?: string;
	contextWindow?: number;
	vision?: boolean;
	/** Reasoning efforts the model accepts; absent when not reported. */
	effortLevels?: string[];
}

/**
 * The `client_version` sent with the request. The server leaves out models whose
 * `minimal_client_version` is newer than this, so it tracks a Codex CLI release
 * (0.154.0, November 2026) rather than the plugin's own version.
 */
export const CODEX_MODELS_CLIENT_VERSION = "0.154.0";

const cachedModels = new Map<string, Map<string, CodexModelInfo>>();

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function effortLevels(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value
		.map((level) =>
			level && typeof level === "object" ? nonEmptyString((level as { effort?: unknown }).effort) : undefined,
		)
		.filter((effort): effort is string => effort !== undefined);
}

export function summarizeCodexModel(entry: CodexModelEntry & { slug: string }): CodexModelInfo {
	const modalities = Array.isArray(entry.input_modalities) ? entry.input_modalities : undefined;
	return {
		id: entry.slug,
		displayName: nonEmptyString(entry.display_name),
		contextWindow: positiveInt(entry.context_window),
		vision: modalities ? modalities.includes("image") : undefined,
		effortLevels: effortLevels(entry.supported_reasoning_levels),
	};
}

/**
 * Replace one provider instance's cached catalogue. Returns the ids to offer: models the
 * server marks for the picker and as usable over the API, sorted.
 */
export function populateCodexCache(providerId: string, entries: readonly CodexModelEntry[]): string[] {
	const models = new Map<string, CodexModelInfo>();
	const listed: string[] = [];
	for (const entry of entries) {
		const slug = nonEmptyString(entry.slug);
		if (!slug) continue;
		models.set(slug, summarizeCodexModel({ ...entry, slug }));
		if (entry.visibility !== "hide" && entry.supported_in_api !== false) listed.push(slug);
	}
	cachedModels.set(providerId, models);
	return listed.sort((a, b) => a.localeCompare(b));
}

/** Forget an instance's catalogue, e.g. once it lists models with an API key instead. */
export function clearCodexCache(providerId: string): void {
	cachedModels.delete(providerId);
}

/** What the Codex catalogue reported for a model, if discovery has run for that instance. */
export function getCodexModelInfo(providerId: string, modelId: string): CodexModelInfo | undefined {
	return cachedModels.get(providerId)?.get(modelId);
}
