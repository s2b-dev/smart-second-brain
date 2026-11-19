<script lang="ts">
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
	if (pluginData.searchShowPath) enabledLabels.push("Path");
	if (pluginData.searchShowTags) enabledLabels.push("Tags");
	if (pluginData.searchShowMatchBadges) enabledLabels.push("Match badges");
	if (pluginData.searchShowMatchContext) enabledLabels.push("Content snippets");

	return enabledLabels.length > 0 ? enabledLabels.join(", ") : "Nothing extra";
});

function openDisplaySettingsModal() {
	new SearchDisplaySettingsModal(plugin.app).open();
}
</script>

<SettingGroup heading="Display">
  <SettingItem
    name="Result details"
    desc={`Choose which metadata and context appear in each search result. Currently: ${displaySummary}.`}
  >
    <Button buttonText="Configure" onClick={openDisplaySettingsModal} />
  </SettingItem>

  {#if isMobileUI()}
    <SettingItem
      name="Use S2B search in the navbar"
      desc="Make the magnifier button in the bottom navbar open Smart Second Brain search instead of Obsidian's quick switcher. Only that button changes — the quick switcher still opens from the command palette and its hotkey."
    >
      <Toggle
        checked={pluginData.overrideMobileNavbarSearch}
        onchange={(checked) => (pluginData.overrideMobileNavbarSearch = checked)}
      />
    </SettingItem>
  {/if}
</SettingGroup>

<SettingGroup
  heading="Indexed content"
  headingDesc="Notes, canvases and widgets are always indexed. Choose which other files have their contents indexed for search and embeddings — the rest are still found by title and path, and the agent can still read them on demand."
>
  <SettingItem
    name="PDFs"
    desc="Extract and index the text of PDFs. Slow on large libraries, and most of a long PDF is rarely relevant. Long PDFs are indexed up to roughly their first 80 pages (4 on mobile)."
  >
    <Toggle checked={pluginData.contentIndexing.pdfs} onchange={(checked) => pluginData.setContentIndexed("pdfs", checked)} />
  </SettingItem>
  <SettingItem
    name="Chats"
    desc="Index past conversations. They are mostly the model's own answers, which can then come back as if they were sources."
  >
    <Toggle
      checked={pluginData.contentIndexing.chats}
      onchange={(checked) => pluginData.setContentIndexed("chats", checked)}
    />
  </SettingItem>
  <SettingItem
    name="Data files"
    desc="Index CSV, JSON and YAML files. Structured data searches poorly by meaning, and a single export can add thousands of entries."
  >
    <Toggle checked={pluginData.contentIndexing.data} onchange={(checked) => pluginData.setContentIndexed("data", checked)} />
  </SettingItem>
</SettingGroup>

<EmbeddingIndexSection purpose="search" />
