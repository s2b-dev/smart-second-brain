<script lang="ts">
import { getData } from "../../stores/dataStore.svelte";
import { t } from "../../i18n";
import type SecondBrainPlugin from "../../main";
import { BUILT_IN_TOOL_IDS, type BuiltInToolId, type ToolConfig } from "../../types/plugin";
import {
	getToolDescription,
	getToolDisplayName,
	toolHasConfigurableSettings,
	ALWAYS_ATTACHED_TOOL_IDS,
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
		.map((ref) => (ref.id === agentId ? t("agents.tools.isolated_subagent", { name: ref.name }) : ref.name));
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
        heading={t("agents.tools.configurable_heading")}
        description={t("agents.tools.configurable_description")}
        hasItems={true}
      >
        {#each BUILT_IN_TOOL_IDS as toolId (toolId)}
          {@const skills = attachingSkills.get(toolId) ?? []}
          {@const alwaysAttached = ALWAYS_ATTACHED_TOOL_IDS.has(toolId)}
          {@const attached = alwaysAttached || skills.length > 0}
          {@const enabled = isToolEnabled(toolId)}
          {@const displayName = getToolDisplayName(toolId)}
          <ManagedEntityItem
            name={displayName}
            desc={getToolDescription(toolId)}
            disabled={!attached}
          >
            {#snippet badges()}
              {#if alwaysAttached}
                <Badge label={t("agents.tools.built_in_badge")} tone="accent" />
              {:else if attached}
                {#each skills as skillName (skillName)}
                  <Badge label={skillName} tone="accent" />
                {/each}
              {:else}
                <Badge label={t("agents.tools.not_attached_badge")} tone="warning" />
              {/if}
            {/snippet}
            {#snippet actions()}
              {#if toolHasConfigurableSettings(toolId)}
                <Button
                  iconId="settings"
                  ariaLabel={t("agents.tools.configure_aria", { name: displayName })}
                  tooltip={t("agents.tools.configure_tooltip")}
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
          heading={t("agents.tools.always_available_heading")}
          description={t("agents.tools.always_available_description")}
          hasItems={true}
        >
          <ManagedEntityItem
            name={t("agents.tools.load_skill_name")}
            desc={t("agents.tools.load_skill_desc")}
          />
          {#each activeIntegrations as integ (integ.pluginId)}
            <ManagedEntityItem
              name={t("agents.tools.exec_plugin_name", { plugin: integ.displayName })}
              desc={t("agents.tools.exec_plugin_desc", { plugin: integ.displayName })}
            >
              {#snippet badges()}
                <Badge label={t("agents.tools.integrations_badge")} tone="accent" />
              {/snippet}
            </ManagedEntityItem>
          {/each}
          {#each activeSubAgents as name (name)}
            <ManagedEntityItem
              name={t("agents.tools.task_name", { name })}
              desc={t("agents.tools.task_desc")}
            >
              {#snippet badges()}
                <Badge label={t("agents.tools.subagents_badge")} tone="accent" />
              {/snippet}
            </ManagedEntityItem>
          {/each}
        </ManagedEntitySection>
      {/if}
    </div>
  {/if}

  <div class="tools-modal-footer">
    <div class="s2b-flex-1"></div>
    <Button buttonText={t("common.done")} cta={true} onClick={() => modal.close()} />
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
