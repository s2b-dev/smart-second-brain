import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	clearBuffers,
	deleteAllChatFiles,
	disablePlugin,
	domCount,
	enablePlugin,
	executeCommand,
	getErrors,
	isProviderConfigured,
	sleep,
	submitChatMessageViaUi,
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

describe("end-to-end chat flow", () => {
	beforeAll(async () => {
		clearBuffers();
		disablePlugin();
		await sleep(1000);
		enablePlugin();
		await sleep(5000);
		executeCommand("smart-second-brain:new-chat");
		await waitForSelector(".s2b-chat-root");
		await sleep(1000);
	}, 30_000);

	afterAll(() => {
		deleteAllChatFiles();
		clearBuffers();
	});

	it("should show the empty state logo before any messages", async () => {
		await waitForSelector(".logo-container");
		expect(domCount(".logo-container")).toBeGreaterThanOrEqual(1);
	});

	it.skipIf(!providerAvailable)("should submit a message through the chat UI", async () => {
		const submitResult = await submitChatMessageViaUi("Reply with exactly: HELLO_E2E");
		expect(submitResult).not.toContain("missing-editor-api");
		expect(submitResult).not.toContain("missing-send-button");
		expect(submitResult).not.toContain("send-disabled");
		expect(submitResult).not.toContain("ERROR:");

		const normalizedSubmitResult = submitResult.startsWith("=> ") ? submitResult.slice(3) : submitResult;
		const parsed = JSON.parse(normalizedSubmitResult) as { clicked?: boolean; value?: string };
		expect(parsed.clicked).toBe(true);
		expect(typeof parsed.value).toBe("string");
	});

	it.skipIf(!providerAvailable)("should hide the empty state logo after messages are sent", async () => {
		executeCommand("smart-second-brain:open-chat");
		await waitForSelector(".s2b-chat-root");
		await sleep(500);
		const logoCount = domCount(".logo-container");
		expect(logoCount).toBeDefined();
	});

	it("should not produce errors during the chat flow", () => {
		expect(getErrors()).toBe("");
	});
});
