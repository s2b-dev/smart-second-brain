<script lang="ts">
import { Keymap } from "obsidian";
import { onDestroy } from "svelte";
import {
	VisibleNotesTracker,
	toVisibleNoteRefs,
	type VisibleNote,
	type VisibleNoteRef,
} from "../../hooks/useVisibleNotes.svelte";
import { SelectionTracker, type SelectionRef } from "../../hooks/useSelection.svelte";
import type { GraphNoteRef } from "../../stores/chatTimeline";
import type { ChatAttachment } from "../../types/shared";
import { getPlugin } from "../../stores/state.svelte";
import { icon } from "../../utils/utils";
import { VIEW_TYPE_CHAT } from "../../views/chat/Chat";

const SELECTION_PREVIEW_LENGTH = 40;
const BASENAME_RE = /(?:.*\/)?([^/]+?)(?:\.\w+)?$/;

interface Props {
	/** Graph note paths set externally (e.g. from Messenger.pendingGraphNotes). */
	graphPaths?: string[];
	/** Name of the topic(s) `graphPaths` exactly matches, or null/undefined if
	 * the selection isn't a whole topic (e.g. Messenger.graphSelectionTopicLabel). */
	topicLabel?: string | null;
	/** True when `graphPaths` was republished by background vault maintenance
	 * (a live patch pruning deleted notes) rather than a new user selection
	 * gesture (e.g. Messenger.graphSelectionIsMaintenance). */
	graphSelectionIsMaintenance?: boolean;
	/** Content attachments (files whose bytes/content are inlined into the message). */
	attachments?: ChatAttachment[];
	/** Remove a content attachment. */
	onRemoveAttachment?: (attachment: ChatAttachment) => void;
	/** Promote the active note to a content attachment. */
	onPromoteToAttachment?: (note: VisibleNote) => void | Promise<void>;
	/** Whether the active note can be promoted to a content attachment. */
	canPromoteToAttachment?: (note: VisibleNote) => boolean;
}

let {
	graphPaths = [],
	topicLabel = null,
	graphSelectionIsMaintenance = false,
	attachments = [],
	onRemoveAttachment,
	onPromoteToAttachment,
	canPromoteToAttachment,
}: Props = $props();

const tracker = new VisibleNotesTracker();
const selectionTracker = new SelectionTracker();
const sourcePath = $derived(getPlugin().app.workspace.getActiveFile()?.path ?? "");

// --- Selection ---
// Remember *which* selection the user dismissed (by identity) rather than a bare
// boolean, so a freshly-captured selection un-dismisses automatically without a
// state-sync effect: the tracker hands back a new ref and the identity no longer
// matches the dismissed one.
let dismissedSelection = $state<SelectionRef | undefined>(undefined);
const activeSelection = $derived<SelectionRef | undefined>(
	selectionTracker.selection && selectionTracker.selection === dismissedSelection
		? undefined
		: selectionTracker.selection,
);

// --- Visible notes (auto references, front tab of each pane) ---
let deactivatedPaths = $state(new Set<string>());
const attachmentPathSet = $derived(new Set(attachments.map((a) => a.vaultPath)));
// Show every visible note as a reference chip, except when the same note is
// already a content attachment (it renders as an attachment chip instead) or
// its own text is captured as the selection.
const visibleNotes = $derived(
	tracker.notes.filter((note) => !attachmentPathSet.has(note.file.path) && activeSelection?.path !== note.file.path),
);

// Drop deactivations for notes that are no longer visible so a reopened note
// starts active again.
$effect(() => {
	const present = new Set(tracker.notes.map((n) => n.file.path));
	let changed = false;
	const next = new Set<string>();
	for (const path of deactivatedPaths) {
		if (present.has(path)) next.add(path);
		else changed = true;
	}
	if (changed) deactivatedPaths = next;
});

// --- Graph notes ---
let graphDismissed = $state(new Set<string>());
// Graph selections can be large (lasso-select of many nodes). Collapse them into
// a single summary chip by default; expand on demand to review/remove individuals.
let graphExpanded = $state(false);
// `graphPaths` changes for two different reasons, which need opposite treatment:
//  1. A genuinely new selection gesture (topic click, panel row, lasso, Shift-click,
//     drilling into one cluster of a larger selection) — may be a subset of, equal
//     to, or disjoint from the old one, but the user's old dismissals shouldn't
//     carry over regardless of shape: without a reset, stale exclusions would filter
//     fresh paths out of a selection the user never touched, and (since the topic
//     label requires an exact match) permanently hide the name for a selection
//     gesture that has nothing to do with the earlier dismissal.
//  2. A background live-patch pruning vault-deleted notes out of the *current*
//     selection (SmartGraphView's live-patch handler): this republishes a fresh,
//     shrunk array too, but it's the same selection minus some notes — a note the
//     user explicitly dismissed must stay dismissed, not reappear because of
//     unrelated vault maintenance.
// These can't be told apart from the paths alone — a user picking a smaller
// selection also produces a subset, so shape is not a valid signal (see the prior
// `isPrune`-by-membership attempt). SmartGraphView knows which case it is by
// construction (only its live-patch handler sets `graphSelectionIsMaintenance`), so
// it's threaded through as an explicit flag instead of inferred here.
$effect(() => {
	void graphPaths; // establish the dependency; the reset itself is unconditional
	if (!graphSelectionIsMaintenance) graphDismissed = new Set();
});
const activeGraphPaths = $derived(graphPaths.filter((p) => !graphDismissed.has(p)));
// Once every graph note is dismissed there's nothing to expand.
$effect(() => {
	if (activeGraphPaths.length === 0 && graphExpanded) graphExpanded = false;
});
// The topic name only describes the full, untouched selection — once the user
// dismisses any member of it, the remaining notes no longer are that topic.
const effectiveTopicLabel = $derived(activeGraphPaths.length === graphPaths.length ? topicLabel : null);

// --- One-way outputs. Derived, not synced through effects, per the repo's
// Svelte guidance. Exposed as getter functions (Svelte disallows exporting
// `$derived` directly); the parent reads them inside its own `$derived`, so the
// reactive dependency is tracked across the component boundary. ---
const activeVisibleNotes = $derived(toVisibleNoteRefs(visibleNotes.filter((n) => !deactivatedPaths.has(n.file.path))));
const activeGraphNotes = $derived<GraphNoteRef[]>(activeGraphPaths.map((p) => ({ path: p, basename: basename(p) })));

export function getActiveVisibleNotes(): VisibleNoteRef[] {
	return activeVisibleNotes;
}
export function getActiveSelection(): SelectionRef | undefined {
	return activeSelection;
}
export function getActiveGraphNotes(): GraphNoteRef[] {
	return activeGraphNotes;
}

const hasAny = $derived(
	visibleNotes.length > 0 || Boolean(activeSelection) || activeGraphPaths.length > 0 || attachments.length > 0,
);

function basename(path: string): string {
	return BASENAME_RE.exec(path)?.[1] ?? path;
}

function noteLinkPath(note: VisibleNote): string {
	if (note.viewType !== "pdf" || !note.context) return note.file.path;
	const match = note.context.match(/^p\.\s+([^/]+)\s*\/\s*/);
	const pageLabel = match?.[1]?.trim();
	if (!pageLabel || !/^\d+$/.test(pageLabel)) return note.file.path;
	return `${note.file.path}#page=${pageLabel}`;
}

function previewLink(evt: Event, linktext: string): void {
	const target = evt.currentTarget;
	if (!(target instanceof HTMLElement)) return;
	getPlugin().app.workspace.trigger("hover-link", {
		event: evt,
		source: VIEW_TYPE_CHAT,
		hoverParent: getPlugin(),
		targetEl: target,
		linktext,
		sourcePath,
	});
}

function openLink(linktext: string): void {
	getPlugin().app.workspace.openLinkText(linktext, sourcePath, true);
}

// --- Visible-note handlers ---
function toggleNote(path: string): void {
	const next = new Set(deactivatedPaths);
	if (next.has(path)) next.delete(path);
	else next.add(path);
	deactivatedPaths = next;
}

function onNoteClick(evt: MouseEvent, note: VisibleNote): void {
	if (Keymap.isModEvent(evt)) {
		evt.preventDefault();
		evt.stopPropagation();
		openLink(noteLinkPath(note));
		return;
	}
	toggleNote(note.file.path);
}

function onPromote(evt: MouseEvent, note: VisibleNote): void {
	evt.preventDefault();
	evt.stopPropagation();
	void onPromoteToAttachment?.(note);
}

// --- Selection handlers ---
function selectionPreview(text: string): string {
	const oneLine = text.replace(/\n/g, " ").trim();
	return oneLine.length <= SELECTION_PREVIEW_LENGTH ? oneLine : `${oneLine.slice(0, SELECTION_PREVIEW_LENGTH)}…`;
}

function onSelectionClick(evt: MouseEvent): void {
	if (!selectionTracker.selection) return;
	if (Keymap.isModEvent(evt)) {
		evt.preventDefault();
		evt.stopPropagation();
		openLink(selectionTracker.selection.path);
		return;
	}
	dismissSelection();
}

function dismissSelection(): void {
	dismissedSelection = selectionTracker.selection;
	selectionTracker.clear();
}

// --- Graph handlers ---
function onGraphClick(evt: MouseEvent, path: string): void {
	if (Keymap.isModEvent(evt)) {
		evt.preventDefault();
		evt.stopPropagation();
		openLink(path);
		return;
	}
	const next = new Set(graphDismissed);
	if (next.has(path)) next.delete(path);
	else next.add(path);
	graphDismissed = next;
}

/** Dismiss every graph note at once (the summary chip's close button). */
function clearAllGraphNotes(evt: MouseEvent): void {
	evt.preventDefault();
	evt.stopPropagation();
	graphDismissed = new Set(graphPaths);
	graphExpanded = false;
}

// --- Attachment handlers ---
function attachmentIcon(attachment: ChatAttachment): string {
	return attachment.mimeType.startsWith("image/") ? "image" : "paperclip";
}

function onAttachmentClick(evt: MouseEvent, attachment: ChatAttachment): void {
	if (Keymap.isModEvent(evt)) {
		evt.preventDefault();
		evt.stopPropagation();
		openLink(attachment.vaultPath);
		return;
	}
	onRemoveAttachment?.(attachment);
}

/** Clear selection + graph chips for THIS chat (e.g. after sending a message).
 * Graph selection is ambient (shared across chats), so we don't wipe the source
 * — we mark the currently-active graph notes as locally dismissed, dropping them
 * from this chat while leaving them visible in other open chats. */
export function clear(): void {
	dismissSelection();
	if (activeGraphPaths.length > 0) {
		graphDismissed = new Set([...graphDismissed, ...activeGraphPaths]);
	}
	graphExpanded = false;
}

onDestroy(() => {
	tracker.destroy();
	selectionTracker.destroy();
});
</script>

{#if hasAny}
  <div class="context-tray flex flex-row flex-wrap items-start gap-1.5 min-w-0 max-w-full">
    <!-- Visible notes (auto references) -->
    {#each visibleNotes as note (note.file.path)}
      {@const deactivated = deactivatedPaths.has(note.file.path)}
      {@const canPromote = canPromoteToAttachment?.(note) ?? false}
      <span class="s2b-chip visible" class:deactivated>
        <button
          type="button"
          class="chip-body s2b-pill s2b-pill--interactive"
          title={deactivated
            ? `${note.file.path} (excluded — click to include as reference)`
            : `${note.file.path} (open note — click to exclude)`}
          onclick={(evt) => onNoteClick(evt, note)}
          onmouseover={(evt) => previewLink(evt, noteLinkPath(note))}
          onfocus={(evt) => previewLink(evt, noteLinkPath(note))}
        >
          <div
            class="chip-icon"
            use:icon={deactivated ? "eye-off" : "eye"}
            style="--icon-size: 12px"
          ></div>
          <span class="chip-label"
            >{note.file.basename}{#if !deactivated && note.context}<span
                class="chip-meta"> · {note.context}</span
              >{/if}</span
          >
        </button>
        {#if canPromote && !deactivated}
          <button
            type="button"
            class="chip-action"
            title="Attach full content to the message"
            onclick={(evt) => onPromote(evt, note)}
          >
            <div class="chip-icon" use:icon={"paperclip"} style="--icon-size: 11px"></div>
          </button>
        {/if}
      </span>
    {/each}

    <!-- Graph-selected notes: collapsed into one summary chip (can be many). -->
    {#if activeGraphPaths.length > 0}
      <span class="s2b-chip graph-group">
        <button
          type="button"
          class="chip-body s2b-pill s2b-pill--interactive"
          title={graphExpanded
            ? "Graph selection — click to collapse"
            : effectiveTopicLabel
              ? `${effectiveTopicLabel} — click to expand`
              : `${activeGraphPaths.length} note${activeGraphPaths.length === 1 ? "" : "s"} from graph — click to expand`}
          aria-expanded={graphExpanded}
          onclick={() => (graphExpanded = !graphExpanded)}
        >
          <div class="chip-icon" use:icon={"git-fork"} style="--icon-size: 12px"></div>
          <span>
            {effectiveTopicLabel ?? `${activeGraphPaths.length} Graph Note${activeGraphPaths.length === 1 ? "" : "s"}`}
          </span>
          <div class="chip-icon chip-chevron" use:icon={graphExpanded ? "chevron-up" : "chevron-down"} style="--icon-size: 12px"></div>
        </button>
        <button
          type="button"
          class="chip-action"
          title="Remove all graph notes"
          onclick={clearAllGraphNotes}
        >
          <div class="chip-icon" use:icon={"x"} style="--icon-size: 11px"></div>
        </button>
      </span>

      {#if graphExpanded}
        <span class="graph-members">
          {#each activeGraphPaths as path (path)}
            <button
              type="button"
              class="s2b-chip s2b-pill s2b-pill--interactive graph-member"
              title={`${path} (from graph — click to exclude)`}
              onclick={(evt) => onGraphClick(evt, path)}
            >
              <span class="chip-label">{basename(path)}</span>
              <div class="chip-close" use:icon={"x"} style="--icon-size: 10px"></div>
            </button>
          {/each}
        </span>
      {/if}
    {/if}

    <!-- Selected text -->
    {#if activeSelection}
      <button
        type="button"
        class="s2b-chip s2b-pill s2b-pill--interactive selection"
        title={`Selected text from ${activeSelection.path} (click to dismiss)\n\n${activeSelection.text.slice(0, 200)}`}
        onclick={onSelectionClick}
      >
        <div class="chip-icon" use:icon={activeSelection.icon} style="--icon-size: 12px"></div>
        <span class="chip-label">{selectionPreview(activeSelection.text)}</span>
        {#if selectionTracker.isLong}
          <span class="chip-warning" title="Long selection — will be truncated to fit the model's context">⚠</span>
        {/if}
        <div class="chip-close" use:icon={"x"} style="--icon-size: 10px"></div>
      </button>
    {/if}

    <!-- Content attachments -->
    {#each attachments as attachment (attachment.vaultPath)}
      <button
        type="button"
        class="s2b-chip s2b-pill s2b-pill--interactive attachment"
        title={`${attachment.vaultPath} (click to remove attachment)`}
        onclick={(evt) => onAttachmentClick(evt, attachment)}
        onmouseover={(evt) => previewLink(evt, attachment.vaultPath)}
        onfocus={(evt) => previewLink(evt, attachment.vaultPath)}
      >
        <div class="chip-icon" use:icon={attachmentIcon(attachment)} style="--icon-size: 12px"></div>
        <span class="chip-label">{attachment.name}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .s2b-chip {
    display: inline-flex;
    align-items: center;
    /* Every chip caps its own width and can be squeezed below its intrinsic
       text size. `.s2b-pill` sets `white-space: nowrap`, so without this a
       long filename grows the pill until it pushes past the composer's edge —
       `.chip-label`'s `text-overflow` can only engage once the chip itself is
       allowed to be narrower than its content. `min(100%, 18rem)` keeps a
       single chip inside the tray on a narrow composer while still letting
       short names size naturally. */
    max-width: min(100%, 18rem);
    min-width: 0;
  }

  /* One accent-tinted HUE for every chip, mixed against `--background-primary`
     — the fill the composer actually has now (mixing into
     `--background-secondary` produced a grey-shifted tint over the
     page-coloured card). Attachments used to be green, which read muddy and
     collided with what green means one surface up: in the pending-changes bar
     and tool cards green is DIFF-ADD semantics, so a green chip implied a
     pending mutation rather than "this file rides along with the message".

     The two chip families are separated by WEIGHT within that one hue, not by
     colour (see the `.attachment` override below). A hollow chip reads as a
     pointer to something; a filled chip reads as containing something — which
     is exactly the difference: a reference sends a path the model may choose
     to read, an attachment inlines the file's bytes into the message. It also
     tracks how each is created: references appear on their own as you move
     around the vault (ambient, so quiet), attachments are a deliberate act
     (louder). And promoting one to the other visibly fills the chip, so the
     paperclip action shows its own result.

     This carries real weight: the reference/attachment distinction drives
     token cost and what reaches an untrusted provider, and it was previously
     encoded only in a 12px icon plus a hover tooltip that mobile never shows. */
  /* Compact variant of the shared pill: inside the composer card the default
     4px vertical padding reads oversized next to the single text line below.
     Scoped to the tray so search-modal / history pills keep their size. */
  .context-tray :global(.s2b-pill) {
    padding: 2px 8px;
  }

  /* Ghost: the default for reference chips (visible note, selection, graph).
     Fill is the page colour, so the chip is defined by its border alone —
     the same "outline, not slab" logic the composer itself now follows. The
     accent-tinted border and `--text-normal` label are what keep it clearly
     active rather than disabled; hover brings in a faint tint so it still
     answers the pointer. */
  .context-tray :global(.s2b-chip) {
    --s2b-pill-bg: var(--background-primary);
    --s2b-pill-border: color-mix(in srgb, var(--interactive-accent) 20%, var(--background-modifier-border));
    --s2b-pill-color: var(--text-normal);
    --s2b-pill-bg-hover: color-mix(in srgb, var(--interactive-accent) 7%, var(--background-primary));
    --s2b-pill-border-hover: color-mix(in srgb, var(--interactive-accent) 30%, var(--background-modifier-border));
  }

  /* Filled: attachments carry content, so they carry pigment. 12% is enough
     to read as solid next to a hollow chip at 11px without competing with the
     accent border of the focused composer around it. */
  .context-tray :global(.s2b-chip.attachment) {
    --s2b-pill-bg: color-mix(in srgb, var(--interactive-accent) 12%, var(--background-primary));
    --s2b-pill-border: color-mix(in srgb, var(--interactive-accent) 24%, var(--background-modifier-border));
    --s2b-pill-bg-hover: color-mix(in srgb, var(--interactive-accent) 17%, var(--background-primary));
    --s2b-pill-border-hover: color-mix(in srgb, var(--interactive-accent) 32%, var(--background-modifier-border));
  }

  /* Now that an ACTIVE reference chip is also page-filled (ghost), fill no
     longer separates deactivated from active — so the remaining cues have to
     carry it: no accent in the border at all, muted label, reduced opacity,
     and a struck-through name. The strikethrough is the unambiguous one; it
     says "excluded from the message" without relying on a tint difference
     that some themes render nearly invisible. */
  .s2b-chip.deactivated {
    --s2b-pill-bg: var(--background-primary);
    --s2b-pill-border: color-mix(in srgb, var(--background-modifier-border) 90%, transparent);
    --s2b-pill-color: var(--text-muted);
    --s2b-pill-bg-hover: var(--background-primary);
    --s2b-pill-border-hover: color-mix(in srgb, var(--background-modifier-border) 90%, transparent);
    --s2b-pill-color-hover: var(--text-muted);
    opacity: 0.6;
  }

  .s2b-chip.deactivated .chip-label {
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, currentColor 55%, transparent);
  }

  .s2b-chip.deactivated:hover {
    opacity: 0.75;
  }

  /* Active-note chip wraps a body button + optional promote action */
  .s2b-chip.visible {
    padding: 0;
    background: none;
    border: none;
  }

  .s2b-chip.visible .chip-body {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  /* Graph summary chip: body (expand toggle) + close-all action, like .visible */
  .s2b-chip.graph-group {
    padding: 0;
    background: none;
    border: none;
  }

  .s2b-chip.graph-group .chip-body {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .chip-chevron {
    opacity: 0.55;
    margin-left: 2px;
  }

  /* Expanded member list: its own full-width row so the members wrap under the
     summary chip. Capped in height so a large graph selection stays scrollable
     instead of pushing the composer around. */
  .graph-members {
    flex-basis: 100%;
    display: flex;
    flex-flow: row wrap;
    gap: 6px;
    max-height: 5.5rem;
    overflow-y: auto;
    padding: 2px;
  }

  .s2b-chip.graph-member {
    max-width: 14rem;
    min-width: 0;
  }

  /* Restates the pill fill (same `--s2b-pill-bg` the adjacent `.chip-action`
     paints) because it can't be left to `.s2b-pill`: the body is a <button>,
     and Obsidian's app.css button rule outspecifies the unscoped pill class —
     without this the body renders `--interactive-normal` grey next to a
     tinted action and the chip reads as two unrelated buttons. The scoped
     selector is what wins that fight. */
  /* The chip's cap has to reach the label, and the label lives inside this
     inner button on `.visible` / `.graph-group` chips. Without `min-width: 0`
     the button floors at its content width and the ellipsis never engages. */
  .chip-body {
    background: var(--s2b-pill-bg);
    color: inherit;
    min-width: 0;
    flex-shrink: 1;
  }


  .chip-body:hover {
    background: var(--s2b-pill-bg-hover);
  }

  .chip-action {
    display: inline-flex;
    align-items: center;
    /* Fixed-size target: it must not absorb the squeeze that belongs to the
       label when the chip hits its width cap. */
    flex-shrink: 0;
    /* Vertical padding tracks the compact tray pill above. */
    padding: 2px 7px 2px 5px;
    border: 1px solid var(--s2b-pill-border);
    border-left: none;
    border-top-right-radius: 999px;
    border-bottom-right-radius: 999px;
    background: var(--s2b-pill-bg);
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }

  /* Hover uses the chip's own tint family via the var, not a hardcoded green:
     this action sits on the accent-tinted visible-note chip, and green is the
     attachment palette — flashing it here implied a different chip type. */
  .chip-action:hover {
    background: var(--s2b-pill-bg-hover);
    color: var(--text-normal);
  }

  .chip-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    opacity: 0.9;
  }

  .chip-meta {
    opacity: 0.62;
  }

  .chip-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selection {
    /* Never let a long selection preview stretch the tray past the input width. */
    max-width: min(100%, 22rem);
    min-width: 0;
  }

  .chip-warning {
    flex-shrink: 0;
    font-size: 10px;
  }

  .chip-close {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    margin-left: 2px;
    padding-left: 6px;
    border-left: 1px solid color-mix(in srgb, currentColor 12%, transparent);
    opacity: 0.45;
    transition: opacity 0.15s ease, border-color 0.15s ease;
  }

  .selection:hover .chip-close,
  .graph-member:hover .chip-close {
    opacity: 1;
    border-color: color-mix(in srgb, currentColor 22%, transparent);
  }
</style>
