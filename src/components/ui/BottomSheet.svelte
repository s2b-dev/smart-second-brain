<script lang="ts">
import { untrack } from "svelte";
import type { Snippet } from "svelte";
import { t } from "../../i18n";
import { claimTouchGestures } from "../../utils/claimTouchGestures";

interface Props {
	open: boolean;
	onClose: () => void;
	/**
	 * Heights to snap to, as fractions of the containing block. Ascending.
	 * Two is the useful number here: a peek that leaves the graph visible, and
	 * a full stop for a long list.
	 */
	detents?: number[];
	/** Which detent to open at. */
	initialDetent?: number;
	/**
	 * False for a sheet that should be exactly as tall as its content — the
	 * selection sheet is a fixed set of verbs, so there is nothing to expand
	 * into and a handle would promise a gesture that does nothing.
	 */
	draggable?: boolean;
	ariaLabel: string;
	children: Snippet;
}

let {
	open,
	onClose,
	detents = [0.45, 0.9],
	initialDetent = 0,
	draggable = true,
	ariaLabel,
	children,
}: Props = $props();

/** The sheet element, used to measure its containing block during a drag. */
let sheetEl = $state<HTMLElement | undefined>(undefined);
/** The scroll region, watched so the overflow fade can turn itself off. */
let scrollEl = $state<HTMLElement | undefined>(undefined);

/**
 * Live height in px while dragging, `null` when settled.
 *
 * A settled sheet is sized by its detent (a percentage) rather than a frozen
 * pixel value, so it keeps tracking the viewport if the device rotates or the
 * leaf is resized. Only the drag needs pixels.
 */
let dragHeight = $state<number | null>(null);
let detentIndex = $state(0);

/** True once dragged far enough to count as a drag rather than a tap. */
let isDragging = $state(false);

/** Whether the scroll region has content below the fold. */
let hasOverflow = $state(false);

/**
 * Reset to the opening detent each time the sheet is shown.
 *
 * Reopening a sheet the user had dragged to full height would otherwise
 * reopen at full height, which hides the graph the sheet is meant to leave
 * visible. A side effect on state owned elsewhere (`open`), not a derivation.
 */
$effect(() => {
	if (!open) return;
	// Only the open/closed transition should reset the sheet — untracked so a
	// later detent change (the user dragging) can't re-enter this and snap the
	// sheet back under their finger.
	untrack(() => {
		detentIndex = initialDetent;
		dragHeight = null;
	});
});

/**
 * Track whether the scroll region actually overflows, so the bottom fade only
 * appears when there is something below the fold — an always-on fade reads as
 * decoration and stops carrying information.
 *
 * A ResizeObserver rather than a one-shot measure: the content changes height
 * as topics are found and as sections are toggled, and the sheet itself
 * changes height when dragged.
 */
$effect(() => {
	const el = scrollEl;
	if (!el) return;

	const measure = () => {
		hasOverflow = el.scrollHeight - el.scrollTop - el.clientHeight > 1;
	};

	measure();
	const observer = new ResizeObserver(measure);
	observer.observe(el);
	// The content is a separate box from the scroll port; both can change.
	for (const child of Array.from(el.children)) observer.observe(child);
	el.addEventListener("scroll", measure, { passive: true });

	return () => {
		observer.disconnect();
		el.removeEventListener("scroll", measure);
	};
});

/** Escape closes, matching every other dismissible surface in the plugin. */
$effect(() => {
	if (!open) return;
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		onClose();
	};
	document.addEventListener("keydown", onKeyDown);
	return () => document.removeEventListener("keydown", onKeyDown);
});

/** Height of the box the sheet is positioned against. */
function containerHeight(): number {
	return sheetEl?.parentElement?.clientHeight ?? window.innerHeight;
}

// ── Drag ────────────────────────────────────────────────────────────────────
// Pointer events with capture, the same approach the graph canvas uses for its
// own drags: it survives the pointer leaving the handle, which happens
// constantly when you fling a sheet.

/** Where the drag started, and the sheet height at that moment. */
let dragStartY = 0;
let dragStartHeight = 0;
/** Last sample, for the release velocity. */
let lastY = 0;
let lastT = 0;
let velocity = 0;

/** Past this much movement a press is a drag, not a tap on the handle. */
const DRAG_THRESHOLD_PX = 4;
/** px/ms past which a flick decides the direction regardless of position. */
const FLICK_VELOCITY = 0.5;
/** How far below the smallest detent the sheet must go to dismiss. */
const DISMISS_MARGIN = 0.6;

function handleDragStart(e: PointerEvent) {
	if (!draggable || !sheetEl) return;
	dragStartY = e.clientY;
	lastY = e.clientY;
	lastT = e.timeStamp;
	velocity = 0;
	dragStartHeight = sheetEl.clientHeight;
	isDragging = false;
	(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function handleDragMove(e: PointerEvent) {
	if (!draggable || !sheetEl) return;
	const el = e.currentTarget as HTMLElement;
	if (!el.hasPointerCapture(e.pointerId)) return;

	const delta = dragStartY - e.clientY;
	if (!isDragging && Math.abs(delta) < DRAG_THRESHOLD_PX) return;
	isDragging = true;

	const dt = e.timeStamp - lastT;
	if (dt > 0) velocity = (lastY - e.clientY) / dt;
	lastY = e.clientY;
	lastT = e.timeStamp;

	const max = containerHeight() * detents[detents.length - 1];
	// Allowed below the smallest detent so a downward drag can reach dismissal,
	// but never above the largest — a sheet taller than its container has
	// nowhere to put the overshoot.
	dragHeight = Math.min(max, Math.max(0, dragStartHeight + delta));
}

function handleDragEnd(e: PointerEvent) {
	const el = e.currentTarget as HTMLElement;
	if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
	if (!draggable || !isDragging || dragHeight === null) {
		isDragging = false;
		return;
	}

	const height = dragHeight;
	const container = containerHeight();
	isDragging = false;
	dragHeight = null;

	const smallest = detents[0] * container;

	// A decisive flick wins over position: someone who throws the sheet down
	// from full height means "close", even though it is still passing through
	// the peek detent when they let go.
	if (velocity < -FLICK_VELOCITY) {
		if (detentIndex === 0) {
			onClose();
		} else {
			detentIndex -= 1;
		}
		return;
	}
	if (velocity > FLICK_VELOCITY) {
		detentIndex = Math.min(detents.length - 1, detentIndex + 1);
		return;
	}

	// Dragged well below the smallest detent and released: dismiss.
	if (height < smallest * DISMISS_MARGIN) {
		onClose();
		return;
	}

	// Otherwise settle on whichever detent the sheet is closest to.
	let nearest = 0;
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i < detents.length; i++) {
		const distance = Math.abs(detents[i] * container - height);
		if (distance < best) {
			best = distance;
			nearest = i;
		}
	}
	detentIndex = nearest;
}

/**
 * Keyboard control for the handle. A `<div>` synthesises no click from
 * Enter/Space the way the old `<button>` did, so the binding is explicit — and
 * since this is announced as a slider, the arrow keys should move it directly
 * rather than only cycling.
 */
function handleHandleKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		handleHandleClick();
		return;
	}
	if (e.key === "ArrowUp") {
		e.preventDefault();
		detentIndex = Math.min(detents.length - 1, detentIndex + 1);
		return;
	}
	if (e.key === "ArrowDown") {
		e.preventDefault();
		// Below the smallest detent there is nowhere left to go but closed, which
		// matches what dragging past it does.
		if (detentIndex === 0) onClose();
		else detentIndex -= 1;
	}
}

/** Tapping the handle steps between detents — a reachable alternative to dragging. */
function handleHandleClick() {
	if (!draggable || isDragging) return;
	detentIndex = detentIndex >= detents.length - 1 ? 0 : detentIndex + 1;
}

const sheetHeight = $derived.by(() => {
	if (!draggable) return "auto";
	if (dragHeight !== null) return `${dragHeight}px`;
	return `${(detents[detentIndex] ?? detents[0]) * 100}%`;
});
</script>

{#if open}
  <!--
    Dismiss layer: deliberately transparent rather than a dimming scrim.

    The controls in these sheets are drag-and-watch — the point of the
    granularity slider is seeing topics re-cluster underneath it — so anything
    that dims the canvas defeats the reason the sheet exists. It still catches
    the tap, which is the behaviour a backdrop is actually there for.
  -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="s2b-sheet-dismiss" onclick={onClose}></div>

  <!-- One attachment on the root covers everything inside: the drag handle, the
       granularity slider, and the scrolling body. The host's swipe recognizer
       is a bubble-phase `touchmove` on `window`, so stopping the event here
       starves it before it can decide an axis — see the action for the
       on-device measurement this is based on. -->
  <div
    bind:this={sheetEl}
    use:claimTouchGestures
    class="s2b-bottom-sheet"
    class:s2b-bottom-sheet--dragging={isDragging}
    style="height: {sheetHeight}"
    role="dialog"
    aria-modal="false"
    aria-label={ariaLabel}
  >
    {#if draggable}
      <!-- The handle is the whole drag surface, not just the visible grabber:
           a 4px-tall pill is far below anything a thumb can reliably land on,
           so the padded bar around it takes the pointer.

           Deliberately not a `<button>`. It was one, for keyboard reach, but
           mobile Obsidian paints `button:active` with a full-width background
           and WebKit adds its own tap highlight — so every drag flashed a
           rectangle behind the pill and made an indicator feel like a control
           you had pressed. A `separator` with `tabindex` keeps it focusable and
           correctly announced as a resize grip, without inheriting any button
           chrome to fight. -->
      <div
        class="s2b-sheet-handle"
        role="slider"
        aria-orientation="vertical"
        aria-label={t("ui.bottom_sheet.resize_label")}
        aria-valuemin={0}
        aria-valuemax={detents.length - 1}
        aria-valuenow={detentIndex}
        tabindex="0"
        onpointerdown={handleDragStart}
        onpointermove={handleDragMove}
        onpointerup={handleDragEnd}
        onpointercancel={handleDragEnd}
        onclick={handleHandleClick}
        onkeydown={handleHandleKeydown}
      >
        <div class="s2b-sheet-grabber"></div>
      </div>
    {/if}

    <div class="s2b-sheet-scroll" class:s2b-sheet-scroll--faded={hasOverflow} bind:this={scrollEl}>
      {@render children()}
    </div>
  </div>
{/if}

<style>
  /* Covers the canvas above the sheet only — the sheet itself must stay
     tappable, so this is a sibling rather than a parent. */
  /* 12 / 13 / 14 across the three layers is load-bearing: the graph toolbar
     sits at 13, between this and the sheet, so it stays pressable while a
     sheet is open without painting over the sheet's own controls. */
  .s2b-sheet-dismiss {
    position: absolute;
    inset: 0;
    z-index: 12;
    background: transparent;
  }

  /* `bottom: 0` against `.smart-graph-view`, which on mobile already ends above
     Obsidian's floating navbar (it subtracts the navbar band from its own
     height). So the sheet lands flush on the navbar without repeating that
     measurement — the previous selection bar hardcoded a 92px offset to do the
     same job, and drifted whenever the real inset differed. */
  .s2b-bottom-sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 14;
    display: flex;
    flex-direction: column;
    min-height: 0;
    /* The darker of the pair, matching how a settings tab renders: the page is
       `--background-secondary` and the grouped cards on it are lighter. (Don't
       read that off `--setting-items-background`, which resolves to the darker
       value here — the settings tab overrides it. Measured, core paints a
       #ffffff card on a #f6f6f6 page.) */
    background: var(--background-secondary);
    border-top: 1px solid var(--background-modifier-border);
    /* Rounded at the top only: the bottom edge is flush against the navbar, and
       rounding an edge that touches something reads as a rendering mistake. */
    border-radius: var(--radius-l) var(--radius-l) 0 0;
    box-shadow: var(--shadow-l);
    animation: s2b-sheet-in 160ms ease-out;
    transition: height 200ms cubic-bezier(0.32, 0.72, 0, 1);
    /* Stops the browser's own panning on the sheet's chrome, so a drag on the
       handle never also scrolls something underneath. Keeping the host's swipe
       recognizers out is a separate job, done by `use:claimTouchGestures` on
       this same element — `touch-action` alone provably does not do it. The
       scroll region below re-enables the one axis it genuinely needs. */
    touch-action: none;
  }

  /* Under the finger the height must follow the pointer exactly; a transition
     here would make the sheet lag behind the drag. */
  .s2b-bottom-sheet--dragging {
    transition: none;
  }

  @keyframes s2b-sheet-in {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
  }

  /* Obsidian gives every `button` a background, border and shadow; this one is
     a grab surface, so it resets them and lets the grabber pill be the only
     thing that paints. */
  .s2b-sheet-handle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    /* A 4px pill inside a bar tall enough to actually grab. */
    padding: 10px 0;
    min-height: 24px;
    flex-shrink: 0;
    background: none;
    border: none;
    border-radius: 0;
    box-shadow: none;
    cursor: grab;
    /* The grabber pill is the only thing that should ever paint here. WebKit
       otherwise flashes a full-width grey rectangle on touch, which made a
       passive indicator read as a button being pressed. */
    -webkit-tap-highlight-color: transparent;
    user-select: none;
    -webkit-user-select: none;
    /* Claim the vertical gesture for the drag. Only on the handle: the scroll
       region below must keep its own panning, and the sliders inside it keep
       the `pan-y` they need (see RangeSlider). */
    touch-action: none;
  }

  /* Focus lands on the grabber pill rather than outlining the full-width bar,
     which would reintroduce exactly the rectangle this stopped painting. */
  .s2b-sheet-handle:focus-visible {
    outline: none;
  }

  .s2b-sheet-handle:focus-visible .s2b-sheet-grabber {
    outline: 2px solid var(--background-modifier-border-focus);
    outline-offset: 3px;
  }

  /* Feedback while dragging belongs on the pill too — it darkens instead of the
     bar behind it lighting up. */
  .s2b-bottom-sheet--dragging .s2b-sheet-grabber {
    background: var(--text-muted);
  }

  .s2b-sheet-grabber {
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--background-modifier-border);
  }

  .s2b-sheet-scroll {
    flex: 1;
    /* Without this a flex child refuses to shrink below its content height, so
       the sheet would grow past its detent instead of scrolling. */
    min-height: 0;
    overflow-y: auto;
    /* Keep a scroll that reaches its end from chaining into the canvas behind. */
    overscroll-behavior: contain;
    /* Vertical only: this genuinely scrolls, so the browser must own that axis.
       Horizontal stays claimed by the sheet's `none`, which is what keeps a
       sideways drag over the content from opening a sidebar. */
    touch-action: pan-y;
    /* The bottom inset clears Obsidian's floating mobile navbar, which is NOT
       covered by the host view's own reservation: `.smart-graph-view` subtracts
       the navbar's 52px, but the navbar floats with a gap beneath it and so
       occupies more of the viewport bottom than its own height. Measured in the
       emulator, it starts 32px above where the sheet ends — so without this the
       last rows of the topic list sit under the navbar pill.

       Padding rather than shortening the sheet: the sheet's background should
       still run to the bottom edge (a gap under it would show canvas through a
       strip the navbar only partly covers); it is the scrollable *content* that
       has to stop short. */
    padding: 0 12px calc(44px + env(safe-area-inset-bottom));
  }

  /* Without a handle above it the content would sit flush against the sheet's
     top edge, so the padding the handle was providing has to come from here. */
  .s2b-bottom-sheet:not(:has(.s2b-sheet-handle)) .s2b-sheet-scroll {
    padding-top: 12px;
  }

  /* The "there is more below" affordance. Fades the last few pixels of content
     rather than adding a chrome element, and turns itself off at the end of the
     scroll so its presence always means something. */
  .s2b-sheet-scroll--faded {
    mask-image: linear-gradient(to bottom, black calc(100% - 24px), transparent 100%);
  }
</style>
