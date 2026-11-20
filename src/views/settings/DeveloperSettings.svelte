<script lang="ts">
import { Notice } from "obsidian";
import { t } from "../../i18n";
import SettingGroup from "../../components/settings/SettingGroup.svelte";
import SettingItem from "../../components/settings/SettingItem.svelte";
import SecretSelect from "../../components/settings/SecretSelect.svelte";
import Button from "../../components/ui/Button.svelte";
import Text from "../../components/ui/Text.svelte";
import Toggle from "../../components/ui/Toggle.svelte";
import { createObsidianFetch } from "../../lib/obsidianFetch";
import { suggestSecretId } from "../../lib/secretStorage";
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import { VIEW_TYPE_ONBOARDING } from "../onboarding/OnboardingView";

const pluginData = getData();
const plugin = getPlugin();
const DEFAULT_LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";
let langSmithEndpointDraft = $state(pluginData.langSmithEndpoint);
let langSmithCheckState = $state<"idle" | "pending" | "success" | "error">("idle");
let langSmithCheckMessage = $state(t("settings.developer.observability.check_idle"));

$effect(() => {
	if (langSmithCheckState !== "pending") {
		langSmithEndpointDraft = pluginData.langSmithEndpoint;
	}
});

function replayOnboardingIntro() {
	pluginData.onboardingSplashSeen = false;
	pluginData.onboardingComplete = false;

	// activateOnboardingView reveals an existing Welcome leaf rather than remounting
	// it, so if one is already open (likely, in a dev vault) the flag reset above
	// would silently not replay anything — playIntro is only computed once, at the
	// Svelte component's construction. Detach any existing leaf first to force a
	// fresh mount; this is specific to this dev action, not activateOnboardingView
	// itself, since the real "reveal what's already open" behavior is correct for
	// the startup auto-open.
	for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_ONBOARDING)) {
		leaf.detach();
	}

	// Startup auto-open also requires zero configured providers (see main.ts), which
	// a dev/test vault rarely has — so resetting the flags alone would silently do
	// nothing visible here. Open it directly instead of waiting on that gate; this
	// also closes Settings first (activateOnboardingView's own behavior), matching
	// what a real first run looks like when the plugin is enabled from Settings.
	void plugin.activateOnboardingView();
	new Notice(t("settings.developer.onboarding.reset_notice"));
}

function restoreDismissedRecommendations() {
	const count = pluginData.dismissedRecommendations.length;
	pluginData.restoreDismissedRecommendations();
	new Notice(
		count > 0
			? t("settings.developer.chat.restored_recommendations", { count })
			: t("settings.developer.chat.no_recommendations"),
	);
}

function restoreIntegrationPrivacyWarning() {
	const wasSuppressed = pluginData.suppressIntegrationPrivacyWarning;
	pluginData.suppressIntegrationPrivacyWarning = false;
	new Notice(
		wasSuppressed
			? t("settings.developer.chat.privacy_warning_restored")
			: t("settings.developer.chat.privacy_warning_not_suppressed"),
	);
}

function getLangSmithCheckIcon(): string {
	if (langSmithCheckState === "success") return "check-circle";
	if (langSmithCheckState === "error") return "x-circle";
	return "refresh-cw";
}

function getLangSmithCheckButtonStyles(): string {
	if (langSmithCheckState === "success") return "s2b-langsmith-check-button is-success";
	if (langSmithCheckState === "error") return "s2b-langsmith-check-button is-error";
	if (langSmithCheckState === "pending") return "s2b-langsmith-check-button is-pending";
	return "s2b-langsmith-check-button";
}

function normalizeLangSmithEndpoint(endpoint: string): string {
	return (endpoint.trim() || DEFAULT_LANGSMITH_ENDPOINT).replace(/\/+$/, "");
}

async function handleCheckLangSmithConnection() {
	const apiKey = pluginData.langSmithApiKey;
	if (!pluginData.langSmithApiKeyId || !apiKey) {
		langSmithCheckState = "error";
		langSmithCheckMessage = t("settings.developer.observability.check_no_key");
		new Notice(langSmithCheckMessage);
		return;
	}

	pluginData.langSmithEndpoint = langSmithEndpointDraft.trim() || DEFAULT_LANGSMITH_ENDPOINT;
	const endpoint = normalizeLangSmithEndpoint(langSmithEndpointDraft);

	let validationUrl: string;
	try {
		validationUrl = new URL("/api/v1/sessions?limit=1", `${endpoint}/`).toString();
	} catch {
		langSmithCheckState = "error";
		langSmithCheckMessage = t("settings.developer.observability.check_invalid_url");
		new Notice(langSmithCheckMessage);
		return;
	}

	langSmithCheckState = "pending";
	langSmithCheckMessage = t("settings.developer.observability.check_pending");

	try {
		const obsidianFetch = createObsidianFetch(window.fetch.bind(window));
		const response = await obsidianFetch(validationUrl, {
			method: "GET",
			headers: {
				"x-api-key": apiKey,
				accept: "application/json",
			},
		});

		if (response.ok) {
			langSmithCheckState = "success";
			langSmithCheckMessage = t("settings.developer.observability.check_success");
			new Notice(langSmithCheckMessage);
			return;
		}

		const responseText = (await response.text()).trim();
		if (response.status === 401 || response.status === 403) {
			langSmithCheckState = "error";
			langSmithCheckMessage = t("settings.developer.observability.check_rejected");
		} else if (response.status === 404) {
			langSmithCheckState = "error";
			langSmithCheckMessage = t("settings.developer.observability.check_not_found");
		} else {
			langSmithCheckState = "error";
			langSmithCheckMessage = responseText
				? t("settings.developer.observability.check_failed_body", {
						status: response.status,
						body: responseText,
					})
				: t("settings.developer.observability.check_failed_status", { status: response.status });
		}
		new Notice(langSmithCheckMessage);
	} catch (error) {
		langSmithCheckState = "error";
		langSmithCheckMessage =
			error instanceof Error ? error.message : t("settings.developer.observability.check_unreachable");
		new Notice(t("settings.developer.observability.check_failed_notice", { message: langSmithCheckMessage }));
	}
}
</script>

<!-- Onboarding -->
<SettingGroup heading={t("settings.developer.onboarding.heading")}>
  <SettingItem
    name={t("settings.developer.onboarding.replay")}
    desc={t("settings.developer.onboarding.replay_desc")}
  >
    <Button buttonText={t("settings.developer.onboarding.reset")} iconId="rotate-ccw" onClick={replayOnboardingIntro} />
  </SettingItem>
</SettingGroup>

<!-- Chat -->
<SettingGroup heading={t("settings.developer.chat.heading")}>
  <SettingItem
    name={t("settings.developer.chat.raw_tool_io")}
    desc={t("settings.developer.chat.raw_tool_io_desc")}
  >
    <Toggle
      checked={pluginData.showToolIODetails}
      onchange={(checked) => (pluginData.showToolIODetails = checked)}
    />
  </SettingItem>

  <SettingItem
    name={t("settings.developer.chat.restore_recommendations")}
    desc={t("settings.developer.chat.restore_recommendations_desc")}
  >
    <Button
      buttonText={t("settings.developer.chat.restore")}
      iconId="rotate-ccw"
      onClick={restoreDismissedRecommendations}
    />
  </SettingItem>

  <SettingItem
    name={t("settings.developer.chat.restore_privacy_warning")}
    desc={t("settings.developer.chat.restore_privacy_warning_desc")}
  >
    <Button
      buttonText={t("settings.developer.chat.restore")}
      iconId="rotate-ccw"
      onClick={restoreIntegrationPrivacyWarning}
    />
  </SettingItem>
</SettingGroup>

<!-- Observability -->
<SettingGroup heading={t("settings.developer.observability.heading")}>
  <SettingItem
    name={t("settings.developer.observability.langsmith")}
    desc={t("settings.developer.observability.langsmith_desc")}
  >
    <Toggle
      checked={pluginData.enableLangSmith}
      onchange={(checked) => (pluginData.enableLangSmith = checked)}
    />
  </SettingItem>

  {#if pluginData.enableLangSmith}
    <SettingItem
      name={t("settings.developer.observability.api_key")}
      desc={t("settings.developer.observability.api_key_desc")}
    >
      <SecretSelect
        value={pluginData.langSmithApiKeyId}
        suggestedId={suggestSecretId(plugin.app, "LangSmith", "apiKey")}
        onChange={(secretId) => (pluginData.langSmithApiKeyId = secretId)}
      />
    </SettingItem>

    <SettingItem name={t("settings.developer.observability.project")} desc={t("settings.developer.observability.project_desc")}>
      <Text
        placeholder="obsidian-agent"
        inputType="text"
        value={pluginData.langSmithProject}
        onblur={(v) => (pluginData.langSmithProject = v)}
      />
    </SettingItem>

    <SettingItem name={t("settings.developer.observability.endpoint")} desc={t("settings.developer.observability.endpoint_desc")}>
      <div class="s2b-flex s2b-items-center s2b-gap-2 s2b-w-full">
        <Button
          iconId={getLangSmithCheckIcon()}
          ariaLabel={t("settings.developer.observability.check_aria")}
          tooltip={langSmithCheckMessage}
          styles={getLangSmithCheckButtonStyles()}
          disabled={langSmithCheckState === "pending"}
          onClick={() => void handleCheckLangSmithConnection()}
        />
        <Text
          placeholder={DEFAULT_LANGSMITH_ENDPOINT}
          inputType="text"
          bind:value={langSmithEndpointDraft}
          class="s2b-flex-1"
          onblur={(v) => (pluginData.langSmithEndpoint = v)}
        />
      </div>
    </SettingItem>
  {/if}
</SettingGroup>

<style>
  :global(.s2b-langsmith-check-button) {
    color: var(--text-muted);
  }

  :global(.s2b-langsmith-check-button.is-success) {
    color: var(--text-success, #4caf50);
  }

  :global(.s2b-langsmith-check-button.is-error) {
    color: var(--text-error);
  }

  :global(.s2b-langsmith-check-button.is-pending .s2b-button-icon) {
    animation: langsmith-check-spin 1s linear infinite;
  }

  @keyframes langsmith-check-spin {
    from {
      transform: rotate(0deg);
    }

    to {
      transform: rotate(360deg);
    }
  }
</style>
