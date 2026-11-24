/**
 * An LM Studio model picked while unloaded saves its maximum window; LM Studio then JIT-loads it at
 * a smaller one. Each turn lowers the saved window to the loaded length so budgets fit the server.
 */

import { requestUrl } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../../src/types/plugin";

const agents = new Map<string, AgentConfig>();
const updateAgent = vi.fn((id: string, updates: Partial<AgentConfig>) => {
	agents.set(id, { ...(agents.get(id) as AgentConfig), ...updates });
});

vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => ({
		getProviderTemplateId: (id: string) => (id.startsWith("lm-studio") ? "lmstudio" : "openai"),
		getResolvedAuthState: () => ({ baseUrl: "http://localhost:1234" }),
		getAgent: (id: string) => agents.get(id),
		updateAgent,
	}),
}));

const { clampLmStudioContextWindows, LMSTUDIO_CHECK_TIMEOUT_MS } = await import(
	"../../src/agent/lmStudioContextWindow"
);

/** `/api/v1/models` listing one LLM, loaded at `loadedAt` tokens (or not loaded). */
function serveModel(loadedAt: number | null): void {
	vi.mocked(requestUrl).mockImplementation((async () => ({
		status: 200,
		text: "",
		json: {
			models: [
				{
					type: "llm",
					key: "qwen3-8b",
					loaded_instances: loadedAt ? [{ config: { context_length: loadedAt } }] : [],
					max_context_length: 131072,
				},
			],
		},
	})) as never);
}

function agentWith(provider: string, contextWindow: number): AgentConfig {
	const agent = {
		id: "a1",
		chatModel: { provider, model: "qwen3-8b", modelConfig: { contextWindow } },
		summarizationModel: null,
	} as unknown as AgentConfig;
	agents.set(agent.id, agent);
	return agent;
}

describe("clampLmStudioContextWindows", () => {
	beforeEach(() => {
		agents.clear();
		updateAgent.mockClear();
		vi.mocked(requestUrl).mockReset();
	});

	it("lowers a saved maximum to the loaded length", async () => {
		serveModel(4096);
		const agent = await clampLmStudioContextWindows(agentWith("lm-studio", 131072));
		expect(agent.chatModel?.modelConfig?.contextWindow).toBe(4096);
		expect(updateAgent).toHaveBeenCalledOnce();
	});

	it("keeps a saved window that already fits", async () => {
		serveModel(32768);
		const agent = await clampLmStudioContextWindows(agentWith("lm-studio", 8192));
		expect(agent.chatModel?.modelConfig?.contextWindow).toBe(8192);
		expect(updateAgent).not.toHaveBeenCalled();
	});

	it("leaves the agent alone while the model isn't loaded", async () => {
		serveModel(null);
		await clampLmStudioContextWindows(agentWith("lm-studio", 131072));
		expect(updateAgent).not.toHaveBeenCalled();
	});

	it("leaves the agent alone when the server can't be reached", async () => {
		vi.mocked(requestUrl).mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));
		await clampLmStudioContextWindows(agentWith("lm-studio", 131072));
		expect(updateAgent).not.toHaveBeenCalled();
	});

	it("keeps a model the user picked while the server was being asked", async () => {
		let answer: () => void = () => {};
		vi.mocked(requestUrl).mockImplementation(
			(() =>
				new Promise((resolve) => {
					answer = () =>
						resolve({
							status: 200,
							text: "",
							json: {
								models: [
									{
										type: "llm",
										key: "qwen3-8b",
										loaded_instances: [{ config: { context_length: 4096 } }],
									},
								],
							},
						});
				})) as never,
		);
		const running = clampLmStudioContextWindows(agentWith("lm-studio", 131072));
		await vi.waitFor(() => expect(requestUrl).toHaveBeenCalled());
		const picked = { provider: "openai", model: "gpt-5", modelConfig: { contextWindow: 400000 } };
		agents.set("a1", { ...(agents.get("a1") as AgentConfig), chatModel: picked } as AgentConfig);
		answer();

		const agent = await running;
		expect(updateAgent).not.toHaveBeenCalled();
		expect(agent.chatModel).toEqual(picked);
	});

	it("goes ahead without the check when LM Studio stalls", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(requestUrl).mockImplementation((() => new Promise(() => {})) as never);
			const running = clampLmStudioContextWindows(agentWith("lm-studio", 131072));
			await vi.advanceTimersByTimeAsync(LMSTUDIO_CHECK_TIMEOUT_MS);
			const agent = await running;
			expect(agent.chatModel?.modelConfig?.contextWindow).toBe(131072);
			expect(updateAgent).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops waiting as soon as the turn is cancelled", async () => {
		vi.mocked(requestUrl).mockImplementation((() => new Promise(() => {})) as never);
		const controller = new AbortController();
		const running = clampLmStudioContextWindows(agentWith("lm-studio", 131072), controller.signal);
		controller.abort();
		await expect(running).resolves.toMatchObject({ id: "a1" });
		expect(updateAgent).not.toHaveBeenCalled();
	});

	it("never queries for other providers", async () => {
		await clampLmStudioContextWindows(agentWith("openai", 131072));
		expect(requestUrl).not.toHaveBeenCalled();
	});
});
