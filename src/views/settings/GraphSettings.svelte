<script lang="ts">
import { t } from "../../i18n";
import EmbeddingIndexSection from "../../components/settings/EmbeddingIndexSection.svelte";
import ModelSettingControl from "../../components/settings/ModelSettingControl.svelte";
import SettingGroup from "../../components/settings/SettingGroup.svelte";
import SettingItem from "../../components/settings/SettingItem.svelte";
import RangeSlider from "../../components/ui/RangeSlider.svelte";
import Toggle from "../../components/ui/Toggle.svelte";
import { ModelSelectionModal } from "../../components/modal/ModelSelectionModal";
import { useAvailableModels } from "../../hooks/useAvailableModels.svelte";
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";

const pluginData = getData();
const plugin = getPlugin();
const models = useAvailableModels();

// Helper to update a single graph setting field
function updateSetting<K extends keyof typeof pluginData.smartGraphSettings>(
	key: K,
	value: (typeof pluginData.smartGraphSettings)[K],
) {
	pluginData.smartGraphSettings = { ...pluginData.smartGraphSettings, [key]: value };
}

const graphChatModel = $derived(pluginData.smartGraphSettings.graphChatModel ?? null);

/**
 * Whether the configured naming model would have private titles withheld.
 *
 * Note titles are the entire payload for topic naming, so a private note is
 * withheld outright rather than partially redacted.
 */
const graphModelWithholdsPrivate = $derived(
	graphChatModel != null && !pluginData.isProviderTrusted(graphChatModel.provider),
);

/**
 * The naming-model description, which gains a warning only while it is actually
 * true — invisible for a trusted or local provider.
 *
 * Sits on the model row rather than the automatic toggle because withholding is
 * a property of the selected provider: it applies to manual naming too. Stated
 * here at all because the automatic pass deliberately runs silent (it fires on
 * every topic change, and a notice there would nag), so for a user who never
 * presses the button in the Topics panel this is the only place it surfaces.
 */
const namingModelDesc = $derived(
	graphModelWithholdsPrivate
		? t("settings.graph.topic_names.naming_model_desc_withheld")
		: t("settings.graph.topic_names.naming_model_desc"),
);

function openGraphModelSelection() {
	new ModelSelectionModal(
		plugin,
		"chat",
		graphChatModel ? { provider: graphChatModel.provider, model: graphChatModel.model } : null,
		(selected) => {
			updateSetting("graphChatModel", selected ? { ...selected, modelConfig: {} } : null);
		},
	).open();
}
</script>

<SettingGroup heading={t("settings.graph.topic_names.heading")}>
  <SettingItem name={t("settings.graph.topic_names.naming_model")} desc={namingModelDesc}>
    <ModelSettingControl
      available={models.hasProviders && models.hasModels}
      loading={models.hasProviders && models.isLoadingModels}
      configureLabel={!models.hasProviders ? t("settings.graph.topic_names.configure_provider") : t("settings.graph.topic_names.configure_models")}
      unavailableHint={!models.hasProviders ? t("settings.graph.topic_names.no_provider") : undefined}
      onConfigure={() => models.openSettings()}
      placeholder={t("settings.graph.topic_names.select_model")}
      selectedLabel={graphChatModel?.model ?? null}
      onSelect={openGraphModelSelection}
      secondaryLabel={graphChatModel ? t("settings.graph.topic_names.clear") : undefined}
      onSecondary={graphChatModel ? () => updateSetting("graphChatModel", null) : undefined}
    />
  </SettingItem>
  <SettingItem
    name={t("settings.graph.topic_names.auto_name")}
    desc={t("settings.graph.topic_names.auto_name_desc")}
  >
    <Toggle
      checked={pluginData.smartGraphSettings.autoLabelClusters ?? false}
      onchange={(value) => updateSetting("autoLabelClusters", value)}
    />
  </SettingItem>
</SettingGroup>

<!-- Selecting a graph index turns on semantic edges: notes with no wiki links are
     connected to their nearest topic, so topic detection can place them. Without
     one the graph falls back to wiki links only. -->
<EmbeddingIndexSection purpose="graph" />
