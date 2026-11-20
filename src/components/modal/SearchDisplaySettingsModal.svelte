<script lang="ts">
import { t } from "../../i18n";
import Button from "../ui/Button.svelte";
import SettingContainer from "../settings/SettingContainer.svelte";
import Toggle from "../ui/Toggle.svelte";
import { Platform } from "obsidian";
import type { SearchDisplaySettingsModal } from "./SearchDisplaySettingsModal";
import { getData } from "../../stores/dataStore.svelte";
import { icon } from "../../utils/utils";

const tabKey = Platform.isMacOS ? "⇥" : "Tab";
const modEnterKey = Platform.isMacOS ? "⌘↵" : "Ctrl+↵";
const altEnterKey = Platform.isMacOS ? "⌥↵" : "Alt+↵";

interface Props {
	modal: SearchDisplaySettingsModal;
}

const pluginData = getData();

let { modal }: Props = $props();

// Tags are suppressed in phone search results — the strip is `max-content` wide
// and crushes the note name. Mirror that here so the preview and the toggle tell
// the truth about what the user will actually see.
const tagsAvailable = !Platform.isPhone;
const showTags = $derived(pluginData.searchShowTags && tagsAvailable);

const enabledCount = $derived.by(() => {
	let count = 0;
	if (pluginData.searchShowPath) count += 1;
	if (showTags) count += 1;
	if (pluginData.searchShowMatchBadges) count += 1;
	if (pluginData.searchShowMatchContext) count += 1;
	if (pluginData.searchShowKeyboardHints) count += 1;
	return count;
});
</script>

<div class="modal-title">{t("modals.search_display.title")}</div>

<div class="modal-content search-display-settings-modal">
  <p class="search-display-settings-intro">{t("modals.search_display.intro")}</p>

  <div class="search-display-settings-preview-panel">
    <div class="search-display-settings-preview-header">
      <div class="search-display-settings-preview-title">{t("modals.search_display.preview")}</div>
      <div class="search-display-settings-preview-count">
        {t("modals.search_display.enabled_count", { enabled: enabledCount, total: tagsAvailable ? 5 : 4 })}
      </div>
    </div>

    <div class="search-display-settings-preview-card">
      <div class="s2b-search-result">
        <div class="s2b-search-result-title">
          <div class="s2b-search-result-title-meta">
            <span class="s2b-search-result-note-icon" aria-hidden="true" use:icon={"file-text"}
            ></span>
            <span class="s2b-search-result-name" title={t("modals.search_display.sample_note_name")}>
              {t("modals.search_display.sample_note_name")}
            </span>

            {#if pluginData.searchShowPath || showTags}
              <div class="s2b-search-result-title-secondary">
                {#if pluginData.searchShowPath}
                  <span class="s2b-search-result-separator">•</span>
                  <span class="s2b-search-result-path" title="Research/AI">Research/AI</span>
                {/if}

                {#if showTags}
                  <div class="s2b-search-result-tags">
                    <span class="s2b-search-result-tag">
                      <span class="s2b-search-result-tag-label">ml</span>
                    </span>
                    <span class="s2b-search-result-tag">
                      <span class="s2b-search-result-tag-label">deep-learning</span>
                    </span>
                  </div>
                {/if}
              </div>
            {/if}
          </div>

          {#if pluginData.searchShowMatchBadges}
            <div class="s2b-search-result-badges">
              <span
                class="s2b-search-result-badge s2b-search-result-badge-title"
                aria-label={t("modals.search_display.badge_title")}
                title={t("modals.search_display.badge_title")}
              >
                <span class="s2b-search-result-badge-icon" aria-hidden="true" use:icon={"heading"}
                ></span>
              </span>
              <span
                class="s2b-search-result-badge s2b-search-result-badge-tag"
                aria-label={t("modals.search_display.badge_tag")}
                title={t("modals.search_display.badge_tag")}
              >
                <span class="s2b-search-result-badge-icon" aria-hidden="true" use:icon={"tags"}
                ></span>
              </span>
              <span
                class="s2b-search-result-badge s2b-search-result-badge-content"
                aria-label={t("modals.search_display.badge_content")}
                title={t("modals.search_display.badge_content")}
              >
                <span
                  class="s2b-search-result-badge-icon"
                  aria-hidden="true"
                  use:icon={"align-left"}
                ></span>
              </span>
            </div>
          {/if}
        </div>

        {#if pluginData.searchShowMatchContext}
          <div class="s2b-search-result-explanation">
            <div class="s2b-search-result-heading">## {t("modals.search_display.sample_heading")}</div>
            <div class="s2b-search-result-snippet">
              {t("modals.search_display.sample_snippet")}
            </div>
          </div>
        {/if}
      </div>

      {#if pluginData.searchShowKeyboardHints}
        <div class="prompt-instructions">
          <div class="prompt-instruction"><span class="prompt-instruction-command">↑↓</span><span>{t("modals.search.hint_navigate")}</span></div>
          <div class="prompt-instruction"><span class="prompt-instruction-command">↵</span><span>{t("modals.search.open_note")}</span></div>
          <div class="prompt-instruction"><span class="prompt-instruction-command">{modEnterKey}</span><span>{t("modals.search.hint_open_new_tab")}</span></div>
          <div class="prompt-instruction"><span class="prompt-instruction-command">{altEnterKey}</span><span>{t("modals.search.hint_ask_agent")}</span></div>
          <div class="prompt-instruction"><span class="prompt-instruction-command">⇧↵</span><span>{t("modals.search.hint_create_note")}</span></div>
          <div class="prompt-instruction"><span class="prompt-instruction-command">{tabKey}</span><span>{t("modals.search.hint_semantic_off")}</span></div>
          <div class="prompt-instruction"><span class="prompt-instruction-command">esc</span><span>{t("common.close")}</span></div>
        </div>
      {/if}
    </div>
  </div>

  <SettingContainer name={t("modals.search_display.path_label")} desc={t("modals.search_display.path_desc")}>
    <Toggle
      checked={pluginData.searchShowPath}
      onchange={(checked) => (pluginData.searchShowPath = checked)}
    />
  </SettingContainer>

  <SettingContainer
    name={t("modals.search_display.tags_label")}
    desc={tagsAvailable
      ? t("modals.search_display.tags_desc")
      : t("modals.search_display.tags_desc_phone")}
  >
    <Toggle
      checked={showTags}
      disabled={!tagsAvailable}
      onchange={(checked) => (pluginData.searchShowTags = checked)}
    />
  </SettingContainer>

  <SettingContainer
    name={t("modals.search_display.badges_label")}
    desc={t("modals.search_display.badges_desc")}
  >
    <Toggle
      checked={pluginData.searchShowMatchBadges}
      onchange={(checked) => (pluginData.searchShowMatchBadges = checked)}
    />
  </SettingContainer>

  <SettingContainer
    name={t("modals.search_display.snippets_label")}
    desc={t("modals.search_display.snippets_desc")}
  >
    <Toggle
      checked={pluginData.searchShowMatchContext}
      onchange={(checked) => (pluginData.searchShowMatchContext = checked)}
    />
  </SettingContainer>

  <SettingContainer
    name={t("modals.search_display.shortcuts_label")}
    desc={t("modals.search_display.shortcuts_desc")}
  >
    <Toggle
      checked={pluginData.searchShowKeyboardHints}
      onchange={(checked) => (pluginData.searchShowKeyboardHints = checked)}
    />
  </SettingContainer>
</div>

<div class="modal-button-container">
  <Button buttonText={t("common.done")} onClick={() => modal.close()} />
</div>

<style>
  .search-display-settings-modal {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .search-display-settings-intro {
    margin: 0;
    color: var(--text-muted);
  }

  .search-display-settings-preview-panel {
    border: 1px solid var(--background-modifier-border);
    border-radius: 12px;
    padding: 14px;
    background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--background-secondary) 86%, transparent),
        transparent
      ),
      var(--background-primary-alt, var(--background-primary));
  }

  .search-display-settings-preview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .search-display-settings-preview-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-normal);
  }

  .search-display-settings-preview-count {
    font-size: 0.75rem;
    line-height: 1.2;
    color: var(--text-muted);
    padding: 2px 8px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 999px;
    background: var(--background-secondary);
  }

  .search-display-settings-preview-card {
    padding: 14px;
    border-radius: 10px;
    background: var(--background-primary);
    border: 1px solid color-mix(in srgb, var(--background-modifier-border) 80%, transparent);
  }

  .search-display-settings-preview-card :global(.s2b-search-result-name) {
    max-width: clamp(8rem, 24vw, 18rem);
  }

  .search-display-settings-preview-card :global(.s2b-search-result-badges) {
    margin-left: 0;
  }

  .search-display-settings-preview-card :global(.s2b-search-result-tag) {
    --tag-color: var(--text-accent);
    --tag-background: color-mix(in srgb, var(--interactive-accent) 10%, transparent);
    --tag-border-color: color-mix(in srgb, var(--interactive-accent) 25%, transparent);
  }

  .search-display-settings-preview-card :global(.prompt-instructions) {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--background-modifier-border);
  }
</style>
