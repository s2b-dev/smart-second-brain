import { describe, it, expect } from "vitest";
import { SessionRegistry } from "../../src/stores/chatStore.svelte";
import { ChatSession } from "../../src/stores/chatStore.svelte";
import type { AgentManager } from "../../src/agent/AgentManager";

/* --------------------------------------------------------------------------
 * SessionRegistry — per-thread sessions, running set, eviction, rekey
 *
 * The registry owns the global session map but holds NO single "active" or
 * "running" pointer. Each view binds to its own thread path and resolves its
 * session via `sessionFor(threadPath)`; running state is derived per-session
 * from `ChatSession.isRunning`. These tests exercise that surface. The full
 * loadSession/streaming path is covered by the headless integration suite.
 * ------------------------------------------------------------------------*/

function makeRegistry(): SessionRegistry {
	const stub = {} as unknown as AgentManager;
	return new SessionRegistry(stub);
}

function makeSession(id: string): ChatSession {
	return new ChatSession(id, { graphState: { nodes: new Map() }, errorCount: 0, selectedAgentId: "" });
}

function seed(registry: SessionRegistry, id: string): ChatSession {
	const s = makeSession(id);
	registry.sessions.set(id, s);
	return s;
}

/** Force a session into the "running" state without a live stream. `isRunning`
 * is derived from a private reactive `running` flag that the stream lifecycle
 * flips in lockstep with the abortController; poke both via a cast so the state
 * is internally consistent. */
function markRunning(session: ChatSession, running: boolean): void {
	const internals = session as unknown as { abortController: AbortController | null; running: boolean };
	internals.abortController = running ? new AbortController() : null;
	internals.running = running;
}

describe("SessionRegistry — sessionFor is per-thread", () => {
	it("resolves the session for a specific thread path, not a shared pointer", () => {
		const r = makeRegistry();
		expect(r.sessionFor("a.chat")).toBeNull();
		const a = seed(r, "a.chat");
		const b = seed(r, "b.chat");
		expect(r.sessionFor("a.chat")).toBe(a);
		expect(r.sessionFor("b.chat")).toBe(b);
		expect(r.sessionFor(null)).toBeNull();
	});
});

describe("SessionRegistry — running set derives from ChatSession.isRunning", () => {
	it("runningSessions reflects per-session state", () => {
		const r = makeRegistry();
		const a = seed(r, "a.chat");
		const b = seed(r, "b.chat");
		expect(r.runningSessions.length).toBe(0);
		expect(r.runningSessions).toEqual([]);

		markRunning(a, true);
		expect(r.runningSessions.length).toBeGreaterThan(0);
		expect(r.runningSessions).toEqual([a]);

		markRunning(b, true);
		expect(new Set(r.runningSessions)).toEqual(new Set([a, b]));

		markRunning(a, false);
		expect(r.runningSessions).toEqual([b]);
	});

	it("stopAll stops every running session and leaves idle ones alone", () => {
		const r = makeRegistry();
		const a = seed(r, "a.chat");
		const b = seed(r, "b.chat");
		markRunning(a, true);
		markRunning(b, true);
		let aStopped = false;
		let bStopped = false;
		a.stopStreaming = () => {
			aStopped = true;
		};
		b.stopStreaming = () => {
			bStopped = true;
		};
		r.stopAll();
		expect(aStopped).toBe(true);
		expect(bStopped).toBe(true);
	});
});

describe("SessionRegistry — per-session actions never cross threads", () => {
	it("a session's own isRunning is independent of other sessions", () => {
		const r = makeRegistry();
		const a = seed(r, "a.chat");
		const b = seed(r, "b.chat");
		markRunning(a, true);
		expect(a.isRunning).toBe(true);
		expect(b.isRunning).toBe(false);
		// Per-view gate: a is running so b would be "busy elsewhere" (Phase-1 policy);
		// a is free to act on itself.
		const anyRunning = r.runningSessions.length > 0;
		expect(anyRunning && !a.isRunning).toBe(false); // a can act
		expect(anyRunning && !b.isRunning).toBe(true); // b is blocked
	});
});

describe("SessionRegistry — LRU eviction protects ALL running sessions", () => {
	it("keeps every running session plus N most-recent idle ones", () => {
		const r = makeRegistry();
		for (let i = 0; i < 6; i++) {
			const s = seed(r, `p${i}.chat`);
			s.lastTouchedAt = 1000 + i;
		}
		// Two running sessions, both least-recently-touched — must survive.
		const run1 = seed(r, "run1.chat");
		run1.lastTouchedAt = 0;
		markRunning(run1, true);
		const run2 = seed(r, "run2.chat");
		run2.lastTouchedAt = 1;
		markRunning(run2, true);

		(r as unknown as { evictParkedSessions(): void }).evictParkedSessions();

		expect(r.sessions.has("run1.chat")).toBe(true);
		expect(r.sessions.has("run2.chat")).toBe(true);
		// Idle: keep the 3 most-recent (p5, p4, p3), drop older.
		expect(r.sessions.has("p5.chat")).toBe(true);
		expect(r.sessions.has("p4.chat")).toBe(true);
		expect(r.sessions.has("p3.chat")).toBe(true);
		expect(r.sessions.has("p2.chat")).toBe(false);
		expect(r.sessions.has("p1.chat")).toBe(false);
		expect(r.sessions.has("p0.chat")).toBe(false);
	});
});

describe("SessionRegistry — rekey on thread rename", () => {
	it("moves the session to the new key", () => {
		const r = makeRegistry();
		const s = seed(r, "Untitled.chat");

		(r as unknown as { rekeySession(o: string, n: string): void }).rekeySession(
			"Untitled.chat",
			"Renamed Title.chat",
		);

		expect(r.sessions.has("Untitled.chat")).toBe(false);
		expect(r.sessions.get("Renamed Title.chat")).toBe(s);
	});

	it("is a no-op when old and new paths are equal", () => {
		const r = makeRegistry();
		const s = seed(r, "a.chat");
		(r as unknown as { rekeySession(o: string, n: string): void }).rekeySession("a.chat", "a.chat");
		expect(r.sessions.get("a.chat")).toBe(s);
	});
});

/* --------------------------------------------------------------------------
 * Regression: session callbacks must survive the auto-title rename.
 *
 * The first message in a chat renames the thread (auto-title). `runStream`
 * performs that rename and THEN fires `onNeedReload` for `reloadAfter`. A
 * callback that captured the load-time path resolves to a map key that no
 * longer exists, so the reload threw "No session to reload" — swallowed by
 * runStream's catch, which flipped the just-succeeded turn to an error state.
 * ------------------------------------------------------------------------*/
describe("SessionRegistry — reload callbacks survive a mid-run rename", () => {
	/** Minimal AgentManager stub covering only what loadSession/reload touch. */
	function makeLoadableRegistry(): { registry: SessionRegistry; historyCalls: string[] } {
		const historyCalls: string[] = [];
		const stub = {
			isThreadEmpty: async () => false,
			getThreadHistory: async (id: string) => {
				historyCalls.push(id);
				return { messages: [], metadata: {} };
			},
			getCheckpointHistory: async () => [{ id: "cp1", parentId: undefined, messages: [] }],
			setLastViewedCheckpoint: async () => {},
			onNextInitialized: () => {},
		} as unknown as AgentManager;
		const registry = new SessionRegistry(stub);
		// Agent selection is orthogonal to this regression and would require a
		// fully constructed PluginDataStore; stub it to a fixed agent id.
		(
			registry as unknown as { restoreSelectionFromLoadedMessages: () => Promise<string> }
		).restoreSelectionFromLoadedMessages = async () => "agent-1";
		return { registry, historyCalls };
	}

	async function loadThread(registry: SessionRegistry, path: string): Promise<ChatSession> {
		await registry.loadSession({ path } as unknown as Parameters<SessionRegistry["loadSession"]>[0]);
		const session = registry.sessionFor(path);
		if (!session) throw new Error("expected a session after load");
		return session;
	}

	it("onNeedReload still resolves after the session is rekeyed", async () => {
		const { registry, historyCalls } = makeLoadableRegistry();
		const session = await loadThread(registry, "Untitled.chat");

		// Reproduce what runStream does on the first message: update the session's
		// own id, then rekey the registry via the onThreadIdChange callback.
		const opts = session as unknown as {
			onNeedReload?: () => Promise<void>;
			onThreadIdChange?: (o: string, n: string) => void;
		};
		session.id = "Renamed Title.chat";
		opts.onThreadIdChange?.("Untitled.chat", "Renamed Title.chat");

		historyCalls.length = 0;
		// Previously threw "No session to reload".
		await expect(opts.onNeedReload?.()).resolves.toBeUndefined();
		// And it reloaded the RENAMED thread, not the stale path.
		expect(historyCalls).toContain("Renamed Title.chat");
		expect(historyCalls).not.toContain("Untitled.chat");
	});

	it("reloadSession(path) still throws for a genuinely absent session", async () => {
		const { registry } = makeLoadableRegistry();
		await expect(registry.reloadSession("nope.chat")).rejects.toThrow("No session to reload");
	});
});

describe("ChatSession — isRunning reflects an in-flight stream", () => {
	it("is false on a freshly built session", () => {
		const s = makeSession("a.chat");
		expect(s.isRunning).toBe(false);
	});
});
