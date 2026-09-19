import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));
vi.mock("../../src/stores/dataStore.svelte", () => ({ getData: () => ({}) }));
vi.mock("../../src/stores/state.svelte", () => ({ getPlugin: () => ({ app: {} }) }));
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

	it("stops when the only view showing the bound thread detaches", () => {
		const session = boundSession("a.chat");
		const view = Symbol("v1");
		session.attachView(view, "a.chat");

		session.detachView(view);

		expect(session.status).toBe("off");
		expect(session.threadPath).toBeNull();
	});

	it("keeps running while another view still shows the bound thread", () => {
		const session = boundSession("a.chat");
		const v1 = Symbol("v1");
		const v2 = Symbol("v2");
		session.attachView(v1, "a.chat");
		session.attachView(v2, "a.chat");

		session.detachView(v1);
		expect(session.status).toBe("listening");

		session.detachView(v2);
		expect(session.status).toBe("off");
	});

	it("stops when a view navigates its thread away, but not when an unrelated view closes", () => {
		const session = boundSession("a.chat");
		const bound = Symbol("bound");
		const other = Symbol("other");
		session.attachView(bound, "a.chat");
		session.attachView(other, "b.chat");

		session.detachView(other);
		expect(session.status).toBe("listening");

		// Thread change = cleanup (detach) then re-attach with the new path.
		session.detachView(bound);
		session.attachView(bound, "c.chat");
		expect(session.status).toBe("off");
	});

	it("ignores detaches while no session is running", () => {
		const session = new VoiceSession();
		const view = Symbol("v");
		session.attachView(view, "a.chat");
		session.detachView(view);
		expect(session.status).toBe("off");
	});
});
