<script lang="ts">
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import { getSessionRegistry } from "../../stores/chatStore.svelte";
import { buildPersistedChatModel } from "../../utils/persistedChatModel";
import { ModelSelectionModal } from "../modal/ModelSelectionModal";
import { useAvailableModels } from "../../hooks/useAvailableModels.svelte";
import { stripVendorPrefix } from "../../lib/modelMetadataNormalizer";
import Button from "../ui/Button.svelte";

const data = getData();
const plugin = getPlugin();
const models = useAvailableModels();

interface Props {
	threadPath?: string | null;
}
const { threadPath = null }: Props = $props();

// The agent this TAB runs (per-session selection, falling back to the global).
// The model pill and the modal's current selection both read from this agent so
// they reflect what the tab will actually use, not the global selection.
const session = $derived(getSessionRegistry()?.sessionFor(threadPath));
const selectedAgent = $derived(
	(session?.selectedAgentId ? data.getAgent(session.selectedAgentId) : undefined) ?? data.getSelectedAgent(),
);

function getModelDisplayName(provider: string, model: string): string {
	const hydrated = models.hydratedChatModelsByKey.get(`${provider}:${model}`);
	if (hydrated?.displayName) {
		// The composer pill is the tightest model surface in the app, and the
		// agent pill right beside it already implies the vendor — so drop the
		// catalogue's "Lab: " prefix ("Qwen: Qwen3.8 Max" -> "Qwen3.8 Max") and
		// spend the width on the part that actually distinguishes the model.
		return stripVendorPrefix(hydrated.displayName);
	}
	return model;
}

function openModelSelectionModal() {
	const currentSelection = selectedAgent?.chatModel
		? { provider: selectedAgent.chatModel.provider, model: selectedAgent.chatModel.model }
		: null;
	new ModelSelectionModal(plugin, "chat", currentSelection, (selected) => {
		if (!selected) return;
		const agentId = session?.selectedAgentId || data.selectedAgentId;
		data.updateAgent(agentId, {
			chatModel: buildPersistedChatModel(selected.provider, selected.model, selectedAgent?.chatModel),
		});
	}).open();
}
</script>

<Button
  styles="clickable-icon s2b-model-select-btn"
  tooltip="Select model"
  dataTestId="model-select-button"
  onClick={openModelSelectionModal}
>
  {#if selectedAgent?.chatModel}
    <span class="model-name" data-testid="model-pill">
      {getModelDisplayName(selectedAgent.chatModel.provider, selectedAgent.chatModel.model)}
    </span>
  {:else}
    <span class="model-name no-model">Select model</span>
  {/if}
</Button>

<style>
  /* `flex-shrink` (not just `min-width: 0`) makes this the one control in the
     action row that gives up width under pressure. The row is `nowrap`, so
     something has to absorb a narrow composer; the alternatives are all worse
     — the attach/send buttons are fixed-size touch targets, and the agent
     collapses to an icon at its own breakpoint. An over-long model name
     ellipsises instead of pushing the send button onto a second line. */
  :global(.s2b-model-select-btn) {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
    flex-shrink: 1;
  }

  /* No max-width: the name shows in full whenever the row has room, and is
     capped only by actual width pressure — the action row is `nowrap` with
     this button as its only shrinkable item (see Input.svelte), so when the
     composer narrows, flex squeezes the button and `min-width: 0` +
     `text-overflow` turn the surplus into an ellipsis. A fixed cap here
     truncated long names even when the row had plenty of free space. */
  .model-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
    /* `--text-normal`, matching the agent pill beside it: the two text
       triggers in the row are the same kind of control and should read as
       one family. Muted is this app's label colour, and a muted model name
       read as a caption rather than something clickable. */
    color: var(--text-normal);
  }

  .model-name.no-model {
    color: var(--text-faint);
    font-style: italic;
  }
</style>
