<script lang="ts">
import { Notice, type TFolder } from "obsidian";
import { AgentEditorModal } from "../../components/modal/AgentEditorModal";
import FolderSuggest from "../../components/modal/FolderSuggest.svelte";
import ManagedEntityItem from "../../components/settings/ManagedEntityItem.svelte";
import ManagedEntitySection from "../../components/settings/ManagedEntitySection.svelte";
import SettingGroup from "../../components/settings/SettingGroup.svelte";
import SettingItem from "../../components/settings/SettingItem.svelte";
import Badge from "../../components/ui/Badge.svelte";
import Button from "../../components/ui/Button.svelte";
import { confirmDelete } from "../../components/modal/ConfirmModal";
import Dropdown from "../../components/ui/Dropdown.svelte";
import Icon from "../../components/ui/Icon.svelte";
import Toggle from "../../components/ui/Toggle.svelte";
import { getProviderDefinition } from "../../providers/index";
import { getData } from "../../stores/dataStore.svelte";
import { DEFAULT_AGENT_ID } from "../../stores/agentDefaults";
import { getPlugin } from "../../stores/state.svelte";
import { DEFAULT_AGENT_ICON, type ChatOpenLocation } from "../../types/plugin";
import { isMobileUI } from "../../utils/platform";

const pluginData = getData();
const plugin = getPlugin();

const chatOpenLocationOptions: { display: string; value: ChatOpenLocation }[] = [
	{ display: "Main area (tab)", value: "tab" },
	{ display: "Left sidebar", value: "left" },
	{ display: "Right sidebar", value: "right" },
];

function suggestFolders(): TFolder[] {
	return plugin.app.vault.getAllFolders(true);
}

// Persist a new agent-context root, then seed core skills + base prompts into it (skip-if-exists;
// existing files in the old folder are left untouched) so the change takes effect without a reload.
async function changeAgentFolder(path: string): Promise<void> {
	pluginData.agentFolder = path;
	await plugin.reinitAgentFolder();
}

let agents = $derived(pluginData.agents);
let agentIds = $derived(Object.keys(agents));

function openAgentEditor(agentId: string) {
	new AgentEditorModal(plugin, agentId).open();
}

function createNewAgent() {
	const agent = pluginData.createAgent("New Agent");
	pluginData.selectedAgentId = agent.id;
	// Seed the base prompt note immediately so it exists in the vault before the editor opens.
	void plugin.promptFilesService?.ensureAgentPrompt(agent.id);
	openAgentEditor(agent.id);
}

function duplicateAgent(agentId: string) {
	const sourceAgent = agents[agentId];
	if (!sourceAgent) return;
	const duplicated = pluginData.duplicateAgent(agentId, `${sourceAgent.name} (Copy)`);
	pluginData.selectedAgentId = duplicated.id;
	// Carry over the source's edited base + memory prompts to the duplicate's own notes.
	void plugin.promptFilesService?.copyAgentPrompt(agentId, duplicated.id);
	openAgentEditor(duplicated.id);
}

async function deleteAgent(agentId: string) {
	if (agentId === DEFAULT_AGENT_ID) {
		new Notice("Cannot delete the built-in default agent");
		return;
	}
	const agent = agents[agentId];
	if (!(await confirmDelete(plugin.app, agent?.name ?? agentId))) return;
	try {
		// Remove the agent's folder BEFORE the agent leaves config, and AWAIT it:
		// deleteAgentDir resolves the folder path from the agent's (name-based) entry, and
		// only once the agent is gone can its name be reused by another agent. Fully ordering
		// the removal closes the window where a reused name could point deletion at the wrong
		// folder.
		await plugin.promptFilesService?.deleteAgentDir(agentId);
		pluginData.deleteAgent(agentId);
		plugin.agentManager?.invalidateAgentRunnable(agentId);
	} catch (error) {
		new Notice(error instanceof Error ? error.message : "Failed to delete agent");
	}
}

function selectDefaultAgent(agentId: string) {
	if (pluginData.defaultAgentId === agentId) return;
	pluginData.setDefaultAgentId(agentId);
}

function getAgentModelSummary(agentId: string): string {
	const agent = agents[agentId];
	if (!agent?.chatModel) {
		return "No chat model selected";
	}
	const providerDef = getProviderDefinition(agent.chatModel.provider, pluginData.getAllProviderMeta());
	return `${providerDef?.displayName ?? agent.chatModel.provider} · ${agent.chatModel.model}`;
}

// Enabled-skills summary for an agent row: a capped strip of the enabled skills' icons
// with a "+N" overflow chip. Icons come from AgentManager.getEnabledSkillIcons (single
// source of truth — see collectEnabledSkills).
const MAX_SKILL_ICONS = 12;
function getAgentSkillsSummary(agentId: string): { icons: string[]; overflow: number; count: number } {
	const icons = plugin.agentManager?.getEnabledSkillIcons(agentId) ?? [];
	return {
		icons: icons.slice(0, MAX_SKILL_ICONS),
		overflow: Math.max(0, icons.length - MAX_SKILL_ICONS),
		count: icons.length,
	};
}
</script>

<div class="agents-settings">
  <ManagedEntitySection
    heading="Agents"
    description="Agents combine a model, system prompt, skills, tools, and MCP servers into reusable assistants for different workflows."
    emptyMessage="No agents configured."
    hasItems={agentIds.length > 0}
  >
    {#snippet actions()}
      <Button buttonText="Add agent" cta={true} onClick={createNewAgent} />
    {/snippet}

    {#each agentIds as agentId (agentId)}
      {@const agent = agents[agentId]}
      {@const skillsSummary = getAgentSkillsSummary(agentId)}
      <ManagedEntityItem
        name={agent.name}
        selected={pluginData.defaultAgentId === agentId}
        radio={agentIds.length > 1
          ? {
              selected: pluginData.defaultAgentId === agentId,
              onclick: () => selectDefaultAgent(agentId),
              ariaLabel: `Set ${agent.name} as default agent`,
            }
          : undefined}
      >
        {#snippet leading()}
          <span class="agent-avatar" class:agent-avatar--default={pluginData.defaultAgentId === agentId}>
            <Icon name={agent.icon?.trim() || DEFAULT_AGENT_ICON} size="s" />
          </span>
        {/snippet}

        {#snippet badges()}
          {#if agentId === DEFAULT_AGENT_ID}
            <Badge label="Built-in" tone="muted" />
          {/if}
        {/snippet}

        {#snippet children()}
          <div class="agent-summary-row">
            <span class="agent-model-summary">{getAgentModelSummary(agentId)}</span>
            {#if skillsSummary.count > 0}
              <span class="agent-skills-icons">
                {#each skillsSummary.icons as icon, i (i)}
                  <Icon name={icon} size="xs" />
                {/each}
                {#if skillsSummary.overflow > 0}
                  <span class="agent-skills-overflow">+{skillsSummary.overflow}</span>
                {/if}
              </span>
            {/if}
          </div>
        {/snippet}

        {#snippet actions()}
          {#if agentId !== DEFAULT_AGENT_ID}
            <Button
              iconId="trash"
              ariaLabel="Delete agent"
              tooltip="Delete agent"
              onClick={() => deleteAgent(agentId)}
            />
          {/if}
          <Button
            iconId="settings"
            ariaLabel="Edit agent"
            tooltip="Edit agent"
            onClick={() => openAgentEditor(agentId)}
          />
          <Button
            iconId="copy"
            ariaLabel="Duplicate agent"
            tooltip="Duplicate agent"
            onClick={() => duplicateAgent(agentId)}
          />
        {/snippet}
      </ManagedEntityItem>
    {/each}
  </ManagedEntitySection>

  <SettingGroup heading="Agents storage">
    <SettingItem
      name="Agents folder"
      desc="Vault folder holding agent context — skills, memories, and base prompts. Changing it seeds the new location; existing files are left in place."
    >
      <FolderSuggest
        app={plugin.app}
        value={pluginData.agentFolder}
        placeholder="Agents"
        suggestionFn={(query) =>
          suggestFolders().filter((folder) =>
            folder.path.toLowerCase().includes(query.toLowerCase()),
          )}
        onSelected={(path: string) => void changeAgentFolder(path)}
        onSubmit={(path: string) => void changeAgentFolder(path)}
      />
    </SettingItem>
  </SettingGroup>

  <SettingGroup heading="Chats">
    <SettingItem name="Chats folder" desc="Folder to store chat files and related data">
      <FolderSuggest
        app={plugin.app}
        value={pluginData.targetFolder}
        placeholder="Chats"
        suggestionFn={(query) =>
          suggestFolders().filter((folder) =>
            folder.path.toLowerCase().includes(query.toLowerCase()),
          )}
        onSelected={(path: string) => (pluginData.targetFolder = path)}
        onSubmit={(path: string) => (pluginData.targetFolder = path)}
      />
    </SettingItem>

    <SettingItem
      name="Attachment folder"
      desc="Folder for chat file attachments. Leave empty to use Obsidian's attachment folder."
    >
      <FolderSuggest
        app={plugin.app}
        value={pluginData.attachmentFolder}
        placeholder={pluginData.resolvedAttachmentFolder}
        suggestionFn={(query) =>
          suggestFolders().filter((folder) =>
            folder.path.toLowerCase().includes(query.toLowerCase()),
          )}
        onSelected={(path: string) => (pluginData.attachmentFolder = path)}
        onSubmit={(path: string) => (pluginData.attachmentFolder = path)}
      />
    </SettingItem>

    <SettingItem name="Open new chat in" desc="Where to open new chat windows">
      <Dropdown
        type="options"
        dropdown={chatOpenLocationOptions}
        selected={pluginData.chatOpenLocation}
        onchange={(value) => (pluginData.chatOpenLocation = value)}
      />
    </SettingItem>

    <!-- Obsidian mobile has no status bar (addStatusBarItem is a no-op there), so the
         toggle would control nothing. Hide it rather than offering a dead switch. -->
    {#if !isMobileUI()}
      <SettingItem
        name="Show active agents in status bar"
        desc="Display a clickable indicator in the status bar for each chat with a running agent."
      >
        <Toggle
          checked={pluginData.showActiveAgentsInStatusBar}
          onchange={(checked) => (pluginData.showActiveAgentsInStatusBar = checked)}
        />
      </SettingItem>
    {/if}
  </SettingGroup>
</div>

<style>
  .agents-settings {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .agent-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 10px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    color: var(--text-muted);
  }

  .agent-avatar--default {
    background: color-mix(in srgb, var(--interactive-accent) 16%, var(--background-secondary));
    border-color: color-mix(in srgb, var(--interactive-accent) 45%, var(--background-modifier-border));
    color: var(--text-accent);
  }

  /* These live inside ManagedEntityItem's `children` snippet and are only referenced
     within {#if} branches, so Svelte's scoped-CSS analysis prunes the plain-class rules
     (unlike .agent-avatar, which survives via its class: directive). Scope them with
     :global so the flex layout actually reaches the rendered row. */
  :global(.agent-summary-row) {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 14px;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  :global(.agent-model-summary) {
    color: var(--text-muted);
  }

  :global(.agent-skills-icons) {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--text-muted);
  }

  :global(.agent-skills-overflow) {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
</style>
