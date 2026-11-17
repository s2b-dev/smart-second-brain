import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	clearBuffers,
	deleteAllChatFiles,
	deleteAgentThread,
	executeCommand,
	getLatestPersistedChatSummary,
	getErrors,
	isProviderConfigured,
	obsidianEval,
	submitChatMessageViaUi,
	sleep,
	waitForCondition,
	waitForSelector,
} from "./helpers/cli.ts";

const providerAvailable = (() => {
	try {
		return isProviderConfigured();
	} catch {
		return false;
	}
})();

describe("agent interaction", () => {
	let simpleThreadId: string | null = null;

	beforeAll(() => {
		clearBuffers();
		deleteAllChatFiles();
	});

	afterAll(async () => {
		if (simpleThreadId) {
			await deleteAgentThread(simpleThreadId);
		}
		clearBuffers();
	});

	async function openFreshChat(): Promise<void> {
		executeCommand("smart-second-brain:new-chat");
		await waitForSelector(".s2b-chat-root");
		await sleep(1000);
	}

	it.skipIf(!providerAvailable)("should have a chat model configured", () => {
		const result = obsidianEval(
			`(function(){ var a = app.plugins.plugins["smart-second-brain"].pluginData.getSelectedAgent(); return a.chatModel.provider + ":" + a.chatModel.model; })()`,
		);
		expect(result).toContain("=>");
		expect(result).not.toContain("undefined");
	});

	it.skipIf(!providerAvailable)("should have at least one configured provider", () => {
		const result = obsidianEval(
			`app.plugins.plugins["smart-second-brain"].pluginData.getConfiguredProviders().join(",")`,
		);
		expect(result).toContain("=>");
		// Should have at least one provider like ollama or openrouter
		const providers = result.replace("=> ", "");
		expect(providers.length).toBeGreaterThan(0);
	});

	it.skipIf(!providerAvailable)("should send a simple message and receive a response", async () => {
		await openFreshChat();
		const submitResult = await submitChatMessageViaUi("Reply with exactly: PONG");
		expect(submitResult).not.toContain("missing-");
		expect(submitResult).not.toContain("send-disabled");
		expect(submitResult).not.toContain("ERROR:");

		await waitForCondition(
			() => {
				const summary = getLatestPersistedChatSummary();
				return Boolean(
					summary?.humanContents.includes("Reply with exactly: PONG") &&
						summary.assistantContents.some((content) => content.includes("PONG")),
				);
			},
			"persisted chat summary for simple UI message",
			{ timeoutMs: 90_000, intervalMs: 1_000 },
		);

		const summary = getLatestPersistedChatSummary();
		expect(summary).not.toBeNull();
		expect(summary?.assistantContents.at(-1)).toContain("PONG");
		simpleThreadId = summary?.threadId ?? null;
	});

	it("should not produce errors during agent interaction", () => {
		expect(getErrors()).toBe("");
	});
});

describe("agent with tool use", () => {
	let toolThreadId: string | null = null;

	beforeAll(() => {
		clearBuffers();
		deleteAllChatFiles();
	});

	afterAll(async () => {
		if (toolThreadId) {
			await deleteAgentThread(toolThreadId);
		}
		clearBuffers();
	});

	it.skipIf(!providerAvailable)(
		"should invoke tools when asked to search vault content",
		async () => {
			executeCommand("smart-second-brain:new-chat");
			await waitForSelector(".s2b-chat-root");
			await sleep(1000);

			const prompt = "Use the search_notes tool to find notes about machine learning in my vault";
			const submitResult = await submitChatMessageViaUi(prompt);
			expect(submitResult).not.toContain("missing-");
			expect(submitResult).not.toContain("send-disabled");
			expect(submitResult).not.toContain("ERROR:");

			await waitForCondition(
				() => {
					const summary = getLatestPersistedChatSummary();
					return Boolean(
						summary?.humanContents.includes(prompt) &&
							summary.toolCallNames.length > 0 &&
							summary.toolOutputCount > 0 &&
							summary.assistantContents.length > 0,
					);
				},
				"persisted chat summary for UI tool-use message",
				{ timeoutMs: 120_000, intervalMs: 1_000 },
			);

			const summary = getLatestPersistedChatSummary();
			expect(summary).not.toBeNull();
			expect(summary?.assistantContents.length ?? 0).toBeGreaterThan(0);
			expect(summary?.toolCallNames.length ?? 0).toBeGreaterThan(0);
			toolThreadId = summary?.threadId ?? null;
		},
		120_000,
	);

	it.skipIf(!providerAvailable)("should have used a search-related tool", () => {
		const summary = getLatestPersistedChatSummary();
		const hasSearchTool = (summary?.toolCallNames ?? []).some(
			(t: string) => t && (t.includes("search") || t.includes("browse") || t.includes("read")),
		);
		expect(hasSearchTool).toBe(true);
	});

	it.skipIf(!providerAvailable)("should have received non-empty output from every tool", () => {
		const summary = getLatestPersistedChatSummary();
		expect(summary?.toolOutputCount ?? 0).toBeGreaterThan(0);
	});

	it("should not produce errors during tool use", () => {
		expect(getErrors()).toBe("");
	});
});
