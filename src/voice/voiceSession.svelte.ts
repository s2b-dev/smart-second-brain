import { type EventRef, Notice, Platform, TFile } from "obsidian";
import type { TurnProgress } from "../stores/chatStore.svelte";
import { getData } from "../stores/dataStore.svelte";
import { getPlugin } from "../stores/state.svelte";
import { showSettingsLinkNotice } from "../utils/actionNotice";
import { Logger } from "../utils/logging";
import { type AudioCaptureHandle, startAudioCapture } from "./audioCapture";
import { AudioPlayback } from "./audioPlayback";
import { RealtimeClient } from "./realtimeClient";
import {
	EV,
	type ServerEvent,
	base64ToPcm16,
	buildAudioAppend,
	buildFunctionCallOutput,
	buildNarrationResponse,
	isNarrationResponse,
	buildResponseCancel,
	buildResponseCreate,
	buildSessionUpdate,
	buildTruncate,
	isFunctionCallItem,
} from "./realtimeProtocol";
import { describeProgress } from "./progressNarration";
import { type SupervisorBridge, type TranscriptLine, createSupervisorBridge } from "./supervisorBridge";
import {
	type CoordinatorEvent,
	type CoordinatorState,
	createInitialState,
	hasPendingWork,
	reduce,
} from "./turnCoordinator";
import {
	ASK_SECOND_BRAIN_TOOL,
	ASK_SECOND_BRAIN_TOOL_NAME,
	VOICE_SYSTEM_INSTRUCTIONS,
	VOICE_TRANSCRIPTION_MODEL,
} from "./voiceInstructions";

/**
 * The voice-mode orchestrator: one global session bound to one chat thread.
 *
 * It owns the socket, the microphone, playback, and the delivery coordinator, and
 * exposes reactive status for the orb surface. The regular agent is reached only
 * through the supervisor bridge, so nothing about how a turn runs changes when it
 * is spoken rather than typed.
 */

export type VoiceStatus = "off" | "connecting" | "listening" | "speaking" | "agentWorking" | "error";

/** How long to wait after `speech_stopped` for the server's own response before assuming none is coming. */
const AUTO_RESPONSE_GRACE_MS = 1500;
/** Minimum gap between spoken progress lines; steps often arrive seconds apart and narrating every one is noise. */
const MIN_NARRATION_GAP_MS = 5000;
/** After this many progress lines for one request the user knows it is working; stay quiet until the answer. */
const MAX_NARRATIONS_PER_DELEGATION = 3;
/** How many spoken lines the model is reminded of so it varies its wording. */
const RECENT_NARRATIONS = 4;

interface OpenAiCredentials {
	apiKey: string;
	baseUrl?: string;
}

function resolveOpenAiCredentials(): OpenAiCredentials | null {
	const data = getData();
	for (const providerId of data.getProviderIdsByTemplate("openai")) {
		if (data.isProviderUsingCodexAuth(providerId)) continue;
		const auth = data.getResolvedAuthState(providerId);
		if (auth?.apiKey) return { apiKey: auth.apiKey, baseUrl: auth.baseUrl || undefined };
	}
	return null;
}

export class VoiceSession {
	status = $state<VoiceStatus>("off");
	threadPath = $state<string | null>(null);
	errorMessage = $state<string | null>(null);
	/** Everything said so far in this voice session, oldest first. Feeds the surface and the delegation context. */
	transcript = $state<TranscriptLine[]>([]);
	/** Partial assistant line while it is still being spoken. */
	liveAssistantText = $state("");
	pendingCalls = $state(0);

	private client: RealtimeClient | null = null;
	private capture: AudioCaptureHandle | null = null;
	private playback: AudioPlayback | null = null;
	private readonly bridge: SupervisorBridge = createSupervisorBridge();
	private coordinator: CoordinatorState = createInitialState();
	private activeResponseId: string | null = null;
	private autoResponseTimer: ReturnType<typeof setTimeout> | null = null;
	private lastDelegationIndex = 0;
	private assistantDrafts = new Map<string, string>();
	private activeResponseIsNarration = false;
	private lastNarrationAt = 0;
	/** The last few progress lines actually sent, newest last. Dedupes and feeds the model's "already said". */
	private recentNarrations: string[] = [];
	private narrationsThisDelegation = 0;
	/** Every progress line of the current request, spoken or not, so a narration can relate steps. */
	private stepsThisDelegation: string[] = [];
	private currentRequest: string | null = null;
	private pendingLeadIn = new Map<string, boolean>();
	private narrationTimer: ReturnType<typeof setTimeout> | null = null;
	/** Bumped on every start/stop so a slow `start()` cannot resurrect a session the user already stopped. */
	private generation = 0;

	/** Which thread each mounted chat view currently shows, keyed by the view's token. */
	private viewPaths = new Map<symbol, string | null>();
	private detachCheckQueued = false;
	private renameRef: EventRef | null = null;

	get isActive(): boolean {
		return this.status !== "off";
	}

	/**
	 * A chat view reports the thread it shows (again on every thread change). The
	 * session is global and owns the microphone, and the views are its only visible
	 * controls — so when the last view showing the bound thread detaches, the session
	 * ends with it. A second leaf on the same thread keeps it alive.
	 */
	attachView(token: symbol, threadPath: string | null): void {
		this.viewPaths.set(token, threadPath);
	}

	detachView(token: symbol): void {
		this.viewPaths.delete(token);
		// Decide after the current flush: a view whose thread path just changed
		// (the auto-title rename) detaches and re-attaches in the same effect run,
		// and must not read as "the last view closed" in between.
		if (this.detachCheckQueued) return;
		this.detachCheckQueued = true;
		queueMicrotask(() => {
			this.detachCheckQueued = false;
			if (!this.isActive || this.threadPath === null) return;
			for (const path of this.viewPaths.values()) {
				if (path === this.threadPath) return;
			}
			this.stop();
		});
	}

	/**
	 * A chat renames itself after its first turn (auto-title). The registry re-keys
	 * the session and the view follows; the voice session must too, or its next
	 * delegation resolves a thread that no longer exists.
	 */
	handleThreadRenamed(oldPath: string, newPath: string): void {
		if (this.threadPath === oldPath) this.threadPath = newPath;
	}

	isBoundTo(threadPath: string | null): boolean {
		return this.isActive && threadPath !== null && this.threadPath === threadPath;
	}

	/** Level of whichever side is audible right now, 0..1. */
	level(): number {
		if (this.status === "speaking") return this.playback?.getLevel() ?? 0;
		if (this.status === "listening" || this.status === "agentWorking") return this.capture?.getLevel() ?? 0;
		return 0;
	}

	/** Frequency bins of whichever side is audible right now; zeroed otherwise. */
	spectrum(out: Uint8Array<ArrayBuffer>): void {
		if (this.status === "speaking" && this.playback) {
			this.playback.getSpectrum(out);
		} else if ((this.status === "listening" || this.status === "agentWorking") && this.capture) {
			this.capture.getSpectrum(out);
		} else {
			out.fill(0);
		}
	}

	async toggle(threadPath: string): Promise<void> {
		// From the error surface a second click is a retry, not a dismissal.
		if (this.isBoundTo(threadPath) && this.status !== "error") {
			this.stop();
			return;
		}
		await this.start(threadPath);
	}

	async start(threadPath: string): Promise<void> {
		if (!Platform.isDesktopApp) {
			new Notice("Voice mode is desktop-only for now.");
			return;
		}
		const data = getData();
		if (!data.voice.enabled) {
			showSettingsLinkNotice(getPlugin().app, "Enable voice mode in settings first.", {
				tab: "agents",
				linkText: "Open settings",
			});
			return;
		}
		const credentials = resolveOpenAiCredentials();
		if (!credentials) {
			showSettingsLinkNotice(getPlugin().app, "Voice mode needs an OpenAI provider with an API key.", {
				tab: "agents",
				linkText: "Open settings",
			});
			return;
		}

		if (this.isActive) this.stop();
		const generation = ++this.generation;
		this.threadPath = threadPath;
		this.errorMessage = null;
		this.transcript = [];
		this.liveAssistantText = "";
		this.lastDelegationIndex = 0;
		this.assistantDrafts.clear();
		this.coordinator = createInitialState();
		this.bridge.reset();
		this.status = "connecting";
		const vault = getPlugin().app.vault;
		this.renameRef = vault.on("rename", (file, oldPath) => {
			if (file instanceof TFile) this.handleThreadRenamed(oldPath, file.path);
		});

		try {
			const playback = new AudioPlayback(() => this.onPlaybackDrained());
			await playback.resume();
			if (generation !== this.generation) {
				playback.close();
				return;
			}
			this.playback = playback;

			const client = new RealtimeClient({
				model: data.voice.model,
				apiKey: credentials.apiKey,
				baseUrl: credentials.baseUrl,
			});
			client.onEvent((event) => {
				if (generation === this.generation) this.handleEvent(event);
			});
			client.onClose((info) => {
				if (generation !== this.generation) return;
				this.fail(`The voice connection closed (${info.code}${info.reason ? `: ${info.reason}` : ""}).`);
			});
			await client.connect();
			if (generation !== this.generation) {
				client.close();
				return;
			}
			this.client = client;
			client.send(
				buildSessionUpdate({
					instructions: VOICE_SYSTEM_INSTRUCTIONS,
					tools: [ASK_SECOND_BRAIN_TOOL],
					voice: data.voice.voice,
					turnDetection: data.voice.turnDetection,
					transcriptionModel: VOICE_TRANSCRIPTION_MODEL,
				}),
			);

			const capture = await startAudioCapture((frame) => {
				if (generation === this.generation) this.client?.send(buildAudioAppend(frame));
			});
			if (generation !== this.generation) {
				capture.stop();
				return;
			}
			this.capture = capture;
			this.status = "listening";
		} catch (err) {
			if (generation !== this.generation) return;
			const message = describeStartError(err);
			Logger.error("[voice] Failed to start:", err);
			this.fail(message);
			if (isMicrophoneError(err)) new Notice(message);
		}
	}

	stop(): void {
		this.generation++;
		this.clearAutoResponseTimer();
		if (this.renameRef) {
			getPlugin().app.vault.offref(this.renameRef);
			this.renameRef = null;
		}
		this.bridge.abort();
		this.capture?.stop();
		this.capture = null;
		this.playback?.close();
		this.playback = null;
		this.client?.close();
		this.client = null;
		this.coordinator = createInitialState();
		this.activeResponseId = null;
		this.activeResponseIsNarration = false;
		this.dropHeldNarration();
		this.recentNarrations = [];
		this.narrationsThisDelegation = 0;
		this.stepsThisDelegation = [];
		this.currentRequest = null;
		this.pendingLeadIn.clear();
		this.assistantDrafts.clear();
		this.pendingCalls = 0;
		this.liveAssistantText = "";
		this.status = "off";
		this.threadPath = null;
	}

	// ---------------------------------------------------------------------
	// Server events
	// ---------------------------------------------------------------------

	private handleEvent(event: ServerEvent): void {
		switch (event.type) {
			case EV.speechStarted: {
				const flushed = this.playback?.flush() ?? null;
				this.dispatch({ type: "speechStarted" });
				// Narration audio is out-of-band: not a conversation item, nothing to truncate.
				if (flushed && this.activeResponseId && !this.activeResponseIsNarration) {
					this.client?.send(buildTruncate(flushed.itemId, flushed.playedMs));
				}
				this.liveAssistantText = "";
				this.refreshIdleStatus();
				break;
			}
			case EV.speechStopped:
				this.dispatch({ type: "speechStopped" });
				this.armAutoResponseTimer();
				break;
			case EV.responseCreated:
				this.clearAutoResponseTimer();
				this.activeResponseId = event.response.id;
				this.activeResponseIsNarration = isNarrationResponse(event.response.metadata);
				this.dispatch({ type: "responseCreated" });
				break;
			case EV.responseDone:
				if (this.activeResponseId === event.response.id) {
					this.activeResponseId = null;
					this.activeResponseIsNarration = false;
				}
				this.dispatch({ type: "responseDone" });
				this.refreshIdleStatus();
				break;
			case EV.audioDelta:
				this.playback?.enqueue(event.item_id, base64ToPcm16(event.delta));
				this.status = "speaking";
				break;
			case EV.audioTranscriptDelta: {
				const draft = (this.assistantDrafts.get(event.item_id) ?? "") + event.delta;
				this.assistantDrafts.set(event.item_id, draft);
				this.liveAssistantText = draft;
				break;
			}
			case EV.audioTranscriptDone:
				this.assistantDrafts.delete(event.item_id);
				this.liveAssistantText = "";
				this.appendTranscript("assistant", event.transcript);
				break;
			case EV.inputTranscriptionCompleted:
				this.appendTranscript("user", event.transcript);
				break;
			case EV.outputItemDone:
				if (isFunctionCallItem(event.item) && event.item.name === ASK_SECOND_BRAIN_TOOL_NAME) {
					this.handleFunctionCall(event.item.call_id, event.item.arguments);
				}
				break;
			case EV.error:
				this.handleServerError(event.error);
				break;
			case "unknown":
				Logger.debug("[voice] Unhandled realtime event:", event.rawType);
				break;
			default:
				break;
		}
	}

	private handleFunctionCall(callId: string, rawArguments: string): void {
		let request = "";
		try {
			const parsed = JSON.parse(rawArguments) as { request?: unknown };
			if (typeof parsed.request === "string") request = parsed.request;
		} catch {
			// Fall through: an unparsable argument string is sent back as an error below.
		}
		if (!request.trim()) {
			this.deliver(callId, JSON.stringify({ error: "The request was empty." }));
			return;
		}
		if (!this.threadPath) return;

		const context = this.transcript.slice(this.lastDelegationIndex);
		this.lastDelegationIndex = this.transcript.length;
		this.dispatch({ type: "functionCall", callId });
		this.pendingCalls = this.coordinator.pending.size;
		this.refreshIdleStatus();

		const generation = this.generation;
		// The path is resolved when the queued run actually starts, so a rename that
		// lands while an earlier delegation is still running does not strand this one.
		const threadPath = () => this.threadPath;
		// A fresh request (nothing else pending) gets a fresh narration budget and history.
		if (this.coordinator.pending.size === 0) {
			this.narrationsThisDelegation = 0;
			this.stepsThisDelegation = [];
			this.recentNarrations = [];
		}
		this.currentRequest = request;
		const onProgress = (progress: TurnProgress) => {
			if (generation !== this.generation) return;
			const line = describeProgress(progress);
			if (!line) return;
			this.stepsThisDelegation = [...this.stepsThisDelegation, line.text].slice(-12);
			this.pendingLeadIn.set(line.text, line.isLeadIn);
			this.queueNarration(line.text);
		};
		void this.bridge.run({ threadPath, request, transcript: context, onProgress }).then((output) => {
			if (generation !== this.generation) return;
			// Progress for this turn is moot now; the answer is what gets spoken.
			this.dropHeldNarration();
			this.dispatch({ type: "outputReady", callId, output });
			this.pendingCalls = this.coordinator.pending.size;
			this.refreshIdleStatus();
		});
	}

	private handleServerError(error: { type?: string; code?: string; message?: string }): void {
		const message = error.message ?? "";
		// Our own `response.cancel` racing the server's `response.done` is harmless.
		if (error.code === "response_cancel_not_active" || /no active response/i.test(message)) return;
		if (/already has an active response/i.test(message)) {
			// Our delivery collided with a response the server opened meanwhile. The
			// output item is already in the conversation, so re-issuing `response.create`
			// once this one finishes is enough — the coordinator's `responseDone` path does
			// exactly that if we hand the output back to it.
			const last = this.lastDelivery;
			if (last) this.dispatch({ type: "deliveryRejected", callId: last.callId, output: last.output });
			return;
		}
		Logger.warn("[voice] Realtime error:", error);
		this.fail(message || "The realtime API reported an error.");
	}

	// ---------------------------------------------------------------------
	// Coordinator + delivery
	// ---------------------------------------------------------------------

	private lastDelivery: { callId: string; output: string } | null = null;
	private deliveredCallIds = new Set<string>();

	private dispatch(event: CoordinatorEvent): void {
		const { state, actions } = reduce(this.coordinator, event);
		this.coordinator = state;
		for (const action of actions) {
			switch (action.type) {
				case "flushPlayback":
					this.playback?.flush();
					break;
				case "cancelResponse":
					this.client?.send(buildResponseCancel(this.activeResponseId ?? undefined));
					break;
				case "deliver":
					this.deliver(action.callId, action.output);
					break;
				case "narrate":
					this.lastNarrationAt = Date.now();
					this.narrationsThisDelegation += 1;
					this.client?.send(
						buildNarrationResponse({
							text: action.text,
							isLeadIn: this.pendingLeadIn.get(action.text) ?? false,
							request: this.currentRequest,
							// Everything before the new step, so it can be related to what came earlier.
							stepsSoFar: this.stepsThisDelegation.filter((step) => step !== action.text),
							alreadySaid: this.recentNarrations,
							userLastWords: this.transcript.findLast((line) => line.role === "user")?.text ?? null,
						}),
					);
					this.pendingLeadIn.delete(action.text);
					this.recentNarrations = [...this.recentNarrations, action.text].slice(-RECENT_NARRATIONS);
					break;
			}
		}
	}

	private deliver(callId: string, output: string): void {
		this.lastDelivery = { callId, output };
		// The output item is created once; a retry after a collision only needs a new response.
		if (!this.deliveredCallIds.has(callId)) {
			this.deliveredCallIds.add(callId);
			this.client?.send(buildFunctionCallOutput(callId, output));
		}
		this.client?.send(buildResponseCreate());
	}

	/**
	 * Rate-limit progress lines: a step that lands within the gap is held (only the
	 * newest survives) and released when the gap has passed. Repeats are dropped.
	 */
	private queueNarration(text: string): void {
		if (!text.trim()) return;
		if (this.narrationsThisDelegation >= MAX_NARRATIONS_PER_DELEGATION) return;
		const key = text.toLowerCase();
		if (this.recentNarrations.some((line) => line.toLowerCase() === key)) return;
		const wait = MIN_NARRATION_GAP_MS - (Date.now() - this.lastNarrationAt);
		if (wait <= 0) {
			this.dispatch({ type: "narrationReady", text });
			return;
		}
		if (this.narrationTimer) clearTimeout(this.narrationTimer);
		this.narrationTimer = setTimeout(() => {
			this.narrationTimer = null;
			// The turn this described may have settled meanwhile; a progress line with
			// nothing pending would only be spoken at the start of the next request.
			if (this.coordinator.pending.size === 0) return;
			this.dispatch({ type: "narrationReady", text });
		}, wait);
	}

	private dropHeldNarration(): void {
		if (this.narrationTimer) {
			clearTimeout(this.narrationTimer);
			this.narrationTimer = null;
		}
	}

	private armAutoResponseTimer(): void {
		this.clearAutoResponseTimer();
		this.autoResponseTimer = setTimeout(() => {
			this.autoResponseTimer = null;
			this.dispatch({ type: "autoResponseTimedOut" });
		}, AUTO_RESPONSE_GRACE_MS);
	}

	private clearAutoResponseTimer(): void {
		if (this.autoResponseTimer) {
			clearTimeout(this.autoResponseTimer);
			this.autoResponseTimer = null;
		}
	}

	// ---------------------------------------------------------------------
	// Status + transcript
	// ---------------------------------------------------------------------

	private onPlaybackDrained(): void {
		if (this.status === "speaking") this.refreshIdleStatus();
	}

	/** Pick the resting status once nothing is being spoken. */
	private refreshIdleStatus(): void {
		if (this.status === "off" || this.status === "error" || this.status === "connecting") return;
		if (this.playback?.isPlaying) {
			this.status = "speaking";
			return;
		}
		this.status = hasPendingWork(this.coordinator) ? "agentWorking" : "listening";
	}

	private appendTranscript(role: TranscriptLine["role"], text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.transcript = [...this.transcript, { role, text: trimmed }];
	}

	private fail(message: string): void {
		const threadPath = this.threadPath;
		this.stop();
		// Keep the surface up with the error so the user sees why it ended.
		this.threadPath = threadPath;
		this.errorMessage = message;
		this.status = "error";
	}
}

function isMicrophoneError(err: unknown): boolean {
	return err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "NotFoundError");
}

function describeStartError(err: unknown): string {
	if (isMicrophoneError(err)) return "Microphone access was denied or no microphone was found.";
	if (err instanceof Error) return err.message;
	return "Voice mode could not start.";
}

let instance: VoiceSession | null = null;

export function getVoiceSession(): VoiceSession {
	if (!instance) instance = new VoiceSession();
	return instance;
}
