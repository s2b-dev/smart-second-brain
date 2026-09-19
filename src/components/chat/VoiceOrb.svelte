<script lang="ts">
import type { VoiceStatus } from "../../voice/voiceSession.svelte";

/**
 * The voice-mode orb. All motion is CSS keyed off `data-status`; the only script
 * is a requestAnimationFrame loop that samples the audio level and writes it to a
 * custom property, so the scale and glow follow the voice without re-rendering.
 */
interface Props {
	status: VoiceStatus;
	/** 0..1 level of whichever side is audible. Sampled every frame. */
	level: () => number;
	compact?: boolean;
}

const { status, level, compact = false }: Props = $props();

let el = $state<HTMLDivElement>();

$effect(() => {
	const node = el;
	if (!node || status === "off") return;
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	let raf = 0;
	let smoothed = 0;
	const tick = () => {
		const target = reducedMotion ? 0 : level();
		smoothed += (target - smoothed) * 0.2;
		node.style.setProperty("--s2b-orb-level", smoothed.toFixed(3));
		raf = requestAnimationFrame(tick);
	};
	raf = requestAnimationFrame(tick);
	return () => {
		cancelAnimationFrame(raf);
		node.style.setProperty("--s2b-orb-level", "0");
	};
});
</script>

<div bind:this={el} class="s2b-voice-orb" class:is-compact={compact} data-status={status} aria-hidden="true">
  <div class="s2b-voice-orb-ring"></div>
  <div class="s2b-voice-orb-core"></div>
</div>

<style>
  .s2b-voice-orb {
    --s2b-orb-level: 0;
    --s2b-orb-size: 160px;
    position: relative;
    width: var(--s2b-orb-size);
    height: var(--s2b-orb-size);
    display: grid;
    place-items: center;
    flex-shrink: 0;
    /* Level drives the outer scale; the breathe keyframe below owns the core's
       transform, so the two never fight over one property. */
    transform: scale(calc(1 + 0.22 * var(--s2b-orb-level)));
    transition: transform 80ms linear;
  }

  .s2b-voice-orb.is-compact {
    --s2b-orb-size: 36px;
  }

  .s2b-voice-orb-core {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: var(--interactive-accent);
    box-shadow: 0 0 calc(10px + 36px * var(--s2b-orb-level))
      color-mix(in srgb, var(--interactive-accent) 55%, transparent);
    transition:
      box-shadow 80ms linear,
      opacity 200ms ease,
      background-color 200ms ease;
  }

  .s2b-voice-orb[data-status="listening"] .s2b-voice-orb-core,
  .s2b-voice-orb[data-status="agentWorking"] .s2b-voice-orb-core {
    animation: s2b-orb-breathe 3.2s ease-in-out infinite;
  }

  .s2b-voice-orb[data-status="connecting"] .s2b-voice-orb-core {
    opacity: 0.35;
  }

  .s2b-voice-orb[data-status="error"] .s2b-voice-orb-core {
    background: var(--text-error);
    opacity: 0.6;
    box-shadow: none;
  }

  .s2b-voice-orb-ring {
    position: absolute;
    inset: -10px;
    border-radius: 50%;
    opacity: 0;
    background: conic-gradient(from 0deg, transparent 0 65%, var(--interactive-accent) 100%);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px));
    transition: opacity 200ms ease;
  }

  .s2b-voice-orb.is-compact .s2b-voice-orb-ring {
    inset: -5px;
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px));
  }

  .s2b-voice-orb[data-status="agentWorking"] .s2b-voice-orb-ring {
    opacity: 1;
    animation: s2b-orb-spin 1.4s linear infinite;
  }

  @keyframes s2b-orb-breathe {
    0%,
    100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.06);
    }
  }

  @keyframes s2b-orb-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .s2b-voice-orb-core,
    .s2b-voice-orb-ring {
      animation: none !important;
    }
  }
</style>
