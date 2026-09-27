<script lang="ts">
import { onMount } from "svelte";
import { diffWords } from "diff";
import type SecondBrainPlugin from "../../main";
import Button from "../ui/Button.svelte";
import type { SystemPromptAccessors, SystemPromptModal } from "./SystemPromptModal";

interface Props {
	modal: SystemPromptModal;
	plugin: SecondBrainPlugin;
	accessors: SystemPromptAccessors;
	description: string;
	readOnly: boolean;
}

const { modal, plugin, accessors, description, readOnly }: Props = $props();

let promptValue = $state("");
let isLoading = $state(true);

// No `?? DEFAULT_AGENT_PROMPT` fallback: diff callers are required to name their own
// baseline, and silently substituting the agent base prompt is exactly the bug this had
// (a skill diffed against — and resettable to — an unrelated document). Read-only previews
// never reach the diff, so "" is inert for them.
const defaultPrompt = $derived(accessors.defaultPrompt ?? "");
const isAtDefault = $derived(promptValue === defaultPrompt);

function renderDiffSide(oldText: string, newText: string, side: "old" | "new"): string {
	const parts = diffWords(oldText, newText);
	return parts
		.filter((p) => (side === "old" ? !p.added : !p.removed))
		.map((p) => {
			const escaped = p.value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
			if (side === "old" && p.removed) return `<mark class="s2b-prompt-diff-removed">${escaped}</mark>`;
			if (side === "new" && p.added) return `<mark class="s2b-prompt-diff-added">${escaped}</mark>`;
			return escaped;
		})
		.join("");
}

onMount(() => {
	void loadPrompt();
});

async function loadPrompt() {
	promptValue = await accessors.getPrompt();
	isLoading = false;
}

// "Use default" is a commit, not a preview step — apply and close immediately.
function handleUseDefault() {
	accessors.setPrompt?.(defaultPrompt);
	modal.close();
}

// Merging by hand happens in the note itself, not in a second editor inside this modal.
function handleOpenNote() {
	if (!accessors.notePath) return;
	void plugin.app.workspace.openLinkText(accessors.notePath, "", true);
	modal.close();
}
</script>

<div class="system-prompt-modal-content">
  <p class="system-prompt-description">{description}</p>

  {#if isLoading}
    <div class="system-prompt-loading">Loading prompt…</div>
  {:else if readOnly}
    <div class="system-prompt-preview-container">
      <pre class="system-prompt-preview">{promptValue}</pre>
    </div>
  {:else if isAtDefault}
    <div class="system-prompt-loading">This note matches the current default.</div>
  {:else}
    <div class="prompt-diff-container">
      <div class="prompt-diff-pane">
        <div class="prompt-diff-pane-label">Yours</div>
        <pre class="prompt-diff-text">{@html renderDiffSide(promptValue, defaultPrompt, "old")}</pre>
      </div>
      <div class="prompt-diff-pane">
        <div class="prompt-diff-pane-label">Default</div>
        <pre class="prompt-diff-text">{@html renderDiffSide(promptValue, defaultPrompt, "new")}</pre>
      </div>
    </div>
  {/if}

  {#if !readOnly}
    <div class="system-prompt-actions">
      <Button buttonText="Cancel" onClick={() => modal.close()} />
      <div class="flex-1"></div>
      {#if accessors.notePath}
        <Button buttonText="Open note" onClick={handleOpenNote} />
      {/if}
      {#if !isLoading && !isAtDefault}
        <Button buttonText="Use default" cta={true} onClick={handleUseDefault} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .system-prompt-modal-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .system-prompt-description {
    flex-shrink: 0;
    margin: 0 0 12px 0;
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }

  /* ── Two-pane diff ── */
  .prompt-diff-container {
    display: flex;
    gap: 12px;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  /* Two monospace panes side-by-side are unreadable on a phone (~165px each);
     stack them vertically on mobile. */
  :global(.is-mobile) .prompt-diff-container {
    flex-direction: column;
    overflow: auto;
  }

  .prompt-diff-pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow-y: auto;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 12px;
    padding: 12px 14px;
  }

  .prompt-diff-pane-label {
    font-size: var(--font-ui-smaller);
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 8px;
    flex-shrink: 0;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .prompt-diff-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-monospace);
    font-size: 0.9rem;
    line-height: 1.6;
    color: var(--text-normal);
    user-select: text;
  }

  :global(mark.s2b-prompt-diff-removed) {
    background: color-mix(in srgb, var(--color-red) 35%, transparent);
    border-radius: 2px;
    color: inherit;
  }

  :global(mark.s2b-prompt-diff-added) {
    background: color-mix(in srgb, var(--color-green) 35%, transparent);
    border-radius: 2px;
    color: inherit;
  }

  /* ── Preview ── */
  .system-prompt-preview-container {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 12px;
    padding: 12px 14px;
  }

  .system-prompt-preview {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-monospace);
    font-size: 0.9rem;
    line-height: 1.6;
    color: var(--text-normal);
    user-select: text;
  }

  .system-prompt-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 200px;
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }

  .system-prompt-actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }
</style>
