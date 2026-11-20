<script lang="ts">
import { t } from "../../i18n";
import { getAllTags, type App } from "obsidian";
import type { ViewFilter } from "../../types/viewFilter";
import {
	buildPrivacyMembershipRulesEditorFilter,
	clonePrivacyMembershipDraft,
	cloneViewFilter,
	compilePrivacyMembershipDraft,
	createEmptyPrivacyFilter,
	extractPrivacyMembershipRulesFilter,
	matchesPrivacyMembershipDraftPath,
	parsePrivacyMembershipFilter,
	resolveViewFilter,
	resolvePrivacyMembershipDraft,
	rewriteViewFilterForRename,
} from "../../lib/views";
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import { isAgentFilePath } from "../../utils/fileFiltering";
import { icon as iconDirective } from "../../utils/utils";
import type { PrivacyMode } from "../../types/plugin";
import Button from "../ui/Button.svelte";
import type { PrivacyListModal } from "./PrivacyListModal";
import FileSetEditor from "./FileSetEditor.svelte";

interface Props {
	modal: PrivacyListModal;
}

const plugin = getPlugin();
const data = getData();
const app: App = plugin.app;
const sourcePath = $derived(app.workspace.getActiveFile()?.path ?? "");

let { modal }: Props = $props();

const availableFolders = $derived.by(() => {
	const folders = new Set<string>();
	for (const file of app.vault.getFiles()) {
		if (isAgentFilePath(file.path)) continue;
		const parts = file.path.split("/");
		if (parts.length > 1) {
			folders.add(parts[0]);
			if (parts.length > 2) folders.add(`${parts[0]}/${parts[1]}`);
		}
	}
	return [...folders].sort();
});

const availableTags = $derived.by(() => {
	const tags = new Set<string>();
	for (const file of app.vault.getMarkdownFiles()) {
		if (isAgentFilePath(file.path)) continue;
		const cache = app.metadataCache.getFileCache(file);
		if (!cache) continue;
		for (const tag of getAllTags(cache) ?? []) {
			tags.add(tag);
		}
	}
	return [...tags].sort();
});

const availableProperties = $derived.by(() => {
	const keys = new Set<string>();
	for (const file of app.vault.getMarkdownFiles()) {
		if (isAgentFilePath(file.path)) continue;
		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!frontmatter) continue;
		for (const key of Object.keys(frontmatter)) {
			// `position` is Obsidian's internal frontmatter range marker, not a user property.
			if (key === "position") continue;
			keys.add(key);
		}
	}
	return [...keys].sort();
});

function ensureGroup(filter: ViewFilter): ViewFilter {
	if (filter.type === "all" || filter.type === "any" || filter.type === "none") {
		return filter;
	}
	return { type: "all", conditions: [filter] };
}

let privacyFilter = $state<ViewFilter>(ensureGroup(data.privacyFilter ?? createEmptyPrivacyFilter()));
/**
 * The rules builder starts collapsed, even when rules are already configured.
 * The file list is what the modal is for; an expanded builder pushed it down the
 * panel on exactly the vaults that have the most files to scan. Configured rules
 * stay discoverable through the Filters toggle, which carries both an active
 * state and a count.
 */
let showFilters = $state(false);
/** Whether the mode explanation + path-visibility caveat are expanded. */
let showModeDetails = $state(false);

/**
 * Which side of the split is listed.
 *
 * "managed" is the set the rules below build — the one this modal edits. But
 * that is only ever one half of the vault, and the question a user actually
 * arrives with ("is this note private?") is just as often about the other half.
 * Previously only the managed side was visible and the other was unlistable, so
 * confirming a file was NOT exposed meant scanning the managed list and
 * reasoning about the absence. This switch lists either side.
 */
type PrivacyListSide = "managed" | "complement";
let listSide = $state<PrivacyListSide>("managed");

// Working copy — edits only touch this local state. `data.setPrivacyFilter` /
// `data.setPrivacyMode` are called once, from `saveChanges`, so a half-typed
// condition (e.g. a folder field mid-edit) is never briefly live for tool calls,
// and closing the modal without saving discards the in-progress edit entirely.
let privacyMode = $state<PrivacyMode>(data.privacyMode);

// `dataStore` already follows vault renames for the *persisted* filter (see its
// constructor), but that rewrite lands underneath this modal's local draft. Without
// this, a rename while the modal is open would be invisible here, and clicking Save
// would overwrite the store's just-rewritten filter with this stale draft — silently
// re-introducing the exact staleness the store-level fix closes. Mirror the same
// rewrite onto the draft so Save can't regress it.
$effect(() => {
	const ref = app.vault.on("rename", (file, oldPath) => {
		privacyFilter = rewriteViewFilterForRename(privacyFilter, oldPath, file.path);
	});
	return () => app.vault.offref(ref);
});
const parsedMembership = $derived.by(() => parsePrivacyMembershipFilter(privacyFilter));
const privacyUniverse = $derived.by(
	() =>
		new Set(
			app.vault
				.getFiles()
				.filter((file) => !isAgentFilePath(file.path))
				.map((file) => file.path),
		),
);
const resolvedPrivacy = $derived.by(() =>
	parsedMembership.isAdvanced
		? {
				...resolveViewFilter(app, privacyFilter, privacyUniverse),
				provenance: new Map<string, string[]>(),
				excludedPaths: new Set<string>(),
			}
		: resolvePrivacyMembershipDraft(app, parsedMembership.draft, privacyUniverse),
);
const includedFiles = $derived.by(() => [...resolvedPrivacy.paths].sort((left, right) => left.localeCompare(right)));
const excludedFiles = $derived.by(() =>
	parsedMembership.isAdvanced
		? []
		: [...parsedMembership.draft.excludedPaths].sort((left, right) => left.localeCompare(right)),
);
const hasFilters = $derived.by(() => parsedMembership.isAdvanced || parsedMembership.draft.autoIncludeRules.length > 0);
const includedEntries = $derived.by(() =>
	includedFiles.map((path) => ({
		path,
		displayName: path.split("/").pop() ?? path,
		contextLabel: getParentPath(path) || null,
		searchable: path.toLowerCase(),
		isManual: parsedMembership.isAdvanced
			? false
			: (resolvedPrivacy.provenance.get(path)?.includes("Manual") ?? false),
	})),
);
const excludedEntries = $derived.by(() =>
	excludedFiles.map((path) => ({
		path,
		displayName: path.split("/").pop() ?? path,
		contextLabel: getParentPath(path) || null,
	})),
);

/**
 * Everything the rules do NOT select: the vault minus the managed set. Derived
 * rather than stored, so it always agrees with the rules as they are edited.
 * Rows here are editable too: a file moves to the managed side either by having
 * its explicit exclusion lifted (`isExcluded` — a rule or manual entry already
 * covers it) or, failing that, by being added as a manual path. Both directions
 * are reachable from whichever tab the user happens to be looking at, so
 * flipping one file never means switching tabs to find it again.
 */
const complementEntries = $derived.by(() => {
	const managed = resolvedPrivacy.paths;
	const excluded = new Set(parsedMembership.isAdvanced ? [] : parsedMembership.draft.excludedPaths);
	return [...privacyUniverse]
		.filter((path) => !managed.has(path))
		.sort((left, right) => left.localeCompare(right))
		.map((path) => ({
			path,
			displayName: path.split("/").pop() ?? path,
			contextLabel: getParentPath(path) || null,
			searchable: path.toLowerCase(),
			isExcluded: excluded.has(path),
		}));
});

const showingManaged = $derived(listSide === "managed");

/**
 * `FileSetEditor` renders every row it is given — no virtualization. The managed
 * set is a deliberate, user-built list so it stays small, but the complement can
 * be the entire vault, and mounting thousands of hover-enabled rows locks the
 * modal. Cap the rows there; the editor applies the cap after its search filter,
 * so anything past it is still reachable by typing.
 */
const COMPLEMENT_ROW_LIMIT = 300;
const activeEntries = $derived(showingManaged ? includedEntries : complementEntries);

function updatePrivacyFilter(nextFilter: ViewFilter) {
	privacyFilter = ensureGroup(nextFilter);
}

function updatePrivacyMode(mode: PrivacyMode) {
	privacyMode = mode;
}

function saveChanges() {
	data.setPrivacyFilter(privacyFilter);
	data.setPrivacyMode(privacyMode);
	modal.close();
}

function updateDraft(mutator: (draft: ReturnType<typeof clonePrivacyMembershipDraft>) => void) {
	const currentParsedMembership = parsePrivacyMembershipFilter(privacyFilter);
	const draft = clonePrivacyMembershipDraft(currentParsedMembership.draft);
	mutator(draft);
	// Deliberately does not open the rules panel. Every row action routes through
	// here, so keying the panel off "rules exist" made a per-file click expand the
	// builder underneath the list the user was working in.
	updatePrivacyFilter(compilePrivacyMembershipDraft(draft));
}

function getParentPath(path: string): string {
	const parts = path.split("/");
	return parts.slice(0, -1).join("/");
}

function removeManualPath(path: string) {
	updateDraft((draft) => {
		draft.manualPaths = draft.manualPaths.filter((entry) => entry !== path);
		draft.excludedPaths = draft.excludedPaths.filter((entry) => entry !== path);
	});
}

function excludePath(path: string) {
	updateDraft((draft) => {
		if (!draft.excludedPaths.includes(path)) {
			draft.excludedPaths = [...draft.excludedPaths, path];
		}
	});
}

function restoreExcludedPath(path: string) {
	updateDraft((draft) => {
		draft.excludedPaths = draft.excludedPaths.filter((entry) => entry !== path);
	});
}

/**
 * Move a complement-side file into the managed set. Lifting the exclusion is
 * enough when a rule or manual entry already selects the path; otherwise nothing
 * covers it and it has to be added manually. Doing both unconditionally is safe
 * and keeps this a single action for the user either way.
 */
function addPathToManaged(path: string) {
	updateDraft((draft) => {
		draft.excludedPaths = draft.excludedPaths.filter((entry) => entry !== path);
		if (!draft.manualPaths.includes(path) && !matchesPrivacyMembershipDraftPath(app, draft, path)) {
			draft.manualPaths = [...draft.manualPaths, path];
		}
	});
}

function handleRulesFilterChange(nextFilter: ViewFilter) {
	const simpleRules = extractPrivacyMembershipRulesFilter(nextFilter);
	if (!simpleRules) {
		showFilters = true;
		updatePrivacyFilter(cloneViewFilter(nextFilter));
		return;
	}

	updateDraft((draft) => {
		const preservedManualPaths = draft.manualPaths;
		const preservedExcludedPaths = draft.excludedPaths;
		draft.manualPaths = preservedManualPaths;
		draft.excludedPaths = preservedExcludedPaths;
		draft.autoIncludeRules = simpleRules;
	});
}

async function handleAddPaths(selectedPaths: string[]) {
	if (selectedPaths.length === 0 || parsedMembership.isAdvanced) return;
	updateDraft((draft) => {
		draft.manualPaths = [...draft.manualPaths, ...selectedPaths];
		draft.excludedPaths = draft.excludedPaths.filter((path) => !selectedPaths.includes(path));
	});
}

function getIncludedFileActions(entry: { isManual?: boolean }): Array<{
	label: string;
	onClick: (path: string) => void;
}> {
	if (parsedMembership.isAdvanced) return [];

	return entry.isManual
		? [{ label: t("common.remove"), onClick: removeManualPath }]
		: [
				{
					label:
						privacyMode === "private-by-default"
							? t("modals.privacy_list.keep_private")
							: t("modals.privacy_list.keep_public"),
					onClick: excludePath,
				},
			];
}

/**
 * Complement-side rows. The managed tab's actions push a file *out* of the
 * managed set; these pull one *in*, so the labels are that tab's mirror image:
 * in private-by-default the complement is the private half ("Make accessible"),
 * in public-by-default it is the exposed half ("Make private"). A file that is
 * here only because it was explicitly kept out gets the matching "Restore …"
 * label, so the button reads as undoing the earlier choice rather than as a new
 * unrelated one.
 */
function getComplementFileActions(entry: { isExcluded?: boolean }): Array<{
	label: string;
	onClick: (path: string) => void;
}> {
	if (parsedMembership.isAdvanced) return [];

	if (entry.isExcluded) {
		return [
			{
				label:
					privacyMode === "private-by-default"
						? t("modals.privacy_list.restore_access")
						: t("modals.privacy_list.restore_private"),
				onClick: restoreExcludedPath,
			},
		];
	}

	return [
		{
			label:
				privacyMode === "private-by-default"
					? t("modals.privacy_list.make_accessible")
					: t("modals.privacy_list.make_private"),
			onClick: addPathToManaged,
		},
	];
}

function getExcludedFileActions(): Array<{ label: string; onClick: (path: string) => void }> {
	if (parsedMembership.isAdvanced) return [];

	return [
		{
			label:
				privacyMode === "private-by-default"
					? t("modals.privacy_list.restore_access")
					: t("modals.privacy_list.restore_private"),
			onClick: restoreExcludedPath,
		},
	];
}

const introBody = $derived.by(() =>
	privacyMode === "private-by-default"
		? t("modals.privacy_list.intro_private_by_default")
		: t("modals.privacy_list.intro_public_by_default"),
);
// A private file is withheld *entirely* from an untrusted provider — path included.
// Every vault-facing read tool filters on `shouldBlockFile` before the path reaches a
// result: `list_directory` reports only a count, `search_notes` drops the hit,
// `grep_notes` never opens the file, `read_content`/`get_properties` refuse, and
// `get_all_tags` omits tags that occur only in private notes (a tag name is itself
// content). Indexing skips them (`VectorStoreService`) and the graph withholds their
// titles from topic labelling.
//
// Three routes still expose a private path, so the note narrows to those rather than
// making the old blanket "names are always visible" claim:
//   1. Workspace context blocks — `[Currently visible notes]`, `[Selected text from
//      <path>]`, `[Graph-selected notes]` are appended to the outgoing message in
//      `chatStore.augmentWithVisibleNotes` with no privacy check. This is the one worth
//      warning about: it is silent, and the selection block carries the selected *text*,
//      not just the path.
//   2. Verbatim content of a *non-private* file — a public note (or `.chat` transcript,
//      which is gated by its own path, not by what it quotes) that contains
//      `[[Private Note]]` passes that name through as ordinary body text.
//   3. `exec_<plugin>` integrations, which bypass the filter wholesale — already covered
//      by `IntegrationPrivacyWarningModal` at enable time, so it is not repeated here.
// Attachments also bypass the filter, but attaching is an explicit user act on a named
// file, so it is not a surprise the way (1) is.
const pathVisibilityNote = t("modals.privacy_list.path_visibility_note");
const managedTitle = $derived.by(() =>
	privacyMode === "private-by-default"
		? t("modals.privacy_list.exposed_files")
		: t("modals.privacy_list.private_files"),
);
/** The other half of the vault, named for what it means rather than "not managed". */
const complementTitle = $derived.by(() =>
	privacyMode === "private-by-default"
		? t("modals.privacy_list.private_files")
		: t("modals.privacy_list.exposed_files"),
);
const managedEmptyText = $derived.by(() =>
	privacyMode === "private-by-default"
		? t("modals.privacy_list.empty_exposed")
		: t("modals.privacy_list.empty_private"),
);
const includedEmptyText = $derived(
	showingManaged
		? managedEmptyText
		: privacyMode === "private-by-default"
			? t("modals.privacy_list.empty_all_exposed")
			: t("modals.privacy_list.empty_none_exposed"),
);
const pickerModalTitle = $derived.by(() =>
	privacyMode === "private-by-default"
		? t("modals.privacy_list.picker_title_expose")
		: t("modals.privacy_list.picker_title_private"),
);
const pickerText = $derived.by(() =>
	privacyMode === "private-by-default"
		? {
				searchPlaceholder: t("modals.privacy_list.picker_search_placeholder"),
				searchAriaLabel: t("modals.privacy_list.picker_search_aria_expose"),
				defaultHeading: t("modals.privacy_list.picker_heading"),
				defaultDescription: t("modals.privacy_list.picker_desc_expose"),
				emptySearchText: t("modals.privacy_list.picker_empty"),
				confirmVerb: t("modals.privacy_list.picker_verb_expose"),
				alreadySelectedBadgeLabel: t("modals.privacy_list.picker_already_exposed"),
			}
		: {
				searchPlaceholder: t("modals.privacy_list.picker_search_placeholder"),
				searchAriaLabel: t("modals.privacy_list.picker_search_aria_private"),
				defaultHeading: t("modals.privacy_list.picker_heading"),
				defaultDescription: t("modals.privacy_list.picker_desc_private"),
				emptySearchText: t("modals.privacy_list.picker_empty"),
				confirmVerb: t("modals.privacy_list.picker_verb_add"),
				alreadySelectedBadgeLabel: t("modals.privacy_list.picker_already_private"),
			},
);
const excludedTitle = $derived.by(() =>
	privacyMode === "private-by-default" ? t("modals.privacy_list.kept_private") : t("modals.privacy_list.kept_public"),
);
</script>

<div class="privacy-modal-shell">
  <div class="privacy-modal-content">
    <!-- One row: neutral heading + info disclosure on the left, the mode toggle
         on the right. The toggle's active segment already states the mode, and
         the tabs below already carry both counts, so this panel repeats
         neither — an earlier revision titled itself with the selected mode and
         summarised the counts, saying everything twice within one screenful. -->
    <div class="privacy-mode-panel">
      <div class="privacy-mode-copy">
        <div class="privacy-mode-headline">
          <div class="privacy-mode-title">{t("modals.privacy_list.mode_title")}</div>
          <button
            type="button"
            class="clickable-icon privacy-mode-info-toggle"
            aria-label={showModeDetails ? t("modals.privacy_list.hide_details") : t("modals.privacy_list.what_does_this_mean")}
            aria-expanded={showModeDetails}
            onclick={() => (showModeDetails = !showModeDetails)}
          >
            <span use:iconDirective={"info"}></span>
          </button>
        </div>
        {#if showModeDetails}
          <p>{introBody}</p>
          <p class="privacy-mode-note">{pathVisibilityNote}</p>
        {/if}
      </div>

      <div class="privacy-mode-toggle" role="tablist" aria-label={t("modals.privacy_list.mode_label")}>
        <button
          type="button"
          class="privacy-mode-button"
          class:privacy-mode-button--active={privacyMode === "private-by-default"}
          aria-pressed={privacyMode === "private-by-default"}
          onclick={() => updatePrivacyMode("private-by-default")}
        >
          {t("modals.privacy_list.private_by_default")}
        </button>
        <button
          type="button"
          class="privacy-mode-button"
          class:privacy-mode-button--active={privacyMode === "public-by-default"}
          aria-pressed={privacyMode === "public-by-default"}
          onclick={() => updatePrivacyMode("public-by-default")}
        >
          {t("modals.privacy_list.public_by_default")}
        </button>
      </div>
    </div>

    <!-- Which half of the vault the list below shows. Editing always applies to
         the managed side, so the add/filter controls only appear there. These
         tabs are the list's heading: the panel below deliberately renders no
         title of its own, since it would just repeat the selected tab verbatim.

         Tabs and panel are wrapped together so the content column's `gap` falls
         around the pair rather than between them — they have to touch for the
         active tab to merge into the panel. -->
    <div class="privacy-list-section">
      <div class="privacy-list-switch" role="tablist" aria-label={t("modals.privacy_list.file_list_label")}>
        <button
          type="button"
          role="tab"
          id="privacy-list-tab-managed"
          aria-controls="privacy-list-panel"
          class="privacy-list-switch-button"
          class:privacy-list-switch-button--active={showingManaged}
          aria-selected={showingManaged}
          onclick={() => (listSide = "managed")}
        >
          {managedTitle}
          <span class="privacy-list-switch-count">{includedEntries.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          id="privacy-list-tab-complement"
          aria-controls="privacy-list-panel"
          class="privacy-list-switch-button"
          class:privacy-list-switch-button--active={!showingManaged}
          aria-selected={!showingManaged}
          onclick={() => (listSide = "complement")}
        >
          {complementTitle}
          <span class="privacy-list-switch-count">{complementEntries.length}</span>
        </button>
      </div>

      <div
        class="privacy-list-panel"
        role="tabpanel"
        id="privacy-list-panel"
        aria-labelledby={showingManaged ? "privacy-list-tab-managed" : "privacy-list-tab-complement"}
      >
        <FileSetEditor
          {app}
          {sourcePath}
          hoverSource="smart-second-brain-privacy-editor"
          sectionTitle={null}
          includedEntries={activeEntries}
          {includedEmptyText}
          searchPlaceholder={t("modals.privacy_list.filter_files")}
          maxVisibleEntries={showingManaged ? undefined : COMPLEMENT_ROW_LIMIT}
          addButtonText={t("modals.privacy_list.add_files")}
          {pickerModalTitle}
          {pickerText}
          pickerExistingPaths={!parsedMembership.isAdvanced ? parsedMembership.draft.manualPaths : []}
          pickerIncludedPaths={includedFiles}
          onAddPaths={showingManaged && !parsedMembership.isAdvanced ? handleAddPaths : undefined}
          showFilterToggle={showingManaged}
          filtersButtonText={t("modals.privacy_list.filters")}
          filterToggleAriaLabel={t("modals.privacy_list.toggle_filters")}
          isFilterActive={hasFilters}
          filterCount={parsedMembership.isAdvanced ? 1 : parsedMembership.draft.autoIncludeRules.length}
          onToggleFilters={() => (showFilters = !showFilters)}
          showFilterPanel={showingManaged && showFilters}
          filterPanelLabel={t("modals.privacy_list.filters")}
          filterBuilderFilter={parsedMembership.isAdvanced
      		? ensureGroup(cloneViewFilter(privacyFilter))
      		: buildPrivacyMembershipRulesEditorFilter(parsedMembership.draft.autoIncludeRules)}
          {availableFolders}
          {availableTags}
          {availableProperties}
          onFilterChange={handleRulesFilterChange}
          revealActionsOnHover
          excludedEntries={showingManaged ? excludedEntries : []}
          {excludedTitle}
          resolveIncludedActions={showingManaged ? getIncludedFileActions : getComplementFileActions}
          resolveExcludedActions={getExcludedFileActions}
        />
      </div>
    </div>
  </div>

  <div class="modal-button-container">
    <Button buttonText={t("common.save")} cta onClick={saveChanges} />
  </div>
</div>

<style>
  .privacy-modal-shell {
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: 100%;
    min-height: 0;
  }

  .privacy-modal-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1;
    min-height: 0;
  }

  .privacy-mode-panel {
    /* Single source of truth for the toggle pill's height, so the heading's
       line box can match it without the two drifting apart when either is
       restyled. Derived from the pill's own box: button line box (0.85rem text
       at ~1.2 + 8px padding top and bottom) + 4px pill padding + 1px border,
       doubled for both edges. */
    --s2b-privacy-toggle-height: calc(0.85rem * 1.2 + 16px + 8px + 2px);
    display: flex;
    flex-wrap: wrap;
    /* Top-aligned: the copy column grows tall when the info details expand, and
       centring floated the toggle into the middle of that block. The single-line
       case is handled instead by matching the heading's line box to the toggle's
       height below, so the two still align when collapsed. */
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 10px;
    background: var(--background-secondary);
  }

  .privacy-mode-copy {
    display: flex;
    flex: 1 1 320px;
    flex-direction: column;
    gap: 6px;
  }

  .privacy-mode-copy p {
    margin: 0;
  }

  /* Matches the toggle pill's height (its buttons' line box + 4px padding and
     1px border, top and bottom) so the heading sits on the toggle's centreline
     while both stay top-anchored — the alignment survives the details expanding
     underneath, which centring the whole panel row did not. */
  .privacy-mode-headline {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: var(--s2b-privacy-toggle-height);
  }

  /* `.clickable-icon` already supplies the transparent-at-rest → hover-highlight
     treatment and native rounding; only the glyph size is set here. */
  .privacy-mode-info-toggle :global(svg) {
    width: 14px;
    height: 14px;
  }

  /*
   * The tabs are the list's heading, so they sit flush on top of the panel and
   * the active one merges into it — the shared surface is what tells you which
   * set is shown, replacing the duplicate title that used to sit inside the
   * panel restating the selected tab.
   */
  /*
   * Owns the flex sizing the panel used to take directly from the content
   * column, and imposes no gap of its own, so the strip and the panel touch.
   */
  .privacy-list-section {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .privacy-list-switch {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    /* Overlaps the panel's top border so the active tab shares that single
       1px line instead of stacking a second one against it. */
    margin-bottom: -1px;
  }

  .privacy-list-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  /* Square the corner the tab strip lands on; the rest keeps its rounding. */
  .privacy-list-panel :global(.file-set-editor-panel) {
    border-top-left-radius: 0;
    background: var(--background-primary);
  }

  .privacy-list-switch-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border: 1px solid var(--background-modifier-border);
    /* Bottom corners stay square so the active tab can sit flush on the panel. */
    border-radius: var(--radius-s) var(--radius-s) 0 0;
    background: var(--background-secondary);
    color: var(--text-muted);
    font-size: var(--font-ui-small);
    cursor: pointer;
    position: relative;
  }

  .privacy-list-switch-button:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  /*
   * The active tab shares the panel's background and drops the border between
   * them, so the two read as one surface. It keeps a bottom border matching that
   * fill (rather than `border-bottom: 0`) so its height stays identical to the
   * inactive tab and the strip does not jog when the selection changes.
   */
  .privacy-list-switch-button--active {
    border-color: var(--background-modifier-border);
    border-bottom-color: var(--background-primary);
    background: var(--background-primary);
    color: var(--text-normal);
    font-weight: 500;
    /* Paints over the panel's top border, which the -1px overlap otherwise
       draws straight through the tab's open bottom edge. */
    z-index: 1;
  }

  .privacy-list-switch-button--active:hover {
    background: var(--background-primary);
    color: var(--text-normal);
  }

  .privacy-list-switch-count {
    padding: 0 5px;
    border-radius: var(--radius-s);
    background: var(--background-primary);
    color: var(--text-muted);
    font-size: var(--font-smallest);
  }

  .privacy-mode-note {
    color: var(--text-muted);
    font-size: var(--font-smaller);
  }

  .privacy-mode-title {
    font-weight: 600;
  }

  .privacy-mode-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px;
    border-radius: 999px;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
  }

  .privacy-mode-button {
    border: 0;
    border-radius: 999px;
    padding: 8px 12px;
    background: transparent;
    color: var(--text-normal);
    font-size: 0.85rem;
    font-weight: 500;
  }

  .privacy-mode-button:hover {
    background: var(--background-modifier-hover);
  }

  .privacy-mode-button--active {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  /*
   * Phone layout. The tab strip's `flex-wrap` is a desktop affordance; on a
   * ~390px screen the two tabs cannot share a row at natural width, so they
   * wrapped into stacked bars and the active tab no longer touched the panel it
   * is supposed to merge into. Split the row 50/50 instead and let the long
   * label wrap *inside* its tab — the strip stays one row, both tabs stretch to
   * the taller one's height, and the merge survives.
   */
  :global(.is-phone) .privacy-list-switch {
    flex-wrap: nowrap;
    align-items: stretch;
  }

  :global(.is-phone) .privacy-list-switch-button {
    flex: 1 1 0;
    min-width: 0;
    justify-content: center;
    text-align: center;
    /* Obsidian's button styling is nowrap, which turns the squeezed label into
       clipped text; multi-line is the whole point of the 50/50 split. */
    white-space: normal;
    height: auto;
    /* Themes can inflate button padding well past core's (Cupertino uses 20px
       inline), which on a half-width tab eats most of the room the label has to
       wrap in and pushes it to three lines. Reclaim it: the tabs are a compact
       strip, not standalone buttons. */
    padding: 6px 8px;
    font-size: var(--font-ui-smaller);
    line-height: 1.25;
  }

  /* The mode pill overflows narrower phones at natural width; as a full-width
     segmented control it fits any screen and reads more native on touch. */
  :global(.is-phone) .privacy-mode-toggle {
    display: flex;
    width: 100%;
  }

  :global(.is-phone) .privacy-mode-button {
    flex: 1 1 0;
    min-width: 0;
  }
</style>
