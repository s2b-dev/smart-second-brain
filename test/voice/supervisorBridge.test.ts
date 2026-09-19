import { describe, expect, it, vi } from "vitest";
import { AssistantState } from "../../src/stores/chatTimeline";
import type { SettledTurn } from "../../src/stores/chatStore.svelte";
import {
	SupervisorBridge,
	type SupervisorSession,
	buildDelegationMessage,
	formatSettledTurn,
} from "../../src/voice/supervisorBridge";

function fakeSession(handler: (content: string) => Promise<SettledTurn>): SupervisorSession & { stops: number } {
	const session = {
		isRunning: false,
		stops: 0,
		async sendMessageAndAwait(content: string) {
			session.isRunning = true;
			try {
				return await handler(content);
			} finally {
				session.isRunning = false;
			}
		},
		stopStreaming() {
			session.stops++;
		},
	};
	return session;
}

const ok = (content: string): SettledTurn => ({ state: AssistantState.success, content });

describe("buildDelegationMessage", () => {
	it("is just the request when there is no voice context", () => {
		expect(buildDelegationMessage("  what did I write?  ", [])).toBe("what did I write?");
	});

	it("prefixes the labelled voice transcript", () => {
		const msg = buildDelegationMessage("summarise it", [
			{ role: "user", text: "hey" },
			{ role: "assistant", text: "hi there" },
		]);
		expect(msg).toBe(
			"[Voice conversation since the last request, for context only]\nUser: hey\nAssistant (voice): hi there\n\n[Request]\nsummarise it",
		);
	});
});

describe("formatSettledTurn", () => {
	it("maps success, cancel and error to JSON the speech model can read", () => {
		expect(JSON.parse(formatSettledTurn(ok(" answer ")))).toEqual({ answer: "answer" });
		expect(JSON.parse(formatSettledTurn(ok("")))).toEqual({ answer: "(The assistant returned an empty answer.)" });
		expect(JSON.parse(formatSettledTurn({ state: AssistantState.cancelled, content: "p" }))).toEqual({
			error: "The request was cancelled in the chat.",
		});
		expect(JSON.parse(formatSettledTurn({ state: AssistantState.error, content: "", errorCode: "boom" }))).toEqual({
			error: "boom",
		});
	});
});

describe("SupervisorBridge", () => {
	it("sends the delegation message to the thread's session and returns the answer", async () => {
		const seen: string[] = [];
		const session = fakeSession(async (c) => {
			seen.push(c);
			return ok("42");
		});
		const bridge = new SupervisorBridge((path) => (path === "t.chat" ? session : null));

		const out = await bridge.run({
			threadPath: "t.chat",
			request: "q",
			transcript: [{ role: "user", text: "yo" }],
		});

		expect(JSON.parse(out)).toEqual({ answer: "42" });
		expect(seen[0]).toContain("[Request]\nq");
		expect(seen[0]).toContain("User: yo");
	});

	it("resolves a thread-path function when the run starts, so a rename while queued is honoured", async () => {
		const seen: string[] = [];
		const bridge = new SupervisorBridge((path) => {
			seen.push(path);
			return path === "new.chat" ? fakeSession(async () => ok("hi")) : null;
		});
		let current = "old.chat";
		const first = bridge.run({ threadPath: () => current, request: "a", transcript: [] });
		current = "new.chat";
		const out = await first;
		expect(seen).toEqual(["new.chat"]);
		expect(JSON.parse(out)).toEqual({ answer: "hi" });
	});

	it("reports a missing session without throwing", async () => {
		const bridge = new SupervisorBridge(() => null);
		expect(JSON.parse(await bridge.run({ threadPath: "gone", request: "q", transcript: [] }))).toEqual({
			error: "The chat this voice session belongs to is no longer open.",
		});
	});

	it("serialises overlapping calls so the session never sees two runs at once", async () => {
		const order: string[] = [];
		let release: (() => void) | undefined;
		const session = fakeSession(async (c) => {
			order.push(`start:${c}`);
			if (c === "a") {
				await new Promise<void>((r) => {
					release = r;
				});
			}
			order.push(`end:${c}`);
			return ok(c);
		});
		const bridge = new SupervisorBridge(() => session);

		const first = bridge.run({ threadPath: "t", request: "a", transcript: [] });
		const second = bridge.run({ threadPath: "t", request: "b", transcript: [] });
		await vi.waitFor(() => expect(release).toBeDefined());
		expect(order).toEqual(["start:a"]);
		release?.();

		expect(JSON.parse(await first)).toEqual({ answer: "a" });
		expect(JSON.parse(await second)).toEqual({ answer: "b" });
		expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
	});

	it("abort stops the in-flight run and short-circuits anything queued", async () => {
		let release: (() => void) | undefined;
		const session = fakeSession(async () => {
			await new Promise<void>((r) => {
				release = r;
			});
			return { state: AssistantState.cancelled, content: "" };
		});
		const bridge = new SupervisorBridge(() => session);

		const first = bridge.run({ threadPath: "t", request: "a", transcript: [] });
		const second = bridge.run({ threadPath: "t", request: "b", transcript: [] });
		await vi.waitFor(() => expect(release).toBeDefined());

		bridge.abort();
		expect(session.stops).toBe(1);
		release?.();

		expect(JSON.parse(await first)).toEqual({ error: "The request was cancelled in the chat." });
		expect(JSON.parse(await second)).toEqual({ error: "Voice mode was stopped before the request ran." });
	});

	it("abort is a no-op when nothing is running, and reset re-arms the bridge", async () => {
		const session = fakeSession(async () => ok("x"));
		const bridge = new SupervisorBridge(() => session);
		bridge.abort();
		expect(session.stops).toBe(0);
		expect(JSON.parse(await bridge.run({ threadPath: "t", request: "a", transcript: [] }))).toEqual({
			error: "Voice mode was stopped before the request ran.",
		});
		bridge.reset();
		expect(JSON.parse(await bridge.run({ threadPath: "t", request: "a", transcript: [] }))).toEqual({
			answer: "x",
		});
	});
});
