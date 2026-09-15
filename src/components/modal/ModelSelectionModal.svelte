<script lang="ts">
import { useAvailableModels } from "../../hooks/useAvailableModels.svelte";
import { extractVendor, logUnclassifiedModelsInfo } from "../../lib/modelVendorClassification";
import type { UiClassifiableModel } from "../../lib/modelVendorClassification";
import { stripVendorPrefix } from "../../lib/modelMetadataNormalizer";
import type { HydratedChatModelMetadata, HydratedEmbeddingModelMetadata } from "../../types/modelMetadata";
import { MODEL_CAPABILITY_ICONS } from "../../lib/modelCapabilityIcons";
import { VENDOR_CATALOG } from "../../lib/vendorLogoSvg";
import type { VendorLogoComponent } from "../../lib/vendorLogoSvg";
import { getProviderDefinition } from "../../providers/index";
import { getData } from "../../stores/dataStore.svelte";
import { addProviderAction } from "../../utils/actionNotice";
import GenericAIIcon from "../ui/logos/GenericAIIcon.svelte";
import Icon from "../ui/Icon.svelte";
import type { ModelSelectionModal, ModelType, SelectedModel } from "./ModelSelectionModal";

interface Props {
	modal?: ModelSelectionModal;
	modelType: ModelType;
	currentSelection: SelectedModel | null;
	onSelect: (model: SelectedModel | null) => void;
}

const { modal, modelType, currentSelection, onSelect }: Props = $props();

const pluginData = getData();
const availableModels = useAvailableModels();
const openRouterModels = $derived(availableModels.openRouterModels);

let searchQuery = $state("");
let selectedVendor = $state<string | null>(null);
let selectedConfiguredProvider = $state<string | null>(null);
let showFavorites = $state(false);
let searchInputEl: HTMLInputElement | undefined = $state();
let modelsListEl: HTMLElement | undefined = $state();

type HydratedModel = HydratedChatModelMetadata | HydratedEmbeddingModelMetadata;

// Get hydrated models based on type
const models = $derived(
	modelType === "chat" ? availableModels.hydratedChatModels : availableModels.hydratedEmbeddingModels,
);

function toClassifiableModel(model: HydratedModel): UiClassifiableModel {
	const providerMeta = pluginData.getProviderMeta(model.provider);
	const providerAuth = pluginData.getResolvedProviderAuth(model.provider);
	const isOllamaProvider = providerMeta?.templateId === "ollama" || model.provider === "ollama";
	const families = isOllamaProvider ? availableModels.getOllamaModelFamilies(model.variantKey) : undefined;
	return {
		provider: model.provider,
		model: model.variantKey,
		templateId: providerMeta?.templateId,
		baseUrl: providerAuth.baseUrl,
		family: families?.[0],
		families,
	};
}

const classifiableModels = $derived(models.map((model) => toClassifiableModel(model)));

$effect(() => {
	logUnclassifiedModelsInfo("model-selection-modal", classifiableModels, openRouterModels);
});

$effect(() => {
	searchInputEl?.focus();
});

// With hundreds of models the current selection is easy to lose; bring it into
// view once, when the (async-loading) model list first contains it. One-shot so
// later filtering/refetching never yanks the scroll position around.
let didRevealSelection = false;
$effect(() => {
	if (didRevealSelection || !currentSelection || models.length === 0) return;
	didRevealSelection = true;
	window.requestAnimationFrame(() => {
		modelsListEl?.querySelector(".model-card.selected")?.scrollIntoView({ block: "center" });
	});
});

// Group models by provider
const modelsByProvider = $derived.by(() => {
	const grouped = new Map<string, HydratedModel[]>();

	for (const model of models) {
		const existing = grouped.get(model.provider) ?? [];
		existing.push(model);
		grouped.set(model.provider, existing);
	}

	return Array.from(grouped.entries()).map(([provider, models]) => ({
		provider,
		models,
	}));
});

const availableConfiguredProviders = $derived.by(() =>
	modelsByProvider.map(({ provider }) => ({
		id: provider,
		name: getProviderDisplayName(provider),
		logo: getProviderLogo(provider),
	})),
);

const showConfiguredProviderFilters = $derived(availableConfiguredProviders.length > 1);

const availableVendors = $derived.by(() => {
	const vendorSet = new Set<string>();
	for (const model of models) {
		const vendor = extractVendor(toClassifiableModel(model), openRouterModels);
		if (vendor) vendorSet.add(vendor);
	}
	return VENDOR_CATALOG.filter((vendor) => vendorSet.has(vendor.id));
});

// Filter models by search query, AI vendor, configured provider, and favorites
const filteredModelsByProvider = $derived.by(() => {
	let result = modelsByProvider;

	// Filter by favorites if selected
	if (showFavorites) {
		result = result
			.map(({ provider, models }) => ({
				provider,
				models: models.filter((m) => pluginData.isFavoriteModel(m.provider, m.variantKey)),
			}))
			.filter(({ models }) => models.length > 0);
	}

	// Filter by AI vendor if one is selected
	if (selectedVendor) {
		result = result
			.map(({ provider, models }) => ({
				provider,
				models: models.filter(
					(model) => extractVendor(toClassifiableModel(model), openRouterModels) === selectedVendor,
				),
			}))
			.filter(({ models }) => models.length > 0);
	}

	// Filter by configured provider instance if one is selected
	if (selectedConfiguredProvider) {
		result = result.filter(({ provider }) => provider === selectedConfiguredProvider);
	}

	// Filter by search query
	if (searchQuery.trim()) {
		const query = searchQuery.toLowerCase();
		result = result
			.map(({ provider, models }) => ({
				provider,
				models: models.filter(
					(m) =>
						m.displayName.toLowerCase().includes(query) ||
						m.variantKey.toLowerCase().includes(query) ||
						provider.toLowerCase().includes(query) ||
						getProviderDisplayName(provider).toLowerCase().includes(query),
				),
			}))
			.filter(({ models }) => models.length > 0);
	}

	return result;
});

// Get provider info
function getProviderDisplayName(providerId: string): string {
	const provider = getProviderDefinition(providerId, pluginData.getAllProviderMeta());
	return provider?.displayName ?? providerId;
}

function getProviderLogo(providerId: string) {
	const provider = getProviderDefinition(providerId, pluginData.getAllProviderMeta());
	if (provider && "logo" in provider && provider.logo) {
		return provider.logo;
	}
	return GenericAIIcon;
}

/** Vendor artwork keyed by the ids `extractVendor` returns — the same set the
 *  sidebar filters offer. Catalogues carry many more labs than that, so a miss
 *  is normal and callers must handle `null`. */
const VENDOR_LOGOS: Record<string, VendorLogoComponent> = Object.fromEntries(
	VENDOR_CATALOG.map((vendor) => [vendor.id, vendor.logo]),
);

/**
 * Row presentation for a model: its lab's logo plus a name with the redundant
 * "Lab: " prefix removed. Catalogues ship names like "Qwen: Qwen3.8 Max"; when
 * we can draw the lab's mark the prefix is just noise, so the logo replaces it.
 * Without artwork the prefix stays as text rather than collapsing every unknown
 * lab into one anonymous glyph. Mirrors `ModelSuggestModal.renderSuggestion`.
 */
function getModelBranding(model: HydratedModel): {
	logo: VendorLogoComponent | null;
	name: string;
} {
	const vendor = extractVendor(toClassifiableModel(model), openRouterModels);
	const logo = vendor ? (VENDOR_LOGOS[vendor] ?? null) : null;
	return { logo, name: logo ? stripVendorPrefix(model.displayName) : model.displayName };
}

// Format cost (per 1M tokens)
function formatCost(costPer1M?: number): string {
	if (costPer1M === undefined) return "—";
	if (costPer1M === 0) return "Free";
	if (costPer1M < 0.01) return `$${costPer1M.toFixed(4)}`;
	return `$${costPer1M.toFixed(2)}`;
}

function formatTokenLimit(tokens?: number): string {
	if (!tokens) return "—";
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		return `${Math.round(tokens / 1_000)}K`;
	}
	return tokens.toString();
}

function getVariantKeyDisplay(model: HydratedModel): string {
	if (model.provider === "ollama") {
		return model.variantKey.replace(/:latest$/i, "");
	}
	return model.variantKey;
}

// Check if model is currently selected
function isSelected(provider: string, variantKey: string): boolean {
	return currentSelection?.provider === provider && currentSelection?.model === variantKey;
}

// Handle model selection
function handleSelect(provider: string, variantKey: string) {
	onSelect({ provider, model: variantKey });
}

// --- Keyboard support ---
// Search is the primary interaction (installs routinely discover 400+ models),
// so the flow "type, Enter" must work without the mouse: Enter picks the top
// visible model, ArrowDown steps into the list, and arrows walk the cards.

function cardEls(): HTMLElement[] {
	return Array.from(modelsListEl?.querySelectorAll<HTMLElement>(".model-card") ?? []);
}

function focusCard(index: number) {
	const cards = cardEls();
	if (cards.length === 0) return;
	cards[Math.max(0, Math.min(index, cards.length - 1))].focus();
}

function handleSearchKeydown(event: KeyboardEvent) {
	if (event.key === "Enter") {
		const first = filteredModelsByProvider[0]?.models[0];
		if (first) handleSelect(first.provider, first.variantKey);
	} else if (event.key === "ArrowDown") {
		event.preventDefault();
		focusCard(0);
	}
}

function handleCardKeydown(event: KeyboardEvent, provider: string, variantKey: string) {
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		handleSelect(provider, variantKey);
		return;
	}
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	event.preventDefault();
	const cards = cardEls();
	const index = cards.indexOf(event.currentTarget as HTMLElement);
	if (event.key === "ArrowUp" && index <= 0) {
		searchInputEl?.focus();
		return;
	}
	focusCard(index + (event.key === "ArrowDown" ? 1 : -1));
}

// --- Model discovery refresh ---
// Discovery can come back empty (bad/placeholder key, models not yet added to
// the provider account, or a freshly-pulled Ollama model). Providers don't
// auto-pull — the user adds models on the provider side, then re-discovers here.
const configuredProviders = $derived(availableModels.providers);
const isLoadingModels = $derived(availableModels.isLoadingModels);

function refreshModels() {
	availableModels.refetchModels();
}

/** The way out of the "no provider configured" dead end: this modal can't do
 *  anything useful until one exists, so close it and open provider setup
 *  (same surface `addProviderAction` notices link to). */
function openProviderSetup() {
	modal?.close();
	addProviderAction().run();
}

function getProviderListDisplay(): string {
	const names = configuredProviders.map((id) => getProviderDisplayName(id));
	if (names.length === 0) return "your provider";
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
</script>

<div class="model-selection-container">
  <div class="model-selection-layout">
    {#if availableVendors.length > 0}
      <div class="model-provider-sidebar" aria-label="AI vendor filters">
        <button
          type="button"
          class="clickable-icon model-provider-btn"
          class:active={showFavorites}
          onclick={() => {
            showFavorites = !showFavorites;
            if (showFavorites) selectedConfiguredProvider = null;
          }}
          title="Favorites"
          aria-label="Favorites"
          aria-pressed={showFavorites}
        >
          <Icon name="star" size="m" />
        </button>

        {#each availableVendors as vendorFilter (vendorFilter.id)}
          {@const VendorLogo = vendorFilter.logo}
          <button
            type="button"
            class="clickable-icon model-provider-btn"
            class:active={selectedVendor === vendorFilter.id}
            onclick={() => {
              selectedVendor = selectedVendor === vendorFilter.id ? null : vendorFilter.id;
            }}
            title={vendorFilter.name}
            aria-label={vendorFilter.name}
            aria-pressed={selectedVendor === vendorFilter.id}
          >
            <VendorLogo width={32} height={32} />
          </button>
        {/each}
      </div>
    {/if}

    <div class="model-selection-main">
      <div class="model-search">
        <Icon name="search" size="s" />
        <input
          bind:this={searchInputEl}
          type="text"
          placeholder={modelType === "chat"
            ? "Search chat models…"
            : "Search embedding models…"}
          bind:value={searchQuery}
          onkeydown={handleSearchKeydown}
          class="search-input"
        />
        {#if searchQuery}
          <button
            type="button"
            class="clickable-icon clear-search"
            aria-label="Clear search"
            onclick={() => (searchQuery = "")}
          >
            <Icon name="x" size="xs" />
          </button>
        {/if}
        <button
          type="button"
          class="clickable-icon refresh-models"
          class:is-loading={isLoadingModels}
          onclick={refreshModels}
          disabled={isLoadingModels}
          aria-label="Re-fetch models from your configured providers"
          title="Re-fetch models from your configured providers"
        >
          <Icon name="refresh-cw" size="s" />
        </button>
      </div>

      {#if showConfiguredProviderFilters}
        <div class="provider-filter-bar" aria-label="Configured provider filters">
          {#each availableConfiguredProviders as providerFilter (providerFilter.id)}
            {@const ProviderLogo = providerFilter.logo}
            <button
              type="button"
              class="s2b-pill s2b-pill--interactive provider-filter-btn"
              class:s2b-pill--active={selectedConfiguredProvider === providerFilter.id}
              aria-pressed={selectedConfiguredProvider === providerFilter.id}
              onclick={() => {
                showFavorites = false;
                selectedConfiguredProvider =
                  selectedConfiguredProvider === providerFilter.id ? null : providerFilter.id;
              }}
              title={providerFilter.name}
            >
              <ProviderLogo width={18} height={18} />
              <span>{providerFilter.name}</span>
            </button>
          {/each}
        </div>
      {/if}

      <div class="models-list" bind:this={modelsListEl}>
        {#each filteredModelsByProvider as { provider, models } (provider)}
          {@const Logo = getProviderLogo(provider)}
          <div class="provider-group">
            <div class="provider-header">
              <Logo width={16} height={16} />
              <span>{getProviderDisplayName(provider)}</span>
            </div>

            <div class="provider-models">
              {#each models as model (`${model.provider}::${model.variantKey}`)}
                {@const isFavorite = pluginData.isFavoriteModel(model.provider, model.variantKey)}
                {@const branding = getModelBranding(model)}
                {@const VendorLogo = branding.logo}
                <div
                  role="button"
                  tabindex="0"
                  class="model-card"
                  class:selected={isSelected(model.provider, model.variantKey)}
                  onclick={() => handleSelect(model.provider, model.variantKey)}
                  onkeydown={(e) => handleCardKeydown(e, model.provider, model.variantKey)}
                >
                  <div class="model-main">
                    {#if VendorLogo}
                      <span class="model-vendor-logo" aria-hidden="true">
                        <VendorLogo width={20} height={20} />
                      </span>
                    {/if}
                    <div class="model-info">
                      <div class="model-name">{branding.name}</div>
                      {#if model.displayName !== getVariantKeyDisplay(model)}
                        <div class="model-description">{getVariantKeyDisplay(model)}</div>
                      {/if}
                    </div>
                    <div class="model-actions">
                      <button
                        type="button"
                        class="clickable-icon favorite-btn"
                        class:is-favorite={isFavorite}
                        onclick={(e) => {
                          e.stopPropagation();
                          pluginData.toggleFavoriteModel(model.provider, model.variantKey);
                        }}
                        aria-pressed={isFavorite}
                        aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
                        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
                      >
                        <Icon name="star" size="s" />
                      </button>
                      {#if isSelected(model.provider, model.variantKey)}
                        <span class="check-icon" aria-hidden="true">
                          <Icon name="check" size="s" />
                        </span>
                      {/if}
                    </div>
                  </div>

                  <div class="model-meta">
                    {#if model.kind === "chat"}
                      <span class="meta-tag" title="Context window">
                        {formatTokenLimit(model.contextWindow)} ctx
                      </span>
                    {:else}
                      <span class="meta-tag" title="Max input tokens">
                        {formatTokenLimit(model.maxInputTokens)} max input
                      </span>
                    {/if}

                    {#if model.paramSize}
                      <span class="meta-tag" title="Parameter size">
                        {model.paramSize}
                      </span>
                    {/if}
                    {#if model.quantization}
                      <span class="meta-tag" title="Quantization level">
                        {model.quantization}
                      </span>
                    {/if}

                    {#if model.kind === "chat" && (model.pricing?.inputUsdPer1M !== undefined || model.pricing?.outputUsdPer1M !== undefined)}
                      <span class="meta-tag" title="Cost per 1M tokens (in/out)">
                        {formatCost(model.pricing?.inputUsdPer1M)}/{formatCost(
                          model.pricing?.outputUsdPer1M,
                        )}
                      </span>
                    {/if}

                    {#if model.kind === "embedding" && model.pricing?.inputUsdPer1M !== undefined}
                      <span class="meta-tag" title="Cost per 1M input tokens">
                        {formatCost(model.pricing.inputUsdPer1M)}
                      </span>
                    {/if}

                    {#if model.kind === "chat" && model.capabilities.toolCalls}
                      {@const { icon, label } = MODEL_CAPABILITY_ICONS.toolCalls}
                      <span class="meta-tag capability" title={label} aria-label={label}>
                        <Icon name={icon} size="xs" />
                      </span>
                    {/if}
                    {#if model.kind === "chat" && model.capabilities.reasoning}
                      {@const { icon, label } = MODEL_CAPABILITY_ICONS.reasoning}
                      <span class="meta-tag capability" title={label} aria-label={label}>
                        <Icon name={icon} size="xs" />
                      </span>
                    {/if}
                    {#if model.kind === "chat" && model.capabilities.vision}
                      {@const { icon, label } = MODEL_CAPABILITY_ICONS.vision}
                      <span class="meta-tag capability" title={label} aria-label={label}>
                        <Icon name={icon} size="xs" />
                      </span>
                    {/if}
                    {#if model.kind === "chat" && model.capabilities.structuredOutput}
                      {@const { icon, label } = MODEL_CAPABILITY_ICONS.structuredOutput}
                      <span class="meta-tag capability" title={label} aria-label={label}>
                        <Icon name={icon} size="xs" />
                      </span>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {:else}
          {#if showFavorites}
            <div class="no-models">No favorite models yet. Click the star on any model to add it.</div>
          {:else if searchQuery || selectedVendor || selectedConfiguredProvider}
            <div class="no-models">No models match your filters</div>
          {:else if configuredProviders.length === 0}
            <div class="no-models-guide">
              <div class="no-models-title">No provider configured</div>
              <div class="no-models-desc">
                Add an AI provider to discover {modelType === "embedding"
                  ? "embedding"
                  : "chat"} models.
              </div>
              <button type="button" class="mod-cta no-models-cta" onclick={openProviderSetup}>
                <Icon name="plus" size="s" />
                Add provider
              </button>
            </div>
          {:else}
            <div class="no-models-guide">
              <div class="no-models-title">No models found</div>
              <div class="no-models-desc">
                {#if modelType === "embedding"}
                  No embedding models were discovered for {getProviderListDisplay()}. Add embedding
                  models to your provider (for local providers like Ollama, pull them first), then
                  refresh.
                {:else}
                  No chat models were discovered for {getProviderListDisplay()}. Add models to your
                  provider (for local providers like Ollama, pull them first), then refresh.
                {/if}
              </div>
              <button
                type="button"
                class="mod-cta no-models-cta"
                class:is-loading={isLoadingModels}
                onclick={refreshModels}
                disabled={isLoadingModels}
              >
                <Icon name="refresh-cw" size="s" />
                {isLoadingModels ? "Refreshing…" : "Refresh models"}
              </button>
            </div>
          {/if}
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .model-selection-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    box-sizing: border-box;
  }

  .model-selection-layout {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .model-provider-sidebar {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 8px;
    margin: 16px 0 16px 16px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-l);
    background: var(--background-secondary);
    overflow-y: auto;
    flex-shrink: 0;
    box-sizing: border-box;
  }

  /* `.clickable-icon` supplies the native rest/hover treatment; this only
     fixes the hit area so the rail stays a uniform column. */
  .model-provider-btn {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
  }

  .model-provider-btn.active {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .model-provider-btn.active:hover {
    background: var(--interactive-accent-hover);
    color: var(--text-on-accent);
  }

  .model-selection-main {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    gap: 12px;
    padding: 16px;
    overflow: hidden;
  }

  .model-search {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--background-secondary);
    border-radius: var(--radius-m);
    border: 1px solid var(--background-modifier-border);
  }

  .provider-filter-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding-bottom: 4px;
  }

  /* Base look and states come from the shared `.s2b-pill` family (the mobile
     picker's filter strip uses the same classes); this only sizes the pill up
     to carry 18px provider artwork. */
  .provider-filter-btn {
    min-height: 34px;
    padding: 6px 10px;
    gap: 8px;
    font-size: var(--font-ui-smaller);
  }

  .provider-filter-btn span {
    font-weight: 500;
  }

  .model-search:focus-within {
    border-color: var(--interactive-accent);
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    box-shadow: none;
    color: var(--text-normal);
    font-size: var(--font-ui-small);
  }

  .search-input:focus,
  .search-input:focus-visible {
    outline: none;
    border: none;
    box-shadow: none;
  }

  .search-input::placeholder {
    color: var(--text-muted);
  }

  .clear-search,
  .refresh-models {
    flex-shrink: 0;
  }

  .refresh-models:disabled {
    cursor: default;
  }

  .models-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding-bottom: 8px;
  }

  .provider-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .provider-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--font-ui-smaller);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 0 4px;
  }

  .provider-models {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }

  .model-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    margin: 0;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    cursor: pointer;
    text-align: left;
    width: 100%;
    box-sizing: border-box;
  }

  .model-card:hover {
    background: var(--background-modifier-hover);
    border-color: var(--interactive-accent-hover);
  }

  .model-card:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 45%, transparent);
  }

  .model-card.selected {
    background: color-mix(in srgb, var(--interactive-accent) 15%, transparent);
    border-color: var(--interactive-accent);
  }

  .model-main {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 12px;
    width: 100%;
    height: auto;
  }

  /* Fixed box so names line up across rows whether or not a lab has artwork. */
  .model-vendor-logo {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }

  .model-info {
    flex: 1;
    min-width: 0;
    height: auto;
  }

  .model-name {
    font-weight: 500;
    font-size: var(--font-ui-small);
    color: var(--text-normal);
  }

  .model-description {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    margin-top: 2px;
  }

  .model-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding-top: 8px;
    border-top: 1px solid var(--background-modifier-border);
    height: auto;
  }

  .meta-tag {
    display: inline-block;
    padding: 3px 8px;
    font-size: 11px;
    line-height: 1.2;
    background: var(--background-primary);
    border-radius: var(--radius-s);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .meta-tag.capability {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    background: color-mix(in srgb, var(--interactive-accent) 15%, transparent);
    color: var(--text-accent);
  }

  .check-icon {
    display: flex;
    align-items: center;
    color: var(--text-accent);
  }

  .model-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .favorite-btn {
    color: var(--text-faint);
  }

  .favorite-btn.is-favorite {
    color: var(--text-accent);
  }

  /* Filled star = favourited, matching the mobile picker's visual language. */
  .favorite-btn.is-favorite :global(svg) {
    fill: currentColor;
  }

  .no-models {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    color: var(--text-muted);
    font-style: italic;
  }

  .no-models-guide {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    padding: 32px 24px;
    color: var(--text-muted);
  }

  .no-models-title {
    font-size: var(--font-ui-medium);
    font-weight: 600;
    color: var(--text-normal);
  }

  .no-models-desc {
    font-size: var(--font-ui-small);
    max-width: 34rem;
    line-height: 1.5;
  }

  .no-models-cta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    cursor: pointer;
  }

  .no-models-cta:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .refresh-models.is-loading :global(svg),
  .no-models-cta.is-loading :global(svg) {
    animation: s2b-model-refresh-spin 0.8s linear infinite;
  }

  @keyframes s2b-model-refresh-spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
