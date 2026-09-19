/**
 * AudioWorklet processor for voice-mode microphone capture.
 *
 * Plain JS on purpose: it is imported as raw text (`?raw`) and loaded through a
 * blob URL, so nothing here is transpiled. It accumulates the 128-frame render
 * quanta into 100 ms frames (2400 samples at the 24 kHz context rate) and posts
 * each one to the main thread, transferring the buffer instead of copying it.
 */
const FRAME_SAMPLES = 2400;

class CaptureProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.buffer = new Float32Array(FRAME_SAMPLES);
		this.offset = 0;
	}

	process(inputs) {
		const channel = inputs[0]?.[0];
		if (!channel) return true;
		let i = 0;
		while (i < channel.length) {
			const n = Math.min(channel.length - i, FRAME_SAMPLES - this.offset);
			this.buffer.set(channel.subarray(i, i + n), this.offset);
			this.offset += n;
			i += n;
			if (this.offset === FRAME_SAMPLES) {
				const frame = this.buffer;
				this.port.postMessage(frame, [frame.buffer]);
				this.buffer = new Float32Array(FRAME_SAMPLES);
				this.offset = 0;
			}
		}
		return true;
	}
}

registerProcessor("s2b-capture", CaptureProcessor);
