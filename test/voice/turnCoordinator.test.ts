import { describe, expect, it } from "vitest";
import {
	type CoordinatorAction,
	type CoordinatorEvent,
	type CoordinatorState,
	canDeliver,
	createInitialState,
	hasPendingWork,
	reduce,
} from "../../src/voice/turnCoordinator";

function play(events: CoordinatorEvent[], from = createInitialState()) {
	const log: CoordinatorAction[] = [];
	let state: CoordinatorState = from;
	for (const ev of events) {
		const r = reduce(state, ev);
		state = r.state;
		log.push(...r.actions);
	}
	return { state, actions: log };
}

const deliveries = (actions: CoordinatorAction[]) => actions.filter((a) => a.type === "deliver");

describe("turnCoordinator", () => {
	it("delivers a result immediately when the model is idle and the user silent", () => {
		const { state, actions } = play([
			{ type: "functionCall", callId: "c1" },
			{ type: "responseDone" },
			{ type: "outputReady", callId: "c1", output: "o1" },
		]);
		expect(deliveries(actions)).toEqual([{ type: "deliver", callId: "c1", output: "o1" }]);
		expect(state.model).toBe("responding");
		expect(state.ready).toEqual([]);
		expect(hasPendingWork(state)).toBe(false);
	});

	it("holds a result while the model is responding and drains it on response.done", () => {
		const { state: held, actions: a1 } = play([
			{ type: "functionCall", callId: "c1" },
			{ type: "responseCreated" },
			{ type: "outputReady", callId: "c1", output: "o1" },
		]);
		expect(deliveries(a1)).toEqual([]);
		expect(held.ready).toHaveLength(1);

		const { actions: a2 } = play([{ type: "responseDone" }], held);
		expect(deliveries(a2)).toEqual([{ type: "deliver", callId: "c1", output: "o1" }]);
	});

	it("holds a result while the user is speaking and until the auto-response window closes", () => {
		const { state: s1, actions: a1 } = play([
			{ type: "functionCall", callId: "c1" },
			{ type: "speechStarted" },
			{ type: "outputReady", callId: "c1", output: "o1" },
		]);
		expect(deliveries(a1)).toEqual([]);

		// speech_stopped: the server is about to create its own response.
		const { state: s2, actions: a2 } = play([{ type: "speechStopped" }], s1);
		expect(deliveries(a2)).toEqual([]);
		expect(canDeliver(s2)).toBe(false);

		// That response runs and finishes; only then does ours go out.
		const { actions: a3 } = play([{ type: "responseCreated" }, { type: "responseDone" }], s2);
		expect(deliveries(a3)).toEqual([{ type: "deliver", callId: "c1", output: "o1" }]);
	});

	it("releases the auto-response guard on timeout when no response shows up", () => {
		const { actions } = play([
			{ type: "functionCall", callId: "c1" },
			{ type: "speechStarted" },
			{ type: "speechStopped" },
			{ type: "outputReady", callId: "c1", output: "o1" },
			{ type: "autoResponseTimedOut" },
		]);
		expect(deliveries(actions)).toHaveLength(1);
	});

	it("delivers one result per idle window when several are ready", () => {
		const { state: s1, actions: a1 } = play([
			{ type: "functionCall", callId: "c1" },
			{ type: "functionCall", callId: "c2" },
			{ type: "responseCreated" },
			{ type: "outputReady", callId: "c1", output: "o1" },
			{ type: "outputReady", callId: "c2", output: "o2" },
			{ type: "responseDone" },
		]);
		expect(deliveries(a1)).toEqual([{ type: "deliver", callId: "c1", output: "o1" }]);
		expect(s1.ready).toEqual([{ callId: "c2", output: "o2" }]);

		const { actions: a2 } = play([{ type: "responseDone" }], s1);
		expect(deliveries(a2)).toEqual([{ type: "deliver", callId: "c2", output: "o2" }]);
	});

	it("flushes playback and cancels the response on barge-in, without dropping pending calls", () => {
		const { state, actions } = play([
			{ type: "functionCall", callId: "c1" },
			{ type: "responseCreated" },
			{ type: "speechStarted" },
		]);
		expect(actions).toEqual([{ type: "flushPlayback" }, { type: "cancelResponse" }]);
		expect(state.pending.has("c1")).toBe(true);
	});

	it("only flushes on barge-in when nothing is being spoken", () => {
		const { actions } = play([{ type: "speechStarted" }]);
		expect(actions).toEqual([{ type: "flushPlayback" }]);
	});

	it("re-queues a rejected delivery at the front and waits for the active response", () => {
		const { state: s1 } = play([
			{ type: "functionCall", callId: "c1" },
			{ type: "functionCall", callId: "c2" },
			{ type: "responseCreated" },
			{ type: "outputReady", callId: "c2", output: "o2" },
		]);
		const { state: s2, actions: a2 } = play([{ type: "deliveryRejected", callId: "c1", output: "o1" }], s1);
		expect(deliveries(a2)).toEqual([]);
		expect(s2.ready.map((r) => r.callId)).toEqual(["c1", "c2"]);

		const { actions: a3 } = play([{ type: "responseDone" }], s2);
		expect(deliveries(a3)).toEqual([{ type: "deliver", callId: "c1", output: "o1" }]);
	});

	it("reset drops everything", () => {
		const { state } = play([
			{ type: "functionCall", callId: "c1" },
			{ type: "responseCreated" },
			{ type: "outputReady", callId: "c1", output: "o1" },
			{ type: "reset" },
		]);
		expect(state).toEqual(createInitialState());
	});
});

describe("turnCoordinator narration", () => {
	it("speaks a progress line while a call is pending and the model is idle", () => {
		const { state, actions } = play([
			{ type: "functionCall", callId: "c1" },
			{ type: "narrationReady", text: "Searching your notes" },
		]);
		expect(actions).toEqual([{ type: "narrate", text: "Searching your notes" }]);
		expect(state.model).toBe("responding");
		expect(state.narration).toBeNull();
	});

	it("holds a progress line while the model responds and keeps only the newest", () => {
		const { state: held, actions: a1 } = play([
			{ type: "functionCall", callId: "c1" },
			{ type: "responseCreated" },
			{ type: "narrationReady", text: "first" },
			{ type: "narrationReady", text: "second" },
		]);
		expect(a1).toEqual([]);
		expect(held.narration).toBe("second");

		const { actions: a2 } = play([{ type: "responseDone" }], held);
		expect(a2).toEqual([{ type: "narrate", text: "second" }]);
	});

	it("never narrates over the user, and drops the line once the answer is ready", () => {
		const { state: s1, actions: a1 } = play([
			{ type: "functionCall", callId: "c1" },
			{ type: "speechStarted" },
			{ type: "narrationReady", text: "reading a note" },
		]);
		expect(deliveries(a1)).toEqual([]);
		expect(a1.some((a) => a.type === "narrate")).toBe(false);

		const { state: s2, actions: a2 } = play(
			[
				{ type: "speechStopped" },
				{ type: "autoResponseTimedOut" },
				{ type: "outputReady", callId: "c1", output: "o" },
			],
			s1,
		);
		expect(a2).toEqual([{ type: "deliver", callId: "c1", output: "o" }]);
		expect(s2.narration).toBeNull();
	});

	it("prefers a ready result over a waiting progress line", () => {
		const { actions } = play([
			{ type: "functionCall", callId: "c1" },
			{ type: "responseCreated" },
			{ type: "narrationReady", text: "almost there" },
			{ type: "outputReady", callId: "c1", output: "o" },
			{ type: "responseDone" },
		]);
		expect(actions).toEqual([{ type: "deliver", callId: "c1", output: "o" }]);
	});

	it("does not narrate when nothing is pending", () => {
		const { actions } = play([{ type: "narrationReady", text: "stray" }]);
		expect(actions).toEqual([]);
	});
});
