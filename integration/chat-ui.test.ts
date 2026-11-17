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
	obsidianEval,
	sleep,
	waitForSelector,
} from "./helpers/cli.ts";

describe("chat view UI", () => {
	beforeAll(async () => {
		clearBuffers();
		disablePlugin();
		await sleep(1000);
		enablePlugin();
		await sleep(5000);
		executeCommand("smart-second-brain:new-chat");
		await waitForSelector(".s2b-chat-root");
		await sleep(1000);
	});

	afterAll(() => {
		deleteAllChatFiles();
		clearBuffers();
	});

	it("should render the chat root element", () => {
		expect(domCount(".s2b-chat-root")).toBeGreaterThanOrEqual(1);
	});

	it("should show the empty state logo on a fresh chat", () => {
		expect(domCount(".logo-container")).toBeGreaterThanOrEqual(1);
	});

	it("should render the message input area with placeholder", () => {
		expect(domCount('[aria-placeholder="Ask about your notes..."]')).toBeGreaterThanOrEqual(1);
	});

	it("should show the agent selector button", () => {
		expect(domCount('[data-testid="agent-select-button"][title="Agent options"]')).toBeGreaterThanOrEqual(1);
	});

	it("should display an agent name in the agent pill", () => {
		const agentName = domText(".agent-pill");
		expect(agentName.length).toBeGreaterThan(0);
	});

	it("should show the agent selector with an agent name", () => {
		const agentText = domText("[data-testid='agent-pill']");
		expect(agentText.length).toBeGreaterThan(0);
	});

	it("should have a send button that is disabled when input is empty", () => {
		const sendButton = obsidian(`dev:dom selector='[title="Send message"]' attr=disabled`, { ignoreError: true });
		// disabled attribute should be present (empty string or "true")
		expect(sendButton).not.toBe("No elements found.");
	});

	it("should have an attachment input for file uploads", () => {
		expect(domCount('input[type="file"]#attachment')).toBeGreaterThanOrEqual(1);
	});

	it("should have a New chat ribbon icon or command available", () => {
		// New chat button was removed from input area; it's accessible via ribbon icon and command palette
		expect(domCount('[aria-label="New chat"]')).toBeGreaterThanOrEqual(1);
	});

	it("should display a context usage indicator in the input area", () => {
		const contextIndicators = domCount('[aria-label="Open context token distribution"][title*="Context usage"]');
		expect(contextIndicators).toBeGreaterThanOrEqual(1);
	});

	it("should handle file drag events across the chat view without errors", async () => {
		const dragResult = obsidianEval(`
			(() => {
				const root = document.querySelector(".s2b-chat-root");
				if (!root) return "missing-root";
				const dataTransfer = {
					types: ["Files"],
					items: [{ kind: "file", type: "text/plain" }],
					files: [],
					getData: () => "",
					dropEffect: "copy",
				};
				const dragEnter = new DragEvent("dragenter", { bubbles: true, cancelable: true });
				Object.defineProperty(dragEnter, "dataTransfer", { value: dataTransfer });
				const enterResult = root.dispatchEvent(dragEnter);
				const enterPrevented = dragEnter.defaultPrevented;
				const dragOver = new DragEvent("dragover", { bubbles: true, cancelable: true });
				Object.defineProperty(dragOver, "dataTransfer", { value: dataTransfer });
				const overResult = root.dispatchEvent(dragOver);
				const overPrevented = dragOver.defaultPrevented;
				const dragLeave = new DragEvent("dragleave", { bubbles: true, cancelable: true });
				const leaveResult = root.dispatchEvent(dragLeave);
				const leavePrevented = dragLeave.defaultPrevented;
				return JSON.stringify({
					enterResult,
					enterPrevented,
					overResult,
					overPrevented,
					leaveResult,
					leavePrevented,
				});
			})()
		`);
		expect(dragResult).toContain('"enterPrevented":true');
		expect(dragResult).toContain('"overPrevented":true');
		expect(dragResult).toContain('"leavePrevented":true');
		expect(getErrors()).toBe("");
	});

	it("should not produce errors during rendering", () => {
		expect(getErrors()).toBe("");
	});
});
