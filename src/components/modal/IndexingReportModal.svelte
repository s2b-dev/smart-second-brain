<script lang="ts">
import { onMount } from "svelte";
import type { IndexingReport, SkipReason } from "../../vectorstore/types";
import { getVectorStoreService, isVectorStoreInitialized } from "../../vectorstore";
import type { IndexingReportModal } from "./IndexingReportModal";

interface Props {
	modal: IndexingReportModal;
	indexId: string;
}

let { modal, indexId }: Props = $props();

let report = $state<IndexingReport | null>(null);
let loading = $state(true);
let activeTab = $state<"indexed" | "skipped">("indexed");

const skipReasonLabels: Record<SkipReason, string> = {
	excluded: "Excluded by internal rules",
	privacy: "Private (untrusted provider)",
	"not-indexed": "Not yet indexed",
	"read-error": "Failed to read file",
	"embed-error": "Embedding failed",
};

const skipReasonIcons: Record<SkipReason, string> = {
	excluded: "folder-x",
	privacy: "shield-check",
	"not-indexed": "clock",
	"read-error": "alert-triangle",
	"embed-error": "zap-off",
};

const skippedByReason = $derived.by(() => {
	if (!report) return new Map<SkipReason, string[]>();
	const map = new Map<SkipReason, string[]>();
	for (const { path, reason } of report.skippedFiles) {
		if (!map.has(reason)) map.set(reason, []);
		map.get(reason)?.push(path);
	}
	return map;
});

const totalSkipped = $derived(report?.skippedFiles.length ?? 0);
const totalIndexed = $derived(report?.indexedFiles.length ?? 0);

onMount(async () => {
	if (!isVectorStoreInitialized()) {
		loading = false;
		return;
	}
	const service = getVectorStoreService();
	report = await service.getReport(indexId);
	loading = false;
});
</script>

{#if loading}
  <div class="s2b-report-loading">Loading report...</div>
{:else if !report}
  <div class="s2b-report-empty">No indexing data available. Build the index first.</div>
{:else}
  <div class="s2b-report-tabs">
    <button
      class="s2b-report-tab"
      class:is-active={activeTab === "indexed"}
      onclick={() => (activeTab = "indexed")}
    >
      Indexed ({totalIndexed})
    </button>
    <button
      class="s2b-report-tab"
      class:is-active={activeTab === "skipped"}
      onclick={() => (activeTab = "skipped")}
    >
      Skipped ({totalSkipped})
    </button>
  </div>

  <div class="s2b-report-content">
    {#if activeTab === "indexed"}
      {#if totalIndexed === 0}
        <div class="s2b-report-empty">No files indexed yet.</div>
      {:else}
        <div class="s2b-report-list">
          {#each report.indexedFiles as filePath}
            <div class="s2b-report-item">
              <span class="s2b-report-path">{filePath}</span>
            </div>
          {/each}
        </div>
      {/if}
    {:else if totalSkipped === 0}
      <div class="s2b-report-empty">No files were skipped.</div>
    {:else}
      {#each [...skippedByReason.entries()] as [reason, files]}
        <div class="s2b-report-group">
          <div class="s2b-report-group-header">
            <span class="s2b-report-reason">{skipReasonLabels[reason]}</span>
            <span class="s2b-report-count">{files.length}</span>
          </div>
          <div class="s2b-report-list">
            {#each files as filePath}
              <div class="s2b-report-item s2b-report-item--skipped">
                <span class="s2b-report-path">{filePath}</span>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  {#if report.timestamp}
    <div class="s2b-report-footer">
      Last updated: {new Date(report.timestamp).toLocaleString()}
    </div>
  {/if}
{/if}

<style>
  .s2b-report-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--background-modifier-border);
    margin-bottom: 12px;
  }

  .s2b-report-tab {
    padding: 8px 16px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: var(--font-ui-small);
    font-weight: 500;
    transition: all 0.15s ease;
  }

  .s2b-report-tab:hover {
    color: var(--text-normal);
  }

  .s2b-report-tab.is-active {
    color: var(--text-normal);
    border-bottom-color: var(--interactive-accent);
  }

  .s2b-report-content {
    max-height: 400px;
    overflow-y: auto;
  }

  .s2b-report-list {
    display: flex;
    flex-direction: column;
  }

  .s2b-report-item {
    padding: 4px 8px;
    border-radius: 4px;
    font-size: var(--font-ui-smaller);
  }

  .s2b-report-item:hover {
    background: var(--background-modifier-hover);
  }

  .s2b-report-path {
    color: var(--text-muted);
    word-break: break-all;
  }

  .s2b-report-group {
    margin-bottom: 12px;
  }

  .s2b-report-group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    margin-bottom: 2px;
    font-size: var(--font-ui-small);
    font-weight: 600;
    color: var(--text-normal);
  }

  .s2b-report-count {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    background: var(--background-modifier-hover);
    padding: 1px 8px;
    border-radius: 10px;
  }

  .s2b-report-loading,
  .s2b-report-empty {
    padding: 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }

  .s2b-report-footer {
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid var(--background-modifier-border);
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
    text-align: right;
  }
</style>
