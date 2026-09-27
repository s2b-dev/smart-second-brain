<script lang="ts">
import { Notice } from "obsidian";
import { get } from "svelte/store";
import { t } from "svelte-i18n";
import SettingGroup from "../../components/settings/SettingGroup.svelte";
import SettingItem from "../../components/settings/SettingItem.svelte";
import Button from "../../components/ui/Button.svelte";
import Toggle from "../../components/ui/Toggle.svelte";
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import { ConfirmModal } from "../../components/modal/ConfirmModal";
import DocsLink from "../../components/ui/DocsLink.svelte";
import ExternalLinkButton from "../../components/ui/ExternalLinkButton.svelte";
import { Logger } from "../../utils/logging";

const pluginData = getData();
const plugin = getPlugin();
const githubIssuesListUrl =
	"https://github.com/s2b-dev/smart-second-brain/issues?q=is%3Aissue%20state%3Aopen%20label%3Abug";
const githubIssuesNewUrl = "https://github.com/s2b-dev/smart-second-brain/issues/new/choose";

async function handleCleanupPluginData() {
	const modal = new ConfirmModal(
		plugin.app,
		get(t)("settings.clear_modal.title"),
		get(t)("settings.clear_modal.description"),
		"Delete",
	);
	modal.open();
	if (!(await modal.promise).confirmed) return;

	try {
		// Each index is deleted independently, and a failure does not abort the cleanup:
		// `deleteIndex` rejects when its IndexedDB databases can't be dropped (e.g. a
		// connection still holds one), and letting that propagate would skip `deleteData()`
		// entirely — so "clear plugin data" would leave the plugin data behind too.
		const failed: string[] = [];
		for (const index of [...pluginData.embeddingIndexes]) {
			try {
				await plugin.vectorStoreService.deleteIndex(index.id);
			} catch (error) {
				failed.push(index.id);
				Logger.error(`[Troubleshooting] Failed to delete embedding index ${index.id}:`, error);
			}
		}

		await pluginData.deleteData();
		if (failed.length > 0) {
			new Notice(
				`Plugin data cleared, but the stored vectors for ${failed.join(", ")} could not be deleted. See the console for details.`,
			);
		} else {
			new Notice(get(t)("plugin_data_cleared"));
		}
	} catch (error) {
		new Notice(error instanceof Error ? error.message : "Failed to clean plugin data");
	}
}
</script>

<!-- Diagnostics -->
<SettingGroup heading="Diagnostics">
  <SettingItem name={$t("settings.verbose")} desc={$t("settings.verbose_desc")}>
    <Toggle
      checked={pluginData.isVerbose}
      onchange={(checked) => (pluginData.isVerbose = checked)}
    />
  </SettingItem>
</SettingGroup>

<!-- Maintenance -->
<SettingGroup heading="Maintenance">
  <SettingItem
    name="Release notes"
    desc={`You are on version ${plugin.manifest.version}. See what changed in recent releases.`}
  >
    <Button buttonText="Show release notes" onClick={() => void plugin.showReleaseNotes()} />
  </SettingItem>

  <!-- Docs first, GitHub as the escalation path: the troubleshooting guide is
       organised by symptom (the agent won't respond, search returns nothing, a note
       is being withheld, …), so it answers most of what would otherwise arrive as
       an issue. -->
  <SettingItem
    name="Troubleshooting guide"
    desc="Common problems and how to resolve them — the agent not responding, unhelpful search results, withheld notes, missing MCP tools, and mobile-specific issues."
  >
    <DocsLink variant="button" doc="troubleshooting" label="Open guide" />
  </SettingItem>

  <SettingItem
    name="Still stuck?"
    desc="Look through existing GitHub issues to see whether the problem is already tracked. If it is not, open a new issue and include what you tried, any error messages, and steps to reproduce it."
  >
    <div class="flex gap-2 flex-wrap">
      <ExternalLinkButton href={githubIssuesListUrl} label="View existing issues" />
      <ExternalLinkButton href={githubIssuesNewUrl} label="Open new issue" />
    </div>
  </SettingItem>

  <SettingItem name={$t("settings.clear")} desc={$t("settings.clear_desc")}>
    <Button
      buttonText={$t("settings.clear_label")}
      styles="mod-warning"
      onClick={() => void handleCleanupPluginData()}
    />
  </SettingItem>
</SettingGroup>
