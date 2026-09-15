<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { Notice, Platform } from "obsidian";
import { EmbeddingIndexSetupModal } from "../modal/EmbeddingIndexSetupModal";
import { IndexingReportModal } from "../modal/IndexingReportModal";
import ManagedEntityItem from "./ManagedEntityItem.svelte";
import ManagedEntitySection from "./ManagedEntitySection.svelte";
import OrphanedVectorDatabases from "./OrphanedVectorDatabases.svelte";
import SettingContainer from "./SettingContainer.svelte";
import Button from "../ui/Button.svelte";
import ProgressBar from "../ui/ProgressBar.svelte";
import GenericAIIcon from "../ui/logos/GenericAIIcon.svelte";
import { confirmDelete } from "../modal/ConfirmModal";
import { Logger } from "../../utils/logging";
import { getProviderDefinition } from "../../providers/index";
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import {
	isVectorStoreInitialized,
	getVectorStoreService,
	formatEta,
	formatIndexBuildStatus,
	type IndexingProgress,
} from "../../vectorstore";
import { largeDimensionHint } from "../../vectorstore/embeddingMemoryHint";

interface Props {
	/** Which feature this embedding index is for */
	purpose: "search" | "graph";
}

let { purpose }: Props = $props();

const pluginData = getData();
const plugin = getPlugin();

const indexId = $derived(purpose === "search" ? pluginData.searchEmbedIndex : pluginData.graphEmbedIndex);
const indexConfig = $derived(indexId ? pluginData.getEmbeddingIndex(indexId) : null);
// Index progress
let indexProgress = $state<IndexingProgress>({
	isIndexing: false,
	total: 0,
	indexed: 0,
	skipped: 0,
	currentFile: null,
	percentage: 0,
	etaMs: null,
});

// Document count derived from reactive pluginData
const documentCount = $derived(indexConfig?.documentCount ?? 0);
const indexes = $derived(pluginData.embeddingIndexes);
// Mobile only: a wide-vector model costs memory in proportion once its index is
// loaded (#432). The width is recorded from the first stored vector, so the hint
// appears once the index has been built or opened at least once.
const memoryHint = $derived(
	Platform.isMobile && indexConfig ? largeDimensionHint(indexConfig.model, indexConfig.dimensions) : null,
);

let unsubscribeProgress: (() => void) | null = null;

function subscribeToIndex(id: string | null) {
	unsubscribeProgress?.();
	unsubscribeProgress = null;

	if (!id || !isVectorStoreInitialized()) {
		indexProgress = {
			isIndexing: false,
			total: 0,
			indexed: 0,
			skipped: 0,
			currentFile: null,
			percentage: 0,
			etaMs: null,
		};
		return;
	}

	const service = getVectorStoreService();
	indexProgress = service.getProgress(id);
	unsubscribeProgress = service.onProgress((progress) => {
		indexProgress = progress;
	}, id);
}

$effect(() => {
	const id = indexId ?? null;
	untrack(() => subscribeToIndex(id));
});

onDestroy(() => {
	unsubscribeProgress?.();
});

function openAddIndexModal() {
	const currentSelection = indexConfig
		? {
				provider: indexConfig.provider,
				model: indexConfig.model,
			}
		: null;

	new EmbeddingIndexSetupModal(plugin, {
		purpose,
		currentSelection,
		onSave: (selectedModel, batchSize) => {
			pluginData.setEmbedIndex(purpose, selectedModel.provider, selectedModel.model, {
				batchSize,
			});
			if (isVectorStoreInitialized()) {
				getVectorStoreService().ensureIndex(`${selectedModel.provider}:${selectedModel.model}`);
			}
		},
		// Import needs a native file dialog + node fs, so it's offered on desktop
		// only; leaving it undefined hides the row rather than showing a dead control.
		onImport: Platform.isDesktopApp ? importFromFile : undefined,
	}).open();
}

function clearSelectedIndex() {
	if (!indexId) return;
	pluginData.clearEmbedIndex(purpose);
	indexProgress = {
		isIndexing: false,
		total: 0,
		indexed: 0,
		skipped: 0,
		currentFile: null,
		percentage: 0,
		etaMs: null,
	};
}

function selectIndex(targetIndexId: string) {
	if (targetIndexId === indexId) {
		clearSelectedIndex();
		return;
	}
	const selected = pluginData.getEmbeddingIndex(targetIndexId);
	if (!selected) return;
	pluginData.setEmbedIndex(purpose, selected.provider, selected.model);
	if (isVectorStoreInitialized()) {
		getVectorStoreService().ensureIndex(targetIndexId);
	}
}

async function deleteIndex(targetIndexId: string) {
	if (!isVectorStoreInitialized()) return;
	const entry = indexes.find((e) => e.id === targetIndexId);
	if (!(await confirmDelete(plugin.app, entry?.model ?? targetIndexId))) return;
	try {
		await getVectorStoreService().deleteIndex(targetIndexId);
	} catch (error) {
		// `deleteIndex` rejects when the stored vectors can't actually be dropped. Report it
		// rather than letting it surface as an unhandled rejection: the index is still there,
		// so the row below must not be reset as though it had been removed.
		Logger.error(`[EmbeddingIndexSection] Failed to delete index ${targetIndexId}:`, error);
		new Notice(`Could not delete this index: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (targetIndexId === indexId) {
		indexProgress = {
			isIndexing: false,
			total: 0,
			indexed: 0,
			skipped: 0,
			currentFile: null,
			percentage: 0,
			etaMs: null,
		};
	}
}

function openIndexingReport(targetIndexId: string) {
	const modal = new IndexingReportModal(plugin, targetIndexId);
	modal.open();
}

function cancelIndexing() {
	if (indexId && isVectorStoreInitialized()) {
		getVectorStoreService().cancelIndexing(indexId);
	}
}

async function exportIndex(targetIndexId: string) {
	if (!isVectorStoreInitialized()) return;
	await getVectorStoreService().exportIndex(targetIndexId);
}

/** Returns whether an index was actually imported: `importIndex` yields null both
 * when the user cancels the file dialog and when the file is rejected (it reports
 * why through its own notice), and callers need to distinguish "nothing happened"
 * from "done" to decide whether to stay open. */
async function importFromFile(): Promise<boolean> {
	if (!isVectorStoreInitialized()) return false;
	const service = getVectorStoreService();
	const indexId = await service.importIndex(purpose);
	if (indexId) {
		const sep = indexId.indexOf(":");
		pluginData.setEmbedIndex(purpose, indexId.slice(0, sep), indexId.slice(sep + 1));
		return true;
	}
	return false;
}

function describeCurrentSelection(): string {
	return purpose === "search"
		? "Embedding indexes power semantic search across your notes."
		: "Embedding indexes power semantic graph features across your notes.";
}

function getSelectionGroupLabel(): string {
	return purpose === "search" ? "Search embedding index" : "Graph embedding index";
}
</script>

<ManagedEntitySection
  heading="Embedding indexes"
  actionsLayout="control"
  description={describeCurrentSelection()}
  emptyMessage="No embedding indexes configured yet."
  hasItems={indexes.length > 0}
>
  {#snippet actions()}
    {#if indexProgress.isIndexing}
      <!-- The progress summary is desktop-only. A phone settings row has no width
           for a bar plus its counts plus Cancel: the bar ends up a squashed sliver
           and reports nothing legibly. Nothing is lost by dropping it — the
           indexing Notice (VectorStoreService.updateNotice) already shows the same
           count, skipped tally, ETA, its own bar and a percentage, and it floats
           above whatever screen you are on rather than only this one.

           Cancel stays: the Notice carries no way to stop a run, so this is the
           only control that can, and alone in the row it lands as the native
           full-width action. -->
      {#if !Platform.isPhone}
        <div class="index-progress-summary">
          <ProgressBar progress={indexProgress.percentage} />
          <span>
            {indexProgress.indexed}/{indexProgress.total}
            {#if indexProgress.skipped > 0}
              ({indexProgress.skipped} skipped)
            {/if}
            {#if indexProgress.etaMs !== null}
              (~{formatEta(indexProgress.etaMs)} left)
            {/if}
          </span>
        </div>
      {/if}
      <Button buttonText="Cancel" onClick={cancelIndexing} />
    {:else}
      <!-- Importing an existing index lives inside the setup modal, as the
           alternative to building one — not as a bare icon competing with the
           primary action here. -->
      <Button buttonText="Add index" cta={true} onClick={openAddIndexModal} />
    {/if}
  {/snippet}

  {#if indexes.length > 0}
    <div class="embedding-index-list" role="radiogroup" aria-label={getSelectionGroupLabel()}>
      {#each indexes as entry (entry.id)}
        {@const entryProviderDef = getProviderDefinition(
          entry.provider,
          pluginData.getAllProviderMeta(),
        )}
        {@const EntryLogo =
          entryProviderDef && "logo" in entryProviderDef && entryProviderDef.logo
            ? entryProviderDef.logo
            : GenericAIIcon}
        {@const selected = entry.id === indexId}
        <ManagedEntityItem
          class="embedding-index-option"
          name={entry.model}
          meta={[
            entryProviderDef?.displayName ?? entry.provider,
            formatIndexBuildStatus(entry.lastBuiltAt, entry.documentCount),
            `${entry.documentCount} notes indexed`,
          ]
            .filter(Boolean)
            .join(" · ")}
          {selected}
          radio={{
            selected,
            onclick: () => selectIndex(entry.id),
            ariaLabel: `Use ${entry.model} as ${purpose} index`,
          }}
        >
          {#snippet leading()}
            <EntryLogo width={16} height={16} />
          {/snippet}

          {#snippet actions()}
            {#if entry.documentCount > 0}
              <Button
                iconId="list"
                ariaLabel="View indexing report"
                tooltip="View indexing report"
                onClick={() => openIndexingReport(entry.id)}
              />
              <!-- Index export uses a native file dialog + node fs; desktop only. -->
              {#if Platform.isDesktopApp}
              <Button
                iconId="download"
                ariaLabel="Export index to file"
                tooltip="Export index to file"
                onClick={() => void exportIndex(entry.id)}
              />
              {/if}
            {/if}
            <Button
              iconId="trash"
              ariaLabel="Delete index"
              tooltip="Delete index"
              onClick={() => void deleteIndex(entry.id)}
            />
          {/snippet}
        </ManagedEntityItem>
      {/each}
    </div>
  {/if}

  {#if memoryHint}
    <SettingContainer name="Memory on mobile" desc={memoryHint} />
  {/if}
</ManagedEntitySection>

<OrphanedVectorDatabases />

<style>
  .embedding-index-list {
    display: flex;
    flex-direction: column;
  }

  .index-progress-summary {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 220px;
  }

  /* The 220px floor overflows a narrow row alongside the Cancel button. Phones
     drop the summary outright (see the markup), but tablets are `.is-mobile`
     without being `.is-phone` and still render it, so they still need this. */
  :global(.is-mobile) .index-progress-summary {
    min-width: 0;
    flex: 1;
  }

  .index-progress-summary span {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
</style>
