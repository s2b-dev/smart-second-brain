<script lang="ts">
import ManagedEntitySection from "../../components/settings/ManagedEntitySection.svelte";
import { PrivacyListModal } from "../../components/modal/PrivacyListModal";
import ProviderItem from "../../components/settings/ProviderItem.svelte";
import SettingGroup from "../../components/settings/SettingGroup.svelte";
import SettingItem from "../../components/settings/SettingItem.svelte";
import Button from "../../components/ui/Button.svelte";
import DocsLink from "../../components/ui/DocsLink.svelte";
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import { icon } from "../../utils/utils";
import { ProviderSetupModal } from "../provider-setup/ProviderSetup";

const pluginData = getData();
const plugin = getPlugin();

const privacyListModal = new PrivacyListModal(plugin.app);

// Provider management state
let configuredProviderIds = $derived(pluginData.getConfiguredProviders());

function handleOpenProviderSetup() {
	new ProviderSetupModal(plugin, {}).open();
}
</script>

<!-- Providers -->
<ManagedEntitySection
  heading="Providers"
  description="Providers connect Smart Second Brain to the AI services used for chat, embeddings, and other model-powered features."
  emptyMessage="No provider instances configured yet."
  hasItems={configuredProviderIds.length > 0}
>
  {#snippet actions()}
    <Button buttonText="Add provider" cta={true} onClick={handleOpenProviderSetup} />
  {/snippet}

  {#if configuredProviderIds.length > 0}
    {#each configuredProviderIds as provider (provider)}
      <ProviderItem {provider} />
    {/each}
  {/if}
</ManagedEntitySection>

<!-- Privacy -->
<SettingGroup heading="Privacy">
  <SettingItem
    name="Note access policy"
    class="privacy-setting-item"
    desc="Choose whether untrusted providers see nothing or everything by default, then manage the matching file list."
  >
    {#snippet nameSuffix()}
      <span
        class="privacy-trust-icon privacy-trust-icon--label"
        use:icon={"shield-check"}
        aria-hidden="true"
      ></span>
      <!-- Two vault modes crossed with per-provider trust, where the same toggle
           inverts meaning depending on the mode — more than one description line
           can carry, so link the page that lays it out. -->
      <DocsLink doc="privacyModel" subject="Note access policy" />
    {/snippet}

    <Button onClick={() => privacyListModal.open()} buttonText="Manage" />
  </SettingItem>
</SettingGroup>

<style>
  /* --icon-size drives the injected svg too: Obsidian's .svg-icon reads it for
     both axes, so sizing only the span leaves the glyph at the inherited 18px
     height and it overflows the box. */
  .privacy-trust-icon {
    --icon-size: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--icon-size);
    height: var(--icon-size);
    color: var(--text-accent);
    flex-shrink: 0;
  }

  .privacy-trust-icon :global(svg.svg-icon) {
    width: var(--icon-size);
    height: var(--icon-size);
  }

  .privacy-trust-icon--label {
    --icon-size: 14px;
  }
</style>
