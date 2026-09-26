/**
 * The OpenAI Realtime wire protocol, in one place.
 *
 * Every event name the plugin sends or consumes lives in `EV`, the consumed server
 * events are typed below, and the client events are built by the `build*` helpers —
 * so when the API renames something (it has, between beta and GA) the fix is one
 * file. Everything here is pure: no sockets, no audio contexts, no stores.
 */

export const EV = {
	// client → server
	sessionUpdate: "session.update",
	audioAppend: "input_audio_buffer.append",
	itemCreate: "conversation.item.create",
	itemTruncate: "conversation.item.truncate",
	responseCreate: "response.create",
	responseCancel: "response.cancel",
	// server → client
	sessionCreated: "session.created",
	sessionUpdated: "session.updated",
	speechStarted: "input_audio_buffer.speech_started",
	speechStopped: "input_audio_buffer.speech_stopped",
	responseCreated: "response.created",
	responseDone: "response.done",
	audioDelta: "response.output_audio.delta",
	audioTranscriptDelta: "response.output_audio_transcript.delta",
	audioTranscriptDone: "response.output_audio_transcript.done",
	inputTranscriptionCompleted: "conversation.item.input_audio_transcription.completed",
	outputItemDone: "response.output_item.done",
	error: "error",
} as const;

/** Audio format the Realtime API speaks in both directions. */
export const REALTIME_SAMPLE_RATE = 24_000;

export interface FunctionCallItem {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
}

export interface OtherOutputItem {
	type: string;
	id?: string;
}

export type OutputItem = FunctionCallItem | OtherOutputItem;

export interface RealtimeError {
	type?: string;
	code?: string;
	message?: string;
	param?: string;
}

export type ServerEvent =
	| { type: typeof EV.sessionCreated; session?: unknown }
	| { type: typeof EV.sessionUpdated; session?: unknown }
	| { type: typeof EV.speechStarted; item_id?: string }
	| { type: typeof EV.speechStopped; item_id?: string }
	| { type: typeof EV.responseCreated; response: { id: string; metadata?: Record<string, unknown> | null } }
	| { type: typeof EV.responseDone; response: { id: string; status?: string } }
	| { type: typeof EV.audioDelta; response_id: string; item_id: string; delta: string }
	| { type: typeof EV.audioTranscriptDelta; item_id: string; delta: string }
	| { type: typeof EV.audioTranscriptDone; item_id: string; transcript: string }
	| { type: typeof EV.inputTranscriptionCompleted; item_id: string; transcript: string }
	| { type: typeof EV.outputItemDone; item: OutputItem }
	| { type: typeof EV.error; error: RealtimeError }
	| { type: "unknown"; rawType: string | null; raw: unknown };

const KNOWN_SERVER_TYPES: ReadonlySet<string> = new Set([
	EV.sessionCreated,
	EV.sessionUpdated,
	EV.speechStarted,
	EV.speechStopped,
	EV.responseCreated,
	EV.responseDone,
	EV.audioDelta,
	EV.audioTranscriptDelta,
	EV.audioTranscriptDone,
	EV.inputTranscriptionCompleted,
	EV.outputItemDone,
	EV.error,
]);

/**
 * Parse one server frame. Anything the plugin does not consume (and anything that
 * is not JSON) comes back as `unknown` so the caller can log it without crashing —
 * the API emits many more event types than the handful used here.
 */
export function parseServerEvent(raw: string): ServerEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { type: "unknown", rawType: null, raw };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { type: "unknown", rawType: null, raw: parsed };
	}
	const type = (parsed as { type?: unknown }).type;
	if (typeof type !== "string" || !KNOWN_SERVER_TYPES.has(type)) {
		return { type: "unknown", rawType: typeof type === "string" ? type : null, raw: parsed };
	}
	return parsed as ServerEvent;
}

export function isFunctionCallItem(item: OutputItem): item is FunctionCallItem {
	return item.type === "function_call" && typeof (item as FunctionCallItem).call_id === "string";
}

// ---------------------------------------------------------------------------
// Client event builders
// ---------------------------------------------------------------------------

export interface RealtimeToolDefinition {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface SessionConfig {
	instructions: string;
	tools: RealtimeToolDefinition[];
	voice: string;
	turnDetection: "semantic_vad" | "server_vad";
	/** Model used to transcribe the user's audio (for the transcript shown in the UI). */
	transcriptionModel: string;
}

export function buildSessionUpdate(config: SessionConfig) {
	return {
		type: EV.sessionUpdate,
		session: {
			type: "realtime",
			instructions: config.instructions,
			tools: config.tools,
			tool_choice: "auto",
			output_modalities: ["audio"],
			audio: {
				input: {
					format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
					transcription: { model: config.transcriptionModel },
					turn_detection: {
						type: config.turnDetection,
						create_response: true,
						interrupt_response: true,
					},
				},
				output: {
					format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
					voice: config.voice,
				},
			},
		},
	};
}

export function buildAudioAppend(base64Pcm16: string) {
	return { type: EV.audioAppend, audio: base64Pcm16 };
}

export function buildFunctionCallOutput(callId: string, output: string) {
	return {
		type: EV.itemCreate,
		item: { type: "function_call_output", call_id: callId, output },
	};
}

export function buildResponseCreate() {
	return { type: EV.responseCreate };
}

/** Marker carried in `response.metadata` so the client can tell its own narration responses apart. */
export const NARRATION_METADATA = { s2b: "narration" } as const;

export interface NarrationContext {
	/** The new step to convey: the assistant's own lead-in sentence for that step. */
	text: string;
	/** What the user asked the assistant to do, so the narration can relate steps to it. */
	request?: string | null;
	/** Every step so far for this request, oldest first, whether or not it was spoken. */
	stepsSoFar?: readonly string[];
	/** Lines already spoken for this request, oldest first; the model must not repeat them. */
	alreadySaid?: readonly string[];
	/** The user's most recent words, so the sentence comes out in their language. */
	userLastWords?: string | null;
}

/**
 * An out-of-band spoken progress line. `conversation: "none"` keeps it out of the
 * conversation state, so it can never be mistaken for the answer to the pending
 * function call, and the audio it produces is not an item that can be truncated.
 *
 * `input` is set explicitly. Without it the response sees the whole conversation,
 * which ends in the user's question — and the model then answers that, in the same
 * words every time, instead of conveying the step. What it gets instead is the
 * context that actually matters for a good line: the request, the steps so far,
 * what has already been said, and the new step.
 */
export function buildNarrationResponse(context: NarrationContext) {
	const alreadySaid = context.alreadySaid ?? [];
	const steps = context.stepsSoFar ?? [];
	const rules = [
		"You are the voice of an assistant that is working on the user's request in the background; you keep the user company by telling them what it is doing.",
		"Speak ONE sentence, at most fifteen words, in the language of the user's last words. No filler, no questions, no technical tool names, no markdown.",
		"The new step is a sentence the assistant wrote itself: say it in your own voice, close to its meaning, shortened if long. It usually explains why this step follows the last one — keep that.",
		"Vary how you start and phrase lines; never open two lines the same way. Relate the step to the request or to the previous step when that makes it more natural.",
		alreadySaid.length > 0
			? `Lines you already said, do not repeat or rephrase them: ${alreadySaid.map((line) => `"${line}"`).join("; ")}. If the new step adds nothing new, say a very short "still on it" in the user's language.`
			: "",
	]
		.filter(Boolean)
		.join(" ");
	const parts: string[] = [];
	if (context.userLastWords?.trim()) parts.push(`User's last words: ${context.userLastWords.trim()}`);
	if (context.request?.trim()) parts.push(`The user's request: ${context.request.trim()}`);
	if (steps.length > 0) parts.push(`Steps so far:\n${steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}`);
	parts.push(`New step: ${context.text}`);
	return {
		type: EV.responseCreate,
		response: {
			conversation: "none",
			output_modalities: ["audio"],
			metadata: NARRATION_METADATA,
			instructions: rules,
			input: [{ type: "message", role: "user", content: [{ type: "input_text", text: parts.join("\n\n") }] }],
		},
	};
}

export function isNarrationResponse(metadata: Record<string, unknown> | null | undefined): boolean {
	return metadata?.s2b === NARRATION_METADATA.s2b;
}

export function buildResponseCancel(responseId?: string) {
	return responseId ? { type: EV.responseCancel, response_id: responseId } : { type: EV.responseCancel };
}

export function buildTruncate(itemId: string, audioEndMs: number) {
	return {
		type: EV.itemTruncate,
		item_id: itemId,
		content_index: 0,
		audio_end_ms: Math.max(0, Math.round(audioEndMs)),
	};
}

// ---------------------------------------------------------------------------
// PCM16 codecs
// ---------------------------------------------------------------------------

export function float32ToPcm16(samples: Float32Array): Int16Array<ArrayBuffer> {
	const out = new Int16Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
	}
	return out;
}

export function pcm16ToFloat32(samples: Int16Array): Float32Array<ArrayBuffer> {
	const out = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		const s = samples[i];
		out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
	}
	return out;
}

/** Base64 of the little-endian bytes. Chunked so `String.fromCharCode` never sees a huge arg list. */
export function pcm16ToBase64(samples: Int16Array): string {
	const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
	}
	return btoa(binary);
}

/** Inverse of `pcm16ToBase64`. A trailing odd byte (never expected) is dropped rather than misaligned. */
export function base64ToPcm16(base64: string): Int16Array<ArrayBuffer> {
	const binary = atob(base64);
	const even = binary.length - (binary.length % 2);
	const bytes = new Uint8Array(even);
	for (let i = 0; i < even; i++) bytes[i] = binary.charCodeAt(i);
	return new Int16Array(bytes.buffer);
}

export function pcm16DurationMs(sampleCount: number, sampleRate = REALTIME_SAMPLE_RATE): number {
	return (sampleCount / sampleRate) * 1000;
}
