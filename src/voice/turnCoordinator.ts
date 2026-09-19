/**
 * Decides *when* a finished supervisor result may be handed back to the speech model.
 *
 * The Realtime API lets the conversation continue while a function call is pending,
 * but a `response.create` sent while the model is already responding (or while
 * server VAD is about to create one for the user's last utterance) fails with
 * "conversation already has an active response". So results queue here and drain
 * one at a time, only when the model is idle and the user is silent.
 *
 * Pure reducer: the orchestrator feeds it events and executes the returned actions.
 */

export interface ReadyOutput {
	callId: string;
	output: string;
}

export interface CoordinatorState {
	/** `responding` between `response.created` and `response.done`. */
	model: "idle" | "responding";
	/** `speaking` between `speech_started` and `speech_stopped`. */
	user: "silent" | "speaking";
	/**
	 * Set on `speech_stopped`: with `create_response: true` the server is about to open a
	 * response for that utterance, and ours would collide. Cleared by `response.created`
	 * or by the orchestrator's timeout when no response shows up.
	 */
	awaitingAutoResponse: boolean;
	/** Function calls handed to the supervisor whose result is still running. */
	pending: ReadonlySet<string>;
	/** Finished results waiting for a safe delivery window, oldest first. */
	ready: readonly ReadyOutput[];
	/**
	 * Latest progress line to speak while a call is pending. Only the newest is kept
	 * (narrating stale steps is worse than skipping them), and a ready result always
	 * wins over it.
	 */
	narration: string | null;
}

export type CoordinatorEvent =
	| { type: "responseCreated" }
	| { type: "responseDone" }
	| { type: "speechStarted" }
	| { type: "speechStopped" }
	| { type: "autoResponseTimedOut" }
	| { type: "functionCall"; callId: string }
	| { type: "outputReady"; callId: string; output: string }
	/** The server rejected a delivery (active response). Re-queue it at the front. */
	| { type: "deliveryRejected"; callId: string; output: string }
	/** A progress line worth speaking; replaces any earlier one still waiting. */
	| { type: "narrationReady"; text: string }
	| { type: "reset" };

export type CoordinatorAction =
	| { type: "deliver"; callId: string; output: string }
	| { type: "narrate"; text: string }
	| { type: "cancelResponse" }
	| { type: "flushPlayback" };

export function createInitialState(): CoordinatorState {
	return {
		model: "idle",
		user: "silent",
		awaitingAutoResponse: false,
		pending: new Set(),
		ready: [],
		narration: null,
	};
}

export function canDeliver(state: CoordinatorState): boolean {
	return state.model === "idle" && state.user === "silent" && !state.awaitingAutoResponse;
}

export function hasPendingWork(state: CoordinatorState): boolean {
	return state.pending.size > 0 || state.ready.length > 0;
}

export function reduce(
	state: CoordinatorState,
	event: CoordinatorEvent,
): { state: CoordinatorState; actions: CoordinatorAction[] } {
	const actions: CoordinatorAction[] = [];
	let next: CoordinatorState = state;

	switch (event.type) {
		case "responseCreated":
			next = { ...state, model: "responding", awaitingAutoResponse: false };
			break;
		case "responseDone":
			next = { ...state, model: "idle" };
			break;
		case "speechStarted":
			actions.push({ type: "flushPlayback" });
			if (state.model === "responding") actions.push({ type: "cancelResponse" });
			next = { ...state, user: "speaking", awaitingAutoResponse: false };
			break;
		case "speechStopped":
			next = { ...state, user: "silent", awaitingAutoResponse: true };
			break;
		case "autoResponseTimedOut":
			next = { ...state, awaitingAutoResponse: false };
			break;
		case "functionCall": {
			const pending = new Set(state.pending);
			pending.add(event.callId);
			next = { ...state, pending };
			break;
		}
		case "outputReady": {
			const pending = new Set(state.pending);
			pending.delete(event.callId);
			// The answer supersedes any progress line still waiting to be spoken.
			next = {
				...state,
				pending,
				ready: [...state.ready, { callId: event.callId, output: event.output }],
				narration: null,
			};
			break;
		}
		case "narrationReady":
			next = { ...state, narration: event.text };
			break;
		case "deliveryRejected":
			next = {
				...state,
				model: "responding",
				ready: [{ callId: event.callId, output: event.output }, ...state.ready],
			};
			break;
		case "reset":
			return { state: createInitialState(), actions };
	}

	// Drain at most one thing per idle window; the rest waits for `response.done`.
	// A finished result always outranks a progress line.
	if (canDeliver(next) && next.ready.length > 0) {
		const [head, ...rest] = next.ready;
		actions.push({ type: "deliver", callId: head.callId, output: head.output });
		next = { ...next, model: "responding", ready: rest, narration: null };
	} else if (canDeliver(next) && next.narration !== null && next.pending.size > 0) {
		actions.push({ type: "narrate", text: next.narration });
		next = { ...next, model: "responding", narration: null };
	}

	return { state: next, actions };
}
