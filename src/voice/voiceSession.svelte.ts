import { Notice, Platform } from "obsidian";
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
	buildResponseCancel,
	buildResponseCreate,
	buildSessionUpdate,
	buildTruncate,
	isFunctionCallItem,
} from "./realtimeProtocol";
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
	/** Bumped on every start/stop so a slow `start()` cannot resurrect a session the user already stopped. */
	private generation = 0;

	get isActive(): boolean {
		return this.status !== "off";
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
				tab: "general",
				linkText: "Open settings",
			});
			return;
		}
		const credentials = resolveOpenAiCredentials();
		if (!credentials) {
			showSettingsLinkNotice(getPlugin().app, "Voice mode needs an OpenAI provider with an API key.", {
				tab: "general",
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
		this.bridge.abort();
		this.capture?.stop();
		this.capture = null;
		this.playback?.close();
		this.playback = null;
		this.client?.close();
		this.client = null;
		this.coordinator = createInitialState();
		this.activeResponseId = null;
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
				if (flushed && this.activeResponseId) {
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
				this.dispatch({ type: "responseCreated" });
				break;
			case EV.responseDone:
				if (this.activeResponseId === event.response.id) this.activeResponseId = null;
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
		const threadPath = this.threadPath;
		if (!threadPath) return;

		const context = this.transcript.slice(this.lastDelegationIndex);
		this.lastDelegationIndex = this.transcript.length;
		this.dispatch({ type: "functionCall", callId });
		this.pendingCalls = this.coordinator.pending.size;
		this.refreshIdleStatus();

		const generation = this.generation;
		void this.bridge.run({ threadPath, request, transcript: context }).then((output) => {
			if (generation !== this.generation) return;
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
