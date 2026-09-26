import { REALTIME_SAMPLE_RATE, pcm16DurationMs, pcm16ToFloat32 } from "./realtimeProtocol";

/**
 * Gapless playback of the model's PCM16 chunks.
 *
 * Each chunk becomes an `AudioBuffer` scheduled back-to-back on the context clock.
 * Chunks are grouped by the assistant item they belong to so a barge-in can report
 * how much of the current item the user actually heard — the API needs that to
 * truncate its own copy of the transcript.
 */

export interface FlushResult {
	itemId: string;
	playedMs: number;
}

/** Lead time before the first chunk starts, so scheduling never lands in the past. */
const START_LEAD_S = 0.02;

export class AudioPlayback {
	private readonly ctx: AudioContext;
	private readonly analyser: AnalyserNode;
	private readonly window: Float32Array<ArrayBuffer>;
	private readonly sources = new Set<AudioBufferSourceNode>();
	private nextStartTime = 0;
	/** Every item with queued audio, in playback order; the last one is still receiving chunks. */
	private items: { itemId: string; startTime: number; enqueuedMs: number }[] = [];
	private closed = false;

	constructor(private readonly onDrained?: () => void) {
		this.ctx = new AudioContext({ sampleRate: REALTIME_SAMPLE_RATE });
		this.analyser = this.ctx.createAnalyser();
		this.analyser.fftSize = 256;
		this.analyser.connect(this.ctx.destination);
		this.window = new Float32Array(this.analyser.fftSize);
	}

	get isPlaying(): boolean {
		return this.sources.size > 0;
	}

	async resume(): Promise<void> {
		if (this.ctx.state === "suspended") await this.ctx.resume();
	}

	enqueue(itemId: string, pcm16: Int16Array): void {
		if (this.closed || pcm16.length === 0) return;
		const buffer = this.ctx.createBuffer(1, pcm16.length, REALTIME_SAMPLE_RATE);
		buffer.copyToChannel(pcm16ToFloat32(pcm16), 0);

		const startAt = Math.max(this.ctx.currentTime + START_LEAD_S, this.nextStartTime);
		const durationMs = pcm16DurationMs(pcm16.length);
		let item = this.items.at(-1);
		if (!item || item.itemId !== itemId) {
			item = { itemId, startTime: startAt, enqueuedMs: 0 };
			this.items.push(item);
		}
		item.enqueuedMs += durationMs;

		const source = this.ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(this.analyser);
		source.onended = () => {
			source.disconnect();
			this.sources.delete(source);
			if (this.sources.size === 0 && !this.closed) this.onDrained?.();
		};
		this.sources.add(source);
		source.start(startAt);
		this.nextStartTime = startAt + durationMs / 1000;
	}

	/**
	 * Stop everything now; report the item that was audible at this moment and how much
	 * of it had played. Items queued behind it have not been heard at all, and an item
	 * that already finished is not the one to truncate.
	 */
	flush(): FlushResult | null {
		const now = this.ctx.currentTime;
		const audible = this.items.filter((item) => item.startTime <= now).at(-1) ?? this.items[0] ?? null;
		for (const source of this.sources) {
			source.onended = null;
			try {
				source.stop();
			} catch {
				// Not started yet or already ended.
			}
			source.disconnect();
		}
		this.sources.clear();
		this.nextStartTime = 0;
		this.items = [];
		if (!audible) return null;
		// Whole milliseconds: that is what the truncate event carries, and it keeps the
		// float clock's noise out of the number.
		const playedMs = Math.round(Math.max(0, Math.min(audible.enqueuedMs, (now - audible.startTime) * 1000)));
		return { itemId: audible.itemId, playedMs };
	}

	/** 0..1 RMS of what is being rendered right now, for the orb. */
	getLevel(): number {
		if (this.closed || this.sources.size === 0) return 0;
		this.analyser.getFloatTimeDomainData(this.window);
		let sum = 0;
		for (let i = 0; i < this.window.length; i++) sum += this.window[i] * this.window[i];
		return Math.min(1, Math.sqrt(sum / this.window.length) * 3);
	}

	/** Byte frequency bins (0..255) of what is being rendered, for the spectrum-style orb. */
	getSpectrum(out: Uint8Array<ArrayBuffer>): void {
		if (this.closed || this.sources.size === 0) {
			out.fill(0);
			return;
		}
		this.analyser.getByteFrequencyData(out);
	}

	close(): void {
		if (this.closed) return;
		this.flush();
		this.closed = true;
		this.analyser.disconnect();
		void this.ctx.close();
	}
}
