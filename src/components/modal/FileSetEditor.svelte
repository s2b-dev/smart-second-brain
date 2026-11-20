<script lang="ts">
import { t } from "../../i18n";
import type { App } from "obsidian";
import type { ViewFilter } from "../../types/viewFilter";
import { icon as iconDirective } from "../../utils/utils";
import ViewFilterBuilder from "../settings/ViewFilterBuilder.svelte";
import Button from "../ui/Button.svelte";
import FileSetEntryRow from "./FileSetEntryRow.svelte";
import { SearchModal, type SearchModalPickerText } from "./SearchModal";

interface FileSetListEntry {
	path: string;
	displayName?: string;
	contextLabel?: string | null;
	isManual?: boolean;
	hasAuto?: boolean;
	/** Set only on complement-side rows: the file is out of the managed set
	 *  because of an explicit exclusion, not merely because no rule selects it. */
	isExcluded?: boolean;
	searchable?: string;
}

interface FileSetAction {
	label: string;
	onClick: (path: string) => void;
	cta?: boolean;
	disabled?: boolean;
}

interface Props {
	app: App;
	sourcePath?: string;
	hoverSource?: string;
	/**
	 * Heading above the list. Pass `null` when the surrounding UI already names
	 * the set — a tab strip, say — so the panel does not repeat the label
	 * directly beneath it.
	 */
	sectionTitle?: string | null;
	includedEntries: FileSetListEntry[];
	includedEmptyText: string;
	filteredEmptyText?: string;
	searchPlaceholder?: string;
	searchThreshold?: number;
	addButtonText?: string;
	addButtonCta?: boolean;
	onAddFile?: (() => void | Promise<void>) | undefined;
	pickerModalTitle?: string;
	pickerText?: SearchModalPickerText;
	pickerExistingPaths?: string[];
	pickerIncludedPaths?: string[];
	onAddPaths?: ((paths: string[]) => void | Promise<void>) | undefined;
	showFilterToggle?: boolean;
	filtersButtonText?: string;
	filterToggleAriaLabel?: string;
	isFilterActive?: boolean;
	filterCount?: number;
	onToggleFilters?: (() => void) | undefined;
	showFilterPanel?: boolean;
	filterPanelLabel?: string;
	filterBuilderFilter?: ViewFilter | null;
	availableFolders?: string[];
	availableTags?: string[];
	availableProperties?: string[];
	onFilterChange?: ((nextFilter: ViewFilter) => void) | undefined;
	/**
	 * Cap on how many included rows are mounted at once. Rows are not virtualized,
	 * so a caller whose list can run to whole-vault size passes a cap to keep the
	 * panel responsive. The cap applies AFTER the search filter, so filtering still
	 * reaches entries beyond it. Undefined means no cap.
	 */
	maxVisibleEntries?: number;
	/**
	 * Hide row action buttons until the row is hovered/focused. Worth setting on
	 * long lists where every row has the same action and the buttons would
	 * otherwise out-shout the filenames.
	 */
	revealActionsOnHover?: boolean;
	excludedEntries?: FileSetListEntry[];
	excludedTitle?: string;
	resolveIncludedActions?: ((entry: FileSetListEntry) => FileSetAction[]) | undefined;
	resolveExcludedActions?: ((entry: FileSetListEntry) => FileSetAction[]) | undefined;
}

let {
	app,
	sourcePath = "",
	hoverSource = "smart-second-brain-file-set-editor",
	sectionTitle = t("modals.file_set_editor.included_files"),
	includedEntries,
	includedEmptyText,
	filteredEmptyText = t("modals.file_set_editor.filtered_empty"),
	searchPlaceholder = t("modals.file_set_editor.filter_placeholder"),
	searchThreshold = 6,
	addButtonText = t("modals.file_set_editor.add_files"),
	addButtonCta = false,
	onAddFile,
	pickerModalTitle = t("modals.file_set_editor.add_files"),
	pickerText = {},
	pickerExistingPaths = [],
	pickerIncludedPaths = [],
	onAddPaths,
	showFilterToggle = false,
	filtersButtonText = t("modals.file_set_editor.filters"),
	filterToggleAriaLabel = filtersButtonText,
	isFilterActive = false,
	filterCount = 0,
	onToggleFilters,
	showFilterPanel = false,
	filterPanelLabel = t("modals.file_set_editor.filters"),
	filterBuilderFilter = null,
	availableFolders = [],
	availableTags = [],
	availableProperties = [],
	onFilterChange,
	maxVisibleEntries,
	revealActionsOnHover = false,
	excludedEntries = [],
	excludedTitle = t("modals.file_set_editor.excluded_files"),
	resolveIncludedActions,
	resolveExcludedActions,
}: Props = $props();

let includedQuery = $state("");
const matchingIncludedEntries = $derived.by(() => {
	const query = includedQuery.trim().toLowerCase();
	if (!query) return includedEntries;
	return includedEntries.filter((entry) => (entry.searchable ?? entry.path).toLowerCase().includes(query));
});
// Cap AFTER filtering, so a search still finds entries past the cap.
const filteredIncludedEntries = $derived.by(() =>
	maxVisibleEntries === undefined ? matchingIncludedEntries : matchingIncludedEntries.slice(0, maxVisibleEntries),
);
const hiddenIncludedCount = $derived(matchingIncludedEntries.length - filteredIncludedEntries.length);

const showSearchInput = $derived.by(() => includedEntries.length > searchThreshold || includedQuery.trim().length > 0);
const hasAddButton = $derived.by(() => Boolean(onAddFile || onAddPaths));
function handleAddButtonClick() {
	if (onAddPaths) {
		void pickerModalTitle;
		new SearchModal(app, {
			picker: {
				pickerText,
				pickerExistingPaths,
				pickerIncludedPaths,
				onAddPaths,
			},
		}).open();
		return;
	}
	void onAddFile?.();
}
</script>

<div class="file-set-editor-panel">
  {#if sectionTitle}
    <div class="file-set-editor-header">
      <div class="file-set-editor-title">{sectionTitle}</div>
    </div>
  {/if}

  {#if hasAddButton || showFilterToggle}
    <div class="file-set-editor-toolbar">
      {#if showFilterToggle}
        <button
          type="button"
          class="file-set-editor-filter-toggle"
          class:file-set-editor-filter-toggle--active={isFilterActive}
          aria-label={filterToggleAriaLabel}
          onclick={() => onToggleFilters?.()}
        >
          <span class="file-set-editor-filter-toggle-content">
            <span class="file-set-editor-filter-toggle-icon" use:iconDirective={"filter"}></span>
            <span>{filtersButtonText}</span>
          </span>
          {#if filterCount > 0}
            <span class="file-set-editor-filter-count">{filterCount}</span>
          {/if}
        </button>
      {/if}

      {#if hasAddButton}
        <Button onClick={handleAddButtonClick} buttonText={addButtonText} cta={addButtonCta} />
      {/if}
    </div>
  {/if}

  {#if showFilterPanel && filterBuilderFilter && onFilterChange}
    <div class="file-set-editor-filter-panel">
      <div class="file-set-editor-filter-panel-header">
        <div class="file-set-editor-filter-panel-title">{filterPanelLabel}</div>
        {#if filterCount > 0}
          <div class="file-set-editor-filter-panel-meta">{t("modals.file_set_editor.active_count", { count: filterCount })}</div>
        {/if}
      </div>

      <ViewFilterBuilder
        filter={filterBuilderFilter}
        onchange={onFilterChange}
        {availableFolders}
        {availableTags}
        {availableProperties}
      />
    </div>
  {/if}

  {#if includedEntries.length === 0}
    <div class="file-set-editor-empty">{includedEmptyText}</div>
  {:else}
    <div class="file-set-editor-content">
      {#if showSearchInput}
        <input
          type="search"
          class="file-set-editor-search-input"
          placeholder={searchPlaceholder}
          bind:value={includedQuery}
        />
      {/if}

      {#if filteredIncludedEntries.length === 0}
        <div class="file-set-editor-empty">{filteredEmptyText}</div>
      {:else}
        <div class="file-set-editor-list">
          {#each filteredIncludedEntries as entry (entry.path)}
            {@const actionItems = resolveIncludedActions?.(entry) ?? []}
            {#if actionItems.length > 0}
              <FileSetEntryRow {app} {entry} {sourcePath} {hoverSource} {revealActionsOnHover}>
                {#snippet actions()}
                  {#each actionItems as action, index (`${entry.path}-${action.label}-${index}`)}
                    <Button
                      buttonText={action.label}
                      onClick={() => action.onClick(entry.path)}
                      cta={action.cta ?? false}
                      disabled={action.disabled ?? false}
                    />
                  {/each}
                {/snippet}
              </FileSetEntryRow>
            {:else}
              <FileSetEntryRow {app} {entry} {sourcePath} {hoverSource} />
            {/if}
          {/each}
        </div>

        {#if hiddenIncludedCount > 0}
          <div class="file-set-editor-truncation">
            {t("modals.file_set_editor.hidden_count", { count: hiddenIncludedCount })}
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  {#if excludedEntries.length > 0}
    <div class="file-set-editor-excluded">
      <div class="file-set-editor-excluded-title">{excludedTitle}</div>
      <div class="file-set-editor-list">
        {#each excludedEntries as entry (entry.path)}
          {@const actionItems = resolveExcludedActions?.(entry) ?? []}
          {#if actionItems.length > 0}
            <FileSetEntryRow {app} {entry} {sourcePath} {hoverSource} {revealActionsOnHover} compact>
              {#snippet actions()}
                {#each actionItems as action, index (`${entry.path}-${action.label}-${index}`)}
                  <Button
                    buttonText={action.label}
                    onClick={() => action.onClick(entry.path)}
                    cta={action.cta ?? false}
                    disabled={action.disabled ?? false}
                  />
                {/each}
              {/snippet}
            </FileSetEntryRow>
          {:else}
            <FileSetEntryRow {app} {entry} {sourcePath} {hoverSource} compact />
          {/if}
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .file-set-editor-panel {
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    gap: 10px;
  }

  .file-set-editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .file-set-editor-title,
  .file-set-editor-filter-panel-title,
  .file-set-editor-excluded-title {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .file-set-editor-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .file-set-editor-filter-toggle {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 999px;
    background: var(--background-primary);
    color: var(--text-normal);
    transition:
      border-color 120ms ease,
      background-color 120ms ease;
  }

  .file-set-editor-filter-toggle:hover {
    background: var(--background-modifier-hover);
  }

  .file-set-editor-filter-toggle-content {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    font-weight: 500;
  }

  .file-set-editor-filter-toggle-icon {
    width: var(--icon-m);
    height: var(--icon-m);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .file-set-editor-filter-toggle--active {
    border-color: var(--interactive-accent);
    background: color-mix(in srgb, var(--interactive-accent) 14%, var(--background-primary));
  }

  .file-set-editor-filter-count {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    font-size: 10px;
    line-height: 16px;
    text-align: center;
    font-weight: 600;
  }

  .file-set-editor-filter-panel {
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--background-secondary) 35%, transparent);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 0.8rem;
  }

  .file-set-editor-filter-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .file-set-editor-filter-panel-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .file-set-editor-content,
  .file-set-editor-excluded {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }

  .file-set-editor-content {
    flex: 1;
  }

  .file-set-editor-search-input {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    background: var(--background-primary);
    color: var(--text-normal);
  }

  .file-set-editor-list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    /* Rows are flat with a hover highlight, so they sit close rather than
       being separated like cards. */
    gap: 1px;
  }

  .file-set-editor-empty {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .file-set-editor-truncation {
    padding: 6px 2px 0;
    font-size: 0.75rem;
    color: var(--text-faint);
    font-style: italic;
  }
</style>
