<script lang="ts">
interface Props {
	name: string;
	namePrefix?: import("svelte").Snippet;
	nameSuffix?: import("svelte").Snippet;
	isHeading?: boolean;
	class?: string;
	desc?: string;
	disabled?: boolean;
	isDisabled?: boolean;
	/** When true, hides the description text and shows it as a tooltip on the name instead. */
	compact?: boolean;
	children?: import("svelte").Snippet;
}

let {
	name,
	namePrefix,
	nameSuffix,
	isHeading = false,
	desc = "",
	disabled = false,
	isDisabled = false,
	compact = false,
	children,
	class: className = "",
}: Props = $props();

const isRowDisabled = $derived(disabled || isDisabled);
</script>

<div
  class="setting-item s2b-setting-item {isHeading ? 'setting-item-heading' : ''} {isRowDisabled
    ? 's2b-opacity-50 s2b-pointer-events-none'
    : ''} {compact ? 'setting-item--compact' : ''} {className}"
>
  <div class="setting-item-info">
    <div class="setting-item-name" aria-label={compact && desc ? desc : undefined}>
      {#if namePrefix}
        <span class="setting-item-name-prefix">{@render namePrefix()}</span>
      {/if}
      <span>{name}</span>
      {#if nameSuffix}
        <span class="setting-item-name-suffix">{@render nameSuffix()}</span>
      {/if}
    </div>
    <!-- Normal rows keep the description stacked under the name, as Obsidian does. -->
    {#if !compact && desc}
      <div class="setting-item-description">{desc}</div>
    {/if}
  </div>
  <div class="setting-item-control">
    {@render children?.()}
  </div>
</div>

<style>
  .setting-item--compact {
    padding-top: 4px;
    padding-bottom: 4px;
  }

  .setting-item-name {
    display: inline-flex;
    align-items: center;
    gap: 0;
    line-height: 1.4;
  }

  .setting-item-name-prefix {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-right: 6px;
    align-self: center;
  }

  .setting-item-name-suffix {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 6px;
    align-self: center;
  }

  /* A compact row always carries its description as a tooltip on the name, so
     the name always hints that there is something to reveal. */
  .setting-item--compact .setting-item-name {
    cursor: help;
  }

  /* Phone: core stacks a setting's control full-width under its info column
     (`.is-phone .modal .setting-item:not(:is(.mod-toggle, …))`), which is right
     for wide controls — inputs, selects, text buttons — but wrong for compact
     ones: native rows built via Obsidian's Setting API keep toggles and small
     actions inline on the right (the .mod-toggle/.mod-action exemptions).
     Our rows take arbitrary snippets, so detect the compact case structurally
     instead: every direct child of the control is a toggle or an icon button.
     Global because the snippet-rendered children carry other components' scopes. */
  :global(
    .is-phone .modal .s2b-setting-item:has(.setting-item-control :is(.checkbox-container, .clickable-icon)):not(
      :has(.setting-item-control :is(input:not([type="checkbox"]), select, textarea, .dropdown, button:not(.clickable-icon)))
    )
  ) {
    flex-direction: row;
    align-items: center;
  }

  :global(
    .is-phone .modal .s2b-setting-item:has(.setting-item-control :is(.checkbox-container, .clickable-icon)):not(
      :has(.setting-item-control :is(input:not([type="checkbox"]), select, textarea, .dropdown, button:not(.clickable-icon)))
    ) > .setting-item-control
  ) {
    width: auto;
    flex: 0 0 auto;
    margin-top: 0;
    padding-top: 0;
  }
</style>
