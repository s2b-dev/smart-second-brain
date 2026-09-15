<script lang="ts">
/**
 * Recursive filter tree editor.
 *
 * Each node is either:
 *   - a **leaf**: type dropdown (folder/tag/extension) + value input
 *   - a **group**: ALL/ANY/NONE toggle + child list + add/remove buttons
 *
 * The component mutates a `ViewFilter` object in-place via `onchange`.
 *
 * Lives under settings, not graph: its only consumer is the privacy list, via
 * `FileSetEditor`. It sat in `components/graph/` because filters were once part
 * of the graph's saved views, which no longer exist.
 */
import { formatPropertyValues, parsePropertyValues } from "../../lib/propertyValues";
import type { ViewFilter, ViewFilterLeaf, ViewFilterGroup } from "../../types/viewFilter";
import Dropdown from "../ui/Dropdown.svelte";
import Text from "../ui/Text.svelte";
import Icon from "../ui/Icon.svelte";
import PickerOptionRow from "../ui/PickerOptionRow.svelte";
import ViewFilterBuilder from "./ViewFilterBuilder.svelte";

interface Props {
	filter: ViewFilter;
	onchange: (filter: ViewFilter) => void;
	/** Depth for indentation (0 = root) */
	depth?: number;
	/** Show a remove button for this node */
	onremove?: () => void;
	/** Live selection leaf (root only) — reflects current graph selection */
	liveLeaf?: ViewFilterLeaf | null;
	/** Called when user edits or clears (null) the live leaf */
	onLiveLeafChange?: (leaf: ViewFilterLeaf | null) => void;
	/** Available folder paths for autocomplete */
	availableFolders?: string[];
	/** Available tags for autocomplete */
	availableTags?: string[];
	/** Available frontmatter property keys for autocomplete */
	availableProperties?: string[];
}

let {
	filter,
	onchange,
	depth = 0,
	onremove,
	liveLeaf,
	onLiveLeafChange,
	availableFolders = [],
	availableTags = [],
	availableProperties = [],
}: Props = $props();

// ── Leaf vs group detection ─────────────────────────────
const leafTypes = ["folder", "tag", "extension", "property"] as const;
type LeafType = (typeof leafTypes)[number];

let isGroup = $derived(filter.type === "all" || filter.type === "any" || filter.type === "none");

// ── Leaf options ────────────────────────────────────────
const baseLeafTypeOptions = [
	{ display: "Folder", value: "folder" as LeafType },
	{ display: "Tag", value: "tag" as LeafType },
	{ display: "Extension", value: "extension" as LeafType },
	{ display: "Property", value: "property" as LeafType },
];

function getLeafTypeOptions(selectedType?: LeafType) {
	return baseLeafTypeOptions;
}

// ── Group combinator options ────────────────────────────
const combinatorOptions = [
	{ display: "ALL of", value: "all" as const },
	{ display: "ANY of", value: "any" as const },
	{ display: "NONE of", value: "none" as const },
];

// ── Combobox state ──────────────────────────────────────
let comboOpen = $state(false);
let comboQuery = $state("");
// Track which field is open: "leaf" | "live" | null
let comboTarget: "leaf" | "live" | null = $state(null);
let closeTimeout: number | null = null;

function getSuggestionPool(type: LeafType): string[] {
	if (type === "folder") return availableFolders;
	if (type === "tag") return availableTags;
	if (type === "property") return availableProperties;
	return [];
}

function getSuggestions(type: LeafType, query: string): string[] {
	const pool = getSuggestionPool(type);
	if (pool.length === 0) return [];
	const q = query.toLowerCase();
	return pool.filter((v) => v.toLowerCase().includes(q)).slice(0, 10);
}

/**
 * A vault with no frontmatter anywhere yields no property suggestions. Without a
 * hint the field just sits silent on focus, which reads as a broken control rather
 * than an empty pool — the value is still free text, so typing a key works fine.
 * Only shown for `property`: every vault has folders and tags, so those pools are
 * never legitimately empty.
 */
function showsEmptyPoolHint(type: LeafType): boolean {
	return type === "property" && getSuggestionPool(type).length === 0;
}

function openCombo(target: "leaf" | "live", currentValue: string) {
	if (closeTimeout) {
		window.clearTimeout(closeTimeout);
		closeTimeout = null;
	}
	comboTarget = target;
	comboQuery = currentValue;
	comboOpen = true;
}

function closeCombo() {
	comboOpen = false;
	comboTarget = null;
}

function handleComboBlur() {
	// Delay so a suggestion click fires before we close
	closeTimeout = window.setTimeout(closeCombo, 150);
}

function handleComboFocus(target: "leaf" | "live", currentValue: string) {
	openCombo(target, currentValue);
}

function pickSuggestion(value: string, target: "leaf" | "live") {
	if (closeTimeout) {
		window.clearTimeout(closeTimeout);
		closeTimeout = null;
	}
	if (target === "leaf") {
		handleLeafValueChange(value);
	} else {
		const lt = liveLeaf as ViewFilterLeaf;
		onLiveLeafChange?.({ ...lt, value } as ViewFilterLeaf);
	}
	closeCombo();
}

// ── Leaf handlers ───────────────────────────────────────
function handleLeafTypeChange(newType: LeafType) {
	onchange({ type: newType, value: "" });
	closeCombo();
}

function handleLeafValueChange(newValue: string) {
	const leaf = filter as ViewFilterLeaf;
	onchange({ ...leaf, value: newValue } as ViewFilterLeaf);
}

// ── Group handlers ──────────────────────────────────────
function handleCombinatorChange(newType: "all" | "any" | "none") {
	const group = filter as ViewFilterGroup;
	onchange({ type: newType, conditions: group.conditions });
}

function handleChildChange(index: number, child: ViewFilter) {
	const group = filter as ViewFilterGroup;
	const next = [...group.conditions];
	next[index] = child;
	onchange({ ...group, conditions: next });
}

function handleRemoveChild(index: number) {
	const group = filter as ViewFilterGroup;
	const next = group.conditions.filter((_, i) => i !== index);
	onchange({ ...group, conditions: next });
}

function handleAddLeaf() {
	const group = filter as ViewFilterGroup;
	const extra = liveLeaf ? [liveLeaf] : [];
	onchange({
		...group,
		conditions: [...group.conditions, ...extra, { type: "folder", value: "" }],
	});
	if (liveLeaf) onLiveLeafChange?.(null);
}

function handleAddGroup() {
	const group = filter as ViewFilterGroup;
	const extra = liveLeaf ? [liveLeaf] : [];
	onchange({
		...group,
		conditions: [...group.conditions, ...extra, { type: "all", conditions: [] }],
	});
	if (liveLeaf) onLiveLeafChange?.(null);
}

// Whether a leaf type supports combobox suggestions
function hasCombo(type: string): boolean {
	return type === "folder" || type === "tag" || type === "property";
}

/**
 * Build a property leaf from a key and the comma-separated values input.
 * An empty input clears `values` entirely (back to an existence check) rather
 * than storing an empty array, so the two states stay distinguishable in saved data.
 */
function buildPropertyLeaf(key: string, rawValues: string): ViewFilterLeaf {
	const parsed = parsePropertyValues(rawValues);
	return { type: "property", value: key, values: parsed.length > 0 ? parsed : undefined };
}

function handlePropertyValuesChange(raw: string) {
	const leaf = filter as ViewFilterLeaf;
	onchange(buildPropertyLeaf(leaf.value as string, raw));
}
</script>

<div class="filter-node" class:filter-node--nested={depth > 0}>
  {#if isGroup}
    <!-- ── Group node ────────────────────────── -->
    <div class="filter-group-header">
      <Dropdown
        type="options"
        dropdown={combinatorOptions}
        selected={(filter as ViewFilterGroup).type}
        onchange={handleCombinatorChange}
        class="filter-combinator-dropdown"
      />
      {#if onremove}
        <button type="button" class="filter-remove" onclick={onremove} title="Remove condition">
          <Icon name="x" size="xs" />
        </button>
      {/if}
    </div>

    <div class="filter-group-children">
      {#each (filter as ViewFilterGroup).conditions as child, i (i)}
        <ViewFilterBuilder
          filter={child}
          onchange={(c: ViewFilter) => handleChildChange(i, c)}
          onremove={() => handleRemoveChild(i)}
          depth={depth + 1}
          {availableFolders}
          {availableTags}
          {availableProperties}
        />
      {/each}

      <!-- Live selection row (root only) -->
      {#if depth === 0 && liveLeaf !== undefined}
        {#if liveLeaf}
          {@const liveType = liveLeaf.type as LeafType}
          <div class="filter-node filter-node--nested">
            <div class="filter-leaf-row">
              <Dropdown
                type="options"
                dropdown={getLeafTypeOptions(liveType)}
                selected={liveType}
                onchange={(t) => onLiveLeafChange?.({ type: t, value: "" } as ViewFilterLeaf)}
                class="filter-leaf-type"
              />
              {#if hasCombo(liveLeaf.type)}
                <!-- Combobox for folder/tag live leaf -->
                <div class="filter-combo-wrap">
                  <input
                    class="filter-combo-input"
                    type="text"
                    value={liveLeaf.value as string}
                    placeholder={liveType === "folder"
                      ? "Work/projects"
                      : liveType === "property"
                        ? "property name"
                        : "#my-tag"}
                    oninput={(e) => {
                      const v = (e.target as HTMLInputElement).value;
                      onLiveLeafChange?.({ ...liveLeaf!, value: v } as ViewFilterLeaf);
                      comboQuery = v;
                    }}
                    onfocus={() => handleComboFocus("live", liveLeaf!.value as string)}
                    onblur={handleComboBlur}
                  />
                  {#if comboOpen && comboTarget === "live" && getSuggestions(liveType, comboQuery).length > 0}
                    <div class="filter-combo-list picker-popover-content">
                      <div class="picker-popover-menu">
                        {#each getSuggestions(liveType, comboQuery) as suggestion (suggestion)}
                          <PickerOptionRow onClick={() => pickSuggestion(suggestion, "live")}>
                            {#snippet content()}
                              {suggestion}
                            {/snippet}
                          </PickerOptionRow>
                        {/each}
                      </div>
                    </div>
                  {:else if comboOpen && comboTarget === "live" && showsEmptyPoolHint(liveType)}
                    <div class="filter-combo-list picker-popover-content">
                      <div class="filter-combo-empty">
                        No properties found in vault — type a name to use it anyway.
                      </div>
                    </div>
                  {/if}
                </div>
                {#if liveType === "property"}
                  <Text
                    inputType="text"
                    value={formatPropertyValues((liveLeaf as ViewFilterLeaf & { values?: string[] }).values)}
                    placeholder="any value"
                    onchange={(v: string) =>
                      onLiveLeafChange?.(buildPropertyLeaf(liveLeaf!.value as string, v))}
                    class="filter-leaf-value"
                  />
                {/if}
              {:else}
                <Text
                  inputType="text"
                  value={liveLeaf.value as string}
                  placeholder="md"
                  onchange={(v: string) =>
                    onLiveLeafChange?.({ ...liveLeaf!, value: v } as ViewFilterLeaf)}
                  class="filter-leaf-value"
                />
              {/if}
              <span class="live-leaf-slot"><span class="live-leaf-dot"></span></span>
            </div>
          </div>
        {:else if (filter as ViewFilterGroup).conditions.length === 0}
          <div class="live-leaf-placeholder">Make a selection in the graph</div>
        {/if}
      {/if}

      <div class="filter-add-row">
        <button type="button" class="filter-add-button" onclick={handleAddLeaf}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"
            ></line></svg
          >
          Condition
        </button>
        <button type="button" class="filter-add-button" onclick={handleAddGroup}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"
            ></line></svg
          >
          Group
        </button>
      </div>
    </div>
  {:else}
    <!-- ── Leaf node ─────────────────────────── -->
    {@const leafType = (filter as ViewFilterLeaf).type as LeafType}
    <div class="filter-leaf-row">
      <Dropdown
        type="options"
        dropdown={getLeafTypeOptions(leafType)}
        selected={leafType}
        onchange={handleLeafTypeChange}
        class="filter-leaf-type"
      />
      {#if hasCombo(leafType)}
        <!-- Combobox for folder/tag leaf -->
        <div class="filter-combo-wrap">
          <input
            class="filter-combo-input"
            type="text"
            value={(filter as ViewFilterLeaf).value as string}
            placeholder={leafType === "folder"
              ? "Work/projects"
              : leafType === "property"
                ? "property name"
                : "#my-tag"}
            oninput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              handleLeafValueChange(v);
              comboQuery = v;
            }}
            onfocus={() => handleComboFocus("leaf", (filter as ViewFilterLeaf).value as string)}
            onblur={handleComboBlur}
          />
          {#if comboOpen && comboTarget === "leaf" && getSuggestions(leafType, comboQuery).length > 0}
            <div class="filter-combo-list picker-popover-content">
              <div class="picker-popover-menu">
                {#each getSuggestions(leafType, comboQuery) as suggestion (suggestion)}
                  <PickerOptionRow onClick={() => pickSuggestion(suggestion, "leaf")}>
                    {#snippet content()}
                      {suggestion}
                    {/snippet}
                  </PickerOptionRow>
                {/each}
              </div>
            </div>
          {:else if comboOpen && comboTarget === "leaf" && showsEmptyPoolHint(leafType)}
            <div class="filter-combo-list picker-popover-content">
              <div class="filter-combo-empty">No properties found in vault — type a name to use it anyway.</div>
            </div>
          {/if}
        </div>
        {#if leafType === "property"}
          <Text
            inputType="text"
            value={formatPropertyValues((filter as ViewFilterLeaf & { values?: string[] }).values)}
            placeholder="any value"
            onchange={handlePropertyValuesChange}
            class="filter-leaf-value"
          />
        {/if}
      {:else}
        <Text
          inputType="text"
          value={(filter as ViewFilterLeaf).value as string}
          placeholder="md"
          onchange={handleLeafValueChange}
          class="filter-leaf-value"
        />
      {/if}
      {#if onremove}
        <button type="button" class="filter-remove" onclick={onremove} title="Remove condition">
          <Icon name="x" size="xs" />
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .filter-node {
    position: relative;
  }

  .filter-node--nested {
    margin-left: 12px;
    padding-left: 8px;
    border-left: 2px solid var(--background-modifier-border);
  }

  .filter-group-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
  }

  .filter-group-header :global(.filter-combinator-dropdown) {
    font-size: 11px;
    font-weight: 600;
    max-width: 100px;
  }

  .filter-group-children {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .filter-leaf-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
  }

  .filter-leaf-row :global(.filter-leaf-type) {
    font-size: 11px;
    max-width: 90px;
    flex-shrink: 0;
  }

  .filter-leaf-row :global(.filter-leaf-value) {
    flex: 1;
    min-width: 0;
    font-size: 12px;
  }

  /* ── Combobox ───────────────────────────────────── */

  .filter-combo-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
  }

  .filter-combo-input {
    width: 100%;
    font-size: 12px;
    padding: 2px 6px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--input-radius, 4px);
    background: var(--background-modifier-form-field);
    color: var(--text-normal);
    outline: none;
    box-sizing: border-box;
  }

  .filter-combo-input:focus {
    border-color: var(--interactive-accent);
    box-shadow: 0 0 0 1px var(--interactive-accent);
  }

  .filter-combo-list.filter-combo-list {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    z-index: 100;
    max-height: 180px;
    overflow: hidden auto;
  }

  .filter-combo-empty {
    padding: 8px 10px;
    color: var(--text-muted);
    font-size: var(--font-smaller);
  }

  /* ── Add row ────────────────────────────────────── */

  .filter-add-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
  }

  .filter-add-button {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border: 1px dashed var(--background-modifier-border);
    border-radius: 4px;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 11px;
  }

  .filter-add-button:hover {
    border-color: var(--interactive-accent);
    color: var(--text-accent);
    background: var(--background-secondary);
  }

  .filter-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    padding: 0;
    flex-shrink: 0;
    border: none;
    border-radius: 3px;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    opacity: 0.35;
    transition:
      opacity 0.1s ease,
      color 0.1s ease,
      background-color 0.1s ease;
  }

  .filter-remove :global(.icon) {
    width: 12px !important;
    height: 12px !important;
  }

  .filter-remove:hover {
    opacity: 1;
    color: var(--text-error);
    background: var(--background-modifier-hover);
  }

  /* Live selection row */
  .live-leaf-slot {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  .live-leaf-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    min-width: 7px;
    border-radius: 50%;
    background: var(--interactive-accent);
    flex-shrink: 0;
    animation: live-pulse 1.5s ease-in-out infinite;
  }

  @keyframes live-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }

  .live-leaf-placeholder {
    padding: 3px 2px;
    font-size: 12px;
    color: var(--text-faint);
    font-style: italic;
  }
</style>
