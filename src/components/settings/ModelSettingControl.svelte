<script lang="ts">
import type { Component } from "svelte";
import Button from "../ui/Button.svelte";

interface Props {
	available?: boolean;
	loading?: boolean;
	configureLabel?: string;
	onConfigure?: () => void;
	placeholder: string;
	selectedLabel?: string | null;
	selectedLogo?: Component<{ width?: number; height?: number }> | null;
	onSelect: () => void;
	secondaryLabel?: string;
	onSecondary?: () => void;
	/** Shown next to the configure button when `available` is false, explaining why. */
	unavailableHint?: string;
}

let {
	available = true,
	loading = false,
	configureLabel,
	onConfigure,
	placeholder,
	selectedLabel = null,
	selectedLogo = null,
	onSelect,
	secondaryLabel,
	onSecondary,
	unavailableHint,
}: Props = $props();
</script>

{#if loading}
  <span class="s2b-text-[--text-muted] s2b-text-sm">Loading models…</span>
{:else if !available && configureLabel && onConfigure}
  <!-- Labelled, not icon-only: a bare gear reads as "configure this dropdown" and its meaning
       lived only in the tooltip/aria-label, which touch devices never surface. -->
  <div class="model-setting-unavailable">
    {#if unavailableHint}
      <span class="model-setting-hint s2b-text-sm s2b-text-[--text-muted]">{unavailableHint}</span>
    {/if}
    <Button
      iconId="settings"
      buttonText={configureLabel}
      tooltip={configureLabel}
      onClick={() => onConfigure()}
    />
  </div>
{:else}
  <div class="model-setting-control">
    <Button onClick={onSelect}>
      {#if selectedLabel}
        <div class="model-setting-button-content">
          {#if selectedLogo}
            {@const Logo = selectedLogo}
            <Logo width={14} height={14} />
          {/if}
          <span>{selectedLabel}</span>
        </div>
      {:else}
        <span class="s2b-text-[--text-muted]">{placeholder}</span>
      {/if}
    </Button>

    {#if secondaryLabel && onSecondary}
      <Button buttonText={secondaryLabel} onClick={onSecondary} />
    {/if}
  </div>
{/if}

<style>
  /* Wraps on narrow (mobile) widths so the hint never squeezes the button to an unreadable size. */
  .model-setting-unavailable {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    width: 100%;
  }

  .model-setting-hint {
    flex: 1 1 12ch;
    min-width: 0;
    text-align: right;
    line-height: 1.35;
  }

  .model-setting-control {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: flex-end;
    width: 100%;
  }

  .model-setting-button-content {
    display: flex;
    align-items: center;
    gap: 8px;
  }
</style>
