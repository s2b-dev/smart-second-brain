<script lang="ts">
import { Notice } from "obsidian";
import { firstChangedLine, revealAndScroll } from "../../lib/pendingChangeNavigation";
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import { getPendingChangesStore } from "../../stores/pendingChangesStore.svelte";
import type { PendingChangeEntry } from "../../types/shared";
import type { RevertSkip } from "../../stores/pendingChangesStore.svelte";
import { icon } from "../../utils/utils";
import { VIEW_TYPE_CHAT } from "../../views/chat/Chat";
import { ConfirmModal } from "../modal/ConfirmModal";
import { isWidgetFilePath } from "../../widget/widgetSpec";
import MarkdownRenderer from "../ui/MarkdownRenderer.svelte";
import PendingDiffHunks from "./PendingDiffHunks.svelte";
import PendingWidgetPreview from "./PendingWidgetPreview.svelte";

interface Props {
	threadPath: string | null;
}

const { threadPath }: Props = $props();
const store = getPendingChangesStore();
const pluginData = getData();

/**
 * The global in-note diff rendering preference, surfaced here because this bar is where
 * review starts — the same toggle the in-note and reading-view diff bars carry. The icon
 * shows the mode a click switches TO (matching those bars): columns for two-pane, a
 * file-diff glyph for inline word diff.
 */
const diffViewMode = $derived(pluginData.diffViewMode);

function toggleDiffViewMode(e: Event) {
	e.stopPropagation();
	pluginData.diffViewMode = diffViewMode === "word-diff" ? "two-pane" : "word-diff";
	// Same dedicated event the in-note bars dispatch: a mode flip is not a
	// pending-changes mutation, so it must not trigger the reading views'
	// destructive rerender (see readingViewDiffProcessor).
	document.dispatchEvent(new CustomEvent("s2b-diff-mode-changed"));
}

const threadId = $derived(threadPath);
/**
 * Everything in this thread that still needs the user — pending proposals, plus
 * any entry whose groups were all resolved individually but whose applied text is
 * still written to the note.
 *
 * The bar used to render only `status === "pending"` entries. Accepting one diff
 * group and then rejecting the rest leaves an entry marked `rejected` with its
 * accepted content on disk; if that was the thread's only entry the bar vanished,
 * stranding the change with no way to reach "Reject All".
 */
const actionableEntries = $derived.by(() => {
	void store.revision;
	return threadId ? store.getActionableForThread(threadId) : [];
});
const pendingEntries = $derived(actionableEntries.filter((e) => e.status === "pending"));
const pendingCount = $derived(pendingEntries.length);
/** Entries holding applied-but-unreverted content (never also `pending`). */
const appliedEntries = $derived(actionableEntries.filter((e) => e.status !== "pending"));
const appliedCount = $derived(appliedEntries.length);

/** Headline for the summary row, which now covers two distinct kinds of entry.
 * Spells out the pending batch's composition — "2 updates, 1 delete pending"
 * reads very differently from "3 pending changes" when Accept All sits one
 * click away and the destructive rows are hidden behind the collapse. */
const summaryLabel = $derived.by(() => {
	const parts: string[] = [];
	if (pendingCount > 0) {
		const counts = { create: 0, update: 0, delete: 0, move: 0 };
		for (const e of pendingEntries) counts[e.change.type]++;
		const composition = (Object.keys(counts) as Array<keyof typeof counts>)
			.filter((type) => counts[type] > 0)
			.map((type) => `${counts[type]} ${type}${counts[type] !== 1 ? "s" : ""}`)
			.join(", ");
		parts.push(`${composition} pending`);
	}
	if (appliedCount > 0) parts.push(`${appliedCount} partially applied`);
	return parts.join(", ");
});

let isExpanded = $state(false);

/** True while an Accept All / Reject All batch is running — disables both
 * buttons so a double-click can't queue a second batch (the store's guard
 * makes re-entry a silent no-op, but the button shouldn't invite it). */
let batchRunning = $state(false);

/**
 * Entries whose target no longer matches what was staged (edited externally,
 * or deleted). Accepting one will fail its conflict check, so surface the
 * staleness up front instead of letting Accept error as the first signal.
 * Async (`hasConflict` reads the vault), hence state + explicit recompute
 * rather than a `$derived`.
 *
 * Staleness only changes when DISK changes, so vault reads happen in exactly
 * two places: a full pass when the thread changes (or on mount), and a
 * targeted pass for the one path a vault event named. Store mutations can't
 * change disk — a fresh stage reads disk as its original, and a group accept
 * advances originalContent to exactly what it wrote — so the revision effect
 * below only PRUNES resolved ids, without a single read. (The previous
 * version re-read every staged file on every store revision: a 100-entry
 * vault-wide replace did 100 reads per accept click.)
 */
let staleEntryIds = $state(new Set<string>());
/** Invalidates in-flight recomputes: reads are async, so a slow older pass
 * must not overwrite the result of a newer one. Last started wins. */
let staleToken = 0;

/** Re-evaluate staleness against disk. `paths` limits the pass to entries
 * targeting those vault paths (others keep their current verdict); omitted =
 * full pass over the thread's pending entries. */
async function recomputeStale(paths?: ReadonlySet<string>) {
	const token = ++staleToken;
	const ids = paths ? new Set(staleEntryIds) : new Set<string>();
	for (const entry of threadId ? getPendingChangesStore().getPendingForThread(threadId) : []) {
		if (entry.change.type === "create") continue;
		if (paths && !paths.has(entry.change.path)) continue;
		try {
			if (await store.hasConflict(entry.id)) ids.add(entry.id);
			else ids.delete(entry.id);
		} catch {
			// vault read failed — leave the entry unmarked rather than crying wolf
		}
	}
	if (token === staleToken) staleEntryIds = ids;
}

// Full pass only when the surveyed thread changes (covers mount, where
// entries may have gone stale while the plugin was unloaded).
$effect(() => {
	void threadId;
	void recomputeStale();
});

// Store mutations: prune ids whose entry is no longer pending — synchronous,
// no vault reads (see the state doc above for why none are needed).
$effect(() => {
	void store.revision;
	if (!threadId) return;
	const pendingIds = new Set(
		getPendingChangesStore()
			.getPendingForThread(threadId)
			.map((e) => e.id),
	);
	// Only assign on an actual removal: this effect reads staleEntryIds, so an
	// unconditional write would re-trigger it (harmlessly, but noisily).
	if ([...staleEntryIds].some((id) => !pendingIds.has(id))) {
		staleEntryIds = new Set([...staleEntryIds].filter((id) => pendingIds.has(id)));
	}
});

// External edits to a staged note arrive as vault events, scoped to the one
// path the event names.
$effect(() => {
	const app = getPlugin().app;
	const touchesStagedPath = (path: string) =>
		threadId &&
		getPendingChangesStore()
			.getPendingForThread(threadId)
			.some((e) => e.change.path === path);
	const modifyRef = app.vault.on("modify", (file) => {
		if (touchesStagedPath(file.path)) void recomputeStale(new Set([file.path]));
	});
	const deleteRef = app.vault.on("delete", (file) => {
		if (touchesStagedPath(file.path)) void recomputeStale(new Set([file.path]));
	});
	return () => {
		app.vault.offref(modifyRef);
		app.vault.offref(deleteRef);
	};
});

/** Explains a badge on click/keypress — `title` tooltips don't exist on touch,
 * so every badge needs a tap path to its explanation. */
function explainBadge(evt: Event, text: string) {
	evt.stopPropagation();
	new Notice(text, 8000);
}

/**
 * Ids of entries whose preview is open.
 *
 * A `create` has no note to jump to yet and a `delete` is about to lose one,
 * so those render their full content inline. An `update` can also be reviewed
 * in the note itself (the inline-diff decorations, which the path link jumps
 * to), but that means leaving the chat — and on mobile the hover page-preview
 * doesn't exist at all — so it additionally gets an in-chat per-hunk diff
 * (PendingDiffHunks) behind the same toggle.
 */
let previewedEntryIds = $state(new Set<string>());

function togglePreview(entryId: string) {
	const next = new Set(previewedEntryIds);
	if (!next.delete(entryId)) next.add(entryId);
	previewedEntryIds = next;
}

/** The content a row can preview inline, or null when the row previews a diff (update) or nothing (move). */
function previewContentOf(entry: PendingChangeEntry): string | null {
	if (entry.change.type === "create") return entry.change.content;
	if (entry.change.type === "delete") return entry.change.originalContent;
	return null;
}

/** Whether a row previews an in-chat diff instead of full content. Only pending
 * updates: a resolved-but-partly-applied entry has originalContent == newContent
 * (no groups left to show), and its remaining action is Undo, not review. */
function hasDiffPreview(entry: PendingChangeEntry): boolean {
	return entry.change.type === "update" && entry.status === "pending";
}

/**
 * The `.widget` file content a row previews as a RENDERED widget, or null when the
 * row is not about a widget file (or has nothing to render: a move, a resolved
 * update). A widget's source is HTML and script — a code diff says little about
 * what the user would get, and a create previewed as markdown is unreadable — so
 * for widget files the proposal itself is shown: the widget as it would be after
 * accepting. For a pending update the source diff stays reachable inside the
 * preview (`sourceDiffEntryIds`).
 */
function widgetPreviewContent(entry: PendingChangeEntry): string | null {
	void store.revision;
	if (!isWidgetFilePath(entry.change.path)) return null;
	switch (entry.change.type) {
		case "create":
			return entry.change.content;
		case "update":
			return entry.status === "pending" ? entry.change.newContent : null;
		case "delete":
			return entry.change.originalContent;
		case "move":
			return null;
	}
}

/** Ids of widget-update rows whose source diff is unfolded under the rendered preview. */
let sourceDiffEntryIds = $state(new Set<string>());

function toggleSourceDiff(entryId: string) {
	const next = new Set(sourceDiffEntryIds);
	if (!next.delete(entryId)) next.add(entryId);
	sourceDiffEntryIds = next;
}

function changeTypeLabel(entry: PendingChangeEntry): string {
	switch (entry.change.type) {
		case "create":
			return "Create";
		case "update":
			return "Update";
		case "delete":
			return "Delete";
		case "move":
			return "Move";
	}
}

function changeTypeBadgeClass(type: string): string {
	switch (type) {
		case "create":
			return "badge-create";
		case "update":
			return "badge-update";
		case "delete":
			return "badge-delete";
		case "move":
			return "badge-update";
		default:
			return "";
	}
}

/** Vault path as Obsidian shows notes natively: no `.md` extension. The folder
 * prefix stays — it disambiguates same-named notes, and staged changes can
 * target any folder. */
function displayPath(path: string): string {
	return path.replace(/\.md$/, "");
}

function changePathLabel(entry: PendingChangeEntry): string {
	return entry.change.type === "move"
		? `${displayPath(entry.change.path)} → ${displayPath(entry.change.newPath)}`
		: displayPath(entry.change.path);
}

/** Whether this move takes a note out of a private location into a public one.
 * Not a provider-trust question — see `isDeprivatizingMove`. */
function isDeprivatizing(entry: PendingChangeEntry): boolean {
	void store.revision;
	return store.isDeprivatizingMove(entry.change);
}

/** Number of OTHER chats that also have a pending update to this entry's file.
 * Only updates can collide cross-thread (create/delete/move aren't dedup-scoped
 * the same way, and only updates carry the stale-original-content hazard). */
function otherThreadCount(entry: PendingChangeEntry): number {
	void store.revision;
	if (entry.change.type !== "update" || !threadId) return 0;
	return store.countOtherThreadsPendingUpdate(entry.change.path, threadId);
}

async function handleAccept(entry: PendingChangeEntry) {
	try {
		await store.acceptChange(entry.id);
		new Notice(`Applied: ${changePathLabel(entry)}`);
	} catch (e) {
		new Notice(`Failed to apply change: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function handleReject(entry: PendingChangeEntry) {
	store.rejectChange(entry.id);
	new Notice(`Rejected: ${changePathLabel(entry)}`);
}

/** Restore a note whose diff groups were partially accepted, for an entry that is
 *  no longer pending (so accept/reject would both be no-ops on it). */
async function handleUndoApplied(entry: PendingChangeEntry) {
	const skipped = await store.undoAppliedGroups(entry.id);
	if (!skipped) {
		new Notice(`Restored: ${changePathLabel(entry)}`);
		return;
	}
	new Notice(describeSkip(skipped));
}

/** A restore that didn't happen, phrased for the reason it didn't. */
function describeSkip(skip: RevertSkip): string {
	switch (skip.reason) {
		case "conflict":
			return `Left "${skip.path}" as-is — it changed after the change was partially applied.`;
		case "missing":
			return `Could not restore "${skip.path}" — that note no longer exists. Any applied content moved with it.`;
		case "failed":
			return `Failed to restore "${skip.path}". See the console for details.`;
	}
}

async function handleAcceptAll() {
	if (!threadId || batchRunning) return;
	// Stale entries can never apply (their conflict check fails unconditionally),
	// so exclude them up front — the result then reads "skipped", not "failed".
	const acceptable = pendingEntries.filter((e) => !staleEntryIds.has(e.id));
	const staleCount = pendingCount - acceptable.length;
	const count = acceptable.length;
	if (count === 0) {
		new Notice(
			"All pending changes are stale — the notes changed after they were proposed. Reject them and ask the agent to re-stage.",
		);
		return;
	}

	// One click on a collapsed bar can apply deletions and privacy-affecting
	// moves the user never looked at. Those two get a confirm; ordinary
	// creates/updates keep the frictionless path.
	const deletes = acceptable.filter((e) => e.change.type === "delete").length;
	const deprivatizing = acceptable.filter((e) => store.isDeprivatizingMove(e.change)).length;
	if (deletes > 0 || deprivatizing > 0) {
		const risks: string[] = [];
		if (deletes > 0) risks.push(`${deletes} note deletion${deletes !== 1 ? "s" : ""}`);
		if (deprivatizing > 0)
			risks.push(`${deprivatizing} move${deprivatizing !== 1 ? "s" : ""} out of a private location`);
		const modal = new ConfirmModal(
			getPlugin().app,
			"Accept all changes?",
			`This batch includes ${risks.join(" and ")}. Apply all ${count} change${count !== 1 ? "s" : ""}?`,
			"Accept All",
		);
		modal.open();
		if (!(await modal.promise).confirmed) return;
	}

	batchRunning = true;
	try {
		const failures = await store.acceptAll(threadId, staleEntryIds);
		const skippedNote = staleCount > 0 ? `, skipped ${staleCount} stale` : "";
		if (failures.length === 0) {
			new Notice(`Applied ${count === 1 ? "the change" : `all ${count} changes`}${skippedNote}`);
		} else {
			new Notice(
				`Applied ${count - failures.length} changes${skippedNote}, ${failures.length} failed: ${failures.join(", ")}`,
			);
		}
	} catch (e) {
		new Notice(`Error applying changes: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		batchRunning = false;
	}
}

async function handleRejectAll() {
	if (!threadId || batchRunning) return;
	// Capture before the call — both counts are zero afterwards.
	const hadPending = pendingCount > 0;
	batchRunning = true;
	try {
		const skipped = await store.rejectAll(threadId);
		if (skipped.length === 0) {
			new Notice(hadPending ? "Rejected all pending changes" : "Restored the partially applied notes");
		} else {
			// A partially-accepted note that couldn't be restored is left as it is. Say
			// so per reason — otherwise "Rejected all" reads as "everything was undone"
			// while those files still hold the accepted groups.
			const head = hadPending ? "Rejected all pending changes." : "Finished undoing applied changes.";
			new Notice(`${head} ${skipped.map(describeSkip).join(" ")}`);
		}
	} finally {
		batchRunning = false;
	}
}

/** Jump to this change's position in the target note (its first changed line).
 * Only meaningful for updates; create/delete/move fall back to the top of file
 * and the button is only shown for updates. */
async function handleJump(entry: PendingChangeEntry) {
	const opened = await revealAndScroll(getPlugin(), entry.change.path, firstChangedLine(entry.change));
	if (!opened) new Notice("Could not open the note for this change.");
}

/** Fire Obsidian's native page-preview hover for this change's note. The Page
 * Preview core plugin reads modifier keys off the event, so this respects the
 * user's "require Cmd" setting. The rendered preview shows the note WITH its
 * in-note pending-change decorations, which the sidebar can't render itself. */
function previewChange(evt: Event, entry: PendingChangeEntry) {
	const target = evt.currentTarget;
	if (!(target instanceof HTMLElement)) return;
	getPlugin().app.workspace.trigger("hover-link", {
		event: evt,
		source: VIEW_TYPE_CHAT,
		hoverParent: getPlugin(),
		targetEl: target,
		linktext: entry.change.path,
		sourcePath: threadId ?? "",
	});
}
</script>

{#if actionableEntries.length > 0}
  <div class="pcb-container">
    <!-- Summary bar. A div with button semantics, not a <button>: it CONTAINS
         the Accept/Reject All buttons, and interactive elements can't nest. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="pcb-summary"
      role="button"
      tabindex="0"
      aria-expanded={isExpanded}
      aria-label={isExpanded ? "Collapse pending changes" : "Expand pending changes"}
      onclick={() => (isExpanded = !isExpanded)}
      onkeydown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          isExpanded = !isExpanded;
        }
      }}
    >
      <div class="pcb-summary-left">
        <div class="pcb-icon" use:icon={"file-diff"} style="--icon-size: var(--icon-xs)"></div>
        <span class="pcb-count">
          {summaryLabel}
        </span>
      </div>
      <div class="pcb-summary-right">
        <button
          class="clickable-icon pcb-diff-toggle"
          onclick={toggleDiffViewMode}
          title={diffViewMode === "word-diff"
            ? "Switch in-note diffs to two-pane view"
            : "Switch in-note diffs to inline word diff"}
          aria-label="Toggle diff view mode"
          type="button"
        >
          <div use:icon={diffViewMode === "word-diff" ? "columns-2" : "file-diff"} style="--icon-size: 12px"></div>
        </button>
        {#if pendingCount > 0}
          <button
            class="pcb-action pcb-action-accept"
            onclick={(e) => {
              e.stopPropagation();
              handleAcceptAll();
            }}
            title="Accept all changes"
            type="button"
            disabled={batchRunning}
          >
            <div use:icon={"check"} style="--icon-size: 12px"></div>
            <span>Accept All</span>
          </button>
        {/if}
        <button
          class="pcb-action pcb-action-reject"
          onclick={(e) => {
            e.stopPropagation();
            handleRejectAll();
          }}
          title={pendingCount > 0
            ? "Reject all changes, restoring any partially applied notes"
            : "Restore the partially applied notes to their original content"}
          type="button"
          disabled={batchRunning}
        >
          <div use:icon={"x"} style="--icon-size: 12px"></div>
          <span>{pendingCount > 0 ? "Reject All" : "Undo Applied"}</span>
        </button>
        <div class="pcb-chevron" class:pcb-chevron-open={isExpanded}>▸</div>
      </div>
    </div>

    <!-- Expanded change list -->
    {#if isExpanded}
      <div class="pcb-list">
        {#each actionableEntries as entry (entry.id)}
          {@const previewContent = previewContentOf(entry)}
          {@const showsDiff = hasDiffPreview(entry)}
          {@const widgetContent = widgetPreviewContent(entry)}
          {@const isPreviewOpen = previewedEntryIds.has(entry.id)}
          <div class="pcb-entry">
            <div class="pcb-entry-header">
              <div class="pcb-entry-left">
                {#if previewContent !== null || showsDiff}
                  <button
                    class="pcb-preview-toggle"
                    class:pcb-preview-toggle-open={isPreviewOpen}
                    onclick={() => togglePreview(entry.id)}
                    title={widgetContent !== null
                      ? isPreviewOpen
                        ? "Hide widget preview"
                        : "Preview widget"
                      : showsDiff
                        ? isPreviewOpen
                          ? "Hide changes"
                          : "Show changes"
                        : isPreviewOpen
                          ? "Hide content"
                          : "Show content"}
                    aria-label={widgetContent !== null
                      ? isPreviewOpen
                        ? `Hide preview of ${entry.change.path}`
                        : `Preview ${entry.change.path}`
                      : showsDiff
                        ? isPreviewOpen
                          ? `Hide changes to ${entry.change.path}`
                          : `Show changes to ${entry.change.path}`
                        : isPreviewOpen
                          ? `Hide content of ${entry.change.path}`
                          : `Show content of ${entry.change.path}`}
                    aria-expanded={isPreviewOpen}
                    type="button"
                  >
                    <div use:icon={"chevron-right"} style="--icon-size: 12px"></div>
                  </button>
                {/if}
                <span class="pcb-badge {changeTypeBadgeClass(entry.change.type)}">
                  {changeTypeLabel(entry)}
                </span>
                {#if entry.status !== "pending"}
                  {@const appliedText =
                    "Some of this change was applied to the note. Undo it to restore the note's original content."}
                  <!-- Not a proposal awaiting review: its groups were all resolved
                       individually and some accepted text is still in the note. -->
                  <span
                    class="pcb-applied"
                    title={appliedText}
                    role="button"
                    tabindex="0"
                    onclick={(e) => explainBadge(e, appliedText)}
                    onkeydown={(e) => e.key === "Enter" && explainBadge(e, appliedText)}
                  >
                    <span use:icon={"circle-alert"} style="--icon-size: 11px"></span>
                    Partly applied
                  </span>
                {/if}
                {#if staleEntryIds.has(entry.id)}
                  {@const staleText =
                    entry.change.type === "delete"
                      ? "This note changed after the delete was proposed — the preview no longer matches what would be deleted. Accepting will fail; reject and ask the agent to re-stage it."
                      : "This note changed after the change was proposed, so accepting it will fail. Reject it and ask the agent to re-apply its edit on the current content."}
                  <span
                    class="pcb-stale"
                    title={staleText}
                    role="button"
                    tabindex="0"
                    onclick={(e) => explainBadge(e, staleText)}
                    onkeydown={(e) => e.key === "Enter" && explainBadge(e, staleText)}
                  >
                    <span use:icon={"triangle-alert"} style="--icon-size: 11px"></span>
                    Stale
                  </span>
                {/if}
                {#if entry.change.type !== "create"}
                  <!-- Everything except a create targets a note that exists on disk
                       right now — link it. For a delete, the live note is a better
                       review surface than the staged snapshot; for a move, it shows
                       what would be relocated. -->
                  <!-- svelte-ignore a11y_mouse_events_have_key_events -->
                  <a
                    class="internal-link pcb-path"
                    href={entry.change.path}
                    data-href={entry.change.path}
                    onclick={(e) => {
                      e.preventDefault();
                      handleJump(entry);
                    }}
                    onmouseover={(e) => previewChange(e, entry)}
                    onfocus={(e) => previewChange(e, entry)}
                  >{changePathLabel(entry)}</a>
                {:else}
                  <span class="pcb-path">{changePathLabel(entry)}</span>
                {/if}
                {#if isDeprivatizing(entry)}
                  {@const deprivatizingText =
                    "This note is currently private. Moving it to this location takes it out of the privacy filter, so it will be indexed, searchable, and available to untrusted providers from then on."}
                  <span
                    class="pcb-deprivatizing"
                    title={deprivatizingText}
                    role="button"
                    tabindex="0"
                    onclick={(e) => explainBadge(e, deprivatizingText)}
                    onkeydown={(e) => e.key === "Enter" && explainBadge(e, deprivatizingText)}
                  >
                    <span use:icon={"shield-off"} style="--icon-size: 11px"></span>
                    Leaves private
                  </span>
                {/if}
                {#if otherThreadCount(entry) > 0}
                  {@const crossThreadText = `${otherThreadCount(entry)} other chat${otherThreadCount(entry) !== 1 ? "s" : ""} also ${otherThreadCount(entry) !== 1 ? "have" : "has"} a pending edit to this file. Whichever is accepted first wins; the others may then fail to apply.`}
                  <span
                    class="pcb-cross-thread"
                    title={crossThreadText}
                    role="button"
                    tabindex="0"
                    onclick={(e) => explainBadge(e, crossThreadText)}
                    onkeydown={(e) => e.key === "Enter" && explainBadge(e, crossThreadText)}
                  >
                    <span use:icon={"users"} style="--icon-size: 11px"></span>
                    {otherThreadCount(entry)}
                  </span>
                {/if}
              </div>
              <div class="pcb-entry-actions">
                {#if entry.status === "pending"}
                  <!-- Accept is disabled while stale: the store's conflict check
                       makes it fail unconditionally, so an enabled button is just
                       an error with extra steps. If the note reverts to the staged
                       content, the vault-event recompute re-enables it. -->
                  <button
                    class="pcb-action-icon pcb-action-accept"
                    onclick={(e) => {
                      e.stopPropagation();
                      handleAccept(entry);
                    }}
                    title={staleEntryIds.has(entry.id)
                      ? "Cannot accept — the note changed after this was proposed. Reject it and ask the agent to re-stage."
                      : "Accept change"}
                    aria-label="Accept change to {entry.change.path}"
                    type="button"
                    disabled={staleEntryIds.has(entry.id)}
                  >
                    <div use:icon={"check"} style="--icon-size: 12px"></div>
                  </button>
                  <button
                    class="pcb-action-icon pcb-action-reject"
                    onclick={(e) => {
                      e.stopPropagation();
                      handleReject(entry);
                    }}
                    title="Reject change"
                    aria-label="Reject change to {entry.change.path}"
                    type="button"
                  >
                    <div use:icon={"x"} style="--icon-size: 12px"></div>
                  </button>
                {:else}
                  <!-- Already resolved at group level: accept/reject are no-ops on it
                       (both early-return on non-pending), so offer the one action that
                       still does something — undoing the text left in the note. -->
                  <button
                    class="pcb-action-icon pcb-action-reject"
                    onclick={(e) => {
                      e.stopPropagation();
                      handleUndoApplied(entry);
                    }}
                    title="Restore this note to its content from before the proposal"
                    aria-label="Undo applied change to {entry.change.path}"
                    type="button"
                  >
                    <div use:icon={"undo-2"} style="--icon-size: 12px"></div>
                  </button>
                {/if}
              </div>
            </div>

            {#if isPreviewOpen && widgetContent !== null}
              {@const sourceDiffOpen = sourceDiffEntryIds.has(entry.id)}
              <div class="pcb-preview pcb-preview-widget">
                <!-- What accepting yields, rendered. A delete previews the widget
                     that would go; a create/update the one that would exist. -->
                <PendingWidgetPreview content={widgetContent} sourcePath={entry.change.path} />
                {#if showsDiff}
                  <button
                    class="pcb-source-toggle"
                    onclick={() => toggleSourceDiff(entry.id)}
                    aria-expanded={sourceDiffOpen}
                    type="button"
                  >
                    <span use:icon={"file-diff"} style="--icon-size: 11px"></span>
                    {sourceDiffOpen ? "Hide source changes" : "Show source changes"}
                  </button>
                  {#if sourceDiffOpen}
                    <PendingDiffHunks {entry} stale={staleEntryIds.has(entry.id)} />
                  {/if}
                {/if}
              </div>
            {:else if isPreviewOpen && showsDiff}
              <div class="pcb-preview">
                <PendingDiffHunks {entry} stale={staleEntryIds.has(entry.id)} />
              </div>
            {:else if isPreviewOpen && previewContent !== null}
              <div class="pcb-preview">
                {#if previewContent.trim() === ""}
                  <div class="pcb-preview-empty">This note is empty.</div>
                {:else}
                  <MarkdownRenderer content={previewContent} class="pcb-preview-body" />
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .pcb-container {
    display: flex;
    flex-direction: column;
    /* Matches `.chat-input-wrapper`, which this bar sits directly above: the
       page-coloured fill defined by a real border, and the wrapper's literal
       22px pill. 22px is hardcoded rather than a --radius-* token because
       Obsidian's largest, --radius-l, is only 12px — still visibly squarer
       than the composer next to it. */
    border: 1px solid var(--background-modifier-border);
    border-radius: 22px;
    overflow: hidden;
    background: var(--pcb-bg);
    /* Tracks `--input-bg` in Input.svelte — same value, so the bar and the
       composer always read as one stacked surface. */
    --pcb-bg: var(--background-primary);
    /* Cap the whole bar, not just the list, so a long run of changes can't grow
       past the composer. The summary row is a flex sibling that never shrinks,
       so it stays pinned and Accept/Reject All remain reachable at any length. */
    min-height: 0;
    max-height: 45vh;
  }

  .pcb-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    /* Never give up height to the scrolling list below — the accept/reject-all
       controls have to stay reachable however many changes are pending. */
    flex-shrink: 0;
    padding: 6px 10px;
    /* Inherits the container's fill rather than re-stating a colour that
       would paint over it. */
    background: var(--pcb-bg);
    border: none;
    cursor: pointer;
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    width: 100%;
    text-align: left;
  }

  .pcb-summary:hover {
    background: var(--background-modifier-hover);
  }

  .pcb-summary-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .pcb-icon {
    color: var(--text-accent);
    display: flex;
    align-items: center;
  }

  .pcb-count {
    font-weight: var(--font-medium);
    font-size: var(--font-ui-smaller);
  }

  .pcb-summary-right {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .pcb-action {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 2px 8px;
    border: none;
    border-radius: var(--radius-s);
    cursor: pointer;
    font-size: var(--font-smallest);
    font-weight: var(--font-medium);
    background: transparent;
    transition: background 100ms ease;
  }

  .pcb-action[disabled] {
    opacity: 0.5;
    cursor: default;
    pointer-events: none;
  }

  /* Tints derive from the HEX colour vars via `color-mix`, not
     `hsla(var(--color-green-hsl), …)`: the -hsl forms are theme-dependent and
     are absent entirely in some themes (Cupertino), where the hsla() collapses
     to transparent and the hover state silently disappears. Same treatment as
     the in-note diff bar in styles.css, so both review surfaces match. */
  .pcb-action-accept {
    color: var(--color-green);
  }

  .pcb-action-accept:hover {
    background: color-mix(in srgb, var(--color-green) 15%, transparent);
  }

  .pcb-action-reject {
    color: var(--color-red);
  }

  .pcb-action-reject:hover {
    background: color-mix(in srgb, var(--color-red) 15%, transparent);
  }

  .pcb-action-icon {
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

  /* 12px icons + 2px padding are pointer-sized; on touch, bump the hit areas
     to guideline size. Obsidian marks mobile with body.is-mobile. */
  :global(.is-mobile) .pcb-action-icon,
  :global(.is-mobile) .pcb-preview-toggle {
    padding: 8px;
  }

  /* Disabled accept on a stale row: keep it visible (its absence would read as
     "this row can't be accepted ever") but clearly inert. pointer-events stays
     on so the explanatory title tooltip still shows on hover. */
  .pcb-action-icon[disabled] {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .pcb-action-icon[disabled]:hover {
    background: transparent;
  }

  /* Native .clickable-icon supplies the at-rest/hover treatment; only compact it
     to this row's control height so it doesn't inflate the summary bar. */
  .pcb-diff-toggle {
    padding: 2px 4px;
  }

  :global(.is-mobile) .pcb-diff-toggle {
    padding: 8px;
  }

  .pcb-chevron {
    transition: transform 100ms ease;
    color: var(--text-faint);
    font-size: var(--font-smaller);
    margin-left: 2px;
  }

  .pcb-chevron-open {
    transform: rotate(90deg);
  }

  .pcb-list {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--background-modifier-border);
    /* The scroller. `min-height: 0` is required for a flex child to shrink below
       its content size — without it the list wins over the container's
       max-height and the bar overflows the composer instead of scrolling. */
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .pcb-entry {
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .pcb-entry:last-child {
    border-bottom: none;
  }

  .pcb-entry-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 4px 10px;
    background: transparent;
    border: none;
    cursor: default;
    color: var(--text-normal);
    font-size: var(--font-ui-smaller);
    text-align: left;
  }

  .pcb-entry-left {
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    min-width: 0;
  }

  /* Reads as a note title, not code: the row's UI font, no monospace, and the
     label itself already drops the `.md` extension (see displayPath) — matching
     how Obsidian names notes everywhere else. */
  .pcb-path {
    font-size: var(--font-ui-smaller);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  a.pcb-path {
    cursor: pointer;
  }

  .pcb-cross-thread {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
    padding: 1px 5px;
    border-radius: var(--radius-s);
    font-size: 10px;
    font-weight: var(--font-semibold);
    background: color-mix(in srgb, var(--color-orange) 20%, transparent);
    color: var(--color-orange);
    cursor: help;
  }

  /* Same shape as .pcb-cross-thread, but color-mix against the hex --color-red
     rather than hsla(--color-red-hsl): the -hsl vars are undefined in some
     themes (Cupertino among them), which silently renders the badge
     transparent. */
  .pcb-deprivatizing {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
    padding: 1px 5px;
    border-radius: var(--radius-s);
    font-size: 10px;
    font-weight: var(--font-semibold);
    background: color-mix(in srgb, var(--color-red) 20%, transparent);
    color: var(--color-red);
    cursor: help;
  }

  /* Same shape family; red — accepting a stale entry is guaranteed to fail its
     conflict check, and for a delete the preview misrepresents what would go. */
  .pcb-stale {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
    padding: 1px 5px;
    border-radius: var(--radius-s);
    font-size: 10px;
    font-weight: var(--font-semibold);
    background: color-mix(in srgb, var(--color-red) 20%, transparent);
    color: var(--color-red);
    cursor: help;
  }

  /* Shares the deprivatizing badge's shape; amber rather than red — this is a
     "needs your attention" state, not a privacy warning. */
  .pcb-applied {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
    padding: 1px 5px;
    border-radius: var(--radius-s);
    font-size: 10px;
    font-weight: var(--font-semibold);
    background: color-mix(in srgb, var(--color-yellow) 20%, transparent);
    color: var(--color-yellow);
    cursor: help;
  }

  .pcb-entry-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }

  /* Reuses the summary chevron's rotate-on-open idiom so the two disclosure
     affordances in this component read the same. */
  .pcb-preview-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    flex-shrink: 0;
    transition: transform 100ms ease;
  }

  .pcb-preview-toggle:hover {
    color: var(--text-normal);
  }

  .pcb-preview-toggle-open {
    transform: rotate(90deg);
  }

  .pcb-preview {
    padding: 2px 10px 8px;
    border-top: 1px solid var(--background-modifier-border);
    background: var(--background-primary);
    /* Proposed notes can be long; cap the row so a single create can't push the
       accept/reject controls of the others out of reach. */
    max-height: 260px;
    overflow-y: auto;
  }

  .pcb-preview :global(.pcb-preview-body) {
    font-size: var(--font-ui-smaller);
  }

  /* The renderer's first/last block carry their own margins; drop them so the
     preview sits flush inside its padding. */
  .pcb-preview :global(.pcb-preview-body > :first-child) {
    margin-top: 0;
  }

  .pcb-preview :global(.pcb-preview-body > :last-child) {
    margin-bottom: 0;
  }

  .pcb-preview-empty {
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
    font-style: italic;
  }

  /* A rendered widget needs room above the frame's own border, and more height
     than a text preview: a dashboard at 260px is mostly scrollbar. */
  .pcb-preview-widget {
    padding-top: 8px;
    max-height: 360px;
  }

  .pcb-source-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: 6px;
    padding: 2px 6px;
    border: none;
    border-radius: var(--radius-s);
    background: transparent;
    box-shadow: none;
    color: var(--text-muted);
    font-size: var(--font-smallest);
    cursor: pointer;
  }

  .pcb-source-toggle:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .pcb-badge {
    padding: 1px 5px;
    border-radius: var(--radius-s);
    font-size: 10px;
    font-weight: var(--font-semibold);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  /* color-mix on the hex vars rather than the theme-dependent -hsl forms — see
     the note on .pcb-action-accept above. */
  .badge-create {
    background: color-mix(in srgb, var(--color-green) 20%, transparent);
    color: var(--color-green);
  }

  .badge-update {
    background: color-mix(in srgb, var(--color-yellow) 20%, transparent);
    color: var(--color-yellow);
  }

  .badge-delete {
    background: color-mix(in srgb, var(--color-red) 20%, transparent);
    color: var(--color-red);
  }
</style>
