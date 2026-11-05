import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFetch, pluginState, mockAgent } = vi.hoisted(() => {
	const mockFetch = vi.fn();
	const pluginState = {
		webSearchProvider: "keenable",
		webSearchApiKey: "",
	};
	const mockAgent = {
		id: "agent-1",
		toolsConfig: {
			web_search: { settings: { maxResults: 5 }, name: "web_search" },
		},
	};
	return { mockFetch, pluginState, mockAgent };
});

vi.mock("../../src/utils/logging", () => ({
	Logger: {
		log: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => ({
		get webSearchProvider() {
			return pluginState.webSearchProvider;
		},
		get webSearchApiKey() {
			return pluginState.webSearchApiKey;
		},
		getAgent: () => mockAgent,
		getSelectedAgent: () => mockAgent,
	}),
}));

import { createWebSearchTool } from "../../src/agent/tools/webSearch";

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as Response;
}

function lastKeenableRequest(): { url: string; init: RequestInit } {
	const call = mockFetch.mock.calls.at(-1);
	expect(call).toBeDefined();
	return { url: String(call![0]), init: call![1] as RequestInit };
}

beforeEach(() => {
	mockFetch.mockReset();
	vi.stubGlobal("fetch", mockFetch);
	pluginState.webSearchProvider = "keenable";
	pluginState.webSearchApiKey = "";
});

describe("web_search — Keenable", () => {
	it("uses the public endpoint without X-API-Key when no key is saved", async () => {
		mockFetch.mockResolvedValueOnce(
			jsonResponse({
				results: [{ title: "A", url: "https://a.example", description: "desc" }],
			}),
		);

		const tool = createWebSearchTool("agent-1");
		const raw = (await tool.invoke({ query: "test query" })) as string;
		const payload = JSON.parse(raw) as { provider: string; results: Array<{ url: string }> };

		const { url, init } = lastKeenableRequest();
		expect(url).toBe("https://api.keenable.ai/v1/search/public");
		const headers = init.headers as Record<string, string>;
		expect(headers["X-API-Key"]).toBeUndefined();
		expect(headers["X-Keenable-Title"]).toBe("Smart Second Brain");
		expect(JSON.parse(String(init.body))).toEqual({ query: "test query", max_results: 5 });
		expect(payload.provider).toBe("keenable");
		expect(payload.results).toHaveLength(1);
		expect(payload.results[0]?.url).toBe("https://a.example");
	});

	it("uses the keyed endpoint with X-API-Key when a key is saved", async () => {
		pluginState.webSearchApiKey = "keenable-secret";
		mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

		const tool = createWebSearchTool();
		await tool.invoke({ query: "keyed" });

		const { url, init } = lastKeenableRequest();
		expect(url).toBe("https://api.keenable.ai/v1/search");
		const headers = init.headers as Record<string, string>;
		expect(headers["X-API-Key"]).toBe("keenable-secret");
	});

	it("drops results without a URL and maps snippets from description or excerpt", async () => {
		const longSnippet = "x".repeat(1200);
		mockFetch.mockResolvedValueOnce(
			jsonResponse({
				results: [
					{ title: "No URL" },
					{ title: "With description", url: "https://d.example", description: "short desc" },
					{ title: "Snippet only", url: "https://s.example", snippet: longSnippet },
					{
						title: "Both",
						url: "https://b.example",
						description: "preferred",
						snippet: "ignored excerpt",
					},
				],
			}),
		);

		const tool = createWebSearchTool();
		const raw = (await tool.invoke({ query: "mapping" })) as string;
		const payload = JSON.parse(raw) as {
			totalResults: number;
			results: Array<{ rank: number; title: string; snippet: string }>;
		};

		expect(payload.totalResults).toBe(3);
		expect(payload.results.map((r) => r.title)).toEqual(["With description", "Snippet only", "Both"]);
		expect(payload.results[0]?.snippet).toBe("short desc");
		expect(payload.results[1]?.snippet).toHaveLength(1000);
		expect(payload.results[2]?.snippet).toBe("preferred");
		expect(payload.results[0]?.rank).toBe(1);
		expect(payload.results[2]?.rank).toBe(3);
	});

	it("returns provider-specific errors for Keenable HTTP failures", async () => {
		const tool = createWebSearchTool();

		mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));
		expect(await tool.invoke({ query: "bad key" })).toBe("Error searching the web: Invalid Keenable API key");

		mockFetch.mockResolvedValueOnce(jsonResponse({}, 403));
		expect(await tool.invoke({ query: "forbidden" })).toBe("Error searching the web: Invalid Keenable API key");

		mockFetch.mockResolvedValueOnce(jsonResponse({}, 429));
		expect(await tool.invoke({ query: "limited" })).toBe(
			"Error searching the web: Keenable rate limit exceeded — try again shortly, or add an API key for higher limits",
		);

		mockFetch.mockResolvedValueOnce(jsonResponse({}, 502));
		expect(await tool.invoke({ query: "upstream" })).toBe("Error searching the web: Keenable returned HTTP 502");
	});

	it("does not require an API key when Keenable is selected", async () => {
		pluginState.webSearchApiKey = "";
		mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

		const tool = createWebSearchTool();
		const raw = (await tool.invoke({ query: "keyless ok" })) as string;

		expect(raw).not.toMatch(/^Error: No API key/);
		expect(JSON.parse(raw).provider).toBe("keenable");
	});
});
