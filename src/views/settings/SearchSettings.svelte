<script lang="ts">
import { t } from "../../i18n";
import { SearchDisplaySettingsModal } from "../../components/modal/SearchDisplaySettingsModal";
import EmbeddingIndexSection from "../../components/settings/EmbeddingIndexSection.svelte";
import SettingGroup from "../../components/settings/SettingGroup.svelte";
import SettingItem from "../../components/settings/SettingItem.svelte";
import Button from "../../components/ui/Button.svelte";
import Toggle from "../../components/ui/Toggle.svelte";
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import { isMobileUI } from "../../utils/platform";

const pluginData = getData();
const plugin = getPlugin();

const displaySummary = $derived.by(() => {
	const enabledLabels: string[] = [];
	if (pluginData.searchShowPath) enabledLabels.push(t("settings.search.display.label_path"));
	if (pluginData.searchShowTags) enabledLabels.push(t("settings.search.display.label_tags"));
	if (pluginData.searchShowMatchBadges) enabledLabels.push(t("settings.search.display.label_match_badges"));
	if (pluginData.searchShowMatchContext) enabledLabels.push(t("settings.search.display.label_content_snippets"));

	return enabledLabels.length > 0 ? enabledLabels.join(", ") : t("settings.search.display.nothing_extra");
});

function openDisplaySettingsModal() {
	new SearchDisplaySettingsModal(plugin.app).open();
}
</script>

<SettingGroup heading={t("settings.search.display.heading")}>
  <SettingItem
    name={t("settings.search.display.result_details")}
    desc={t("settings.search.display.result_details_desc", { summary: displaySummary })}
  >
    <Button buttonText={t("settings.search.display.configure")} onClick={openDisplaySettingsModal} />
  </SettingItem>

  {#if isMobileUI()}
    <SettingItem
      name={t("settings.search.display.navbar_search")}
      desc={t("settings.search.display.navbar_search_desc")}
    >
      <Toggle
        checked={pluginData.overrideMobileNavbarSearch}
        onchange={(checked) => (pluginData.overrideMobileNavbarSearch = checked)}
      />
    </SettingItem>
  {/if}
</SettingGroup>

<SettingGroup
  heading={t("settings.search.indexed_content.heading")}
  headingDesc={t("settings.search.indexed_content.heading_desc")}
>
  <SettingItem
    name={t("settings.search.indexed_content.pdfs")}
    desc={t("settings.search.indexed_content.pdfs_desc")}
  >
    <Toggle checked={pluginData.contentIndexing.pdfs} onchange={(checked) => pluginData.setContentIndexed("pdfs", checked)} />
  </SettingItem>
  <SettingItem
    name={t("settings.search.indexed_content.chats")}
    desc={t("settings.search.indexed_content.chats_desc")}
  >
    <Toggle
      checked={pluginData.contentIndexing.chats}
      onchange={(checked) => pluginData.setContentIndexed("chats", checked)}
    />
  </SettingItem>
  <SettingItem
    name={t("settings.search.indexed_content.data_files")}
    desc={t("settings.search.indexed_content.data_files_desc")}
  >
    <Toggle checked={pluginData.contentIndexing.data} onchange={(checked) => pluginData.setContentIndexed("data", checked)} />
  </SettingItem>
</SettingGroup>

<EmbeddingIndexSection purpose="search" />
