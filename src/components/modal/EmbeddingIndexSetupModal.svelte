<script lang="ts">
import { t } from "../../i18n";
import {
	MAX_EMBEDDING_BATCH_SIZE,
	MIN_EMBEDDING_BATCH_SIZE,
	getDefaultEmbeddingBatchSize,
	normalizeEmbeddingBatchSize,
} from "../../vectorstore/batchSize";
import { useAvailableModels } from "../../hooks/useAvailableModels.svelte";
import { getProviderDefinition } from "../../providers";
import ModelSettingControl from "../settings/ModelSettingControl.svelte";
import SettingContainer from "../settings/SettingContainer.svelte";
import Button from "../ui/Button.svelte";
import Text from "../ui/Text.svelte";
import GenericAIIcon from "../ui/logos/GenericAIIcon.svelte";
import type SecondBrainPlugin from "../../main";
import { ModelSelectionModal, type SelectedModel } from "./ModelSelectionModal";
import type { EmbeddingIndexSetupModal } from "./EmbeddingIndexSetupModal";

interface Props {
	modal: EmbeddingIndexSetupModal;
	plugin: SecondBrainPlugin;
	currentSelection: SelectedModel | null;
	onSave: (selectedModel: SelectedModel, batchSize: number) => void;
	/** Resolves true when an index was imported, false when cancelled or rejected.
	 * Omitted when importing isn't available (desktop-only), which hides the row. */
	onImport?: () => Promise<boolean>;
}

const { modal, plugin, currentSelection, onSave, onImport }: Props = $props();
const availableModels = useAvailableModels();
let selectedModel = $state<SelectedModel | null>(null);
let isImporting = $state(false);

$effect(() => {
	if (!selectedModel && currentSelection) {
		selectedModel = currentSelection;
	}
});

const suggestedBatchSize = $derived.by(() => {
	if (!selectedModel) {
		return MIN_EMBEDDING_BATCH_SIZE;
	}

	const existingIndex = plugin.pluginData.getEmbeddingIndex(`${selectedModel.provider}:${selectedModel.model}`);
	return existingIndex?.batchSize ?? getDefaultEmbeddingBatchSize(selectedModel.provider);
});

let batchSize = $state(0);
let error = $state("");
let lastModelKey = $state<string | null>(null);

$effect(() => {
	if (!selectedModel) {
		return;
	}

	const nextModelKey = `${selectedModel.provider}:${selectedModel.model}`;
	if (nextModelKey !== lastModelKey) {
		batchSize = suggestedBatchSize;
		lastModelKey = nextModelKey;
		error = "";
	}
});

const selectedModelLabel = $derived.by(() => {
	if (!selectedModel) {
		return null;
	}

	return selectedModel.model;
});

const selectedModelLogo = $derived.by(() => {
	if (!selectedModel) {
		return null;
	}

	const providerDefinition = getProviderDefinition(selectedModel.provider, plugin.pluginData.getAllProviderMeta());
	return providerDefinition && "logo" in providerDefinition && providerDefinition.logo
		? providerDefinition.logo
		: GenericAIIcon;
});

function openModelSelection() {
	new ModelSelectionModal(plugin, "embedding", selectedModel, (model) => {
		if (!model) {
			return;
		}

		selectedModel = model;
		error = "";
	}).open();
}

function handleSave() {
	if (!selectedModel) {
		error = t("modals.embedding_index_setup.error_select_model");
		return;
	}

	if (!Number.isFinite(batchSize)) {
		error = t("modals.embedding_index_setup.error_batch_not_number");
		return;
	}

	if (batchSize < MIN_EMBEDDING_BATCH_SIZE || batchSize > MAX_EMBEDDING_BATCH_SIZE) {
		error = t("modals.embedding_index_setup.error_batch_range", {
			min: MIN_EMBEDDING_BATCH_SIZE,
			max: MAX_EMBEDDING_BATCH_SIZE,
		});
		return;
	}

	error = "";
	onSave(selectedModel, normalizeEmbeddingBatchSize(batchSize, selectedModel.provider));
	modal.close();
}

// A successful import selects the imported index outright, so there is nothing
// left to configure here and the modal closes. Cancelling the file dialog (or
// picking a file that gets rejected — that reports itself through a notice) must
// leave the modal open, so the user can still build an index instead.
async function handleImport() {
	if (!onImport || isImporting) {
		return;
	}

	isImporting = true;
	try {
		if (await onImport()) {
			modal.close();
		}
	} catch (importError) {
		error = importError instanceof Error ? importError.message : String(importError);
	} finally {
		isImporting = false;
	}
}
</script>

<div class="embedding-index-setup-modal">
  <div class="modal-intro">{t("modals.embedding_index_setup.intro")}</div>

  <div class="settings-panel">
    <SettingContainer name={t("modals.embedding_index_setup.model_label")} desc={t("modals.embedding_index_setup.model_desc")}>
      <ModelSettingControl
        available={availableModels.hasProviders && availableModels.hasEmbedModels}
        loading={availableModels.hasProviders && availableModels.isLoadingModels}
        configureLabel={!availableModels.hasProviders ? t("modals.embedding_index_setup.configure_provider") : t("modals.embedding_index_setup.configure_models")}
        unavailableHint={!availableModels.hasProviders
          ? t("modals.embedding_index_setup.no_provider_hint")
          : t("modals.embedding_index_setup.no_models_hint")}
        onConfigure={() => availableModels.openSettings(() => modal.close(), { needsEmbedding: true })}
        placeholder={t("modals.embedding_index_setup.model_placeholder")}
        selectedLabel={selectedModelLabel}
        selectedLogo={selectedModelLogo}
        onSelect={openModelSelection}
      />
    </SettingContainer>

    <SettingContainer
      name={t("modals.embedding_index_setup.batch_size_label")}
      desc={t("modals.embedding_index_setup.batch_size_desc", { min: MIN_EMBEDDING_BATCH_SIZE, max: MAX_EMBEDDING_BATCH_SIZE })}
    >
      <Text
        inputType="number"
        value={batchSize}
        placeholder={suggestedBatchSize.toString()}
        onchange={(value) => {
          batchSize = value;
          error = "";
        }}
      />
    </SettingContainer>

    {#if onImport}
      <SettingContainer
        name={t("modals.embedding_index_setup.import_label")}
        desc={t("modals.embedding_index_setup.import_desc")}
      >
        <Button
          iconId="upload"
          buttonText={isImporting ? t("modals.embedding_index_setup.importing") : t("modals.embedding_index_setup.import_button")}
          disabled={isImporting}
          onClick={() => void handleImport()}
        />
      </SettingContainer>
    {/if}

    {#if error}
      <div class="setting-item">
        <div class="s2b-text-[--text-error] s2b-text-sm">{error}</div>
      </div>
    {/if}
  </div>
</div>

<div class="modal-button-container">
  <Button buttonText={t("common.cancel")} onClick={() => modal.close()} />
  <Button buttonText={t("modals.embedding_index_setup.start_button")} cta={true} onClick={handleSave} disabled={!selectedModel} />
</div>

<style>
  .embedding-index-setup-modal {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    min-height: 0;
  }

  .modal-intro {
    color: var(--text-muted);
    font-size: 0.95rem;
    line-height: 1.4;
  }

  .settings-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
</style>
