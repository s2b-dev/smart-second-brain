import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioPlayback } from "../../src/voice/audioPlayback";

/* A minimal AudioContext double: just enough graph API for the playback queue, with
 * a settable clock so tests can place "now" inside a specific item. */
class FakeSource {
	buffer: unknown = null;
	onended: (() => void) | null = null;
	started: number | null = null;
	stopped = false;
	connect() {}
	disconnect() {}
	start(at: number) {
		this.started = at;
	}
	stop() {
		this.stopped = true;
	}
}

class FakeAudioContext {
	currentTime = 0;
	state = "running";
	destination = {};
	sources: FakeSource[] = [];
	createAnalyser() {
		return { fftSize: 256, connect() {}, disconnect() {}, getFloatTimeDomainData() {} };
	}
	createBuffer(_ch: number, length: number, _rate: number) {
		return { length, copyToChannel() {} };
	}
	createBufferSource() {
		const s = new FakeSource();
		this.sources.push(s);
		return s;
	}
	async resume() {}
	async close() {}
}

const samples = (ms: number) => new Int16Array((ms / 1000) * 24_000);

describe("AudioPlayback", () => {
	let ctx: FakeAudioContext;

	beforeEach(() => {
		ctx = new FakeAudioContext();
		// A plain function so `new AudioContext()` hands back the shared double.
		vi.stubGlobal(
			"AudioContext",
			vi.fn(function fakeAudioContext() {
				return ctx;
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("schedules chunks back to back and reports played time of the audible item", () => {
		const playback = new AudioPlayback();
		playback.enqueue("a", samples(500));
		playback.enqueue("a", samples(500));
		expect(ctx.sources.map((s) => s.started)).toEqual([0.02, 0.52]);

		ctx.currentTime = 0.72;
		expect(playback.flush()).toEqual({ itemId: "a", playedMs: 700 });
		expect(ctx.sources.every((s) => s.stopped)).toBe(true);
		expect(playback.isPlaying).toBe(false);
	});

	it("reports the item being heard, not a later one still queued", () => {
		const playback = new AudioPlayback();
		playback.enqueue("a", samples(1000));
		playback.enqueue("b", samples(1000));

		ctx.currentTime = 0.42;
		expect(playback.flush()).toEqual({ itemId: "a", playedMs: 400 });
	});

	it("moves on to the second item once the clock is inside it", () => {
		const playback = new AudioPlayback();
		playback.enqueue("a", samples(1000));
		playback.enqueue("b", samples(1000));

		ctx.currentTime = 1.27;
		expect(playback.flush()).toEqual({ itemId: "b", playedMs: 250 });
	});

	it("clamps to the item's length and to zero before it starts", () => {
		const playback = new AudioPlayback();
		playback.enqueue("a", samples(300));
		ctx.currentTime = 0;
		expect(playback.flush()).toEqual({ itemId: "a", playedMs: 0 });

		playback.enqueue("b", samples(300));
		ctx.currentTime = 5;
		expect(playback.flush()).toEqual({ itemId: "b", playedMs: 300 });
	});

	it("returns null when nothing was queued and after a flush", () => {
		const playback = new AudioPlayback();
		expect(playback.flush()).toBeNull();
		playback.enqueue("a", samples(100));
		playback.flush();
		expect(playback.flush()).toBeNull();
	});
});
