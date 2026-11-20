<script lang="ts">
import { DEFAULT_AGENT_ICON, type AgentConfig } from "../../types/plugin";
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import { getSessionRegistry } from "../../stores/chatStore.svelte";
import { chatHistoryContainsPrivateNotes } from "../../stores/chatTimeline";
import Icon from "../ui/Icon.svelte";
import { PrivacyWarningModal } from "../modal/PrivacyWarningModal";
import { AgentEditorModal } from "../modal/AgentEditorModal";
import Button from "../ui/Button.svelte";
import PickerPopover from "../ui/PickerPopover.svelte";
import PickerOptionRow from "../ui/PickerOptionRow.svelte";
import { t } from "../../i18n";

const data = getData();
const plugin = getPlugin();

interface Props {
	threadPath?: string | null;
}
const { threadPath = null }: Props = $props();

// Get all agents reactively
const agents = $derived(Object.values(data.agents));

// The agent this TAB will actually run. Selection is per-session (each tab holds
// its own selectedAgentId); fall back to the global selection for a tab that
// hasn't overridden it. Displaying the global here would let the pill/checkmark
// lie about which agent the tab runs when two tabs pick different agents.
const session = $derived(getSessionRegistry()?.sessionFor(threadPath));
const selectedAgent = $derived(
	(session?.selectedAgentId ? data.getAgent(session.selectedAgentId) : undefined) ?? data.getSelectedAgent(),
);

let isOpen = $state(false);
let customAnchor: HTMLButtonElement | undefined = $state();

function getAgentIcon(agent: Pick<AgentConfig, "icon"> | null | undefined): string {
	return agent?.icon?.trim() || DEFAULT_AGENT_ICON;
}

async function selectAgent(agent: AgentConfig) {
	// Check if the agent's provider is non-trusted and chat has private notes
	const newProvider = agent.chatModel?.provider;
	if (newProvider && !data.isProviderTrusted(newProvider)) {
		const messages = session?.messages;
		if (messages && chatHistoryContainsPrivateNotes(messages)) {
			const confirmed = await new PrivacyWarningModal(plugin.app).prompt();
			if (!confirmed) return;
		}
	}
	// Set per-session selection; also update the global so new tabs start on this agent.
	if (session) session.selectedAgentId = agent.id;
	data.selectedAgentId = agent.id;
	isOpen = false;
}

function openAgentEditor(agentId: string) {
	isOpen = false;
	new AgentEditorModal(plugin, agentId).open();
}

function createNewAgent() {
	const agent = data.createAgent("New Agent");
	data.selectedAgentId = agent.id;
	// Seed the base prompt note immediately so it exists in the vault before the editor opens.
	void plugin.promptFilesService?.ensureAgentPrompt(agent.id);
	openAgentEditor(agent.id);
}
</script>

{#if agents.length === 0}
  <!-- No agents configured (shouldn't happen, but handle gracefully) -->
  <Button
    onClick={() => openAgentEditor("default-agent")}
    styles="clickable-icon s2b-flex s2b-flex-row s2b-items-center s2b-gap-1"
  >
    <div class="s2b-text-[--text-muted] s2b-text-xs">{t("chat.agent.configure")}</div>
  </Button>
{:else}
  <PickerPopover
    bind:open={isOpen}
    bind:element={customAnchor}
    tooltip={t("chat.agent.options")}
    dataTestId="agent-select-button"
    triggerStyles="clickable-icon s2b-model-select-btn"
    triggerClass="s2b-agent-popover-trigger"
    side="top"
    align="start"
    sideOffset={8}
  >
    <!-- No chevron: the composer row's other picker triggers (the model button and
         the attach popover) don't use one either, and it's the only affordance
         here that did. -->
    {#snippet trigger()}
      <span class="agent-pill" data-testid="agent-pill">
        <span class="agent-pill-icon">
          <Icon name={getAgentIcon(selectedAgent)} size="xs" />
        </span>
        <span class="agent-pill-label">{selectedAgent?.name ?? "S2B Agent"}</span>
      </span>
    {/snippet}

    {#each agents as agent (agent.id)}
      {@const isSelected = agent.id === selectedAgent?.id}
      {@const isDefault = agent.id === data.defaultAgentId}
      <PickerOptionRow
        active={isSelected}
        onClick={() => selectAgent(agent)}
        onActionClick={() => openAgentEditor(agent.id)}
        actionTitle={t("chat.agent.edit")}
      >
        {#snippet leading()}
          <span class="agent-option-icon">
            <Icon name={getAgentIcon(agent)} size="xs" />
          </span>
        {/snippet}

        {#snippet content()}
          <span class="agent-name-pill">{agent.name}</span>
        {/snippet}

        {#if isDefault}
          {#snippet meta()}
            {t("chat.agent.default_badge")}
          {/snippet}
        {/if}

        {#if isSelected}
          {#snippet trailing()}
            <Icon name="check" size="xs" class="s2b-text-[--text-accent]" />
          {/snippet}
        {/if}

        {#snippet action()}
          <Icon name="settings" size="xs" class="s2b-text-[--text-faint]" />
        {/snippet}
      </PickerOptionRow>
    {/each}

    <div class="s2b-picker-popover-separator menu-separator"></div>

    <PickerOptionRow onClick={createNewAgent} actionTitle={t("chat.agent.create")}>
      {#snippet leading()}
        <Icon name="plus" size="xs" />
      {/snippet}

      {#snippet content()}
        {t("chat.agent.new")}
      {/snippet}
    </PickerOptionRow>
  </PickerPopover>
{/if}

<style>
  :global(.s2b-agent-popover-trigger) {
    max-width: 190px;
  }

  /* Collapse to icon-only on mobile — there isn't enough width for icon +
     label + model pill + send button on one row without wrapping. */
  :global(.is-mobile .s2b-agent-popover-trigger) {
    max-width: none;
  }

  :global(.is-mobile) .agent-pill-label {
    display: none;
  }

  .agent-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 132px;
    font-size: var(--font-ui-small);
    color: var(--text-normal);
  }

  .agent-pill-icon,
  .agent-option-icon {
    flex-shrink: 0;
  }

  .agent-pill-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-name-pill {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--font-ui-small);
  }
</style>
