import workletSource from "./capture.worklet.js?raw";
import { REALTIME_SAMPLE_RATE, float32ToPcm16, pcm16ToBase64 } from "./realtimeProtocol";

/**
 * Microphone → 24 kHz mono PCM16 → base64 frames, 100 ms each.
 *
 * The context is opened at the API's sample rate so Chromium does the resampling
 * from the device rate; the worklet then only has to slice. Echo cancellation and
 * noise suppression are requested from the platform, but note Chromium cannot
 * cancel audio the page itself renders through WebAudio, so with speakers the
 * model may hear itself — the prototype assumes headphones.
 */

export interface AudioCaptureHandle {
	/** 0..1 RMS of the last analyser window, for the orb. */
	getLevel(): number;
	stop(): void;
}

const WORKLET_NAME = "s2b-capture";

export async function startAudioCapture(onFrame: (base64Pcm16: string) => void): Promise<AudioCaptureHandle> {
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
	});

	const ctx = new AudioContext({ sampleRate: REALTIME_SAMPLE_RATE });
	const workletUrl = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
	try {
		await ctx.audioWorklet.addModule(workletUrl);
	} catch (err) {
		URL.revokeObjectURL(workletUrl);
		for (const track of stream.getTracks()) track.stop();
		void ctx.close();
		throw err;
	}
	URL.revokeObjectURL(workletUrl);
	if (ctx.state === "suspended") await ctx.resume();

	const source = ctx.createMediaStreamSource(stream);
	const analyser = ctx.createAnalyser();
	analyser.fftSize = 256;
	const worklet = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1 });
	// A node whose output goes nowhere may be skipped by the graph; route it through a
	// muted gain so the processor keeps running without anything reaching the speakers.
	const mute = ctx.createGain();
	mute.gain.value = 0;

	source.connect(analyser);
	analyser.connect(worklet);
	worklet.connect(mute);
	mute.connect(ctx.destination);

	worklet.port.onmessage = (ev: MessageEvent<Float32Array>) => {
		onFrame(pcm16ToBase64(float32ToPcm16(ev.data)));
	};

	const frame = new Float32Array(analyser.fftSize);
	let stopped = false;

	return {
		getLevel() {
			if (stopped) return 0;
			analyser.getFloatTimeDomainData(frame);
			let sum = 0;
			for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
			return Math.min(1, Math.sqrt(sum / frame.length) * 3);
		},
		stop() {
			if (stopped) return;
			stopped = true;
			worklet.port.onmessage = null;
			worklet.disconnect();
			analyser.disconnect();
			source.disconnect();
			mute.disconnect();
			for (const track of stream.getTracks()) track.stop();
			void ctx.close();
		},
	};
}
