<script lang="ts">
import { getData } from "../../stores/dataStore.svelte";
import {
	DEFAULT_TOOLS_CONFIG,
	getReadContentDescription,
	getSearchNotesDescription,
} from "../../agent/tools/builtInToolDefaults";
import type { BuiltInToolId, SearchAlgorithm, ToolConfig } from "../../types/plugin";
import type { ChatModel } from "../../stores/chatTimeline";
import type SecondBrainPlugin from "../../main";
import { ModelSelectionModal, type SelectedModel } from "./ModelSelectionModal";
import { NATIVE_PDF_PROVIDERS } from "../../agent/Agent";
import { suggestSecretId } from "../../lib/secretStorage";
import SecretSelect from "../settings/SecretSelect.svelte";
import SettingContainer from "../settings/SettingContainer.svelte";
import SettingGroup from "../settings/SettingGroup.svelte";
import Button from "../ui/Button.svelte";
import Dropdown from "../ui/Dropdown.svelte";
import { getToolDisplayName } from "../../agent/tools/builtInToolDefaults";
import type { ToolConfigAccessors } from "./ToolConfigModal";

interface Props {
	plugin: SecondBrainPlugin;
	toolId: BuiltInToolId;
	accessors?: ToolConfigAccessors;
	/**
	 * "modal" — render the standalone-modal footer (Cancel / Reset / Save) and persist
	 * only when Save is pressed (preserves the old ToolConfigModal UX).
	 * "none" — no footer; persist on every field commit (inline usage in the agent-level
	 * ToolsModal). A "Reset to default" link is shown when the config is non-default.
	 */
	footer?: "modal" | "none";
	/** Called when the standalone modal saves (footer="modal"). */
	onSave?: () => void;
	/** Called on any persisted change (footer="none") so the caller can invalidate caches. */
	onChange?: () => void;
	/** Called when the standalone modal's Cancel button is pressed (footer="modal"). */
	onCancel?: () => void;
}

const { plugin, toolId, accessors, footer = "modal", onSave, onChange, onCancel }: Props = $props();
const pluginData = getData();

// `footer` is fixed for the form's lifetime (chosen by the caller).
// svelte-ignore state_referenced_locally
const commitMode: "explicit" | "onChange" = footer === "none" ? "onChange" : "explicit";

const capturedToolId = (() => toolId)();
const defaultConfig = DEFAULT_TOOLS_CONFIG[capturedToolId];
const initialToolConfig = (() => accessors?.getToolConfig() ?? defaultConfig)();

function writeToolConfig(config: Partial<ToolConfig>): void {
	if (accessors?.updateToolConfig) {
		accessors.updateToolConfig(config);
		return;
	}
	pluginData.updateAgentToolConfig(pluginData.selectedAgentId, capturedToolId, config);
}

// Name/description feed the LangChain tool definition seen only by the model, not the user —
// deliberately not exposed as editable fields here. `toolsConfig.name`/`.description` stay in
// the data model (existing customizations keep working at runtime and still count toward
// dirty/default detection below); "Reset to Default" can still clear a stale customization even
// though there's no field to edit one manually.
let name = $state(initialToolConfig?.name ?? defaultConfig.name);
let description = $state(initialToolConfig?.description ?? defaultConfig.description);
let maxResults = $state(
	(initialToolConfig?.settings as { maxResults?: number })?.maxResults ??
		(defaultConfig.settings as { maxResults?: number })?.maxResults ??
		10,
);
const webSearchProviderOptions = [
	{ display: "Firecrawl (keyless)", value: "firecrawl" },
	{ display: "Brave Search", value: "brave" },
	{ display: "Tavily", value: "tavily" },
];
type ProcessorMode = "auto" | "custom" | "disabled";

// Processor settings: undefined = auto, null = disabled, ChatModel = custom
const initialImageProcessor: ChatModel | null | undefined = (
	initialToolConfig?.settings as { imageProcessor?: ChatModel | null }
)?.imageProcessor;
const initialPdfProcessor: ChatModel | null | undefined = (
	initialToolConfig?.settings as { pdfProcessor?: ChatModel | null }
)?.pdfProcessor;

let imageProcessor = $state<ChatModel | null | undefined>(initialImageProcessor);
let pdfProcessor = $state<ChatModel | null | undefined>(initialPdfProcessor);

function processorToMode(proc: ChatModel | null | undefined): ProcessorMode {
	if (proc === undefined) return "auto";
	if (proc === null) return "disabled";
	return "custom";
}

let imageProcessorMode = $state<ProcessorMode>(processorToMode(initialImageProcessor));
let pdfProcessorMode = $state<ProcessorMode>(processorToMode(initialPdfProcessor));

// Derive chat model info for auto-mode labels and capability checks
const selectedAgent = pluginData.getSelectedAgent();
const chatModel = selectedAgent.chatModel;
const chatModelLabel = chatModel ? `${chatModel.provider}/${chatModel.model}` : null;
const chatModelSupportsVision = !!chatModel?.modelConfig?.supportsVision;
const chatModelSupportsPdf = chatModelSupportsVision && !!chatModel && NATIVE_PDF_PROVIDERS.has(chatModel.provider);

function autoLabel(capability: boolean): string {
	if (!chatModelLabel) return "Auto (no chat model)";
	return capability ? `Auto (${chatModelLabel})` : `Auto (${chatModelLabel} — not supported)`;
}

const imageProcessorModeOptions = $derived<{ display: string; value: ProcessorMode }[]>([
	{ display: autoLabel(chatModelSupportsVision), value: "auto" },
	{ display: "Custom", value: "custom" },
	{ display: "Disabled", value: "disabled" },
]);

const pdfProcessorModeOptions = $derived<{ display: string; value: ProcessorMode }[]>([
	{ display: autoLabel(chatModelSupportsPdf), value: "auto" },
	{ display: "Custom", value: "custom" },
	{ display: "Disabled", value: "disabled" },
]);

function handleImageModeChange(mode: ProcessorMode) {
	imageProcessorMode = mode;
	if (mode === "auto") imageProcessor = undefined;
	else if (mode === "disabled") imageProcessor = null;
	// "custom" keeps existing selection or waits for user pick
	commit();
}

function handlePdfModeChange(mode: ProcessorMode) {
	pdfProcessorMode = mode;
	if (mode === "auto") pdfProcessor = undefined;
	else if (mode === "disabled") pdfProcessor = null;
	commit();
}

// Resolve effective processor state for guidance/description preview.
// "auto" → derive from chat model capabilities, "custom" → explicit model, "disabled" → off.
function resolveHasProcessor(mode: ProcessorMode, proc: ChatModel | null | undefined, autoCapable: boolean): boolean {
	if (mode === "auto") return autoCapable;
	if (mode === "custom") return !!proc;
	return false;
}

interface ToolConfigSnapshot {
	name: string;
	description: string;
	maxResults: number;
	imageProcessorKey: string;
	pdfProcessorKey: string;
}

function processorKey(proc: ChatModel | null | undefined): string {
	if (proc === undefined) return "auto";
	if (proc === null) return "disabled";
	return JSON.stringify(proc);
}

const initialSnapshot: ToolConfigSnapshot = {
	name: initialToolConfig?.name ?? defaultConfig.name,
	description: initialToolConfig?.description ?? defaultConfig.description,
	maxResults:
		(initialToolConfig?.settings as { maxResults?: number })?.maxResults ??
		(defaultConfig.settings as { maxResults?: number })?.maxResults ??
		10,
	imageProcessorKey: processorKey(initialImageProcessor),
	pdfProcessorKey: processorKey(initialPdfProcessor),
};

const defaultSnapshot: ToolConfigSnapshot = {
	name: defaultConfig.name,
	description: defaultConfig.description,
	maxResults: (defaultConfig.settings as { maxResults?: number })?.maxResults ?? 10,
	// Default is "auto" for both processors
	imageProcessorKey: "auto",
	pdfProcessorKey: "auto",
};

function snapshotKey(snapshot: ToolConfigSnapshot): string {
	return JSON.stringify(snapshot);
}

const initialSnapshotKey = snapshotKey(initialSnapshot);
const defaultSnapshotKey = snapshotKey(defaultSnapshot);

const isDirty = $derived.by(() => {
	const currentSnapshot: ToolConfigSnapshot = {
		// name/description aren't editable in this form; carry the initial (persisted) values
		// through unchanged so dirty/default detection still reflects any pre-existing customization.
		name,
		description,
		maxResults,
		imageProcessorKey: processorKey(imageProcessor),
		pdfProcessorKey: processorKey(pdfProcessor),
	};
	return snapshotKey(currentSnapshot) !== initialSnapshotKey;
});

const isAtDefault = $derived.by(() => {
	const currentSnapshot: ToolConfigSnapshot = {
		name,
		// Pinned to the default: the description isn't user-editable, and two tools swap
		// theirs automatically (read_content by processor capability, search_notes by
		// whether an embedding index exists). Comparing the live value would make an
		// untouched config look "non-default" and offer a pointless "Reset to default".
		description: defaultConfig.description,
		maxResults,
		imageProcessorKey: processorKey(imageProcessor),
		pdfProcessorKey: processorKey(pdfProcessor),
	};
	return snapshotKey(currentSnapshot) === defaultSnapshotKey;
});

const showResetToDefault = $derived(!isAtDefault);

/** Build the persisted patch from current field state (shared by Save + live-commit). */
function buildConfigPatch(): Partial<ToolConfig> {
	// Two tools' shipped descriptions vary with live state — read_content's by processor
	// capability, search_notes' by whether an embedding index exists — so recompute rather
	// than persisting whichever variant happened to be current when the modal opened. The
	// tool factories derive the description the same way at build time, so what's persisted
	// here is only ever a cache of that; nothing user-authored can be lost.
	let resolvedDescription = description;
	if (capturedToolId === "read_content") {
		const hasImg = resolveHasProcessor(imageProcessorMode, imageProcessor, chatModelSupportsVision);
		const hasPdf = resolveHasProcessor(pdfProcessorMode, pdfProcessor, chatModelSupportsPdf);
		resolvedDescription = getReadContentDescription(hasImg, hasPdf);
	} else if (capturedToolId === "search_notes") {
		resolvedDescription = getSearchNotesDescription(Boolean(pluginData.searchEmbedIndex));
	}

	const updatedConfig: Partial<ToolConfig> = {
		name,
		description: resolvedDescription,
	};

	if (capturedToolId === "search_notes") {
		// Nothing here is user-configurable: `algorithm` and `maxResults` are per-call
		// tool parameters the model chooses, and the four display flags are hardcoded on
		// for the agent. Persist an empty settings object so a stale one from an earlier
		// version stops being carried forward.
		updatedConfig.settings = {};
	} else if (capturedToolId === "read_content") {
		// Build settings with three-state processors:
		// undefined = auto, null = disabled, ChatModel = custom
		const settings: Record<string, unknown> = {};
		if (imageProcessor !== undefined) settings.imageProcessor = imageProcessor;
		if (pdfProcessor !== undefined) settings.pdfProcessor = pdfProcessor;
		updatedConfig.settings = settings as ToolConfig["settings"];
	} else if (capturedToolId === "web_search") {
		updatedConfig.settings = { maxResults };
	}
	return updatedConfig;
}

/** Persist immediately (used by inline/live mode on every field commit). */
function commit() {
	if (commitMode !== "onChange") return;
	writeToolConfig(buildConfigPatch());
	onChange?.();
}

function handleSave() {
	writeToolConfig(buildConfigPatch());
	onSave?.();
	onCancel?.(); // footer="modal" wires onCancel to modal.close(); harmless otherwise
}

function handleResetToDefault() {
	name = defaultConfig.name;
	description = defaultConfig.description;

	if (capturedToolId === "search_notes") {
		// Reset to the variant matching this vault, not whichever one ships in
		// DEFAULT_TOOLS_CONFIG — otherwise "reset" could hand a vault with no embedding
		// index a description advertising semantic search. No settings to reset: the
		// tool has no user-configurable ones.
		description = getSearchNotesDescription(Boolean(pluginData.searchEmbedIndex));
	} else if (capturedToolId === "read_content" && defaultConfig.settings) {
		// Reset processors to "auto" mode
		imageProcessor = undefined;
		pdfProcessor = undefined;
		imageProcessorMode = "auto";
		pdfProcessorMode = "auto";
	} else if (capturedToolId === "web_search" && defaultConfig.settings) {
		const settings = defaultConfig.settings as { maxResults: number };
		maxResults = settings.maxResults;
	}
	// In live mode a reset persists immediately; in explicit mode it waits for Save.
	commit();
}

function openProcessorSelectionModal(currentProcessor: ChatModel | null, onSelect: (model: ChatModel) => void) {
	const currentSelection: SelectedModel | null = currentProcessor
		? { provider: currentProcessor.provider, model: currentProcessor.model }
		: null;

	const selectionModal = new ModelSelectionModal(plugin, "chat", currentSelection, (selected) => {
		if (selected) {
			onSelect({
				provider: selected.provider,
				model: selected.model,
				modelConfig: { contextWindow: 128000 },
			});
		}
	});
	selectionModal.open();
}
</script>

<div class="tool-config-modal-content">
  {#if capturedToolId === "search_notes"}
    <!--
      Retrieval strategy is deliberately NOT configurable here.

      `algorithm` is a per-call parameter the model picks, because there is no globally
      right answer — measured on the graded benchmark, semantic wins the core tier while
      hybrid wins the hard tier, and neither difference is significant. The agent has the
      query context needed to choose; the user does not.

      `maxResults` is a per-call parameter for the same reason: "find the note about X"
      wants a handful, "what do I have on Y" wants a page, and only the caller knows
      which this is.

      The four result-detail toggles are hardcoded on for the agent. They still exist for
      the search *modal*, under Settings → Search → Display.

      So this tool has no user-facing settings at all — nothing to render.
    -->
  {:else if capturedToolId === "read_content"}
    <SettingGroup
      heading="Vision processors"
      headingDesc="Configure how images and PDFs encountered during tool use are processed. Auto uses the chat model if it supports vision."
    >
      <SettingContainer name="Image processor" desc="Vision model to analyze images found in notes.">
        <div class="processor-control">
          <Dropdown
            type="options"
            dropdown={imageProcessorModeOptions}
            selected={imageProcessorMode}
            onchange={handleImageModeChange}
          />
          {#if imageProcessorMode === "custom"}
            <Button
              onClick={() =>
                openProcessorSelectionModal(imageProcessor ?? null, (model) => {
                  if (model) {
                    imageProcessor = model;
                    commit();
                  }
                })}
            >
              {#if imageProcessor}
                <span>{imageProcessor.provider}/{imageProcessor.model}</span>
              {:else}
                <span class="text-[--text-muted]">Select model…</span>
              {/if}
            </Button>
          {/if}
        </div>
      </SettingContainer>
      <SettingContainer name="PDF Processor" desc="Vision model for enhanced PDF analysis (charts, tables, diagrams).">
        <div class="processor-control">
          <Dropdown
            type="options"
            dropdown={pdfProcessorModeOptions}
            selected={pdfProcessorMode}
            onchange={handlePdfModeChange}
          />
          {#if pdfProcessorMode === "custom"}
            <Button
              onClick={() =>
                openProcessorSelectionModal(pdfProcessor ?? null, (model) => {
                  if (model) {
                    pdfProcessor = model;
                    commit();
                  }
                })}
            >
              {#if pdfProcessor}
                <span>{pdfProcessor.provider}/{pdfProcessor.model}</span>
              {:else}
                <span class="text-[--text-muted]">Select model…</span>
              {/if}
            </Button>
          {/if}
        </div>
      </SettingContainer>
    </SettingGroup>
  {:else if capturedToolId === "fetch_url" || capturedToolId === "ask_question"}
    <!-- no tool-specific settings -->
  {:else if capturedToolId === "web_search"}
    <SettingGroup heading="Web search">
      <SettingContainer
        name="Provider"
        desc="Search provider used by this tool. The provider and API key are shared across all agents that enable web_search."
      >
        <Dropdown
          type="options"
          dropdown={webSearchProviderOptions}
          selected={pluginData.webSearchProvider}
          onchange={(val) => (pluginData.webSearchProvider = val)}
        />
      </SettingContainer>
      {#if pluginData.webSearchProvider}
        <SettingContainer
          name={pluginData.webSearchProvider === "firecrawl" ? "API Key (optional)" : "API Key"}
          desc={pluginData.webSearchProvider === "brave"
            ? "Brave Search API key from api.search.brave.com."
            : pluginData.webSearchProvider === "tavily"
              ? "Tavily API key from app.tavily.com."
              : "Optional — add a Firecrawl API key (fc-…) for higher rate limits. Leave empty to use the keyless tier."}
        >
          <SecretSelect
            value={pluginData.webSearchApiKeyId}
            suggestedId={suggestSecretId(plugin.app, pluginData.webSearchProvider, "apiKey")}
            onChange={(secretId) => (pluginData.webSearchApiKeyId = secretId)}
          />
        </SettingContainer>
      {/if}
    </SettingGroup>
  {/if}

  {#if footer === "modal"}
    <div class="tool-config-actions">
      <Button buttonText="Cancel" onClick={() => onCancel?.()} />
      <div class="flex-1"></div>
      {#if showResetToDefault}
        <Button buttonText="Reset to default" onClick={handleResetToDefault} />
      {/if}
      {#if isDirty}
        <Button buttonText="Save" cta={true} onClick={handleSave} />
      {/if}
    </div>
  {:else if showResetToDefault}
    <div class="tool-config-inline-reset">
      <button type="button" class="tool-config-reset-link" onclick={handleResetToDefault}>
        Reset {getToolDisplayName(capturedToolId, name)} to default
      </button>
    </div>
  {/if}
</div>

<style>
  .tool-config-modal-content {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 8px 0;
  }

  /* `.setting-group` collides with an Obsidian core rule (`max-width: 700px; margin: 0 auto`)
     meant for the native settings tab. Inside these wide modals that centers the tool
     settings; neutralize it here (scoped to this form) rather than globally. */
  .tool-config-modal-content :global(.setting-group) {
    max-width: none;
    margin-left: 0;
    margin-right: 0;
  }

  .processor-control {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .tool-config-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    border-top: 1px solid var(--background-modifier-border);
    padding-top: 16px;
    margin-top: 8px;
  }

  .tool-config-inline-reset {
    display: flex;
    justify-content: flex-end;
  }

  .tool-config-reset-link {
    border: 0;
    background: transparent;
    color: var(--text-accent);
    cursor: pointer;
    padding: 0;
    font-size: var(--font-ui-smaller);
  }

  .tool-config-reset-link:hover {
    text-decoration: underline;
  }
</style>
