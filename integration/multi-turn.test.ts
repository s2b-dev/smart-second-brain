import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	PLUGIN,
	clearBuffers,
	deleteAllChatFiles,
	deleteAgentThread,
	executeCommand,
	getLatestPersistedChatSummary,
	getPersistedChatSummary,
	isProviderConfigured,
	obsidian,
	pollEval,
	sleep,
	submitChatMessageViaUi,
	getErrors,
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

describe.skipIf(!providerAvailable)("multi-turn conversation", () => {
	let threadId: string | null = null;
	let threadFilePath: string | null = null;
	let summaryThreadId: string | null = null;
	let summaryThreadFilePath: string | null = null;

	beforeAll(() => {
		clearBuffers();
		deleteAllChatFiles();
	});

	afterAll(async () => {
		if (threadId) {
			await deleteAgentThread(threadId);
		}
		if (summaryThreadId) {
			await deleteAgentThread(summaryThreadId);
		}
		clearBuffers();
	});

	async function openFreshChat(): Promise<void> {
		executeCommand("smart-second-brain:new-chat");
		await waitForSelector(".s2b-chat-root");
		await sleep(1000);
	}

	async function submitAndWaitForLatestSummary(
		message: string,
		predicate: (summary: NonNullable<ReturnType<typeof getLatestPersistedChatSummary>>) => boolean,
		label: string,
	): Promise<NonNullable<ReturnType<typeof getLatestPersistedChatSummary>>> {
		const submitResult = await submitChatMessageViaUi(message);
		expect(submitResult).not.toContain("missing-");
		expect(submitResult).not.toContain("send-disabled");
		expect(submitResult).not.toContain("ERROR:");

		await waitForCondition(
			() => {
				const summary = getLatestPersistedChatSummary();
				return summary !== null && predicate(summary);
			},
			label,
			{ timeoutMs: 120_000, intervalMs: 1_000 },
		);

		const summary = getLatestPersistedChatSummary();
		expect(summary).not.toBeNull();
		return summary as NonNullable<ReturnType<typeof getLatestPersistedChatSummary>>;
	}

	async function submitAndWaitForExistingSummary(
		chatPath: string,
		threadPath: string,
		message: string,
		predicate: (summary: NonNullable<ReturnType<typeof getPersistedChatSummary>>) => boolean,
		label: string,
	): Promise<NonNullable<ReturnType<typeof getPersistedChatSummary>>> {
		obsidian(`open path="${threadPath}"`);
		await waitForSelector(".s2b-chat-root");
		await sleep(500);

		const submitResult = await submitChatMessageViaUi(message);
		expect(submitResult).not.toContain("missing-");
		expect(submitResult).not.toContain("send-disabled");
		expect(submitResult).not.toContain("ERROR:");

		await waitForCondition(
			() => {
				const summary = getPersistedChatSummary(chatPath);
				return summary !== null && predicate(summary);
			},
			label,
			{ timeoutMs: 120_000, intervalMs: 1_000 },
		);

		const summary = getPersistedChatSummary(chatPath);
		expect(summary).not.toBeNull();
		return summary as NonNullable<ReturnType<typeof getPersistedChatSummary>>;
	}

	async function waitForTitledFreshChatSummary(): Promise<
		NonNullable<ReturnType<typeof getLatestPersistedChatSummary>>
	> {
		await waitForCondition(
			() => {
				const summary = getLatestPersistedChatSummary();
				return summary !== null && summary.threadId !== "Chats/New Chat.chat";
			},
			"fresh chat thread rename",
			{ timeoutMs: 30_000, intervalMs: 500 },
		);

		const summary = getLatestPersistedChatSummary();
		expect(summary).not.toBeNull();
		return summary as NonNullable<ReturnType<typeof getLatestPersistedChatSummary>>;
	}

	it("should send a first message and receive a response", async () => {
		await openFreshChat();
		const initialSummary = await submitAndWaitForLatestSummary(
			"Remember this word: PINEAPPLE. Say OK.",
			(candidate) => candidate.humanContents.length >= 1 && candidate.assistantContents.length >= 1,
			"first persisted UI conversation turn",
		);
		const summary =
			initialSummary.threadId === "Chats/New Chat.chat" ? await waitForTitledFreshChatSummary() : initialSummary;

		expect(summary.assistantContents.at(-1)?.length ?? 0).toBeGreaterThan(0);
		threadId = summary.threadId;
		threadFilePath = summary.filePath;
	});

	it("should recall context from the first message in a follow-up", async () => {
		expect(threadId).toBeTruthy();
		expect(threadFilePath).toBeTruthy();

		const summary = await submitAndWaitForExistingSummary(
			threadFilePath as string,
			threadId as string,
			"What word did I ask you to remember?",
			(candidate) =>
				candidate.humanContents.length >= 2 &&
				candidate.assistantContents.length >= 2 &&
				(candidate.assistantContents.at(-1) ?? "").toUpperCase().includes("PINEAPPLE"),
			"follow-up UI conversation recall",
		);

		expect(summary.assistantContents.at(-1)?.toUpperCase()).toContain("PINEAPPLE");
	});

	it("should maintain history across a third turn", async () => {
		expect(threadId).toBeTruthy();
		expect(threadFilePath).toBeTruthy();

		const summary = await submitAndWaitForExistingSummary(
			threadFilePath as string,
			threadId as string,
			"How many messages have we exchanged so far? Just give the number.",
			(candidate) => candidate.humanContents.length >= 3 && candidate.assistantContents.length >= 3,
			"third UI conversation turn",
		);

		expect(summary.assistantContents.at(-1)?.length ?? 0).toBeGreaterThan(0);
	});

	it("should not produce errors during multi-turn conversation", () => {
		expect(getErrors()).toBe("");
	});

	it("should summarize older turns instead of throwing when the configured context window is small", async () => {
		const configKey = `__s2bSummaryCfg_${Date.now()}`;
		const restoreKey = `__s2bSummaryRestore_${Date.now()}`;
		const filler = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(35);

		const originalConfig = await pollEval(
			`(function(){ var data = ${PLUGIN}.pluginData; var agent = data.getSelectedAgent(); if (!agent.chatModel) return "NO_CHAT_MODEL"; window.${configKey} = JSON.stringify(agent.chatModel.modelConfig || {}); data.updateAgent(agent.id, { chatModel: { ...agent.chatModel, modelConfig: { ...agent.chatModel.modelConfig, contextWindow: 1500 } }, summarizationModel: null }); return "ok"; })()`,
			configKey,
			{ timeoutMs: 10_000 },
		);

		expect(originalConfig).not.toBe("NO_CHAT_MODEL");

		try {
			await openFreshChat();
			const initialSummary = await submitAndWaitForLatestSummary(
				`Remember this codeword exactly: STARFRUIT. Reply with OK only. ${filler}`,
				(candidate) => candidate.humanContents.length >= 1 && candidate.assistantContents.length >= 1,
				"first summarization UI turn",
			);
			const first =
				initialSummary.threadId === "Chats/New Chat.chat"
					? await waitForTitledFreshChatSummary()
					: initialSummary;

			summaryThreadId = first.threadId;
			summaryThreadFilePath = first.filePath;

			for (let i = 0; i < 4; i++) {
				expect(summaryThreadId).toBeTruthy();
				expect(summaryThreadFilePath).toBeTruthy();
				const result = await submitAndWaitForExistingSummary(
					summaryThreadFilePath as string,
					summaryThreadId as string,
					`Keep this response short. ${filler}`,
					(candidate) =>
						candidate.humanContents.length >= i + 2 && candidate.assistantContents.length >= i + 2,
					`summary compaction loop turn ${i + 1}`,
				);
				expect(result.assistantContents.at(-1)?.length ?? 0).toBeGreaterThan(0);
			}

			expect(summaryThreadId).toBeTruthy();
			expect(summaryThreadFilePath).toBeTruthy();
			const recall = await submitAndWaitForExistingSummary(
				summaryThreadFilePath as string,
				summaryThreadId as string,
				"What codeword did I ask you to remember at the start? Reply with the single word only.",
				(candidate) =>
					candidate.humanContents.length >= 6 &&
					candidate.assistantContents.length >= 6 &&
					(candidate.assistantContents.at(-1) ?? "").toUpperCase().includes("STARFRUIT"),
				"summary recall after UI turns",
			);

			expect(recall.assistantContents.at(-1)?.toUpperCase()).toContain("STARFRUIT");
		} finally {
			await pollEval(
				`(function(){ var data = ${PLUGIN}.pluginData; var agent = data.getSelectedAgent(); var original = JSON.parse('${originalConfig.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'); data.updateAgent(agent.id, { chatModel: { ...agent.chatModel, modelConfig: original } }); window.${restoreKey} = "restored"; return "started"; })()`,
				restoreKey,
				{ timeoutMs: 10_000 },
			);
		}
	}, 240_000);
});
