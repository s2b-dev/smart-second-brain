<script lang="ts">
import type { Snippet } from "svelte";
import { t } from "../../i18n";

interface RadioProps {
	selected: boolean;
	onclick: (event: MouseEvent) => void;
	ariaLabel?: string;
}

interface Props {
	name: string;
	desc?: string;
	meta?: string;
	selected?: boolean;
	disabled?: boolean;
	clickable?: boolean;
	interactiveRole?: "button" | "radio";
	class?: string;
	onclick?: (event: MouseEvent) => void;
	radio?: RadioProps;
	leading?: Snippet;
	badges?: Snippet;
	children?: Snippet;
	trailing?: Snippet;
	actions?: Snippet;
}

let {
	name,
	desc,
	meta,
	selected = false,
	disabled = false,
	clickable = false,
	interactiveRole = "button",
	class: className = "",
	onclick,
	radio,
	leading,
	badges,
	children,
	trailing,
	actions,
}: Props = $props();

function handleClick(event: MouseEvent) {
	if (disabled || !clickable) {
		return;
	}
	onclick?.(event);
}

function handleKeyDown(event: KeyboardEvent) {
	if (!clickable || disabled) {
		return;
	}
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		onclick?.(event as unknown as MouseEvent);
	}
}

function handleRadioClick(event: MouseEvent) {
	event.stopPropagation();
	radio?.onclick(event);
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="setting-item managed-entity-item {className}"
  class:selected
  class:disabled
  class:clickable
  role={clickable ? interactiveRole : undefined}
  aria-checked={clickable && interactiveRole === "radio" && !radio ? selected : undefined}
  tabindex={clickable && !disabled ? 0 : undefined}
  onclick={handleClick}
  onkeydown={handleKeyDown}
>
  <div class="setting-item-info managed-entity-item-main">
    {#if leading}
      <div class="managed-entity-item-leading">
        {@render leading()}
      </div>
    {/if}

    <div class="managed-entity-item-body">
      <div class="managed-entity-item-header">
        <span class="managed-entity-item-name">{name}</span>
        {#if badges}
          <div class="managed-entity-item-badges">
            {@render badges()}
          </div>
        {/if}
      </div>

      {#if desc}
        <div class="managed-entity-item-desc">{desc}</div>
      {/if}

      {#if meta}
        <div class="managed-entity-item-meta">{meta}</div>
      {/if}

      {#if children}
        <div class="managed-entity-item-extra">
          {@render children()}
        </div>
      {/if}
    </div>
  </div>

  {#if actions}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="setting-item-control managed-entity-item-actions"
      onclick={(event) => event.stopPropagation()}
    >
      {@render actions()}
    </div>
  {/if}

  {#if radio}
    <div class="managed-entity-item-trailing">
      <button
        type="button"
        class="managed-entity-item-radio"
        class:selected={radio.selected}
        role="radio"
        aria-checked={radio.selected}
        aria-label={radio.ariaLabel ?? t("settings.managed_entity.select", { name })}
        onclick={handleRadioClick}
      ></button>
    </div>
  {:else if trailing}
    <div class="managed-entity-item-trailing">
      {@render trailing()}
    </div>
  {/if}
</div>

<style>
  .managed-entity-item {
    position: relative;
    gap: 12px;
    padding: 6px 8px;
    border-radius: 14px;
  }

  /* Mobile: Obsidian's core `.is-mobile .setting-item` stacks the control under
     the info column — right for form rows with wide controls, wrong for these
     list rows, whose actions are a compact icon cluster. Stacking them burns a
     full row per item (name, then a lonely strip of icons). Keep the native
     mobile list pattern instead: content left, accessories right. `!important`
     mirrors -main's own flex-direction override below — core's `.is-mobile
     .setting-item` rule outranks a single scoped class. */
  :global(.is-mobile) .managed-entity-item {
    flex-direction: row !important;
    align-items: center;
  }

  /* Restored to a row, the info column must also get its grow back — core's
     mobile stacking sizes `.setting-item-info` for a full-width layout, which
     in a row collapses it to min-content (names wrap per word, badges drop to
     their own line). */
  :global(.is-mobile) .managed-entity-item .managed-entity-item-main {
    flex: 1 1 auto !important;
    min-width: 0;
    width: auto;
  }

  /* Core's mobile stacking also stretches `.setting-item-control` full-width
     with a top inset AND gives it `flex: 1 0 auto` — the grow is what actually
     breaks the row layout (the icon cluster expands and squeezes the info column
     to zero width, so names wrap per word). Undo all of it so the actions hug
     the right edge at their natural size. */
  :global(.is-mobile) .managed-entity-item .managed-entity-item-actions,
  :global(.is-mobile) .managed-entity-item .managed-entity-item-trailing {
    width: auto !important;
    margin-top: 0;
    padding-top: 0;
    justify-content: flex-end;
    flex: 0 0 auto !important;
  }

  .managed-entity-item::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 12px;
    background: var(--background-modifier-hover);
    opacity: 0;
    pointer-events: none;
    transition: opacity 140ms ease;
  }

  .managed-entity-item.clickable {
    cursor: pointer;
  }

  .managed-entity-item.clickable:hover::before {
    opacity: 1;
  }

  .managed-entity-item.clickable:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--interactive-accent) 60%, transparent);
    outline-offset: 2px;
  }

  .managed-entity-item.disabled {
    opacity: 0.65;
  }

  .managed-entity-item-main {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-start;
    min-width: 0;
    /* !important: this element also carries Obsidian's native .setting-item-info class
       for native modal styling, and some themes (e.g. Cupertino) set flex-direction:
       column and a smaller gap on that class inside sidebar-layout modals with higher
       selector specificity than a single custom class can beat. */
    flex-direction: row !important;
    gap: 12px !important;
  }

  .managed-entity-item-leading {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    /* Match the header's first-line box so the icon centers on the name line even when
       the body has extra rows below (desc/meta). align-items: flex-start on -main keeps
       it pinned to the first line; this height + centering aligns it with the text. */
    min-height: 1lh;
  }

  .managed-entity-item-body {
    flex: 1;
    min-width: 0;
  }

  .managed-entity-item-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .managed-entity-item-name {
    font-weight: 500;
  }

  .managed-entity-item-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .managed-entity-item-desc,
  .managed-entity-item-meta {
    font-size: 0.85rem;
    color: var(--text-muted);
    margin-top: 4px;
  }

  .managed-entity-item-extra {
    margin-top: 8px;
  }

  .managed-entity-item-trailing {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    min-width: 16px;
  }

  .managed-entity-item-actions {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  /* `width`/`height`/`padding` carry `!important` because core out-specifies the
     scoped class here: `.is-tablet button:not(.clickable-icon)` (and its
     `.is-mobile` sibling) is 0,2,1 against this rule's 0,2,0, and applies
     `padding: var(--size-4-1) var(--size-4-5)` — 4px 20px. Under `border-box`
     that stretches the 16px dot to 43x16, and `border-radius: 999px` renders
     the result as a flat lozenge rather than a circle. This is a real button,
     so it can't opt out via `.clickable-icon` (that class brings its own
     sizing/hover chrome), hence forcing the geometry instead. */
  .managed-entity-item-radio {
    position: relative;
    top: 4px;
    width: 16px !important;
    height: 16px !important;
    min-width: 0 !important;
    padding: 0 !important;
    border-radius: 999px;
    border: 1.5px solid var(--background-modifier-border);
    background: var(--background-primary);
    flex-shrink: 0;
    cursor: pointer;
    transition:
      border-color 120ms ease,
      background-color 120ms ease,
      box-shadow 120ms ease;
  }

  .managed-entity-item-radio:hover {
    border-color: color-mix(in srgb, var(--interactive-accent) 45%, var(--background-modifier-border));
  }

  .managed-entity-item-radio:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--interactive-accent) 60%, transparent);
    outline-offset: 2px;
  }

  .managed-entity-item-radio.selected {
    border-color: var(--interactive-accent);
    background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--interactive-accent) 14%, transparent);
  }

  .managed-entity-item-radio.selected::after {
    content: "";
    position: absolute;
    top: 50%;
    left: 50%;
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--interactive-accent);
    transform: translate(-50%, -50%);
  }
</style>
