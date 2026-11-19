<script lang="ts">
import { Popover } from "bits-ui";
import type { Snippet } from "svelte";
import Button from "./Button.svelte";

type PopoverSide = "top" | "right" | "bottom" | "left";
type PopoverAlign = "start" | "center" | "end";

interface Props {
	open?: boolean;
	element?: HTMLButtonElement | undefined;
	onTriggerClick?: () => void;
	tooltip?: string;
	dataTestId?: string;
	triggerStyles?: string;
	triggerClass?: string;
	contentClass?: string;
	side?: PopoverSide;
	align?: PopoverAlign;
	sideOffset?: number;
	trigger: Snippet<[boolean]>;
	children?: Snippet;
}

let {
	open = $bindable(false),
	element = $bindable(undefined),
	onTriggerClick,
	tooltip = undefined,
	dataTestId = undefined,
	triggerStyles = "s2b-picker-popover-trigger",
	triggerClass = "",
	contentClass = "",
	side = "bottom",
	align = "start",
	sideOffset = 6,
	trigger,
	children,
}: Props = $props();

function handleTriggerClick() {
	if (onTriggerClick) {
		onTriggerClick();
		return;
	}

	open = !open;
}
</script>

<Button
  bind:element
  onClick={handleTriggerClick}
  styles={triggerStyles}
  class={triggerClass}
  {tooltip}
  {dataTestId}
>
  {@render trigger(open)}
</Button>

<Popover.Root bind:open>
  <Popover.Portal>
    <Popover.Content
      class={`s2b-picker-popover-content ${contentClass}`.trim()}
      customAnchor={element}
      {sideOffset}
      {side}
      {align}
    >
      <div class="picker-popover-menu">
        {@render children?.()}
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style>
  :global(.s2b-picker-popover-trigger) {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    height: 28px;
    max-width: 220px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid var(--background-modifier-border);
    background: var(--interactive-normal);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    box-shadow: var(--shadow-xs);
    transition:
      background-color 0.12s ease,
      border-color 0.12s ease,
      box-shadow 0.12s ease;
  }

  /* Guarded so a tap doesn't leave the trigger stuck in its hover state. */
  @media (hover: hover) and (pointer: fine) {
    :global(.s2b-picker-popover-trigger:hover) {
      background: var(--interactive-hover);
      border-color: color-mix(in srgb, var(--background-modifier-border) 72%, var(--text-muted) 28%);
    }
  }

  :global(.s2b-picker-popover-trigger:focus-visible) {
    outline: 2px solid color-mix(in srgb, var(--interactive-accent) 55%, transparent);
    outline-offset: 2px;
  }

  :global(.s2b-picker-popover-content) {
    min-width: min(236px, calc(100vw - 24px));
    max-width: min(340px, calc(100vw - 24px));
    background: var(--background-primary);
    border-radius: var(--radius-m);
    border: 1px solid var(--background-modifier-border);
    box-shadow: var(--shadow-s);
    z-index: var(--layer-popover);
    overflow: hidden;
  }

  .picker-popover-menu {
    display: flex;
    flex-direction: column;
    padding: var(--size-4-1);
  }

  :global(.s2b-picker-popover-separator) {
    height: 1px;
    margin: var(--size-4-1) 0;
    background: var(--background-modifier-border);
  }
</style>
