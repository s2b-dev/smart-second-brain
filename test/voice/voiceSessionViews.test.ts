import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));
vi.mock("../../src/stores/dataStore.svelte", () => ({ getData: () => ({}) }));
vi.mock("../../src/stores/state.svelte", () => ({
	getPlugin: () => ({ app: { vault: { on: vi.fn(), offref: vi.fn() } } }),
}));
vi.mock("../../src/utils/actionNotice", () => ({ showSettingsLinkNotice: vi.fn() }));
vi.mock("../../src/voice/audioCapture", () => ({ startAudioCapture: vi.fn() }));
vi.mock("../../src/voice/audioPlayback", () => ({ AudioPlayback: vi.fn() }));
vi.mock("../../src/voice/realtimeClient", () => ({ RealtimeClient: vi.fn() }));
vi.mock("../../src/voice/supervisorBridge", () => ({
	createSupervisorBridge: () => ({ run: vi.fn(), abort: vi.fn(), reset: vi.fn() }),
}));

import { VoiceSession } from "../../src/voice/voiceSession.svelte";

/* The view bookkeeping alone: the session must end when the last chat view showing
 * its thread detaches, and survive while another leaf still shows that thread. */

const flush = () => new Promise<void>((r) => queueMicrotask(r));

function boundSession(threadPath: string): VoiceSession {
	const session = new VoiceSession();
	session.status = "listening";
	session.threadPath = threadPath;
	return session;
}

describe("VoiceSession view attachment", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("stops when the only view showing the bound thread detaches", async () => {
		const session = boundSession("a.chat");
		const view = Symbol("v1");
		session.attachView(view, "a.chat");

		session.detachView(view);
		await flush();

		expect(session.status).toBe("off");
		expect(session.threadPath).toBeNull();
	});

	it("keeps running while another view still shows the bound thread", async () => {
		const session = boundSession("a.chat");
		const v1 = Symbol("v1");
		const v2 = Symbol("v2");
		session.attachView(v1, "a.chat");
		session.attachView(v2, "a.chat");

		session.detachView(v1);
		await flush();
		expect(session.status).toBe("listening");

		session.detachView(v2);
		await flush();
		expect(session.status).toBe("off");
	});

	it("stops when a view navigates its thread away, but not when an unrelated view closes", async () => {
		const session = boundSession("a.chat");
		const bound = Symbol("bound");
		const other = Symbol("other");
		session.attachView(bound, "a.chat");
		session.attachView(other, "b.chat");

		session.detachView(other);
		await flush();
		expect(session.status).toBe("listening");

		// Thread change = cleanup (detach) then re-attach with the new path.
		session.detachView(bound);
		session.attachView(bound, "c.chat");
		await flush();
		expect(session.status).toBe("off");
	});

	it("survives the auto-title rename: the session follows the path and the view re-attaches in the same flush", async () => {
		const session = boundSession("Chats/New Chat.chat");
		const view = Symbol("view");
		session.attachView(view, "Chats/New Chat.chat");

		// Vault rename event reaches the session, then the view's effect re-runs.
		session.handleThreadRenamed("Chats/New Chat.chat", "Chats/Graph physics.chat");
		session.detachView(view);
		session.attachView(view, "Chats/Graph physics.chat");
		await flush();

		expect(session.status).toBe("listening");
		expect(session.threadPath).toBe("Chats/Graph physics.chat");
	});

	it("ignores renames of other files", () => {
		const session = boundSession("a.chat");
		session.handleThreadRenamed("b.chat", "c.chat");
		expect(session.threadPath).toBe("a.chat");
	});

	it("ignores detaches while no session is running", async () => {
		const session = new VoiceSession();
		const view = Symbol("v");
		session.attachView(view, "a.chat");
		session.detachView(view);
		await flush();
		expect(session.status).toBe("off");
	});
});

describe("progressToNarration", () => {
	it("prefers the model's own lead-in and falls back to a readable tool name", async () => {
		const { progressToNarration } = await import("../../src/voice/voiceSession.svelte");
		expect(progressToNarration({ toolName: "search_notes", preamble: "Let me check your notes." })).toBe(
			"Let me check your notes.",
		);
		expect(progressToNarration({ toolName: "search_notes" })).toBe('Running "Search Notes"');
		expect(progressToNarration({ toolName: "some_mcp_tool" })).toBe('Running "some mcp tool"');
	});
});
