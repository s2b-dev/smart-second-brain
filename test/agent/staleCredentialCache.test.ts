import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

const createdRunnables: Array<{ model: { apiKey?: string } }> = [];
const { createAgentMock, summarizationMiddlewareMock } = vi.hoisted(() => ({
	createAgentMock: vi.fn((opts: { model: unknown }) => {
		const runnable = { invoke: vi.fn(), streamEvents: vi.fn(), _model: opts.model };
		createdRunnables.push({ model: opts.model as { apiKey?: string } });
		return runnable;
	}),
	summarizationMiddlewareMock: vi.fn(() => ({ kind: "summary" })),
}));

vi.mock("langchain", () => ({
	createAgent: createAgentMock,
	summarizationMiddleware: summarizationMiddlewareMock,
	createMiddleware: (config: unknown) => config,
}));

vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: vi.fn(() => ({
		targetFolder: "Chats",
		isFilePrivate: vi.fn(() => false),
		isProviderTrusted: vi.fn(() => false),
	})),
}));

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Agent } from "../../src/agent/Agent";

/**
 * Registry stand-in whose credentials can be rotated between calls, mirroring what
 * `registrySync.syncProvider` does when the user edits an API key: the registry
 * starts minting instances with the new key, but nothing about the agent *config*
 * changes.
 */
function makeRotatableRegistry(initialKey: string) {
	const state = { key: initialKey, generation: 0 };
	return {
		state,
		rotate(newKey: string) {
			state.key = newKey;
			state.generation++;
		},
		registry: {
			createChatInstance: vi.fn((p: string, m: string) => ({ _provider: p, _model: m, apiKey: state.key })),
		} as unknown as { createChatInstance: (p: string, m: string, o?: unknown) => BaseChatModel },
	};
}

/** Mirrors AgentManager.buildRunnableCacheKey's shape, including the authGen term. */
function buildCacheKey(agentId: string, authGen: number): string {
	return JSON.stringify({ provider: "openai", model: "gpt-4o", agentId, authGen });
}

function makeParams(cacheKey: string) {
	return {
		provider: "openai",
		chatModel: "gpt-4o",
		options: { contextWindow: 128_000 },
		cacheKey,
		systemPrompt: "You are helpful.",
		tools: [] as const,
		subAgents: [] as const,
	};
}

beforeEach(() => {
	createAgentMock.mockClear();
	createdRunnables.length = 0;
});

describe("runnable cache — credential rotation", () => {
	it("rebuilds the runnable with the NEW key after a credential change", async () => {
		const { rotate, state, registry } = makeRotatableRegistry("sk-OLD");
		const agent = new Agent({ registry: registry as never });

		const first = await agent.resolveRun(makeParams(buildCacheKey("agent-1", state.generation)));
		expect(createdRunnables[0].model.apiKey).toBe("sk-OLD");

		// User rotates the key: the registry re-registers, bumping authGeneration.
		rotate("sk-NEW");

		const second = await agent.resolveRun(makeParams(buildCacheKey("agent-1", state.generation)));

		// The cache key changed, so a fresh runnable was built around the new key.
		// Regression: without the authGen term this was a cache hit and the request
		// kept going out with sk-OLD until Obsidian restarted.
		expect(second.runnable).not.toBe(first.runnable);
		expect(createAgentMock).toHaveBeenCalledTimes(2);
		expect(createdRunnables[1].model.apiKey).toBe("sk-NEW");
	});

	it("still reuses the cached runnable when credentials are unchanged", async () => {
		const { state, registry } = makeRotatableRegistry("sk-SAME");
		const agent = new Agent({ registry: registry as never });
		const key = buildCacheKey("agent-1", state.generation);

		const first = await agent.resolveRun(makeParams(key));
		const second = await agent.resolveRun(makeParams(key));

		expect(second.runnable).toBe(first.runnable);
		expect(createAgentMock).toHaveBeenCalledTimes(1);
	});

	/**
	 * The cacheKey covers the whole agent config, so every prompt edit or tool toggle
	 * mints a new key while the superseded entry stayed resident forever — each pinning
	 * a LangGraph agent, a model instance and a tool array.
	 */
	it("evicts least-recently-used entries past the cap", async () => {
		const { state, registry } = makeRotatableRegistry("sk-0");
		const agent = new Agent({ registry: registry as never });

		// 20 distinct agent configs at one generation — past the cap of 16.
		for (let i = 0; i < 20; i++) {
			await agent.resolveRun(makeParams(buildCacheKey(`agent-${i}`, state.generation)));
		}
		expect(createAgentMock).toHaveBeenCalledTimes(20);

		// The most recent config is still cached (no rebuild).
		await agent.resolveRun(makeParams(buildCacheKey("agent-19", state.generation)));
		expect(createAgentMock).toHaveBeenCalledTimes(20);

		// The oldest was evicted, so it rebuilds.
		await agent.resolveRun(makeParams(buildCacheKey("agent-0", state.generation)));
		expect(createAgentMock).toHaveBeenCalledTimes(21);
	});

	it("keeps a repeatedly-used entry alive regardless of insertion age", async () => {
		const { state, registry } = makeRotatableRegistry("sk-0");
		const agent = new Agent({ registry: registry as never });
		const hotKey = buildCacheKey("hot-agent", state.generation);

		// Insert the hot key FIRST, so it is the oldest by insertion order.
		await agent.resolveRun(makeParams(hotKey));

		// Push exactly `cap` distinct fillers through, reading the hot key after each.
		for (let i = 0; i < 16; i++) {
			await agent.resolveRun(makeParams(buildCacheKey(`filler-${i}`, state.generation)));
			await agent.resolveRun(makeParams(hotKey));
		}

		// Assert on the TOTAL build count, not on whether a final probe rebuilds. Under
		// a plain insertion-order cap the hot key ages out mid-loop and is rebuilt
		// there — which re-inserts it, so a probe afterwards would hit under either
		// scheme and the two would look identical. 1 hot + 16 fillers = 17 builds means
		// the hot key was never evicted; a naive cap yields 18.
		expect(createAgentMock).toHaveBeenCalledTimes(17);
	});

	it("prunes superseded generations so the cache doesn't grow per key edit", async () => {
		const { rotate, state, registry } = makeRotatableRegistry("sk-0");
		const agent = new Agent({ registry: registry as never });

		await agent.resolveRun(makeParams(buildCacheKey("agent-1", state.generation)));
		await agent.resolveRun(makeParams(buildCacheKey("agent-2", state.generation)));

		rotate("sk-1");
		await agent.resolveRun(makeParams(buildCacheKey("agent-1", state.generation)));

		// Both old-generation entries are gone; re-resolving agent-2 at the current
		// generation must rebuild rather than serve a stale-key runnable.
		const agent2After = await agent.resolveRun(makeParams(buildCacheKey("agent-2", state.generation)));
		expect(createdRunnables.at(-1)?.model.apiKey).toBe("sk-1");
		expect(agent2After.runnable).toBe(
			(await agent.resolveRun(makeParams(buildCacheKey("agent-2", state.generation)))).runnable,
		);
		expect(createAgentMock).toHaveBeenCalledTimes(4);
	});
});
