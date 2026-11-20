<script lang="ts">
import { diffWords } from "diff";
import { Notice } from "obsidian";
import { identifyGroups } from "../../lib/diffGroups";
import { getPendingChangesStore } from "../../stores/pendingChangesStore.svelte";
import type { PendingChangeEntry } from "../../types/shared";
import { icon } from "../../utils/utils";
import { t } from "../../i18n";

/**
 * In-chat diff for a pending `update`: one hunk per contiguous change group,
 * rendered as a word-level diff, with per-hunk Accept/Reject wired to the
 * store's group operations. This is the same grouping the inline editor
 * decorations and the store's partial accept/reject use (see diffGroups.ts),
 * so hunk N here is exactly the group N those act on.
 */
interface Props {
	entry: PendingChangeEntry;
	/** The entry no longer matches the note on disk (see the bar's stale badge).
	 * Group accepts hit the same conflict check as whole-entry accepts, so they
	 * are disabled too; rejecting a group only rewrites the proposal and stays
	 * available. */
	stale?: boolean;
}

const { entry, stale = false }: Props = $props();
const store = getPendingChangesStore();

/**
 * Combined removed+added size above which a hunk is not word-diffed inline.
 * A whole-file rewrite is one giant group; `diffWords` over it plus thousands
 * of highlight spans would stall the chat view for a preview nobody can read
 * at that size anyway — the note (which virtualizes) is the review surface.
 * Accept/Reject on the hunk keep working either way.
 */
const MAX_HUNK_PREVIEW_CHARS = 20000;

/**
 * Recomputed on every store mutation: a group accept/reject rewrites
 * originalContent/newContent, which renumbers the remaining groups — stale
 * indices would target the wrong group, so the hunks must track the store.
 */
const groups = $derived.by(() => {
	void store.revision;
	if (entry.change.type !== "update") return [];
	return identifyGroups(entry.change.originalContent, entry.change.newContent);
});

const isPending = $derived(entry.status === "pending");

/**
 * Strip the group's trailing newline before diffing for display. Line-diff
 * parts carry it, and in a pre-wrap container a highlighted trailing "\n"
 * renders as a stray empty green/red line under the hunk.
 */
function trimTrailingNewline(text: string): string {
	return text.replace(/\n$/, "");
}

async function acceptGroup(groupIndex: number) {
	try {
		await store.acceptChangeGroup(entry.id, groupIndex);
	} catch (e) {
		new Notice(t("chat.pending.notice_apply_failed", { error: e instanceof Error ? e.message : String(e) }));
	}
}

function rejectGroup(groupIndex: number) {
	store.rejectChangeGroup(entry.id, groupIndex);
}
</script>

{#if groups.length === 0}
  <div class="pdh-empty">{t("chat.pending.no_remaining_differences")}</div>
{:else}
  <div class="pdh-hunks">
    {#each groups as group, groupIndex (groupIndex)}
      <div class="pdh-hunk">
        <!-- Single-hunk entries skip the header: the position is meaningless
             ("1/1") and per-hunk accept/reject would exactly duplicate the
             row-level buttons (accepting the only group accepts the entry). -->
        {#if groups.length > 1}
          <div class="pdh-hunk-header">
            <span class="pdh-hunk-position">{groupIndex + 1}/{groups.length}</span>
            {#if isPending}
              <div class="pdh-hunk-actions">
                <button
                  class="pdh-action-icon pdh-action-accept"
                  onclick={() => acceptGroup(groupIndex)}
                  title={stale
                    ? t("chat.pending.stale_accept_disabled")
                    : t("chat.pending.accept_hunk")}
                  aria-label={t("chat.pending.accept_hunk_aria", { index: groupIndex + 1, total: groups.length })}
                  type="button"
                  disabled={stale}
                >
                  <div use:icon={"check"} style="--icon-size: 12px"></div>
                </button>
                <button
                  class="pdh-action-icon pdh-action-reject"
                  onclick={() => rejectGroup(groupIndex)}
                  title={t("chat.pending.reject_hunk")}
                  aria-label={t("chat.pending.reject_hunk_aria", { index: groupIndex + 1, total: groups.length })}
                  type="button"
                >
                  <div use:icon={"x"} style="--icon-size: 12px"></div>
                </button>
              </div>
            {/if}
          </div>
        {/if}
        {#if group.removedText.length + group.addedText.length > MAX_HUNK_PREVIEW_CHARS}
          <div class="pdh-too-large">
            {t("chat.pending.hunk_too_large")}
          </div>
        {:else}
          <!-- Word-level old->new diff, same idiom as the in-note card. The each
               body stays on one line: the container is pre-wrap, so template
               whitespace between spans would render as stray spaces. -->
          <div class="pdh-hunk-body">{#each diffWords(trimTrailingNewline(group.removedText), trimTrailingNewline(group.addedText)) as part, partIndex (partIndex)}<span
                class={part.removed ? "s2b-diff-word-removed" : part.added ? "s2b-diff-word-added" : ""}
                >{part.value}</span
              >{/each}</div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .pdh-empty,
  .pdh-too-large {
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
    font-style: italic;
  }

  .pdh-hunks {
    display: flex;
    flex-direction: column;
  }

  /* Flat hunks separated by hairline dividers — the surrounding .pcb-preview
     already draws the frame, so boxed cards here read as chrome-in-chrome. */
  .pdh-hunk + .pdh-hunk {
    border-top: 1px solid var(--background-modifier-border);
    margin-top: 6px;
    padding-top: 4px;
  }

  .pdh-hunk-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .pdh-hunk-position {
    font-size: 10px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .pdh-hunk-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    /* Right-align even when no position indicator precedes them. */
    margin-left: auto;
  }

  .pdh-action-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    border: none;
    border-radius: var(--radius-s);
    cursor: pointer;
    background: transparent;
    transition: background 100ms ease;
  }

  /* 12px icon + 2px padding is a 16px target — fine for a pointer, far below
     touch guidelines. Obsidian marks mobile with body.is-mobile. */
  :global(.is-mobile) .pdh-action-icon {
    padding: 8px;
  }

  .pdh-action-icon[disabled] {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .pdh-action-icon[disabled]:hover {
    background: transparent;
  }

  .pdh-action-accept {
    color: var(--color-green);
  }

  .pdh-action-accept:hover {
    background: color-mix(in srgb, var(--color-green) 15%, transparent);
  }

  .pdh-action-reject {
    color: var(--color-red);
  }

  .pdh-action-reject:hover {
    background: color-mix(in srgb, var(--color-red) 15%, transparent);
  }

  .pdh-hunk-body {
    font-size: var(--font-ui-smaller);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
