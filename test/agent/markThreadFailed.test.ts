import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { AgentManager } from "../../src/agent/AgentManager";

/**
 * `markThreadFailed` renames a failed placeholder chat to "New Chat (failed)" only when
 * the run checkpointed something. A run that failed before that (e.g. no chat model
 * configured) left the chat empty, and an empty "New Chat" is reused by the next new
 * chat, so renaming it would only strand an empty file. Exercised on a bare instance
 * with just the chat manager stubbed; the constructor pulls in the whole plugin.
 */
function makeManager(checkpoints: Record<string, unknown> | undefined) {
	const renameChatFile = vi.fn().mockResolvedValue("Chats/New Chat (failed).chat");
	const manager = Object.create(AgentManager.prototype) as AgentManager;
	(manager as unknown as { chatManager: unknown }).chatManager = {
		ensureThreadLoaded: vi.fn().mockResolvedValue(checkpoints === undefined ? undefined : { checkpoints }),
		renameChatFile,
	};
	return { manager, renameChatFile };
}

describe("markThreadFailed", () => {
	it("renames a thread the failed run checkpointed", async () => {
		const { manager, renameChatFile } = makeManager({ cp1: {} });

		await expect(manager.markThreadFailed("Chats/New Chat.chat")).resolves.toBe("Chats/New Chat (failed).chat");
		expect(renameChatFile).toHaveBeenCalledWith("Chats/New Chat.chat", "New Chat (failed)");
	});

	it("leaves a thread with no checkpoints reusable", async () => {
		const { manager, renameChatFile } = makeManager({});

		await expect(manager.markThreadFailed("Chats/New Chat.chat")).resolves.toBeUndefined();
		expect(renameChatFile).not.toHaveBeenCalled();
	});

	it("does nothing for a thread it can't load", async () => {
		const { manager, renameChatFile } = makeManager(undefined);

		await expect(manager.markThreadFailed("Chats/New Chat.chat")).resolves.toBeUndefined();
		expect(renameChatFile).not.toHaveBeenCalled();
	});
});
