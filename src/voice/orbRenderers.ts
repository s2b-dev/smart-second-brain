import type { VoiceStatus } from "./voiceSession.svelte";

/**
 * Canvas painters for the orb variants that cannot be expressed in CSS alone.
 * Pure functions of a frame description so the Svelte component only owns the
 * loop, sizing, and colour resolution.
 */

export interface OrbFrame {
	width: number;
	height: number;
	/** Seconds of animation time. Frozen when the user prefers reduced motion. */
	t: number;
	/** 0..1 smoothed audio level. */
	level: number;
	/** Byte frequency bins of the audible side. */
	spectrum: Uint8Array;
	status: VoiceStatus;
	/** Resolved CSS colours (canvas cannot read `var()`). */
	accent: string;
	accentAlt: string;
	accentAlt2: string;
	error: string;
}

const BLOB_HARMONICS: readonly { k: number; a: number; w: number }[] = [
	{ k: 2, a: 0.05, w: 0.7 },
	{ k: 3, a: 0.04, w: -0.9 },
	{ k: 5, a: 0.025, w: 1.3 },
	{ k: 7, a: 0.015, w: -1.7 },
];

/**
 * Radius multiplier of the blob outline at angle `theta`: a few low harmonics whose
 * phases drift with time, and whose amplitude grows with the audio level. Bounded
 * to roughly 0.67..1.33 so the outline never collapses or leaves the canvas.
 */
export function blobRadius(theta: number, t: number, level: number, seed = 0): number {
	const gain = 0.35 + 2.2 * Math.min(1, Math.max(0, level));
	let r = 1;
	for (const h of BLOB_HARMONICS) {
		r += h.a * gain * Math.sin(h.k * theta + h.w * t + seed);
	}
	return r;
}

function blobPath(
	ctx: CanvasRenderingContext2D,
	cx: number,
	cy: number,
	R: number,
	t: number,
	level: number,
	seed: number,
) {
	const STEPS = 96;
	ctx.beginPath();
	for (let i = 0; i <= STEPS; i++) {
		const theta = (i / STEPS) * Math.PI * 2;
		const r = R * blobRadius(theta, t, level, seed);
		const x = cx + Math.cos(theta) * r;
		const y = cy + Math.sin(theta) * r;
		if (i === 0) ctx.moveTo(x, y);
		else ctx.lineTo(x, y);
	}
	ctx.closePath();
}

function workingOrbit(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, t: number, color: string) {
	ctx.save();
	ctx.translate(cx, cy);
	ctx.rotate(t * 2.2);
	ctx.strokeStyle = color;
	ctx.globalAlpha = 0.8;
	ctx.lineWidth = Math.max(1.5, radius * 0.03);
	ctx.lineCap = "round";
	ctx.beginPath();
	ctx.arc(0, 0, radius, 0, Math.PI * 0.55);
	ctx.stroke();
	ctx.globalAlpha = 0.35;
	ctx.beginPath();
	ctx.arc(0, 0, radius, Math.PI, Math.PI * 1.35);
	ctx.stroke();
	ctx.restore();
}

export function drawBlob(ctx: CanvasRenderingContext2D, f: OrbFrame): void {
	const { width, height, t, status } = f;
	const level = status === "error" || status === "connecting" ? 0 : f.level;
	const cx = width / 2;
	const cy = height / 2;
	const R = Math.min(width, height) * 0.34;
	const main = status === "error" ? f.error : f.accent;
	const alt = status === "error" ? f.error : f.accentAlt;

	ctx.clearRect(0, 0, width, height);
	ctx.globalAlpha = status === "connecting" ? 0.4 : 1;

	// Back layer: the alternate colour, slightly larger and phase-shifted, gives depth.
	ctx.save();
	ctx.globalAlpha *= 0.55;
	ctx.fillStyle = alt;
	blobPath(ctx, cx, cy, R * 1.04, t * 0.8, level, Math.PI / 2);
	ctx.fill();
	ctx.restore();

	// Front layer with a lit gradient and a level-driven glow.
	ctx.save();
	const grad = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R * 1.1);
	grad.addColorStop(0, alt);
	grad.addColorStop(0.55, main);
	grad.addColorStop(1, main);
	ctx.fillStyle = grad;
	ctx.shadowColor = main;
	ctx.shadowBlur = R * (0.25 + 0.9 * level);
	blobPath(ctx, cx, cy, R, t, level, 0);
	ctx.fill();
	ctx.restore();

	if (status === "agentWorking") workingOrbit(ctx, cx, cy, R * 1.32, t, main);
	ctx.globalAlpha = 1;
}

const SPECTRUM_BARS = 48;

export function drawSpectrum(ctx: CanvasRenderingContext2D, f: OrbFrame): void {
	const { width, height, t, status, spectrum } = f;
	const live = status === "listening" || status === "speaking" || status === "agentWorking";
	const level = live ? f.level : 0;
	const cx = width / 2;
	const cy = height / 2;
	const R = Math.min(width, height) * 0.5;
	const r0 = R * 0.5;
	const main = status === "error" ? f.error : f.accent;

	ctx.clearRect(0, 0, width, height);
	ctx.globalAlpha = status === "connecting" ? 0.4 : 1;

	// Inner disc + a core that swells with the level.
	ctx.fillStyle = main;
	ctx.save();
	ctx.globalAlpha *= 0.14;
	ctx.beginPath();
	ctx.arc(cx, cy, r0 * 0.92, 0, Math.PI * 2);
	ctx.fill();
	ctx.restore();
	ctx.beginPath();
	ctx.arc(cx, cy, r0 * (0.3 + 0.2 * level), 0, Math.PI * 2);
	ctx.fill();

	// Radial bars, mirrored left/right so the shape reads as one object, rotating slowly.
	ctx.save();
	ctx.translate(cx, cy);
	ctx.rotate(t * 0.15);
	ctx.strokeStyle = main;
	ctx.lineCap = "round";
	ctx.lineWidth = Math.max(2, ((Math.PI * 2 * r0) / SPECTRUM_BARS) * 0.5);
	const usable = Math.min(spectrum.length, 60);
	for (let i = 0; i < SPECTRUM_BARS; i++) {
		const half = SPECTRUM_BARS / 2;
		const mirrored = i < half ? i : SPECTRUM_BARS - 1 - i;
		const bin = Math.min(usable - 1, Math.floor((mirrored / half) * usable));
		const value = live ? (spectrum[bin] ?? 0) / 255 : 0;
		const len = R * 0.06 + value * R * 0.36 + level * R * 0.05;
		const angle = (i / SPECTRUM_BARS) * Math.PI * 2 - Math.PI / 2;
		const x0 = Math.cos(angle) * (r0 * 1.05);
		const y0 = Math.sin(angle) * (r0 * 1.05);
		ctx.globalAlpha = (status === "connecting" ? 0.4 : 1) * (0.45 + 0.55 * value);
		ctx.beginPath();
		ctx.moveTo(x0, y0);
		ctx.lineTo(x0 + Math.cos(angle) * len, y0 + Math.sin(angle) * len);
		ctx.stroke();
	}
	ctx.restore();

	if (status === "agentWorking") workingOrbit(ctx, cx, cy, R * 0.94, t, main);
	ctx.globalAlpha = 1;
}

interface Cloud {
	/** Orbit radius as a fraction of the blob radius, angular speed, phase, size as a fraction. */
	orbit: number;
	speed: number;
	phase: number;
	size: number;
}

const NEBULA_CLOUDS: readonly Cloud[] = [
	{ orbit: 0.42, speed: 0.55, phase: 0, size: 0.95 },
	{ orbit: 0.5, speed: -0.4, phase: 2.1, size: 0.85 },
	{ orbit: 0.36, speed: 0.7, phase: 4.2, size: 0.7 },
];

/**
 * Blob outline as a clip, aurora clouds inside: three soft radial gradients in the
 * accent and its two colour-mixed companions, orbiting the centre at different
 * speeds. The level speeds the drift up and brightens the clouds; the outline's
 * own wobble already follows it.
 */
export function drawNebula(ctx: CanvasRenderingContext2D, f: OrbFrame): void {
	const { width, height, status } = f;
	const level = status === "error" || status === "connecting" ? 0 : f.level;
	const cx = width / 2;
	const cy = height / 2;
	const R = Math.min(width, height) * 0.34;
	const isError = status === "error";
	const main = isError ? f.error : f.accent;
	const colours = isError ? [f.error, f.error, f.error] : [f.accent, f.accentAlt, f.accentAlt2];
	// Drift accelerates with the voice; the phase integrates so it never jumps.
	const t = f.t * (1 + 1.5 * level);

	ctx.clearRect(0, 0, width, height);
	ctx.globalAlpha = status === "connecting" ? 0.4 : 1;

	// Glow that follows the outline.
	ctx.save();
	ctx.fillStyle = main;
	ctx.globalAlpha *= 0.35;
	ctx.shadowColor = main;
	ctx.shadowBlur = R * (0.3 + 1.0 * level);
	blobPath(ctx, cx, cy, R, f.t, level, 0);
	ctx.fill();
	ctx.restore();

	// Clouds, clipped to the morphing outline.
	ctx.save();
	blobPath(ctx, cx, cy, R, f.t, level, 0);
	ctx.clip();
	// Base tint so the gaps between clouds are never empty.
	ctx.fillStyle = main;
	ctx.globalAlpha *= 0.3;
	ctx.fillRect(cx - R * 1.5, cy - R * 1.5, R * 3, R * 3);
	ctx.globalAlpha = status === "connecting" ? 0.4 : 1;
	ctx.filter = `blur(${Math.max(2, R * 0.14)}px)`;
	for (const [i, cloud] of NEBULA_CLOUDS.entries()) {
		const angle = cloud.phase + t * cloud.speed;
		const x = cx + Math.cos(angle) * R * cloud.orbit;
		const y = cy + Math.sin(angle * 0.9) * R * cloud.orbit;
		const radius = R * cloud.size * (1 + 0.25 * level);
		const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
		grad.addColorStop(0, colours[i]);
		grad.addColorStop(1, "transparent");
		ctx.fillStyle = grad;
		ctx.globalAlpha = (status === "connecting" ? 0.4 : 1) * Math.min(1, 0.85 + 0.3 * level);
		ctx.beginPath();
		ctx.arc(x, y, radius, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.filter = "none";
	ctx.restore();

	if (status === "agentWorking") workingOrbit(ctx, cx, cy, R * 1.32, f.t, main);
	ctx.globalAlpha = 1;
}
