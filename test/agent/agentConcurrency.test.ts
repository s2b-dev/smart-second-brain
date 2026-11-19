import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

// Track each createAgent call so we can assert on the model passed in
const createdRunnables: Array<{ model: unknown }> = [];
const { createAgentMock, summarizationMiddlewareMock } = vi.hoisted(() => ({
	createAgentMock: vi.fn((opts: { model: unknown }) => {
		const runnable = { invoke: vi.fn(), streamEvents: vi.fn(), _model: opts.model };
		createdRunnables.push({ model: opts.model });
		return runnable;
	}),
	summarizationMiddlewareMock: vi.fn(() => ({ kind: "summary" })),
}));

vi.mock("langchain", () => ({
	createAgent: createAgentMock,
	summarizationMiddleware: summarizationMiddlewareMock,
	createMiddleware: (config: unknown) => config,
	anthropicPromptCachingMiddleware: () => ({ name: "PromptCachingMiddleware" }),
}));

vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: vi.fn(() => ({
		targetFolder: "Chats",
		isFilePrivate: vi.fn(() => false),
		isProviderTrusted: vi.fn(() => false),
	})),
}));

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { TFile } from "obsidian";
import { Agent } from "../../src/agent/Agent";
import { PendingChangesStore } from "../../src/stores/pendingChangesStore.svelte";

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------*/

function makeRegistry() {
	return {
		createChatInstance: vi.fn((provider: string, model: string) => ({ _provider: provider, _model: model })),
	} as unknown as { createChatInstance: (p: string, m: string, o?: unknown) => BaseChatModel };
}

function makeResolveParams(provider: string, model: string, cacheKey: string) {
	return {
		provider,
		chatModel: model,
		options: { contextWindow: 128_000 },
		cacheKey,
		systemPrompt: "You are helpful.",
		tools: [] as const,
		subAgents: [] as const,
	};
}

function makeTFile(path: string): TFile {
	const f = new TFile();
	f.path = path;
	f.name = path.split("/").pop()!;
	return f;
}

function createMockPlugin() {
	const vault = {
		adapter: {
			exists: vi.fn().mockResolvedValue(false),
			read: vi.fn().mockResolvedValue(""),
			write: vi.fn().mockResolvedValue(undefined),
			mkdir: vi.fn().mockResolvedValue(undefined),
		},
		getAbstractFileByPath: vi.fn((path: string) => makeTFile(path)),
		read: vi.fn().mockResolvedValue("original content"),
		modify: vi.fn().mockResolvedValue(undefined),
		create: vi.fn().mockResolvedValue(undefined),
		createFolder: vi.fn().mockResolvedValue(undefined),
		trash: vi.fn().mockResolvedValue(undefined),
		on: vi.fn().mockReturnValue({ id: "ref" }),
		process: vi.fn(),
	};
	// Mirrors Vault.process by delegating to read/modify. Looks both up on `vault`
	// at call time, so tests that reassign `plugin.app.vault.modify` to instrument
	// gating/ordering still intercept the write.
	vault.process.mockImplementation(async (file: unknown, fn: (data: string) => string) => {
		const data = await vault.read(file);
		const result = fn(data);
		if (result !== data) await vault.modify(file, result);
		return result;
	});
	return {
		manifest: { dir: "test-plugin" },
		app: {
			vault,
			fileManager: { renameFile: vi.fn().mockResolvedValue(undefined) },
		},
		registerEvent: vi.fn(),
		saveData: vi.fn().mockResolvedValue(undefined),
	};
}

/* --------------------------------------------------------------------------
 * Runnable cache: hit, miss, invalidation
 * ------------------------------------------------------------------------*/

describe("Agent.resolveRun — runnable cache", () => {
	beforeEach(() => {
		createAgentMock.mockClear();
		summarizationMiddlewareMock.mockClear();
		createdRunnables.length = 0;
	});

	it("same cacheKey returns the same runnable without rebuilding", async () => {
		const agent = new Agent({ registry: makeRegistry() as never });
		const params = makeResolveParams("openai", "gpt-4o", "key-A");

		const r1 = await agent.resolveRun(params);
		const r2 = await agent.resolveRun(params);

		expect(createAgentMock).toHaveBeenCalledTimes(1);
		expect(r1.runnable).toBe(r2.runnable);
	});

	it("different cacheKey builds a distinct runnable", async () => {
		const agent = new Agent({ registry: makeRegistry() as never });

		const r1 = await agent.resolveRun(makeResolveParams("openai", "gpt-4o", "key-B1"));
		const r2 = await agent.resolveRun(makeResolveParams("anthropic", "claude-sonnet", "key-B2"));

		expect(createAgentMock).toHaveBeenCalledTimes(2);
		expect(r1.runnable).not.toBe(r2.runnable);
		expect(r1.selectedModel.provider).toBe("openai");
		expect(r2.selectedModel.provider).toBe("anthropic");
	});

	it("invalidateRunnable drops matching cache entries and forces rebuild", async () => {
		const agent = new Agent({ registry: makeRegistry() as never });
		// Use an agentId-bearing key (as AgentManager builds it)
		const cacheKey = JSON.stringify({ provider: "openai", model: "gpt-4o", agentId: "agent-1" });

		const r1 = await agent.resolveRun({ ...makeResolveParams("openai", "gpt-4o", cacheKey) });
		expect(createAgentMock).toHaveBeenCalledTimes(1);

		agent.invalidateRunnable("agent-1");

		const r2 = await agent.resolveRun({ ...makeResolveParams("openai", "gpt-4o", cacheKey) });
		expect(createAgentMock).toHaveBeenCalledTimes(2);
		expect(r1.runnable).not.toBe(r2.runnable);
	});

	it("invalidateAllRunnables clears every cached runnable", async () => {
		const agent = new Agent({ registry: makeRegistry() as never });

		await agent.resolveRun(makeResolveParams("openai", "gpt-4o", "key-all-1"));
		await agent.resolveRun(makeResolveParams("anthropic", "claude-sonnet", "key-all-2"));
		expect(createAgentMock).toHaveBeenCalledTimes(2);

		agent.invalidateAllRunnables();

		await agent.resolveRun(makeResolveParams("openai", "gpt-4o", "key-all-1"));
		await agent.resolveRun(makeResolveParams("anthropic", "claude-sonnet", "key-all-2"));
		expect(createAgentMock).toHaveBeenCalledTimes(4);
	});
});

/* --------------------------------------------------------------------------
 * Concurrent different-model resolveRun — no cross-contamination
 * ------------------------------------------------------------------------*/

describe("Agent.resolveRun — concurrent different-model runs", () => {
	beforeEach(() => {
		createAgentMock.mockClear();
		createdRunnables.length = 0;
	});

	it("two concurrent resolveRun calls with different models each get their own runnable and selectedModel", async () => {
		const agent = new Agent({ registry: makeRegistry() as never });

		const [rA, rB] = await Promise.all([
			agent.resolveRun(makeResolveParams("openai", "gpt-4o", "concurrent-A")),
			agent.resolveRun(makeResolveParams("anthropic", "claude-sonnet", "concurrent-B")),
		]);

		// Each run gets the correct provider/model
		expect(rA.selectedModel.provider).toBe("openai");
		expect(rA.selectedModel.name).toBe("gpt-4o");
		expect(rB.selectedModel.provider).toBe("anthropic");
		expect(rB.selectedModel.name).toBe("claude-sonnet");

		// Runnables are distinct objects
		expect(rA.runnable).not.toBe(rB.runnable);

		// createAgent was called once per unique key
		expect(createAgentMock).toHaveBeenCalledTimes(2);
	});

	it("two concurrent resolveRun calls with the SAME model share one runnable", async () => {
		const agent = new Agent({ registry: makeRegistry() as never });

		const [rA, rB] = await Promise.all([
			agent.resolveRun(makeResolveParams("openai", "gpt-4o", "same-key")),
			agent.resolveRun(makeResolveParams("openai", "gpt-4o", "same-key")),
		]);

		// Both resolve to the same cached runnable (one build)
		expect(rA.runnable).toBe(rB.runnable);
		expect(createAgentMock).toHaveBeenCalledTimes(1);
	});
});

/* --------------------------------------------------------------------------
 * PendingChangesStore.acceptAll — per-thread batch guard
 * ------------------------------------------------------------------------*/

describe("PendingChangesStore.acceptAll — per-thread concurrency", () => {
	it("concurrent acceptAll on disjoint threads both succeed (no cross-block)", async () => {
		const plugin = createMockPlugin();
		const store = new PendingChangesStore(plugin as never);

		// Stage one update per thread
		store.addChanges(
			[{ type: "update", path: "a.md", originalContent: "original content", newContent: "new A" }],
			"tc-A",
			"thread-A",
		);
		store.addChanges(
			[{ type: "update", path: "b.md", originalContent: "original content", newContent: "new B" }],
			"tc-B",
			"thread-B",
		);

		const [failuresA, failuresB] = await Promise.all([store.acceptAll("thread-A"), store.acceptAll("thread-B")]);

		// Neither should report an in-progress rejection
		expect(failuresA).not.toContain("Batch operation already in progress");
		expect(failuresB).not.toContain("Batch operation already in progress");
		expect(failuresA).toHaveLength(0);
		expect(failuresB).toHaveLength(0);
	});

	it("second acceptAll on the SAME thread while first is in flight is a silent no-op", async () => {
		const plugin = createMockPlugin();
		// Slow down vault.modify so the first acceptAll is still running when the second starts.
		// We use a deferred promise so we can resolve it after modify has been called.
		let modifyResolve = (_: void | PromiseLike<void>) => {};
		const modifyBlocked = new Promise<void>((res) => {
			modifyResolve = res;
		});
		plugin.app.vault.modify = vi.fn(() => modifyBlocked);

		const store = new PendingChangesStore(plugin as never);
		store.addChanges(
			[{ type: "update", path: "c.md", originalContent: "original content", newContent: "new C" }],
			"tc-C",
			"thread-C",
		);

		// Both calls are made synchronously. acceptAll's guard check + Set.add are
		// synchronous at the top of the async function, so `second` sees the Set already
		// containing "thread-C" and returns immediately without waiting for modify.
		const first = store.acceptAll("thread-C");
		const second = store.acceptAll("thread-C");

		// Second returns immediately with no failures — the first run is already
		// doing exactly what was asked; the UI disables the button while awaiting,
		// so re-entry must not report a phantom failure.
		const secondResult = await second;
		expect(secondResult).toHaveLength(0);

		// Now unblock modify so `first` can finish
		modifyResolve();
		const firstResult = await first;
		expect(firstResult).toHaveLength(0);
		// The no-op second run must not have applied the staged change again.
		expect(plugin.app.vault.modify).toHaveBeenCalledTimes(1);
	});
});

/* --------------------------------------------------------------------------
 * withFileLock — FIFO serialization (not a single-slot barrier)
 * ------------------------------------------------------------------------*/

describe("PendingChangesStore — per-file write serialization", () => {
	it("three concurrent applies to the same path run strictly one-at-a-time", async () => {
		const plugin = createMockPlugin();

		// Instrument modify to record enter/exit ordering and to gate on a manual
		// release, so we can prove no two applies overlap. A single-slot barrier
		// (the old bug) would let ops 2 and 3 enter together after op 1 released.
		let active = 0;
		let maxConcurrent = 0;
		const releases: Array<() => void> = [];
		const enteredOrder: string[] = [];

		plugin.app.vault.modify = vi.fn((_file: unknown, content: string) => {
			active++;
			maxConcurrent = Math.max(maxConcurrent, active);
			enteredOrder.push(content);
			return new Promise<void>((resolve) => {
				releases.push(() => {
					active--;
					resolve();
				});
			});
		});

		const store = new PendingChangesStore(plugin as never);
		// Three updates to the SAME path across three threads.
		const ids = ["1", "2", "3"].map(
			(n) =>
				store.addChanges(
					[{ type: "update", path: "same.md", originalContent: "original content", newContent: `new-${n}` }],
					`tc-${n}`,
					`thread-${n}`,
				)[0],
		);

		// Kick off all three accepts concurrently.
		const accepts = ids.map((id) => store.acceptChange(id));

		// Drain: only one modify should be in flight at any time. Release them one
		// by one, letting the queue advance each time.
		for (let i = 0; i < 3; i++) {
			// Wait a tick for the next queued op to enter modify.
			await new Promise((r) => setTimeout(r, 0));
			expect(active).toBe(1);
			expect(releases.length).toBe(i + 1);
			releases[i]();
		}

		await Promise.all(accepts);

		expect(maxConcurrent).toBe(1);
		// FIFO: they entered in the order they were queued.
		expect(enteredOrder).toEqual(["new-1", "new-2", "new-3"]);
	});
});

/* --------------------------------------------------------------------------
 * acceptChange(create) — apply-time destination re-check
 * ------------------------------------------------------------------------*/

describe("PendingChangesStore.acceptChange — create destination re-check", () => {
	it("fails cleanly when the destination already exists at apply time (double-stage race)", async () => {
		const plugin = createMockPlugin();
		// Destination exists at apply time (the other tab already created it).
		plugin.app.vault.getAbstractFileByPath = vi.fn(() => makeTFile("dup.md"));

		const store = new PendingChangesStore(plugin as never);
		const id = store.addChange({ type: "create", path: "dup.md", content: "# hi" }, "tc-dup", "thread-dup");

		await expect(store.acceptChange(id)).rejects.toThrow(/already exists/);
		// vault.create must NOT have been called — we caught it before the raw throw.
		expect(plugin.app.vault.create).not.toHaveBeenCalled();
	});
});
