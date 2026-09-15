<script lang="ts">
import { onDestroy } from "svelte";
import { claimTouchGestures } from "../../utils/claimTouchGestures";

interface Props {
	value?: number;
	min?: number;
	max?: number;
	step?: number;
	disabled?: boolean;
	showValue?: boolean;
	class?: string;
	onchange?: (value: number) => void;
	oncommit?: (value: number) => void;
}

let {
	value = $bindable(50),
	min = 0,
	max = 100,
	step = 1,
	disabled = false,
	showValue = false,
	class: className = "",
	onchange,
	oncommit,
}: Props = $props();

/** Pending rAF for the deferred `onchange`, so drags coalesce to one per frame. */
let liveFrame: number | null = null;

/**
 * Update the thumb immediately; run the consumer's work after the paint.
 *
 * `onchange` fires on every pointer sample during a drag, and a consumer can do
 * real work in it — the graph's granularity handler re-derives segments and
 * repaints its canvas, measured at ~115ms on a 4,207-note vault. Calling it
 * synchronously here blocks the browser from painting the new thumb position,
 * so the *slider itself* lagged the finger even though `value` was already
 * correct. The work is main-thread by nature (style reads, canvas paint), so
 * it cannot simply be moved to a worker.
 *
 * Deferring to `requestAnimationFrame` lets the thumb paint first and collapses
 * a burst of samples into one call per frame. Drag-and-watch still works — the
 * consumer sees the newest value every frame — it just no longer sits in front
 * of the control's own rendering.
 */
function handleInput(e: Event) {
	const target = e.target as HTMLInputElement;
	value = Number(target.value);
	if (!onchange) return;
	if (liveFrame !== null) cancelAnimationFrame(liveFrame);
	liveFrame = window.requestAnimationFrame(() => {
		liveFrame = null;
		onchange?.(value);
	});
}

function handleChange(e: Event) {
	const target = e.target as HTMLInputElement;
	value = Number(target.value);
	// Drop any deferred live update: the commit below supersedes it, and letting
	// it fire afterwards would re-apply a stale mid-drag value on top.
	if (liveFrame !== null) {
		cancelAnimationFrame(liveFrame);
		liveFrame = null;
	}
	oncommit?.(value);
}

onDestroy(() => {
	if (liveFrame !== null) cancelAnimationFrame(liveFrame);
});

/**
 * How far along the track the value sits, 0–1.
 *
 * Obsidian paints the filled part of the track itself, from a
 * `linear-gradient` on `input[type="range"].slider` that reads this variable —
 * the same way its own `SliderComponent` sets it inline. Without it the
 * gradient resolves to a 0% fill and the control renders as a bare grey rail,
 * which is why this looked hand-rolled next to a native slider.
 */
const fillRatio = $derived.by(() => {
	const span = max - min;
	if (span <= 0) return 0;
	return Math.min(1, Math.max(0, (value - min) / span));
});
</script>

<div class="s2b-range-row flex items-center gap-2 {className}">
	{#if showValue}
		<output class="text-ui-small text-text-muted w-8 text-right">{value}</output>
	{/if}
	<!-- `slider` is Obsidian's own class: it is what opts this input into the
	     native filled track (and the theme's thumb sizing) rather than the bare
	     rail the base `input[type="range"]` rule gives. -->
	<input
		use:claimTouchGestures
		type="range"
		class="slider s2b-range w-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
		style="--slider-fill-ratio: {fillRatio};"
		{value}
		{min}
		{max}
		{step}
		{disabled}
		oninput={handleInput}
		onchange={handleChange}
	/>
</div>

<style>
	/*
	 * `touch-action: none` stops the *browser's* own panning, so dragging the
	 * thumb never also scrolls the surrounding panel.
	 *
	 * It does NOT stop Obsidian's sidebar swipe. That is a JS recognizer
	 * (bubble-phase `touchmove` on `window`), which receives the event stream
	 * no matter what `touch-action` says — `manipulation` → `pan-y` (#417) and
	 * then `pan-y` → `none` both failed on hardware for exactly this reason.
	 * `use:claimTouchGestures` on the input is what actually protects the drag;
	 * see that action for the on-device measurement.
	 *
	 * Deliberately no track or thumb styling: Obsidian paints both itself off the
	 * `slider` class and the `--slider-fill-ratio` we set inline, and overriding
	 * either here would drop the user's theme for a hand-rolled slider. Only the
	 * touch behaviour changes.
	 */
	.s2b-range {
		touch-action: none;
	}

	/* Obsidian's base rule is `input[type="range"] { width: 100px }`, which beats
	   the `w-full` utility class on specificity — measured 100px in a 194px slot
	   on a phone, so the control was using barely half the room it had. Match the
	   element selector to win, and let the row grow into the slot. */
	.s2b-range-row {
		flex: 1;
		min-width: 0;
	}

	input[type="range"].s2b-range {
		width: 100%;
		min-width: 0;
	}

	/* No transparent border to grow the hit area on mobile.

	   That was added back when this rendered as a bare 6px rail, where the only
	   thing to aim at really was 6px tall. With the native `slider` class the
	   theme's own thumb applies at 24px, which is already a reasonable target,
	   and the border made the control 26px tall — visibly fatter than every
	   native slider next to it, which is what gave it away as non-native. The
	   thumb overflows the track box, so it stays grabbable without it. */
</style>
