<script lang="ts">
import { getData } from "../../stores/dataStore.svelte";
import type SecondBrainPlugin from "../../main";
import { BUILT_IN_TOOL_IDS, type BuiltInToolId, type ToolConfig } from "../../types/plugin";
import {
	getToolDescription,
	getToolDisplayName,
	toolHasConfigurableSettings,
} from "../../agent/tools/builtInToolDefaults";
import { toExecToolId } from "../../agent/integrations/pluginIntegrations";
import { humanizeSkillName } from "../../skills";
import Button from "../ui/Button.svelte";
import Toggle from "../ui/Toggle.svelte";
import Badge from "../ui/Badge.svelte";
import ManagedEntityItem from "../settings/ManagedEntityItem.svelte";
import ManagedEntitySection from "../settings/ManagedEntitySection.svelte";
import { ToolConfigModal } from "./ToolConfigModal";
import type { ToolsModal } from "./ToolsModal";
import type { ToolConfigAccessors } from "./ToolConfigModal";

interface Props {
	modal: ToolsModal;
	plugin: SecondBrainPlugin;
	agentId: string;
	onChange?: () => void;
}

const { modal, plugin, agentId, onChange }: Props = $props();
const pluginData = getData();

const selectedAgent = $derived(pluginData.agents[agentId]);

/** Enabled skills (by display name) that attach each built-in tool via `allowed-tools`. */
const attachingSkills = $derived.by<Map<BuiltInToolId, string[]>>(() => {
	const map = new Map<BuiltInToolId, string[]>();
	const cache = plugin.skillsService?.getCachedSkills();
	const agent = selectedAgent;
	if (!cache || !agent) return map;
	const builtIn = new Set<string>(BUILT_IN_TOOL_IDS);
	for (const [name, meta] of cache) {
		if (!(agent.skills[name]?.enabled ?? true)) continue;
		const spec = meta.frontmatter.allowedTools;
		if (!spec) continue;
		const displayName = humanizeSkillName(meta.frontmatter.name ?? name);
		for (const raw of spec.split(/\s+/)) {
			const id = raw.trim();
			if (!id || !builtIn.has(id)) continue;
			const toolId = id as BuiltInToolId;
			const existing = map.get(toolId);
			if (existing) existing.push(displayName);
			else map.set(toolId, [displayName]);
		}
	}
	return map;
});

/** Enabled plugin integrations whose `execute_plugin_api` exec-tool is currently on. */
const activeIntegrations = $derived.by(() => {
	const agent = selectedAgent;
	if (!agent) return [];
	return (plugin.agentManager?.resolvePluginIntegrations() ?? []).filter(
		(integ) => agent.pluginExecTools?.[toExecToolId(integ.pluginId)] ?? false,
	);
});

/** Subagents currently enabled on this agent, resolved to their display names. */
const activeSubAgents = $derived.by(() => {
	const agent = selectedAgent;
	if (!agent) return [];
	return (agent.subAgentIds ?? [])
		.map((id) => pluginData.agents[id])
		.filter((ref): ref is NonNullable<typeof ref> => !!ref)
		.map((ref) => (ref.id === agentId ? `${ref.name} (isolated)` : ref.name));
});

function notifyChange() {
	plugin.agentManager?.invalidateAgentRunnable(agentId);
	plugin.agentManager?.invalidateSystemPromptCaches();
	onChange?.();
}

function toolAccessors(toolId: BuiltInToolId): ToolConfigAccessors {
	return {
		agentId,
		getToolConfig: () => pluginData.agents[agentId]?.toolsConfig[toolId],
		updateToolConfig: (config: Partial<ToolConfig>) => pluginData.updateAgentToolConfig(agentId, toolId, config),
	};
}

function isToolEnabled(toolId: BuiltInToolId): boolean {
	return pluginData.isAgentToolEnabled(agentId, toolId);
}

function toggleTool(toolId: BuiltInToolId) {
	pluginData.toggleAgentToolEnabled(agentId, toolId);
	notifyChange();
}

function openToolConfig(toolId: BuiltInToolId) {
	new ToolConfigModal(plugin, toolId, notifyChange, toolAccessors(toolId)).open();
}
</script>

<div class="tools-modal-content">
  {#if selectedAgent}
    <div class="tools-modal-scroll">
      <ManagedEntitySection
        heading="Configurable"
        description="Enable, rename, and configure the individual tools your skills attach. A tool is only usable when at least one enabled skill provides it."
        hasItems={true}
      >
        {#each BUILT_IN_TOOL_IDS as toolId (toolId)}
          {@const config = selectedAgent.toolsConfig[toolId]}
          {@const skills = attachingSkills.get(toolId) ?? []}
          {@const isInteractive = toolId === "ask_question"}
          {@const attached = skills.length > 0 || isInteractive}
          {@const enabled = isToolEnabled(toolId)}
          {@const displayName = getToolDisplayName(toolId, config?.name)}
          <ManagedEntityItem
            name={displayName}
            desc={getToolDescription(toolId, config?.description)}
            disabled={!attached}
          >
            {#snippet badges()}
              {#if attached && !isInteractive}
                {#each skills as skillName (skillName)}
                  <Badge label={skillName} tone="accent" />
                {/each}
              {:else if !attached}
                <Badge label="Not attached by any enabled skill" tone="warning" />
              {/if}
            {/snippet}
            {#snippet actions()}
              {#if toolHasConfigurableSettings(toolId)}
                <Button
                  iconId="settings"
                  ariaLabel={`Configure ${displayName}`}
                  tooltip="Configure tool"
                  onClick={() => openToolConfig(toolId)}
                />
              {/if}
              <Toggle checked={enabled} disabled={!attached} onchange={() => toggleTool(toolId)} />
            {/snippet}
          </ManagedEntityItem>
        {/each}
      </ManagedEntitySection>

      {#if activeIntegrations.length > 0 || activeSubAgents.length > 0}
        <ManagedEntitySection
          heading="Always available"
          description="Bound outside the skills system, so they aren't configured here — each is controlled by its own setting."
          hasItems={true}
        >
          <ManagedEntityItem
            name="Load skill"
            desc="Lets the agent load a skill's full instructions on demand. Always available whenever any skill exists."
          />
          {#each activeIntegrations as integ (integ.pluginId)}
            <ManagedEntityItem
              name={`Execute Plugin API — ${integ.displayName}`}
              desc={`Lets the agent script against the ${integ.displayName} plugin's api. Controlled in this agent's Integrations section above.`}
            >
              {#snippet badges()}
                <Badge label="Integrations" tone="accent" />
              {/snippet}
            </ManagedEntityItem>
          {/each}
          {#each activeSubAgents as name (name)}
            <ManagedEntityItem
              name={`Task — ${name}`}
              desc="Lets the agent delegate a subtask to this subagent. Controlled in this agent's Subagents section above."
            >
              {#snippet badges()}
                <Badge label="Subagents" tone="accent" />
              {/snippet}
            </ManagedEntityItem>
          {/each}
        </ManagedEntitySection>
      {/if}
    </div>
  {/if}

  <div class="tools-modal-footer">
    <div class="flex-1"></div>
    <Button buttonText="Done" cta={true} onClick={() => modal.close()} />
  </div>
</div>

<style>
  .tools-modal-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  /* `.setting-group` collides with an Obsidian core rule (`max-width: 700px; margin: 0 auto`)
     meant for the native settings tab. Inside this wide modal that would center the tool list;
     neutralize it here (scoped to this component) rather than globally — same fix already
     applied in ToolConfigForm.svelte for the same reason. */
  .tools-modal-content :global(.setting-group) {
    max-width: none;
    margin-left: 0;
    margin-right: 0;
  }

  .tools-modal-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding-right: 4px;
  }

  .tools-modal-footer {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    border-top: 1px solid var(--background-modifier-border);
    padding-top: 16px;
    margin-top: 12px;
  }
</style>
