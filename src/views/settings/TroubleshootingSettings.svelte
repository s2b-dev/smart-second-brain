<script lang="ts">
import { Notice } from "obsidian";
import { t } from "../../i18n";
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
		t("settings.troubleshooting.clear_modal.title"),
		t("settings.troubleshooting.clear_modal.description"),
		t("common.delete"),
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
			new Notice(t("settings.troubleshooting.cleared_partial", { indexes: failed.join(", ") }));
		} else {
			new Notice(t("settings.troubleshooting.cleared"));
		}
	} catch (error) {
		new Notice(error instanceof Error ? error.message : t("settings.troubleshooting.clear_failed"));
	}
}
</script>

<!-- Diagnostics -->
<SettingGroup heading={t("settings.troubleshooting.diagnostics_heading")}>
  <SettingItem name={t("settings.troubleshooting.verbose")} desc={t("settings.troubleshooting.verbose_desc")}>
    <Toggle
      checked={pluginData.isVerbose}
      onchange={(checked) => (pluginData.isVerbose = checked)}
    />
  </SettingItem>
</SettingGroup>

<!-- Maintenance -->
<SettingGroup heading={t("settings.troubleshooting.maintenance_heading")}>
  <SettingItem
    name={t("settings.troubleshooting.release_notes")}
    desc={t("settings.troubleshooting.release_notes_desc", { version: plugin.manifest.version })}
  >
    <Button buttonText={t("settings.troubleshooting.show_release_notes")} onClick={() => void plugin.showReleaseNotes()} />
  </SettingItem>

  <!-- Docs first, GitHub as the escalation path: the troubleshooting guide is
       organised by symptom (the agent won't respond, search returns nothing, a note
       is being withheld, …), so it answers most of what would otherwise arrive as
       an issue. -->
  <SettingItem
    name={t("settings.troubleshooting.guide")}
    desc={t("settings.troubleshooting.guide_desc")}
  >
    <DocsLink variant="button" doc="troubleshooting" label={t("settings.troubleshooting.open_guide")} />
  </SettingItem>

  <SettingItem
    name={t("settings.troubleshooting.still_stuck")}
    desc={t("settings.troubleshooting.still_stuck_desc")}
  >
    <div class="s2b-flex s2b-gap-2 s2b-flex-wrap">
      <ExternalLinkButton href={githubIssuesListUrl} label={t("settings.troubleshooting.view_issues")} />
      <ExternalLinkButton href={githubIssuesNewUrl} label={t("settings.troubleshooting.new_issue")} />
    </div>
  </SettingItem>

  <SettingItem name={t("settings.troubleshooting.clear")} desc={t("settings.troubleshooting.clear_desc")}>
    <Button
      buttonText={t("settings.troubleshooting.clear_label")}
      styles="mod-warning"
      onClick={() => void handleCleanupPluginData()}
    />
  </SettingItem>
</SettingGroup>
