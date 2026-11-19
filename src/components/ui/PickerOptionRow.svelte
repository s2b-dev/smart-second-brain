<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	active?: boolean;
	muted?: boolean;
	onClick?: () => void;
	onActionClick?: (event: MouseEvent) => void;
	actionTitle?: string;
	leading?: Snippet;
	content?: Snippet;
	meta?: Snippet;
	trailing?: Snippet;
	action?: Snippet;
	children?: Snippet;
}

let {
	active = false,
	muted = false,
	onClick,
	onActionClick,
	actionTitle = undefined,
	leading,
	content,
	meta,
	trailing,
	action,
}: Props = $props();
</script>

<div class="s2b-picker-option-row" class:is-active={active} class:is-muted={muted}>
  <button type="button" class="picker-option" onclick={onClick}>
    {#if leading}
      <span class="picker-option-leading menu-item-icon">
        {@render leading()}
      </span>
    {/if}

    <span class="picker-option-body">
      <span class="picker-option-label">
        {@render content?.()}
      </span>

      {#if meta}
        <span class="picker-option-meta">
          {@render meta()}
        </span>
      {/if}
    </span>

    {#if trailing}
      <span class="picker-option-trailing menu-item-icon">
        {@render trailing()}
      </span>
    {/if}
  </button>

  {#if action}
    <button
      type="button"
      class="s2b-picker-option-action clickable-icon"
      title={actionTitle}
      onclick={onActionClick}
    >
      {@render action()}
    </button>
  {/if}
</div>

<style>
  .s2b-picker-option-row {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .s2b-picker-option-row.is-active {
    background: var(--background-modifier-hover);
  }

  /* Touch devices keep a sticky :hover on the last-tapped element, which would
     leave rows looking permanently highlighted. Only real pointers get hover. */
  @media (hover: hover) and (pointer: fine) {
    .s2b-picker-option-row:hover {
      background: var(--background-modifier-hover);
    }
  }

  .s2b-picker-option-row.is-muted {
    color: var(--text-muted);
  }

  .picker-option {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    flex: 1;
    min-width: 0;
    padding: var(--size-4-2) var(--size-4-3);
    border: none;
    background: transparent;
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    text-align: left;
    cursor: pointer;
  }

  .picker-option:focus-visible {
    outline: 2px solid var(--background-modifier-border-focus);
    outline-offset: 1px;
  }

  .s2b-picker-option-row.is-muted .picker-option {
    color: var(--text-muted);
  }

  .s2b-picker-option-row.is-active .picker-option {
    color: var(--text-normal);
  }

  .picker-option-body {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .picker-option-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .picker-option-leading,
  .picker-option-meta,
  .picker-option-trailing {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .picker-option-meta {
    font-size: 0.72rem;
    color: var(--text-muted);
    padding-inline-start: 0.1rem;
  }

  .s2b-picker-option-action {
    flex-shrink: 0;
    align-self: stretch;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.75rem;
    margin: 0.1rem 0.1rem 0.1rem 0;
    opacity: 0;
    padding: 0.25rem;
    border-radius: 0.35rem;
    color: var(--text-muted);
    transition:
      opacity 0.12s ease,
      background-color 0.12s ease,
      color 0.12s ease;
  }

  .s2b-picker-option-row:focus-within .s2b-picker-option-action {
    opacity: 0.92;
  }

  .s2b-picker-option-row.is-active .s2b-picker-option-action {
    opacity: 0.6;
  }

  @media (hover: hover) and (pointer: fine) {
    .s2b-picker-option-row:hover .s2b-picker-option-action {
      opacity: 0.92;
    }

    .s2b-picker-option-action:hover {
      background: color-mix(in srgb, var(--background-primary) 55%, transparent);
      color: var(--text-normal);
    }
  }

  .s2b-picker-option-action:focus-visible {
    outline: 2px solid var(--background-modifier-border-focus);
    outline-offset: 1px;
  }
</style>
