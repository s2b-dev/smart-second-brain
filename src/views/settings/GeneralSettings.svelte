<script lang="ts">
import ManagedEntitySection from "../../components/settings/ManagedEntitySection.svelte";
import { PrivacyListModal } from "../../components/modal/PrivacyListModal";
import ProviderItem from "../../components/settings/ProviderItem.svelte";
import SettingGroup from "../../components/settings/SettingGroup.svelte";
import SettingItem from "../../components/settings/SettingItem.svelte";
import Button from "../../components/ui/Button.svelte";
import DocsLink from "../../components/ui/DocsLink.svelte";
import Dropdown from "../../components/ui/Dropdown.svelte";
import Text from "../../components/ui/Text.svelte";
import { useAvailableModels } from "../../hooks/useAvailableModels.svelte";
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import { icon } from "../../utils/utils";
import { ProviderSetupModal } from "../provider-setup/ProviderSetup";

const pluginData = getData();
const plugin = getPlugin();
const availableModels = useAvailableModels();

const privacyListModal = new PrivacyListModal(plugin.app);

// Provider management state
let configuredProviderIds = $derived(pluginData.getConfiguredProviders());

function handleOpenProviderSetup() {
	new ProviderSetupModal(plugin, {}).open();
}

const overrides = $derived(pluginData.modelContextOverrides);

let selectedDropdownModel = $state("");
let customModelInput = $state("");
let tokensInput = $state(0);

const modelDropdownOptions = $derived.by(() => {
	const options = [{ display: "Select a model…", value: "" }];
	const seen = new Set<string>();
	for (const m of availableModels.hydratedChatModels) {
		if (!seen.has(m.variantKey)) {
			seen.add(m.variantKey);
			options.push({
				display: `${m.displayName} (${m.variantKey})`,
				value: m.variantKey,
			});
		}
	}
	options.push({ display: "Custom model ID…", value: "__custom__" });
	return options;
});

const isCustomSelected = $derived(selectedDropdownModel === "__custom__");
const effectiveModelKey = $derived(isCustomSelected ? customModelInput.trim() : selectedDropdownModel.trim());
const canAddOverride = $derived(effectiveModelKey.length > 0 && tokensInput > 0);

function handleAddOverride() {
	if (!canAddOverride) return;
	pluginData.setModelContextOverride(effectiveModelKey, tokensInput);
	selectedDropdownModel = "";
	customModelInput = "";
	tokensInput = 0;
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

<!-- Model Context Overrides -->
<SettingGroup heading="Model context overrides">
  <div class="setting-item">
    <div class="setting-item-info">
      <div class="setting-item-name">Custom context sizes</div>
      <div class="setting-item-description">
        Override the context window in tokens for models (e.g. self-hosted LiteLLM, vLLM, Ollama) that do not advertise their context length via API.
      </div>
    </div>
  </div>

  {#if Object.keys(overrides).length === 0}
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-description text-muted">
          No model context overrides defined. Models default to their catalog limit or 128,000 tokens.
        </div>
      </div>
    </div>
  {:else}
    {#each Object.entries(overrides) as [modelKey, contextWindow] (modelKey)}
      <SettingItem name={modelKey} desc="Context window in tokens">
        <div class="flex items-center gap-2">
          <Text
            inputType="number"
            placeholder="128000"
            class="w-28 text-right"
            value={contextWindow}
            onblur={(val) => {
              const num = Number(val);
              if (!Number.isNaN(num) && num > 0) {
                pluginData.setModelContextOverride(modelKey, num);
              }
            }}
          />
          <Button
            iconId="trash"
            ariaLabel="Remove override"
            tooltip="Remove override"
            onClick={() => pluginData.setModelContextOverride(modelKey, null)}
          />
        </div>
      </SettingItem>
    {/each}
  {/if}

  <SettingItem
    name="Add context override"
    desc="Select a model or enter a model ID, then specify the context window in tokens"
  >
    <div class="flex flex-wrap items-center gap-2">
      <Dropdown
        type="options"
        dropdown={modelDropdownOptions}
        bind:selected={selectedDropdownModel}
        class="min-w-[160px]"
      />
      {#if isCustomSelected}
        <Text
          inputType="text"
          placeholder="Model ID (e.g. qwen3.8)"
          class="w-36"
          bind:value={customModelInput}
        />
      {/if}
      <Text
        inputType="number"
        placeholder="Tokens (e.g. 41000)"
        class="w-28 text-right"
        bind:value={tokensInput}
      />
      <Button
        buttonText="Add"
        cta={true}
        disabled={!canAddOverride}
        onClick={handleAddOverride}
      />
    </div>
  </SettingItem>
</SettingGroup>

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
