<script lang="ts">
import { getData } from "../../stores/dataStore.svelte";
import { icon } from "../../utils/utils";

interface Props {
	provider: string;
}

const { provider }: Props = $props();

const data = getData();
const isTrusted = $derived(data.isProviderTrusted(provider));
</script>

<!-- Connection status is stated in the modal body (see the "Connection" row in
     ProviderSetup.svelte), which is where users actually look — a 20px check up here was
     the only success signal for a long time, and it was routinely missed. Trust has no
     body-level indicator of its own besides its toggle, so it stays. -->
{#if isTrusted}
  <span
    class="provider-icon-indicator provider-icon-indicator-accent"
    title="Trusted with private notes"
    aria-label="Trusted with private notes"
  >
    <span class="provider-status-icon" use:icon={"shield-check"}></span>
  </span>
{/if}

<style>
  .provider-icon-indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    min-height: 20px;
    flex-shrink: 0;
  }

  .provider-icon-indicator-accent {
    color: var(--text-accent);
  }

  .provider-status-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }

  /* Scale the injected Lucide SVG to fill the icon box. */
  .provider-status-icon :global(svg) {
    width: 20px;
    height: 20px;
  }
</style>
