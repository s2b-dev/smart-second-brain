<script lang="ts" module>
export interface SlidingTab<Id extends string> {
	id: Id;
	label: string;
	/** Lucide icon id rendered via Obsidian's setIcon (optional). */
	icon?: string;
}
</script>

<script lang="ts" generics="T extends string">
import { Tabs } from "bits-ui";
import type { Snippet } from "svelte";
import { icon as iconAction } from "../../utils/utils";

interface Props {
	/** Bindable active tab id. */
	value: T;
	tabs: SlidingTab<T>[];
	/** Called when the active tab changes (in addition to updating the bound value). */
	onValueChange?: (value: T) => void;
	/** Optional extra trigger content rendered after the label (e.g. a count badge). */
	trailing?: Snippet<[SlidingTab<T>]>;
	/** Tab panels (e.g. Tabs.Content) rendered below the tab strip. */
	children?: Snippet;
	/** Class applied to the Tabs.Root element. */
	class?: string;
	/** Phone-only: collapse inactive tabs to bare icons so the whole strip fits on
	    screen without scrolling; the active tab expands to icon + label. Only tabs
	    that have an icon collapse — label-only tabs keep their label. */
	collapseInactiveOnPhone?: boolean;
}

let {
	value = $bindable(),
	tabs,
	onValueChange,
	trailing,
	children,
	class: className = "",
	collapseInactiveOnPhone = false,
}: Props = $props();

// The list element + a live map of trigger elements, used to measure the active
// tab so the sliding indicator can be positioned over it.
let listEl = $state<HTMLElement | null>(null);
const triggerEls = new Map<T, HTMLElement>();

// Indicator geometry (px), relative to the list's padding box.
let indicator = $state<{ left: number; top: number; width: number; height: number; ready: boolean }>({
	left: 0,
	top: 0,
	width: 0,
	height: 0,
	ready: false,
});

// Transitions are enabled only AFTER the pill's initial placement. On (re)mount the
// component measures the active tab and positions the pill there — without this gate
// that first placement would animate in from translate(0,0), so re-selecting the S2B
// settings pane via Obsidian's vertical tabs would replay the slide/fade every time.
// It's flipped on a frame after the first successful measure, so only genuine tab
// switches (which happen later) glide.
let animate = $state(false);

function measure() {
	const active = triggerEls.get(value);
	if (!listEl || !active) return;
	const listRect = listEl.getBoundingClientRect();
	const rect = active.getBoundingClientRect();
	if (rect.width === 0) return; // not laid out yet
	const left = rect.left - listRect.left + listEl.scrollLeft;
	// Track vertical offset too, so the pill follows the active tab when the strip
	// wraps to multiple rows (otherwise it stays pinned to row 1 at the tab's x).
	const top = rect.top - listRect.top + listEl.scrollTop;
	const width = rect.width;
	const height = rect.height;
	// Only write when geometry actually changed — writing an equal value still
	// counts as a state change to Svelte and can retrigger dependent effects,
	// producing an effect_update_depth_exceeded loop.
	if (
		indicator.ready &&
		indicator.left === left &&
		indicator.top === top &&
		indicator.width === width &&
		indicator.height === height
	)
		return;
	indicator = { left, top, width, height, ready: true };
}

// Re-measure whenever the active tab changes or the tab set changes. The measure
// is retried across a few frames until it succeeds, because the tab strip may be
// mounted while still hidden/unsized (Obsidian shows settings tabs lazily), so the
// first frame's getBoundingClientRect can report 0 width.
$effect(() => {
	void value;
	void tabs.length;
	let frames = 0;
	let raf = 0;
	const tick = () => {
		measure();
		// indicator.ready flips true on the first successful (non-zero) measure.
		if (indicator.ready || frames++ > 30) return;
		raf = window.requestAnimationFrame(tick);
	};
	raf = window.requestAnimationFrame(tick);
	return () => cancelAnimationFrame(raf);
});

// Enable transitions one frame after the pill is first placed, so the initial
// placement snaps (no intro animation on mount / when returning to this pane) but
// every later tab switch glides. Runs once — `animate` guards the re-entry.
$effect(() => {
	if (!indicator.ready || animate) return;
	const raf = window.requestAnimationFrame(() => {
		animate = true;
	});
	return () => cancelAnimationFrame(raf);
});

// A single ResizeObserver drives re-measurement on layout changes: initial mount
// (fires once the list has size), theme font swaps, modal width changes, wrap
// reflow. Triggers register/unregister into it via the {@attach} below.
let resizeObserver: ResizeObserver | undefined;
$effect(() => {
	const ro = new ResizeObserver(() => measure());
	resizeObserver = ro;
	if (listEl) ro.observe(listEl);
	for (const el of triggerEls.values()) ro.observe(el);
	return () => {
		resizeObserver = undefined;
		ro.disconnect();
	};
});

// {@attach} on each trigger — records the DOM node and wires it into the resize
// observer. Deliberately touches NO reactive state (a reactive counter here would
// loop: attach → state change → re-render → new attach fn → attach again).
function registerTrigger(node: HTMLElement, id: T) {
	triggerEls.set(id, node);
	resizeObserver?.observe(node);
	window.requestAnimationFrame(measure);
	return () => {
		triggerEls.delete(id);
		resizeObserver?.unobserve(node);
	};
}
</script>

<Tabs.Root bind:value onValueChange={(v) => onValueChange?.(v as T)} class={className}>
	<Tabs.List
		bind:ref={listEl}
		class={`s2b-sliding-tabs ${collapseInactiveOnPhone ? "s2b-tabs-collapse " : ""}flex flex-wrap justify-center gap-1 border-b border-t-0 border-x-0 border-solid border-[--background-modifier-border] pb-2 mb-4`}
	>
		<!-- Sliding accent indicator: a soft pill that glides to the active trigger.
		     Hidden until first measured to avoid a flash at 0,0. -->
		<span
			class="s2b-tab-indicator"
			class:ready={indicator.ready}
			class:animate
			style:transform={`translate(${indicator.left}px, ${indicator.top}px)`}
			style:width={`${indicator.width}px`}
			style:height={`${indicator.height}px`}
			aria-hidden="true"
		></span>

		{#each tabs as tab (tab.id)}
			<Tabs.Trigger
				value={tab.id}
				{@attach (node) => registerTrigger(node, tab.id)}
				class="s2b-tab-trigger relative z-[1] px-3 py-1.5 text-sm font-medium rounded-[10px] border border-transparent bg-transparent shadow-none transition-colors data-[state=active]:text-[--text-normal] data-[state=inactive]:text-[--text-muted] data-[state=inactive]:hover:text-[--text-normal]"
			>
				<span class="s2b-tab-label">
					{#if tab.icon}
						<span class="s2b-tab-icon" use:iconAction={tab.icon} aria-hidden="true"></span>
					{/if}
					<span class="s2b-tab-text">{tab.label}</span>
					{#if trailing}{@render trailing(tab)}{/if}
				</span>
			</Tabs.Trigger>
		{/each}
	</Tabs.List>

	{#if children}{@render children()}{/if}
</Tabs.Root>

<style>
	/* bits-ui forwards this class onto the rendered Tabs.List, so Svelte can't see
	   it statically — must be :global. */
	:global(.s2b-sliding-tabs) {
		position: relative;
	}

	/* Phone: the strip wraps into 2–3 rows at ~390px and pushes the actual settings
	   most of a screen down. Swap wrapping for a single scrollable row — the native
	   mobile pattern for tab bars. The indicator already accounts for scrollLeft in
	   measure(), so the pill tracks the active tab while the strip scrolls. */
	:global(.is-mobile .s2b-sliding-tabs) {
		flex-wrap: nowrap;
		justify-content: flex-start;
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
	}

	:global(.is-mobile .s2b-sliding-tabs)::-webkit-scrollbar {
		display: none;
	}

	:global(.is-mobile .s2b-sliding-tabs [data-tabs-trigger]) {
		flex-shrink: 0;
		white-space: nowrap;
	}

	/* Phone + collapse mode (opt-in via `collapseInactiveOnPhone`): inactive tabs
	   shrink to bare icons so the whole strip fits on screen at once — no hidden
	   tabs, no horizontal scrolling — and the active tab expands to icon + label
	   inside the pill. The label animates via max-width/margin (not display), so
	   the trigger's width change is continuous and the ResizeObserver-driven pill
	   glides along with it. Timing mirrors the pill's transition so they move as
	   one. Only `.s2b-tab-icon + .s2b-tab-text` is targeted: a tab without an icon
	   never collapses, so label-only strips are unaffected even with the flag on. */
	:global(.is-phone .s2b-tabs-collapse) {
		justify-content: center;
	}

	:global(.is-phone .s2b-tabs-collapse) .s2b-tab-label {
		gap: 0;
	}

	:global(.is-phone .s2b-tabs-collapse) .s2b-tab-icon + .s2b-tab-text {
		display: inline-block;
		overflow: hidden;
		white-space: nowrap;
		max-width: 8rem;
		margin-left: 0.45rem;
		opacity: 1;
		transition:
			max-width 240ms cubic-bezier(0.32, 0.72, 0, 1),
			margin-left 240ms cubic-bezier(0.32, 0.72, 0, 1),
			opacity 160ms ease;
	}

	:global(.is-phone .s2b-tabs-collapse [data-state="inactive"]) .s2b-tab-icon + .s2b-tab-text {
		max-width: 0;
		margin-left: 0;
		opacity: 0;
	}

	/* Strip Obsidian's default <button> chrome so only the sliding accent pill shows
	   behind the active trigger. bits-ui renders the trigger as a real <button>, which
	   Obsidian gives a grey background + box-shadow (incl. on hover/focus) — kill it
	   across every state so the pill isn't sitting behind an opaque button fill. */
	:global(.s2b-sliding-tabs [data-tabs-trigger]),
	:global(.s2b-sliding-tabs [data-tabs-trigger]:hover),
	:global(.s2b-sliding-tabs [data-tabs-trigger]:focus),
	:global(.s2b-sliding-tabs [data-tabs-trigger]:focus-visible),
	:global(.s2b-sliding-tabs [data-tabs-trigger]:active) {
		background-color: transparent;
		box-shadow: none;
	}

	.s2b-tab-label {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
	}

	/* Setting --icon-size is what actually sizes the glyph: Obsidian's .svg-icon reads
	   it for both width and height. Constraining only the span left the svg at the
	   inherited 18px height inside a 14px box, so the icon was squashed horizontally
	   and overflowed the span vertically, reading as sitting too low next to the label. */
	.s2b-tab-icon {
		--icon-size: 16px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--icon-size);
		height: var(--icon-size);
		flex-shrink: 0;
		/* Optical centring. `align-items: center` on the label centres the icon on the
		   20px LINE BOX, but a line box is not symmetric around the text it renders:
		   with the stack's 14px/20px metrics the glyph ink of a label like "General"
		   spans 246.40–262.84, centre 254.62, while the line box centre — and so the
		   icon — lands at 255.48. That constant 0.86px surplus below the text is what
		   reads as "icons sit low", and it is identical on every tab (measured), so it
		   is a metrics offset rather than per-label jitter. Pull the icon up by that
		   amount so it centres on the text's ink instead of on its line box.

		   The translate also lifts the box off the half-pixel boundary it otherwise
		   lands on (top 247.49), which was rasterising the 16px glyph across two
		   device pixels and making it read soft as well as low. Use transform, not
		   margin: margin would resize the flex item and retrigger the ResizeObserver
		   that positions the sliding pill.

		   Expressed in em (0.87px measured / 14px font = 0.062em) rather than as a
		   raw px value: the gap is descender asymmetry, which is a property of the
		   font at whatever size it is rendered, so it must scale with the label. A
		   hard-coded px would go wrong the moment a theme changes the tab font size. */
		transform: translateY(-0.062em);
	}

	.s2b-tab-icon :global(svg.svg-icon) {
		width: var(--icon-size);
		height: var(--icon-size);
	}

	/* The gliding pill. Sits behind the triggers (which are z-[1]). Position + size
	   are measured from the active trigger (see measure()), so top/left/width/height
	   are driven inline — the pill follows the active tab even across wrapped rows. */
	.s2b-tab-indicator {
		position: absolute;
		top: 0;
		left: 0;
		/* Softer than the original 6px, echoing the chat composer's rounding without
		   going fully round: the indicator is only ~34px tall, so a pill radius
		   (>=17px) would close the ends into half-circles and read as a different
		   component. 10px keeps recognisably straight edges top and bottom while
		   losing the boxy corners. */
		border-radius: 10px;
		background: color-mix(in srgb, var(--interactive-accent) 16%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--interactive-accent) 24%, transparent);
		opacity: 0;
		pointer-events: none;
		/* No transition until first placed (see `animate` gate) — otherwise the pill
		   would slide/fade in from 0,0 every time this pane mounts. */
		transition: none;
	}
	.s2b-tab-indicator.ready {
		opacity: 1;
	}
	.s2b-tab-indicator.animate {
		transition:
			transform 240ms cubic-bezier(0.32, 0.72, 0, 1),
			width 240ms cubic-bezier(0.32, 0.72, 0, 1),
			height 240ms cubic-bezier(0.32, 0.72, 0, 1),
			opacity 160ms ease;
	}

	/* Respect reduced-motion: snap instead of glide. */
	@media (prefers-reduced-motion: reduce) {
		.s2b-tab-indicator.animate {
			transition: opacity 160ms ease;
		}

		:global(.is-phone .s2b-tabs-collapse) .s2b-tab-icon + .s2b-tab-text {
			transition: opacity 160ms ease;
		}
	}
</style>
