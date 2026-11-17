import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	clearBuffers,
	deleteAllChatFiles,
	disablePlugin,
	domCount,
	domText,
	enablePlugin,
	executeCommand,
	getErrors,
	obsidian,
	sleep,
	waitForSelector,
} from "./helpers/cli.ts";

describe("new chat creation", () => {
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

	it("should have at least one .chat file after executing new-chat command", () => {
		const chatCount = Number.parseInt(obsidian("files ext=chat total"), 10) || 0;
		expect(chatCount).toBeGreaterThanOrEqual(1);
	});

	it("should open the new chat in a tab", () => {
		const count = domCount('[data-type="smart-second-brain-chat"]');
		expect(count).toBeGreaterThanOrEqual(1);
	});

	it("should render the chat UI", () => {
		expect(domCount(".s2b-chat-root")).toBeGreaterThanOrEqual(1);
	});

	it("should not have any errors after chat creation", () => {
		expect(getErrors()).toBe("");
	});
});

describe("open existing chat", () => {
	beforeAll(() => {
		clearBuffers();
	});

	afterAll(() => {
		clearBuffers();
	});

	it("should open the latest chat via command", async () => {
		executeCommand("smart-second-brain:open-chat");
		await waitForSelector('[data-type="smart-second-brain-chat"]');

		const count = domCount('[data-type="smart-second-brain-chat"]');
		expect(count).toBeGreaterThanOrEqual(1);
	});

	it("should not produce errors when opening an existing chat", () => {
		expect(getErrors()).toBe("");
	});
});
