import { AssistantState } from "../stores/chatTimeline";
import type { SettledTurn, TurnProgress } from "../stores/chatStore.svelte";
import { getSessionRegistry } from "../stores/chatStore.svelte";
import { Logger } from "../utils/logging";

/**
 * The one function the speech model can call, implemented as a normal chat turn.
 *
 * The bridge resolves the thread's `ChatSession`, sends the request through the same
 * path a typed message takes (so the turn is persisted, streamed, and reviewable on
 * screen), waits for it to settle, and returns a JSON string for the model to read
 * back. Runs are serialised: `ChatSession` refuses overlapping runs, and the speech
 * model occasionally fires two calls in one breath.
 */

export interface TranscriptLine {
	role: "user" | "assistant";
	text: string;
}

/** The slice of `ChatSession` the bridge needs; narrowed so tests can fake it. */
export interface SupervisorSession {
	readonly isRunning: boolean;
	sendMessageAndAwait(content: string): Promise<SettledTurn>;
	stopStreaming(): void;
	subscribeTurnProgress?(listener: (progress: TurnProgress) => void): () => void;
}

export type SessionResolver = (threadPath: string) => SupervisorSession | null;

export interface SupervisorRequest {
	/** The thread to run on; a function is resolved when the run starts (renames may land while queued). */
	threadPath: string | (() => string | null);
	request: string;
	/** Voice exchanges since the previous delegation, oldest first. */
	transcript: readonly TranscriptLine[];
	/** Tool starts while the turn runs, for spoken progress. */
	onProgress?: (progress: TurnProgress) => void;
}

const NO_SESSION_OUTPUT = JSON.stringify({ error: "The chat this voice session belongs to is no longer open." });
const CANCELLED_OUTPUT = JSON.stringify({ error: "The request was cancelled in the chat." });
const ABORTED_OUTPUT = JSON.stringify({ error: "Voice mode was stopped before the request ran." });

/**
 * What lands in the thread as the user message. The speech model phrases the request
 * self-contained, so most of the voice exchange is redundant with it: the utterance
 * that triggered the call is the request itself, and the assistant's voice lines
 * are fillers by design. Only the user's *earlier* words can add something the
 * request lacks ("I'm prepping for the meeting with Anna" a turn before "what are my
 * tasks"), so those are all that is kept — and when there are none, the request
 * stands alone.
 */
export function buildDelegationMessage(request: string, transcript: readonly TranscriptLine[]): string {
	const trimmed = request.trim();
	const userLines = transcript.filter((line) => line.role === "user");
	// The last user line is the one that produced this request.
	const earlier = userLines
		.slice(0, -1)
		.map((line) => line.text.trim())
		.filter(Boolean);
	if (earlier.length === 0) return trimmed;
	const lines = earlier.map((text) => `User: ${text}`);
	return `[What the user said earlier in this voice conversation, for context only]\n${lines.join("\n")}\n\n[Request]\n${trimmed}`;
}

export function formatSettledTurn(turn: SettledTurn): string {
	switch (turn.state) {
		case AssistantState.success:
			return JSON.stringify({ answer: turn.content.trim() || "(The assistant returned an empty answer.)" });
		case AssistantState.cancelled:
			return CANCELLED_OUTPUT;
		default:
			return JSON.stringify({ error: turn.errorCode || "The request failed." });
	}
}

export class SupervisorBridge {
	private queue: Promise<unknown> = Promise.resolve();
	private active: SupervisorSession | null = null;
	private aborted = false;

	constructor(private readonly resolveSession: SessionResolver) {}

	/** Run one delegated turn. Resolves with the JSON output for the speech model; never rejects. */
	run(req: SupervisorRequest): Promise<string> {
		const task = this.queue.then(() => this.execute(req));
		this.queue = task.catch(() => undefined);
		return task;
	}

	/**
	 * Stop the in-flight turn (if it is ours) and drop everything queued behind it.
	 * Called when voice mode ends; a typed Stop in the chat reaches the same run through
	 * the session itself.
	 */
	abort(): void {
		this.aborted = true;
		const session = this.active;
		if (session?.isRunning) {
			try {
				session.stopStreaming();
			} catch (err) {
				Logger.warn("[voice] Could not stop the supervisor run:", err);
			}
		}
	}

	/** Re-arm after `abort()` so a fresh voice session can delegate again. */
	reset(): void {
		this.aborted = false;
		this.active = null;
		this.queue = Promise.resolve();
	}

	private async execute(req: SupervisorRequest): Promise<string> {
		if (this.aborted) return ABORTED_OUTPUT;
		const threadPath = typeof req.threadPath === "function" ? req.threadPath() : req.threadPath;
		const session = threadPath ? this.resolveSession(threadPath) : null;
		if (!session) return NO_SESSION_OUTPUT;
		this.active = session;
		const onProgress = req.onProgress;
		const unsubscribe =
			onProgress && session.subscribeTurnProgress ? session.subscribeTurnProgress(onProgress) : null;
		try {
			const turn = await session.sendMessageAndAwait(buildDelegationMessage(req.request, req.transcript));
			return formatSettledTurn(turn);
		} catch (err) {
			Logger.error("[voice] Supervisor turn threw:", err);
			return JSON.stringify({ error: "The request failed unexpectedly." });
		} finally {
			unsubscribe?.();
			this.active = null;
		}
	}
}

export function createSupervisorBridge(): SupervisorBridge {
	return new SupervisorBridge((threadPath) => getSessionRegistry()?.sessionFor(threadPath) ?? null);
}
