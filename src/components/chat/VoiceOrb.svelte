<script lang="ts">
import type { VoiceOrbStyle } from "../../types/plugin";
import { drawBlob, drawNebula, drawSpectrum } from "../../voice/orbRenderers";
import type { VoiceStatus } from "../../voice/voiceSession.svelte";

/**
 * The voice-mode orb, in one of several looks (Developer settings → Voice orb style).
 *
 * One requestAnimationFrame loop samples the audio level (and, for the spectrum
 * look, the frequency bins), smooths it, and either writes it to a custom property
 * the CSS looks read, or repaints a canvas for the painted looks. State-driven
 * motion (breathe, ripple, the "working" ring) is CSS keyed off `data-status`.
 */
interface Props {
	status: VoiceStatus;
	/** 0..1 level of whichever side is audible. Sampled every frame. */
	level: () => number;
	/** Fills `out` with byte frequency bins of the audible side. */
	spectrum?: (out: Uint8Array<ArrayBuffer>) => void;
	variant?: VoiceOrbStyle;
	compact?: boolean;
}

const { status, level, spectrum, variant = "nebula", compact = false }: Props = $props();

const isCanvas = $derived(variant === "blob" || variant === "spectrum" || variant === "nebula");

let el = $state<HTMLDivElement>();
let canvas = $state<HTMLCanvasElement>();
let altProbe = $state<HTMLSpanElement>();
let altProbe2 = $state<HTMLSpanElement>();

$effect(() => {
	const node = el;
	if (!node || status === "off") return;
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	const bins = new Uint8Array(128);
	const ctx = isCanvas ? (canvas?.getContext("2d") ?? null) : null;
	let raf = 0;
	let smoothed = 0;
	let t = 0;
	let last = performance.now();
	let colours = { accent: "", accentAlt: "", accentAlt2: "", error: "" };
	let colourAge = 60;

	const tick = (now: number) => {
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;
		if (!reducedMotion) t += dt;
		const target = reducedMotion ? 0 : level();
		smoothed += (target - smoothed) * 0.2;
		node.style.setProperty("--s2b-orb-level", smoothed.toFixed(3));

		if (ctx && canvas) {
			// Theme colours: re-read occasionally so a theme switch mid-session is picked up.
			if (++colourAge >= 60) {
				colourAge = 0;
				const rootStyle = getComputedStyle(node);
				colours = {
					accent: rootStyle.color,
					accentAlt: altProbe ? getComputedStyle(altProbe).color : rootStyle.color,
					accentAlt2: altProbe2 ? getComputedStyle(altProbe2).color : rootStyle.color,
					error: rootStyle.getPropertyValue("--text-error").trim() || rootStyle.color,
				};
			}
			// Backing size follows the displayed size every frame, so the compact
			// toggle never paints an oversized or clipped orb while waiting for the
			// next colour refresh. Setting width/height clears the canvas, hence the guard.
			const dpr = window.devicePixelRatio || 1;
			const size = Math.round(node.clientWidth * dpr);
			if (canvas.width !== size || canvas.height !== size) {
				canvas.width = size;
				canvas.height = size;
			}
			if (variant === "spectrum") spectrum?.(bins);
			const frame = {
				width: canvas.width,
				height: canvas.height,
				t,
				level: smoothed,
				spectrum: bins,
				status,
				...colours,
			};
			if (variant === "blob") drawBlob(ctx, frame);
			else if (variant === "nebula") drawNebula(ctx, frame);
			else drawSpectrum(ctx, frame);
		}
		raf = requestAnimationFrame(tick);
	};
	raf = requestAnimationFrame(tick);
	return () => {
		cancelAnimationFrame(raf);
		node.style.setProperty("--s2b-orb-level", "0");
	};
});
</script>

<div
  bind:this={el}
  class="s2b-voice-orb"
  class:is-compact={compact}
  data-status={status}
  data-variant={variant}
  aria-hidden="true"
>
  {#if variant === "pulse"}
    <div class="s2b-voice-orb-ring"></div>
    <div class="s2b-voice-orb-core"></div>
  {:else if variant === "aurora"}
    <div class="s2b-voice-orb-ring"></div>
    <div class="s2b-voice-orb-aurora">
      <span class="s2b-voice-orb-cloud s2b-voice-orb-cloud-1"></span>
      <span class="s2b-voice-orb-cloud s2b-voice-orb-cloud-2"></span>
      <span class="s2b-voice-orb-cloud s2b-voice-orb-cloud-3"></span>
    </div>
  {:else if variant === "ripple"}
    <div class="s2b-voice-orb-ring"></div>
    <span class="s2b-voice-orb-ripple s2b-voice-orb-ripple-1"></span>
    <span class="s2b-voice-orb-ripple s2b-voice-orb-ripple-2"></span>
    <span class="s2b-voice-orb-ripple s2b-voice-orb-ripple-3"></span>
    <div class="s2b-voice-orb-core s2b-voice-orb-core-small"></div>
  {:else}
    <!-- Probe: resolves the colour-mixed alternate accent so the canvas can use it. -->
    <span bind:this={altProbe} class="s2b-voice-orb-probe"></span>
    <span bind:this={altProbe2} class="s2b-voice-orb-probe s2b-voice-orb-probe-2"></span>
    <canvas bind:this={canvas} class="s2b-voice-orb-canvas"></canvas>
  {/if}
</div>

<style>
  .s2b-voice-orb {
    --s2b-orb-level: 0;
    --s2b-orb-size: 176px;
    /* The canvas looks read the accent off `color`; keeping it here means one
       place tracks the theme for every variant. */
    color: var(--interactive-accent);
    --s2b-orb-alt: color-mix(in srgb, var(--interactive-accent) 55%, #4fd1c5);
    --s2b-orb-alt-2: color-mix(in srgb, var(--interactive-accent) 55%, #f472b6);
    position: relative;
    width: var(--s2b-orb-size);
    height: var(--s2b-orb-size);
    display: grid;
    place-items: center;
    flex-shrink: 0;
  }

  .s2b-voice-orb.is-compact {
    --s2b-orb-size: 40px;
  }

  .s2b-voice-orb[data-status="error"] {
    color: var(--text-error);
  }

  .s2b-voice-orb-probe {
    position: absolute;
    width: 0;
    height: 0;
    color: var(--s2b-orb-alt);
  }

  .s2b-voice-orb-probe-2 {
    color: var(--s2b-orb-alt-2);
  }

  .s2b-voice-orb-canvas {
    width: 100%;
    height: 100%;
    display: block;
  }

  /* ---- shared pieces ------------------------------------------------- */

  .s2b-voice-orb-core {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 calc(10px + 36px * var(--s2b-orb-level)) color-mix(in srgb, currentColor 55%, transparent);
    transform: scale(calc(1 + 0.22 * var(--s2b-orb-level)));
    transition:
      box-shadow 80ms linear,
      opacity 200ms ease;
  }

  .s2b-voice-orb-ring {
    position: absolute;
    inset: -10px;
    border-radius: 50%;
    opacity: 0;
    background: conic-gradient(from 0deg, transparent 0 65%, currentColor 100%);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px));
    transition: opacity 200ms ease;
    z-index: 1;
  }

  .s2b-voice-orb.is-compact .s2b-voice-orb-ring {
    inset: -5px;
  }

  .s2b-voice-orb[data-status="agentWorking"] .s2b-voice-orb-ring {
    opacity: 1;
    animation: s2b-orb-spin 1.4s linear infinite;
  }

  .s2b-voice-orb[data-status="connecting"] > :not(.s2b-voice-orb-ring) {
    opacity: 0.35;
  }

  .s2b-voice-orb[data-status="error"] .s2b-voice-orb-core {
    opacity: 0.6;
    box-shadow: none;
  }

  /* ---- pulse ---------------------------------------------------------- */

  .s2b-voice-orb[data-variant="pulse"][data-status="listening"] .s2b-voice-orb-core,
  .s2b-voice-orb[data-variant="pulse"][data-status="agentWorking"] .s2b-voice-orb-core {
    animation: s2b-orb-breathe 3.2s ease-in-out infinite;
  }

  /* ---- aurora --------------------------------------------------------- */

  .s2b-voice-orb-aurora {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    overflow: hidden;
    background: color-mix(in srgb, currentColor 22%, var(--background-secondary));
    box-shadow: 0 0 calc(8px + 40px * var(--s2b-orb-level)) color-mix(in srgb, currentColor 45%, transparent);
    transform: scale(calc(1 + 0.16 * var(--s2b-orb-level)));
    filter: saturate(calc(1 + 0.8 * var(--s2b-orb-level))) brightness(calc(1 + 0.35 * var(--s2b-orb-level)));
    transition:
      box-shadow 80ms linear,
      opacity 200ms ease;
  }

  .s2b-voice-orb-cloud {
    position: absolute;
    width: 72%;
    height: 72%;
    border-radius: 50%;
    filter: blur(calc(var(--s2b-orb-size) * 0.1));
    opacity: 0.9;
  }

  .s2b-voice-orb-cloud-1 {
    background: currentColor;
    top: -12%;
    left: -12%;
    animation: s2b-aurora-a 7s ease-in-out infinite;
  }

  .s2b-voice-orb-cloud-2 {
    background: var(--s2b-orb-alt);
    bottom: -18%;
    right: -12%;
    animation: s2b-aurora-b 9s ease-in-out infinite;
  }

  .s2b-voice-orb-cloud-3 {
    background: var(--s2b-orb-alt-2);
    top: 22%;
    right: -24%;
    width: 60%;
    height: 60%;
    animation: s2b-aurora-c 11s ease-in-out infinite;
  }

  .s2b-voice-orb[data-status="error"] .s2b-voice-orb-cloud {
    background: currentColor;
    animation: none;
  }

  /* ---- ripple --------------------------------------------------------- */

  .s2b-voice-orb-core-small {
    width: 40%;
    height: 40%;
    transform: scale(calc(1 + 0.5 * var(--s2b-orb-level)));
  }

  .s2b-voice-orb-ripple {
    --s2b-ripple-alpha: calc(0.2 + 0.8 * var(--s2b-orb-level));
    position: absolute;
    inset: 30%;
    border-radius: 50%;
    border: 2px solid currentColor;
    opacity: 0;
    animation: s2b-ripple 2.6s ease-out infinite;
  }

  .s2b-voice-orb-ripple-2 {
    animation-delay: 0.87s;
  }

  .s2b-voice-orb-ripple-3 {
    animation-delay: 1.73s;
  }

  .s2b-voice-orb[data-status="error"] .s2b-voice-orb-ripple,
  .s2b-voice-orb[data-status="connecting"] .s2b-voice-orb-ripple {
    animation: none;
  }

  /* ---- keyframes ------------------------------------------------------ */

  @keyframes s2b-orb-breathe {
    0%,
    100% {
      transform: scale(calc(1 + 0.22 * var(--s2b-orb-level)));
    }
    50% {
      transform: scale(calc(1.06 + 0.22 * var(--s2b-orb-level)));
    }
  }

  @keyframes s2b-orb-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes s2b-ripple {
    from {
      transform: scale(1);
      opacity: var(--s2b-ripple-alpha);
    }
    to {
      transform: scale(2.7);
      opacity: 0;
    }
  }

  @keyframes s2b-aurora-a {
    0%,
    100% {
      transform: translate(0, 0);
    }
    33% {
      transform: translate(28%, 18%);
    }
    66% {
      transform: translate(-8%, 34%);
    }
  }

  @keyframes s2b-aurora-b {
    0%,
    100% {
      transform: translate(0, 0);
    }
    33% {
      transform: translate(-30%, -12%);
    }
    66% {
      transform: translate(10%, -36%);
    }
  }

  @keyframes s2b-aurora-c {
    0%,
    100% {
      transform: translate(0, 0) scale(1);
    }
    50% {
      transform: translate(-40%, -10%) scale(1.2);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .s2b-voice-orb *,
    .s2b-voice-orb-core {
      animation: none !important;
    }
  }
</style>
