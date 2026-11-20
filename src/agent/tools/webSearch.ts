import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createObsidianFetch } from "../../lib/obsidianFetch";
import { getData } from "../../stores/dataStore.svelte";
import { Logger } from "../../utils/logging";
import { toError } from "../../utils/toError";
import { resolveToolAgent } from "./toolAgentContext";
import { t } from "../../i18n";

const DEFAULT_MAX_RESULTS = 10;
const MIN_MAX_RESULTS = 1;
const MAX_MAX_RESULTS = 20;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Run a request against a wall-clock deadline, aborting its signal when the
 * deadline passes. The race is still necessary because createObsidianFetch may
 * fall back to Obsidian's requestUrl, which ignores AbortSignal.
 */
function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
	const controller = new AbortController();
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			const err = new Error(`Web search timed out after ${timeoutMs}ms.`);
			err.name = "TimeoutError";
			controller.abort();
			reject(err);
		}, timeoutMs);
		run(controller.signal).then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				window.clearTimeout(timer);
				reject(toError(error));
			},
		);
	});
}

/** Clamp a raw settings value into [MIN_MAX_RESULTS, MAX_MAX_RESULTS], defaulting on garbage. */
function clampMaxResults(raw: unknown): number {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n)) return DEFAULT_MAX_RESULTS;
	return Math.min(MAX_MAX_RESULTS, Math.max(MIN_MAX_RESULTS, Math.floor(n)));
}

export interface WebSearchResult {
	rank: number;
	title: string;
	url: string;
	snippet: string;
}

interface WebSearchPayload {
	query: string;
	provider: string;
	totalResults: number;
	results: WebSearchResult[];
	message?: string;
}

// ============================================================================
// Provider table
// ============================================================================

export interface WebSearchProviderInfo {
	id: string;
	label: string;
	/** Works without an API key; a key only raises rate limits. */
	keyless: boolean;
	/** Help text for the API key setting. */
	keyHelp: string;
}

/** Every web search provider, in settings-dropdown order. Read by the tool and ToolConfigForm. */
export const WEB_SEARCH_PROVIDERS: readonly WebSearchProviderInfo[] = [
	{
		id: "firecrawl",
		label: t("plugin.web_search.keyless_label", { provider: "Firecrawl" }),
		keyless: true,
		keyHelp: t("plugin.web_search.firecrawl_key_help"),
	},
	{ id: "brave", label: "Brave Search", keyless: false, keyHelp: t("plugin.web_search.brave_key_help") },
	{ id: "tavily", label: "Tavily", keyless: false, keyHelp: t("plugin.web_search.tavily_key_help") },
	{
		id: "keenable",
		label: t("plugin.web_search.keyless_label", { provider: "Keenable" }),
		keyless: true,
		keyHelp: t("plugin.web_search.keenable_key_help"),
	},
];

export function getWebSearchProvider(id: string): WebSearchProviderInfo | undefined {
	return WEB_SEARCH_PROVIDERS.find((p) => p.id === id);
}

// ============================================================================
// Brave Search
// ============================================================================

interface BraveWebResult {
	title?: string;
	url?: string;
	description?: string;
}

interface BraveSearchResponse {
	web?: { results?: BraveWebResult[] };
}

async function searchBrave(
	query: string,
	apiKey: string,
	count: number,
	fetchImpl: ReturnType<typeof createObsidianFetch>,
	signal: AbortSignal,
): Promise<WebSearchResult[]> {
	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&text_decorations=false&search_lang=en`;

	const response = await fetchImpl(url, {
		method: "GET",
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": apiKey,
		},
		signal,
	});

	if (!response.ok) {
		if (response.status === 401) throw new Error("Invalid Brave Search API key");
		if (response.status === 429) throw new Error("Brave Search rate limit exceeded — try again shortly");
		throw new Error(`Brave Search returned HTTP ${response.status}`);
	}

	const data = (await response.json()) as BraveSearchResponse;
	return (data.web?.results ?? []).map((r, i) => ({
		rank: i + 1,
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.description ?? "",
	}));
}

// ============================================================================
// Tavily Search
// ============================================================================

interface TavilySearchResponse {
	results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
}

async function searchTavily(
	query: string,
	apiKey: string,
	count: number,
	fetchImpl: ReturnType<typeof createObsidianFetch>,
	signal: AbortSignal,
): Promise<WebSearchResult[]> {
	const response = await fetchImpl("https://api.tavily.com/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			query,
			max_results: count,
			search_depth: "basic",
			include_answer: false,
			include_raw_content: false,
		}),
		signal,
	});

	if (!response.ok) {
		if (response.status === 401) throw new Error("Invalid Tavily API key");
		if (response.status === 429) throw new Error("Tavily rate limit exceeded — try again shortly");
		throw new Error(`Tavily returned HTTP ${response.status}`);
	}

	const data = (await response.json()) as TavilySearchResponse;
	return (data.results ?? []).map((r, i) => ({
		rank: i + 1,
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.content ?? "",
	}));
}

// ============================================================================
// Firecrawl Search
// ============================================================================

interface FirecrawlWebResult {
	title?: string;
	url?: string;
	description?: string;
	position?: number;
}

interface FirecrawlSearchResponse {
	success?: boolean;
	error?: string;
	data?: { web?: FirecrawlWebResult[] };
}

/**
 * Firecrawl search. Works keyless (the free tier); an optional API key raises
 * rate limits. The Authorization header is only sent when a key is present.
 */
async function searchFirecrawl(
	query: string,
	apiKey: string,
	count: number,
	fetchImpl: ReturnType<typeof createObsidianFetch>,
	signal: AbortSignal,
): Promise<WebSearchResult[]> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const response = await fetchImpl("https://api.firecrawl.dev/v2/search", {
		method: "POST",
		headers,
		body: JSON.stringify({
			query,
			limit: count,
			sources: ["web"],
		}),
		signal,
	});

	if (!response.ok) {
		if (response.status === 401) throw new Error("Invalid Firecrawl API key");
		if (response.status === 429)
			throw new Error("Firecrawl rate limit exceeded — try again shortly, or add an API key for higher limits");
		throw new Error(`Firecrawl returned HTTP ${response.status}`);
	}

	const data = (await response.json()) as FirecrawlSearchResponse;
	if (data.success === false) {
		throw new Error(`Firecrawl search failed${data.error ? `: ${data.error}` : ""}`);
	}

	return (data.data?.web ?? []).map((r, i) => ({
		rank: i + 1,
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.description ?? "",
	}));
}

// ============================================================================
// Keenable Search
// ============================================================================

const KEENABLE_SNIPPET_MAX_CHARS = 1000;

interface KeenableSearchResponse {
	results?: Array<{ title?: string; url?: string; description?: string; snippet?: string }>;
}

/**
 * Keenable search. Works keyless via the public endpoint; an optional API key
 * switches to the keyed endpoint (sent as X-API-Key) for higher limits.
 */
async function searchKeenable(
	query: string,
	apiKey: string,
	count: number,
	fetchImpl: ReturnType<typeof createObsidianFetch>,
	signal: AbortSignal,
): Promise<WebSearchResult[]> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Keenable-Title": "Smart Second Brain",
	};
	if (apiKey) headers["X-API-Key"] = apiKey;
	const endpoint = apiKey ? "https://api.keenable.ai/v1/search" : "https://api.keenable.ai/v1/search/public";

	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify({ query, max_results: count }),
		signal,
	});

	if (!response.ok) {
		// Without a key, a 401/403 is the public endpoint refusing us, not a bad key.
		if (apiKey && (response.status === 401 || response.status === 403)) throw new Error("Invalid Keenable API key");
		if (response.status === 429)
			throw new Error("Keenable rate limit exceeded — try again shortly, or add an API key for higher limits");
		throw new Error(`Keenable returned HTTP ${response.status}`);
	}

	const data = (await response.json()) as KeenableSearchResponse;
	return (data.results ?? [])
		.filter((r) => !!r.url)
		.slice(0, count)
		.map((r, i) => ({
			rank: i + 1,
			title: r.title ?? "",
			url: r.url ?? "",
			// Prefer the short description; the snippet can be a long page excerpt.
			snippet: (r.description || r.snippet || "").slice(0, KEENABLE_SNIPPET_MAX_CHARS),
		}));
}

// ============================================================================
// Tool factory
// ============================================================================

interface WebSearchSettings {
	maxResults?: number;
}

export function createWebSearchTool(agentId = "") {
	const pluginData = getData();
	// Resolve against the agent that owns this run, not the global selection — the
	// global agent can differ in another tab, and subagents carry their own config.
	const getToolConfig = () => resolveToolAgent(agentId).toolsConfig.web_search;
	const fetchImpl = createObsidianFetch(window.fetch.bind(window));

	const webSearchFn = async ({ query }: { query: string }): Promise<string> => {
		const trimmed = query?.trim();
		if (!trimmed) return "Error: Search query is empty.";

		const provider = pluginData.webSearchProvider;
		if (!provider) {
			return "Error: No web search provider configured. Go to Settings → General → Web Search and select a provider with a valid API key.";
		}

		const providerInfo = getWebSearchProvider(provider);
		if (!providerInfo) return `Error: Unknown web search provider "${provider}".`;

		const apiKey = pluginData.webSearchApiKey;
		if (!apiKey && !providerInfo.keyless) {
			return `Error: No API key configured for web search provider "${provider}". Go to Settings → General → Web Search and add an API key.`;
		}

		const settings = getToolConfig()?.settings as WebSearchSettings | undefined;
		const maxResults = clampMaxResults(settings?.maxResults);

		try {
			Logger.log(`[web_search] Searching "${trimmed}" via ${provider}`);
			let results: WebSearchResult[];

			if (provider === "brave") {
				results = await withTimeout(
					(signal) => searchBrave(trimmed, apiKey, maxResults, fetchImpl, signal),
					FETCH_TIMEOUT_MS,
				);
			} else if (provider === "tavily") {
				results = await withTimeout(
					(signal) => searchTavily(trimmed, apiKey, maxResults, fetchImpl, signal),
					FETCH_TIMEOUT_MS,
				);
			} else if (provider === "firecrawl") {
				results = await withTimeout(
					(signal) => searchFirecrawl(trimmed, apiKey, maxResults, fetchImpl, signal),
					FETCH_TIMEOUT_MS,
				);
			} else if (provider === "keenable") {
				results = await withTimeout(
					(signal) => searchKeenable(trimmed, apiKey, maxResults, fetchImpl, signal),
					FETCH_TIMEOUT_MS,
				);
			} else {
				return `Error: Unknown web search provider "${provider}".`;
			}

			const payload: WebSearchPayload = {
				query: trimmed,
				provider,
				totalResults: results.length,
				results,
			};

			if (results.length === 0) {
				payload.message = `No results found for "${trimmed}". Try rephrasing the query.`;
			}

			return JSON.stringify(payload);
		} catch (error) {
			if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
				return `Error: Web search timed out after ${FETCH_TIMEOUT_MS}ms.`;
			}
			const message = error instanceof Error ? error.message : String(error);
			Logger.error(`[web_search] Failed for "${trimmed}"`, error);
			return `Error searching the web: ${message}`;
		}
	};

	const toolConfig = getToolConfig();

	return tool(webSearchFn, {
		name: toolConfig?.name ?? "web_search",
		description:
			toolConfig?.description ??
			"Search the web and return a list of relevant results (title, URL, snippet). Use this when the user asks about current events, external topics, or anything that cannot be in the vault. Always prefer searching the vault first with search_notes.",
		schema: z.object({
			query: z.string().describe("The search query. Be specific — use 3-8 words for best results."),
		}),
	});
}
