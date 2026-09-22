<script lang="ts">
import Icon from "../ui/Icon.svelte";
import PickerPopover from "../ui/PickerPopover.svelte";
import PickerOptionRow from "../ui/PickerOptionRow.svelte";

interface Props {
	/** Attach files from the local computer (opens the OS file picker). */
	onFromComputer: () => void;
	/** Attach files from the vault (opens the search modal in picker mode). */
	onFromVault: () => void;
	/** Take a photo with the device camera. Omitted where there is no camera
	 * to open (desktop), and the row is hidden with it. */
	onFromCamera?: () => void;
}

const { onFromComputer, onFromVault, onFromCamera }: Props = $props();

let isOpen = $state(false);
let anchor: HTMLButtonElement | undefined = $state();

function pick(action: () => void) {
	isOpen = false;
	action();
}
</script>

<PickerPopover
  bind:open={isOpen}
  bind:element={anchor}
  tooltip="Add context"
  dataTestId="attach-context-button"
  triggerStyles="clickable-icon attach-context-button"
  contentClass="attach-context-popover"
  side="top"
  align="start"
  sideOffset={8}
>
  {#snippet trigger()}
    <Icon name="plus" size="s" />
  {/snippet}

  <PickerOptionRow onClick={() => pick(onFromComputer)}>
    {#snippet leading()}
      <Icon name="paperclip" size="xs" />
    {/snippet}
    {#snippet content()}
      From device
    {/snippet}
  </PickerOptionRow>

  {#if onFromCamera}
    <PickerOptionRow onClick={() => pick(onFromCamera)}>
      {#snippet leading()}
        <Icon name="camera" size="xs" />
      {/snippet}
      {#snippet content()}
        Take photo
      {/snippet}
    </PickerOptionRow>
  {/if}

  <PickerOptionRow onClick={() => pick(onFromVault)}>
    {#snippet leading()}
      <Icon name="vault" size="xs" />
    {/snippet}
    {#snippet content()}
      From vault
    {/snippet}
  </PickerOptionRow>
</PickerPopover>

<style>
  /* The attach options are short; don't inherit the picker's wide min-width. */
  :global(.attach-context-popover) {
    min-width: 0;
    width: max-content;
  }

  /* Prominent accent-tinted circle, not a muted glyph. Explicit square
     dimensions (matching the send button at the row's other end) instead of
     `.clickable-icon`'s default padding, which is wider than tall — that
     rendered this as an oval next to send's true circle. The tint mixes with
     `--background-primary`, the fill the composer actually has. */
  :global(.attach-context-button.clickable-icon) {
    background: color-mix(in srgb, var(--interactive-accent) 14%, var(--background-primary));
    color: var(--interactive-accent);
    border-radius: 999px;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    flex: 0 0 auto;
  }

  /* Same touch-size bump the send button gets on mobile. */
  :global(.is-mobile .attach-context-button.clickable-icon) {
    width: 2.75rem;
    height: 2.75rem;
  }

  :global(.attach-context-button.clickable-icon:hover) {
    background: color-mix(in srgb, var(--interactive-accent) 24%, var(--background-primary));
    color: var(--interactive-accent);
  }

  :global(.attach-context-button.clickable-icon .svg-icon) {
    stroke-width: 2.5;
  }
</style>
