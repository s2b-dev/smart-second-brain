<script lang="ts">
/**
 * DISABLED FOR INITIAL RELEASE — not registered, not reachable.
 *
 * The per-note context graph. Its view wrapper (`views/note-context/`) and every
 * hook in `main.ts` (registerView, the `open-note-context` command,
 * `activateNoteContextView`) are commented out, so nothing mounts this today.
 *
 * Kept rather than deleted because it is a complete feature awaiting a later
 * release, and it is the only other consumer of `GraphCanvas` — worth knowing
 * before changing that component's props.
 *
 * To re-enable: uncomment the four blocks in `main.ts` marked
 * "DISABLED FOR INITIAL RELEASE — Note Context".
 */
import { onDestroy, onMount } from "svelte";
import type { EventRef } from "obsidian";
import { getPlugin } from "../../stores/state.svelte";
import { getData } from "../../stores/dataStore.svelte";
import type { GraphData } from "../../types/graph";
import { getVectorStoreService, waitForVectorStore, waitForVectorStoreIndex } from "../../vectorstore";
import Button from "../ui/Button.svelte";
import LoadingAnimation from "../ui/LoadingAnimation.svelte";
import Icon from "../ui/Icon.svelte";
import PickerPopover from "../ui/PickerPopover.svelte";
import Toggle from "../ui/Toggle.svelte";
import GraphCanvas from "./GraphCanvas.svelte";
import {
	DEFAULT_NOTE_CONTEXT_SEMANTIC_THRESHOLD,
	buildNoteContextSemanticGraph,
	buildNoteContextWikiGraph,
	mergeNoteContextGraph,
} from "../../views/note-context/noteContextDataBuilder";
import { VIEW_TYPE_NOTE_CONTEXT } from "../../views/note-context/NoteContextView";

const plugin = getPlugin();
const data = getData();

type NoteContextViewMode = "graph" | "list";
type NoteContextRelationshipMode = "linked" | "semantic" | "both";
type NoteContextDirection = "incoming" | "outgoing" | "both" | "semantic" | "none";

type NoteContextNeighborRow = {
	path: string;
	label: string;
	hasWiki: boolean;
	hasSemantic: boolean;
	semanticScore: number | null;
	direction: NoteContextDirection;
	directionLabel: string | null;
};

let canvasComponent: GraphCanvas | undefined = $state(undefined);
let graphData: GraphData = $state({ nodes: [], edges: [] });
let activePath: string | null = $state(null);
let isLoadingSemantic = $state(false);
let viewMode: NoteContextViewMode = $state("graph");
let relationshipMode: NoteContextRelationshipMode = $state("both");
let showFitButton = $state(false);
let controlsOpen = $state(false);
let buildVersion = 0;
let workspaceRefs: EventRef[] = [];

const semanticHint = "Semantic neighbors appear once a graph embedding index is configured.";
function mergeDirection(
	current: NoteContextDirection | undefined,
	next: "incoming" | "outgoing",
): NoteContextDirection {
	if (!current || current === "none" || current === "semantic") return next;
	if (current === next) return current;
	return "both";
}

function getDirectionLabel(direction: NoteContextDirection): string | null {
	switch (direction) {
		case "incoming":
			return "In";
		case "outgoing":
			return "Out";
		case "both":
			return "Both";
		default:
			return null;
	}
}

const hasSemanticIndex = $derived(Boolean(data.graphEmbedIndex));

const visibleGraphData = $derived.by(() => {
	const edges = graphData.edges.filter((edge) => {
		if (relationshipMode === "linked") return edge.type === "wiki";
		if (relationshipMode === "semantic") return edge.type === "semantic";
		if (relationshipMode === "both") return edge.type === "wiki" || edge.type === "semantic";
		return true;
	});

	const visibleNodeIds = new Set<string>();
	if (activePath) {
		visibleNodeIds.add(activePath);
	}
	for (const edge of edges) {
		visibleNodeIds.add(edge.source);
		visibleNodeIds.add(edge.target);
	}

	const nodes = graphData.nodes.filter((node) => visibleNodeIds.has(node.id));
	return { nodes, edges };
});

const visibleNeighborRows = $derived.by((): NoteContextNeighborRow[] => {
	if (!activePath) return [];

	const relationshipMap = new Map<string, { hasWiki: boolean; semanticScore: number | null }>();
	const directionByPath = new Map<string, NoteContextDirection>();
	for (const edge of visibleGraphData.edges) {
		const neighborPath: string | null =
			edge.source === activePath ? edge.target : edge.target === activePath ? edge.source : null;
		if (!neighborPath || neighborPath === activePath) continue;

		const current = relationshipMap.get(neighborPath) ?? { hasWiki: false, semanticScore: null };
		if (edge.type === "wiki") {
			current.hasWiki = true;
			const nextDirection = edge.source === activePath ? "outgoing" : "incoming";
			directionByPath.set(neighborPath, mergeDirection(directionByPath.get(neighborPath), nextDirection));
		}
		if (edge.type === "semantic") {
			current.semanticScore = Math.max(current.semanticScore ?? Number.NEGATIVE_INFINITY, edge.weight);
		}
		relationshipMap.set(neighborPath, current);
	}

	return visibleGraphData.nodes
		.filter((node) => node.id !== activePath)
		.map((node) => {
			const relationship = relationshipMap.get(node.id) ?? {
				hasWiki: false,
				semanticScore: null,
			};
			const hasSemantic = relationship.semanticScore != null;
			const direction = directionByPath.get(node.id) ?? (hasSemantic ? "semantic" : "none");
			return {
				path: node.path,
				label: node.label,
				hasWiki: relationship.hasWiki,
				hasSemantic,
				semanticScore: relationship.semanticScore,
				direction,
				directionLabel: getDirectionLabel(direction),
			};
		})
		.sort((left, right) => {
			const bothDiff = Number(right.hasWiki && right.hasSemantic) - Number(left.hasWiki && left.hasSemantic);
			if (bothDiff !== 0) return bothDiff;

			const semanticDiff =
				(right.semanticScore ?? Number.NEGATIVE_INFINITY) - (left.semanticScore ?? Number.NEGATIVE_INFINITY);
			if (semanticDiff !== 0) return semanticDiff;

			if (left.hasWiki !== right.hasWiki) return Number(right.hasWiki) - Number(left.hasWiki);
			return left.label.localeCompare(right.label);
		});
});

$effect(() => {
	if (!hasSemanticIndex && (relationshipMode === "semantic" || relationshipMode === "both")) {
		relationshipMode = "linked";
	}
});

function syncActivePath(): string | null {
	const file = plugin.app.workspace.getActiveFile();
	activePath = file?.extension === "md" ? file.path : null;
	return activePath;
}

async function rebuildGraph(): Promise<void> {
	const localBuildVersion = ++buildVersion;
	const nextActivePath = syncActivePath();

	if (!nextActivePath) {
		graphData = { nodes: [], edges: [] };
		isLoadingSemantic = false;
		showFitButton = false;
		return;
	}

	const wikiGraph = buildNoteContextWikiGraph(plugin.app, nextActivePath);
	graphData = wikiGraph;
	showFitButton = false;

	if (!hasSemanticIndex) {
		isLoadingSemantic = false;
		return;
	}

	isLoadingSemantic = true;

	try {
		const serviceReady = await waitForVectorStore();
		if (!serviceReady || localBuildVersion !== buildVersion) return;

		const indexReady = await waitForVectorStoreIndex(data.graphEmbedIndex);
		if (!indexReady || localBuildVersion !== buildVersion) return;

		// The store scores every note against the active one in its own worker and
		// returns only the neighbours; no vector reaches this thread.
		const indexId = data.graphEmbedIndex;
		if (!indexId) return;
		const inst = await getVectorStoreService().getOrCreateInstance(indexId);
		if (localBuildVersion !== buildVersion) return;
		const neighbors = await inst.store.noteNeighbors(nextActivePath, DEFAULT_NOTE_CONTEXT_SEMANTIC_THRESHOLD);
		if (localBuildVersion !== buildVersion) return;

		const semanticGraph = buildNoteContextSemanticGraph(plugin.app, nextActivePath, neighbors);

		if (localBuildVersion !== buildVersion) return;
		graphData = mergeNoteContextGraph(wikiGraph, semanticGraph, nextActivePath);
	} catch (error) {
		console.error("[NoteContext] Failed to build semantic neighborhood", error);
	} finally {
		if (localBuildVersion === buildVersion) {
			isLoadingSemantic = false;
		}
	}
}

function handleNodeClick(path: string) {
	plugin.app.workspace.openLinkText(path, "", false);
}

function handleHoverPreview(event: MouseEvent, path: string, targetEl: HTMLElement) {
	const sourcePath = plugin.app.workspace.getActiveFile()?.path ?? activePath ?? "";
	plugin.app.workspace.trigger("hover-link", {
		event,
		source: VIEW_TYPE_NOTE_CONTEXT,
		hoverParent: plugin,
		targetEl,
		linktext: path,
		sourcePath,
	});
}

function handleListRowHover(event: MouseEvent, path: string) {
	handleHoverPreview(event, path, event.currentTarget as HTMLElement);
}

function handleListRowFocus(event: FocusEvent, path: string) {
	handleHoverPreview(new MouseEvent("mouseover"), path, event.currentTarget as HTMLElement);
}

function setViewMode(mode: NoteContextViewMode) {
	viewMode = mode;
	showFitButton = false;
	controlsOpen = false;
}

function setRelationshipMode(mode: NoteContextRelationshipMode) {
	if (!hasSemanticIndex && (mode === "semantic" || mode === "both")) {
		return;
	}

	relationshipMode = mode;
	showFitButton = false;
	controlsOpen = false;
}

function setDirectedWikiEdges(enabled: boolean) {
	data.smartGraphSettings = {
		...data.smartGraphSettings,
		directedWikiEdges: enabled,
	};
}

function registerWorkspaceListeners() {
	const workspace = plugin.app.workspace;
	workspaceRefs = [
		workspace.on("file-open", () => {
			void rebuildGraph();
		}),
		workspace.on("active-leaf-change", () => {
			void rebuildGraph();
		}),
	];
}

onMount(() => {
	registerWorkspaceListeners();
	void rebuildGraph();
});

onDestroy(() => {
	for (const ref of workspaceRefs) {
		plugin.app.workspace.offref(ref);
	}
	workspaceRefs = [];
	buildVersion++;
});
</script>

<!-- Graph shortcuts are bound at the view root rather than on the canvas, so they
     stay live when focus sits on a control elsewhere in this view. Matches
     SmartGraphView; keydown only fires for focus inside this subtree. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="note-context"
  data-testid="note-context-root"
  onkeydown={(e) => canvasComponent?.handleKeyDown(e)}
>
  <div class="s2b-note-context__surface">
    <div class="s2b-note-context__overlay">
      {#if isLoadingSemantic}
        <div class="s2b-note-context__status">
          <div class="s2b-note-context__loading" data-testid="note-context-loading">
            <LoadingAnimation />
            <span>Updating…</span>
          </div>
        </div>
      {/if}

      <div class="s2b-note-context__overlay-actions">
        {#if viewMode === "graph" && showFitButton}
          <Button
            iconId="scan-search"
            ariaLabel="Fit graph to view"
            tooltip="Fit graph to view"
            class="s2b-note-context__floating-button"
            dataTestId="note-context-fit"
            onClick={() => {
              canvasComponent?.fitToView();
              showFitButton = false;
            }}
            disabled={visibleGraphData.nodes.length === 0}
          />
        {/if}

        <PickerPopover
          bind:open={controlsOpen}
          triggerStyles="clickable-icon"
          triggerClass="s2b-note-context__floating-button s2b-note-context__floating-button--quiet"
          tooltip="Note Context options"
          dataTestId="note-context-controls"
          contentClass="s2b-note-context__menu"
          side="bottom"
          align="end"
          sideOffset={-24}
        >
          {#snippet trigger(open)}
            <Icon name={open ? "x" : "sliders-horizontal"} size="xs" />
          {/snippet}

          <div class="s2b-note-context__menu-section" data-testid="note-context-view-mode">
            <div class="s2b-note-context__menu-section-header">
              <span class="s2b-note-context__menu-label">View</span>
              <Button
                iconId="x"
                ariaLabel="Close Note Context options"
                tooltip="Close"
                class="s2b-note-context__menu-close"
                dataTestId="note-context-controls-close"
                onClick={() => {
                  controlsOpen = false;
                }}
              />
            </div>
            <div class="s2b-note-context__menu-buttons">
              <Button
                buttonText="Graph"
                cta={viewMode === "graph"}
                class="s2b-note-context__button"
                dataTestId="note-context-mode-graph"
                onClick={() => setViewMode("graph")}
              />
              <Button
                buttonText="List"
                cta={viewMode === "list"}
                class="s2b-note-context__button"
                dataTestId="note-context-mode-list"
                onClick={() => setViewMode("list")}
              />
            </div>
          </div>

          <div class="s2b-picker-popover-separator menu-separator"></div>

          <div class="s2b-note-context__menu-section" data-testid="note-context-relationship-mode">
            <span class="s2b-note-context__menu-label">Show</span>
            <div class="s2b-note-context__menu-buttons">
              <Button
                buttonText="Linked"
                cta={relationshipMode === "linked"}
                class="s2b-note-context__button"
                dataTestId="note-context-mode-linked"
                onClick={() => setRelationshipMode("linked")}
              />
              <Button
                buttonText="Semantic"
                cta={relationshipMode === "semantic"}
                class={`s2b-note-context__button ${!hasSemanticIndex ? "s2b-note-context__button--unavailable" : ""}`}
                dataTestId="note-context-mode-semantic"
                tooltip={!hasSemanticIndex ? semanticHint : undefined}
                onClick={() => setRelationshipMode("semantic")}
              />
              <Button
                buttonText="Both"
                cta={relationshipMode === "both"}
                class={`s2b-note-context__button ${!hasSemanticIndex ? "s2b-note-context__button--unavailable" : ""}`}
                dataTestId="note-context-mode-both"
                tooltip={!hasSemanticIndex ? semanticHint : undefined}
                onClick={() => setRelationshipMode("both")}
              />
            </div>
          </div>

          <div class="s2b-picker-popover-separator menu-separator"></div>

          <div class="s2b-note-context__menu-section" data-testid="note-context-display-settings">
            <span class="s2b-note-context__menu-label">Display</span>
            <div class="s2b-note-context__toggle-row">
              <span class="s2b-note-context__toggle-label">Direction arrows</span>
              <Toggle
                checked={data.smartGraphSettings.directedWikiEdges}
                onchange={setDirectedWikiEdges}
              />
            </div>
          </div>
        </PickerPopover>
      </div>
    </div>

    {#if visibleGraphData.nodes.length > 0}
      {#if viewMode === "graph"}
        <GraphCanvas
          bind:this={canvasComponent}
          class="s2b-note-context__graph"
          alwaysRefitOnDataChange={true}
          directedWikiEdges={data.smartGraphSettings.directedWikiEdges}
          graphData={visibleGraphData}
          onUserViewportChange={() => {
            showFitButton = true;
          }}
          linkDistance={data.smartGraphSettings.linkDistance}
          chargeStrength={data.smartGraphSettings.chargeStrength}
          centerStrength={data.smartGraphSettings.centerStrength}
          linkStrength={data.smartGraphSettings.linkStrength}
          clusterCohesionStrength={0}
          showWikiLinks={true}
          onNodeClick={handleNodeClick}
          onHoverPreview={handleHoverPreview}
        />
      {:else}
        <div class="s2b-note-context__list" data-testid="note-context-list">
          {#each visibleNeighborRows as row (row.path)}
            <button
              class="s2b-note-context__list-row"
              type="button"
              data-href={row.path}
              onclick={() => handleNodeClick(row.path)}
              onmouseover={(event) => handleListRowHover(event, row.path)}
              onfocus={(event) => handleListRowFocus(event, row.path)}
            >
              <div class="s2b-note-context__list-main">
                <span class="s2b-note-context__list-title">{row.label}</span>
              </div>

              <div class="s2b-note-context__list-meta">
                {#if row.directionLabel}
                  <span class={`s2b-note-context__badge s2b-note-context__badge--${row.direction}`}
                    >{row.directionLabel}</span
                  >
                {/if}
                {#if row.semanticScore != null}
                  <span class="s2b-note-context__score">{Math.round(row.semanticScore * 100)}%</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="s2b-note-context__empty" data-testid="note-context-empty">
        {#if activePath}
          No neighbors.
        {:else}
          Open a note.
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .note-context {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 0;
  }

  .s2b-note-context__surface {
    display: flex;
    flex: 1;
    min-height: 0;
    position: relative;
  }

  .s2b-note-context__overlay {
    position: absolute;
    top: 8px;
    left: 8px;
    right: 8px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    z-index: 5;
    pointer-events: none;
  }

  .s2b-note-context__overlay-actions {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    pointer-events: auto;
  }

  .s2b-note-context__status {
    pointer-events: auto;
  }

  :global(.s2b-note-context__button) {
    white-space: nowrap;
  }

  :global(.s2b-note-context__floating-button) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--background-primary) 88%, transparent);
    backdrop-filter: blur(10px);
    box-shadow: var(--shadow-xs);
  }

  :global(.s2b-note-context__floating-button--quiet) {
    background: transparent;
    backdrop-filter: none;
    box-shadow: none;
  }

  :global(.s2b-note-context__floating-button--quiet:hover),
  :global(.s2b-note-context__floating-button--quiet:focus-visible) {
    background: color-mix(in srgb, var(--background-primary) 88%, transparent);
    backdrop-filter: blur(10px);
    box-shadow: var(--shadow-xs);
  }

  :global(.s2b-note-context__button--unavailable) {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .s2b-note-context__loading {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border: 1px solid color-mix(in srgb, var(--background-modifier-border) 72%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--background-primary) 88%, transparent);
    backdrop-filter: blur(10px);
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  :global(.s2b-note-context__menu) {
    width: 228px;
  }

  .s2b-note-context__menu-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 2px 0;
  }

  .s2b-note-context__menu-title {
    padding-left: 6px;
    color: var(--text-normal);
    font-size: 0.78rem;
    font-weight: 600;
  }

  :global(.s2b-note-context__menu-close) {
    width: 24px;
    height: 24px;
    min-width: 24px;
    min-height: 24px;
    border-radius: 999px;
  }

  .s2b-note-context__menu-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .s2b-note-context__menu-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .s2b-note-context__menu-label {
    padding: 2px 6px 0;
    color: var(--text-muted);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .s2b-note-context__menu-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .s2b-note-context__toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 6px;
  }

  .s2b-note-context__toggle-label {
    color: var(--text-normal);
    font-size: var(--font-ui-small);
  }

  :global(.s2b-note-context__graph) {
    position: relative;
    flex: 1;
    min-height: 0;
    border: 1px solid var(--background-modifier-border);
    border-radius: 12px;
    overflow: hidden;
    background: radial-gradient(
        circle at top,
        color-mix(in srgb, var(--interactive-accent) 8%, transparent),
        transparent 45%
      ),
      var(--background-primary);
  }

  :global(.s2b-note-context__graph:focus),
  :global(.s2b-note-context__graph:focus-visible) {
    outline: none;
    box-shadow: none;
    border-color: var(--background-modifier-border);
  }

  .s2b-note-context__empty {
    display: grid;
    flex: 1;
    min-height: 0;
    place-items: center;
    padding: 24px;
    text-align: center;
    color: var(--text-muted);
  }

  .s2b-note-context__list {
    display: flex;
    flex-direction: column;
    flex: 1;
    gap: 2px;
    min-height: 0;
    overflow: auto;
  }

  .s2b-note-context__list-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 12px;
    width: 100%;
    padding: 8px 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    text-align: left;
    cursor: var(--cursor);
    color: inherit;
  }

  .s2b-note-context__list-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .s2b-note-context__list-title {
    font-weight: 600;
    color: var(--text-normal);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .s2b-note-context__list-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    justify-content: flex-end;
  }

  .s2b-note-context__badge,
  .s2b-note-context__score {
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 0.78rem;
    line-height: 1;
  }

  .s2b-note-context__badge {
    color: var(--text-normal);
    border: 1px solid transparent;
  }

  .s2b-note-context__badge--incoming {
    background: color-mix(in srgb, #3b82f6 16%, transparent);
    border-color: color-mix(in srgb, #3b82f6 34%, transparent);
  }

  .s2b-note-context__badge--outgoing {
    background: color-mix(in srgb, #f59e0b 16%, transparent);
    border-color: color-mix(in srgb, #f59e0b 34%, transparent);
  }

  .s2b-note-context__badge--both {
    background: color-mix(in srgb, #10b981 16%, transparent);
    border-color: color-mix(in srgb, #10b981 34%, transparent);
  }

  .s2b-note-context__score {
    background: color-mix(in srgb, var(--background-modifier-border) 55%, transparent);
    color: var(--text-muted);
  }

  @media (max-width: 720px) {
    .s2b-note-context__list-row {
      grid-template-columns: minmax(0, 1fr);
    }

    .s2b-note-context__list-meta {
      width: 100%;
      justify-content: flex-start;
      flex-wrap: wrap;
    }
  }
</style>
