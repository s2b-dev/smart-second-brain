<script lang="ts">
import { onMount } from "svelte";
import { t } from "../../i18n";
import type { BuiltInToolId } from "../../types/plugin";
import type SecondBrainPlugin from "../../main";
import { getToolDisplayName } from "../../agent/tools/builtInToolDefaults";
import ToolConfigForm from "./ToolConfigForm.svelte";
import type { ToolConfigAccessors, ToolConfigModal } from "./ToolConfigModal";

interface Props {
	modal: ToolConfigModal;
	plugin: SecondBrainPlugin;
	toolId: BuiltInToolId;
	onSave: () => void;
	accessors?: ToolConfigAccessors;
}

const { modal, plugin, toolId, onSave, accessors }: Props = $props();

const capturedToolId = (() => toolId)();
const configuredName = (() => accessors?.getToolConfig()?.name)();

onMount(() => {
	modal.setTitle(t("agents.tool_config.title", { name: getToolDisplayName(capturedToolId, configuredName) }));
});
</script>

<ToolConfigForm
  {plugin}
  toolId={capturedToolId}
  {accessors}
  footer="modal"
  onSave={() => onSave()}
  onCancel={() => modal.close()}
/>
