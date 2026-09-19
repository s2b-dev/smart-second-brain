import { describe, expect, it } from "vitest";
import {
	EV,
	base64ToPcm16,
	buildFunctionCallOutput,
	buildResponseCancel,
	buildSessionUpdate,
	buildTruncate,
	float32ToPcm16,
	isFunctionCallItem,
	parseServerEvent,
	pcm16DurationMs,
	pcm16ToBase64,
	pcm16ToFloat32,
} from "../../src/voice/realtimeProtocol";

describe("realtimeProtocol codecs", () => {
	it("round-trips float samples through PCM16 within quantisation error", () => {
		const input = new Float32Array([0, 0.5, -0.5, 0.999, -0.999, 0.001]);
		const back = pcm16ToFloat32(float32ToPcm16(input));
		for (let i = 0; i < input.length; i++) {
			expect(Math.abs(back[i] - input[i])).toBeLessThan(1 / 0x7fff + 1e-6);
		}
	});

	it("clamps out-of-range samples instead of wrapping", () => {
		const pcm = float32ToPcm16(new Float32Array([2, -2]));
		expect(pcm[0]).toBe(0x7fff);
		expect(pcm[1]).toBe(-0x8000);
	});

	it("round-trips PCM16 through base64, including a chunk boundary", () => {
		const samples = new Int16Array(40_000);
		for (let i = 0; i < samples.length; i++) samples[i] = ((i * 7919) % 65536) - 32768;
		const back = base64ToPcm16(pcm16ToBase64(samples));
		expect(back.length).toBe(samples.length);
		expect(back[0]).toBe(samples[0]);
		expect(back[33_333]).toBe(samples[33_333]);
		expect(back[samples.length - 1]).toBe(samples[samples.length - 1]);
	});

	it("drops a stray trailing byte rather than misaligning the samples", () => {
		const odd = btoa(String.fromCharCode(1, 2, 3));
		expect(base64ToPcm16(odd).length).toBe(1);
	});

	it("computes durations at the realtime sample rate", () => {
		expect(pcm16DurationMs(2400)).toBe(100);
		expect(pcm16DurationMs(24_000)).toBe(1000);
	});
});

describe("parseServerEvent", () => {
	it("returns known events as-is", () => {
		const ev = parseServerEvent(JSON.stringify({ type: EV.speechStarted, item_id: "x" }));
		expect(ev.type).toBe(EV.speechStarted);
	});

	it("maps unknown types and non-JSON to `unknown`", () => {
		expect(parseServerEvent(JSON.stringify({ type: "rate_limits.updated" }))).toEqual({
			type: "unknown",
			rawType: "rate_limits.updated",
			raw: { type: "rate_limits.updated" },
		});
		expect(parseServerEvent("not json").type).toBe("unknown");
		expect(parseServerEvent("42").type).toBe("unknown");
	});

	it("recognises function-call output items", () => {
		expect(isFunctionCallItem({ type: "function_call", call_id: "c1", name: "f", arguments: "{}" })).toBe(true);
		expect(isFunctionCallItem({ type: "message", id: "m1" })).toBe(false);
	});
});

describe("client event builders", () => {
	it("builds a session.update with tools, voice and turn detection", () => {
		const ev = buildSessionUpdate({
			instructions: "be brief",
			tools: [{ type: "function", name: "ask", description: "d", parameters: { type: "object" } }],
			voice: "marin",
			turnDetection: "semantic_vad",
			transcriptionModel: "gpt-4o-mini-transcribe",
		});
		expect(ev.type).toBe(EV.sessionUpdate);
		expect(ev.session.tools[0].name).toBe("ask");
		expect(ev.session.audio.output.voice).toBe("marin");
		expect(ev.session.audio.input.turn_detection).toEqual({
			type: "semantic_vad",
			create_response: true,
			interrupt_response: true,
		});
	});

	it("builds function outputs, cancels and truncations", () => {
		expect(buildFunctionCallOutput("c1", '{"answer":"x"}').item).toEqual({
			type: "function_call_output",
			call_id: "c1",
			output: '{"answer":"x"}',
		});
		expect(buildResponseCancel()).toEqual({ type: EV.responseCancel });
		expect(buildResponseCancel("r1")).toEqual({ type: EV.responseCancel, response_id: "r1" });
		expect(buildTruncate("i1", 1234.6)).toEqual({
			type: EV.itemTruncate,
			item_id: "i1",
			content_index: 0,
			audio_end_ms: 1235,
		});
		expect(buildTruncate("i1", -5).audio_end_ms).toBe(0);
	});
});

describe("narration responses", () => {
	it("are out-of-band, audio-only, marked, and carry the progress text", async () => {
		const { buildNarrationResponse, isNarrationResponse } = await import("../../src/voice/realtimeProtocol");
		const ev = buildNarrationResponse("Searching your notes for graph physics");
		expect(ev.type).toBe(EV.responseCreate);
		expect(ev.response.conversation).toBe("none");
		expect(ev.response.output_modalities).toEqual(["audio"]);
		expect(ev.response.instructions).toContain("Searching your notes for graph physics");
		expect(ev.response.instructions).not.toContain("already said");
		const varied = buildNarrationResponse("Reading a note", ["Searching your notes for todos"]);
		expect(varied.response.instructions).toContain('You already said: "Searching your notes for todos"');
		expect(isNarrationResponse(ev.response.metadata)).toBe(true);
		expect(isNarrationResponse(null)).toBe(false);
		expect(isNarrationResponse({ other: 1 })).toBe(false);
	});
});
