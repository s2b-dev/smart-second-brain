<script lang="ts">
import { Notice } from "obsidian";
import SettingGroup from "../../components/settings/SettingGroup.svelte";
import SettingItem from "../../components/settings/SettingItem.svelte";
import SecretSelect from "../../components/settings/SecretSelect.svelte";
import Button from "../../components/ui/Button.svelte";
import Dropdown from "../../components/ui/Dropdown.svelte";
import Text from "../../components/ui/Text.svelte";
import Toggle from "../../components/ui/Toggle.svelte";
import { createObsidianFetch } from "../../lib/obsidianFetch";
import { suggestSecretId } from "../../lib/secretStorage";
import { getData } from "../../stores/dataStore.svelte";
import { VOICE_ORB_STYLES } from "../../stores/voiceDefaults";
import { getPlugin } from "../../stores/state.svelte";
import { VIEW_TYPE_ONBOARDING } from "../onboarding/OnboardingView";

const pluginData = getData();
const plugin = getPlugin();
const DEFAULT_LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";
let langSmithEndpointDraft = $state(pluginData.langSmithEndpoint);
let langSmithCheckState = $state<"idle" | "pending" | "success" | "error">("idle");
let langSmithCheckMessage = $state("Check LangSmith connection");

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
	new Notice("Onboarding reset and reopened — the intro will replay from the start.");
}

function restoreDismissedRecommendations() {
	const count = pluginData.dismissedRecommendations.length;
	pluginData.restoreDismissedRecommendations();
	new Notice(
		count > 0
			? `Restored ${count} dismissed recommendation${count === 1 ? "" : "s"}.`
			: "No dismissed recommendations to restore.",
	);
}

function restoreIntegrationPrivacyWarning() {
	const wasSuppressed = pluginData.suppressIntegrationPrivacyWarning;
	pluginData.suppressIntegrationPrivacyWarning = false;
	new Notice(
		wasSuppressed
			? "Integration privacy warning restored — it will show again next time an integration is enabled."
			: "Integration privacy warning was not suppressed.",
	);
}

function getLangSmithCheckIcon(): string {
	if (langSmithCheckState === "success") return "check-circle";
	if (langSmithCheckState === "error") return "x-circle";
	return "refresh-cw";
}

function getLangSmithCheckButtonStyles(): string {
	if (langSmithCheckState === "success") return "langsmith-check-button is-success";
	if (langSmithCheckState === "error") return "langsmith-check-button is-error";
	if (langSmithCheckState === "pending") return "langsmith-check-button is-pending";
	return "langsmith-check-button";
}

function normalizeLangSmithEndpoint(endpoint: string): string {
	return (endpoint.trim() || DEFAULT_LANGSMITH_ENDPOINT).replace(/\/+$/, "");
}

async function handleCheckLangSmithConnection() {
	const apiKey = pluginData.langSmithApiKey;
	if (!pluginData.langSmithApiKeyId || !apiKey) {
		langSmithCheckState = "error";
		langSmithCheckMessage = "Select a LangSmith API key secret first";
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
		langSmithCheckMessage = "Invalid LangSmith endpoint URL";
		new Notice(langSmithCheckMessage);
		return;
	}

	langSmithCheckState = "pending";
	langSmithCheckMessage = "Checking LangSmith connection...";

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
			langSmithCheckMessage = "LangSmith connection successful";
			new Notice(langSmithCheckMessage);
			return;
		}

		const responseText = (await response.text()).trim();
		if (response.status === 401 || response.status === 403) {
			langSmithCheckState = "error";
			langSmithCheckMessage = "LangSmith rejected the API key";
		} else if (response.status === 404) {
			langSmithCheckState = "error";
			langSmithCheckMessage = "LangSmith endpoint did not expose the expected API";
		} else {
			langSmithCheckState = "error";
			langSmithCheckMessage = responseText
				? `LangSmith check failed (${response.status}): ${responseText}`
				: `LangSmith check failed with status ${response.status}`;
		}
		new Notice(langSmithCheckMessage);
	} catch (error) {
		langSmithCheckState = "error";
		langSmithCheckMessage = error instanceof Error ? error.message : "Failed to reach LangSmith";
		new Notice(`LangSmith check failed: ${langSmithCheckMessage}`);
	}
}
</script>

<!-- Onboarding -->
<SettingGroup heading="Onboarding">
  <SettingItem
    name="Replay onboarding intro"
    desc="Reset the splash animation and completion flags — the Welcome view plays its intro again, and auto-opens on startup as if this were a first run (until a provider is configured)."
  >
    <Button buttonText="Reset intro" iconId="rotate-ccw" onClick={replayOnboardingIntro} />
  </SettingItem>
</SettingGroup>

<!-- Chat -->
<SettingGroup heading="Chat">
  <SettingItem
    name="Show raw tool input/output"
    desc="Reveal the exact tool arguments and raw output blob in chat tool-call rows. Off by default — users see only the plain-language summary and the friendly structured result."
  >
    <Toggle
      checked={pluginData.showToolIODetails}
      onchange={(checked) => (pluginData.showToolIODetails = checked)}
    />
  </SettingItem>
  <SettingItem name="Voice orb style" desc="How the voice-mode orb looks and moves. Takes effect the next time voice mode starts.">
    <Dropdown
      type="options"
      dropdown={VOICE_ORB_STYLES.map((s) => ({ display: s.display, value: s.value }))}
      selected={pluginData.voice.orbStyle}
      onchange={(value) => pluginData.setVoice({ orbStyle: value })}
    />
  </SettingItem>

  <SettingItem
    name="Restore dismissed recommendations"
    desc="Bring back every suggested query, plugin skill nudge, and updated-default notice dismissed from a new chat's empty state."
  >
    <Button
      buttonText="Restore"
      iconId="rotate-ccw"
      onClick={restoreDismissedRecommendations}
    />
  </SettingItem>

  <SettingItem
    name="Restore integration privacy warning"
    desc="Undo 'Don't ask again' on the warning shown before enabling a plugin integration's code-exec tool (it bypasses per-provider privacy rules)."
  >
    <Button
      buttonText="Restore"
      iconId="rotate-ccw"
      onClick={restoreIntegrationPrivacyWarning}
    />
  </SettingItem>
</SettingGroup>

<!-- Observability -->
<SettingGroup heading="Observability">
  <SettingItem
    name="LangSmith integration"
    desc="Enable LangSmith telemetry for debugging and tracing"
  >
    <Toggle
      checked={pluginData.enableLangSmith}
      onchange={(checked) => (pluginData.enableLangSmith = checked)}
    />
  </SettingItem>

  {#if pluginData.enableLangSmith}
    <SettingItem
      name="API key"
      desc="Select an Obsidian keychain secret for LangSmith authentication"
    >
      <SecretSelect
        value={pluginData.langSmithApiKeyId}
        suggestedId={suggestSecretId(plugin.app, "LangSmith", "apiKey")}
        onChange={(secretId) => (pluginData.langSmithApiKeyId = secretId)}
      />
    </SettingItem>

    <SettingItem name="Project name" desc="Project name to attribute runs">
      <Text
        placeholder="obsidian-agent"
        inputType="text"
        value={pluginData.langSmithProject}
        onblur={(v) => (pluginData.langSmithProject = v)}
      />
    </SettingItem>

    <SettingItem name="Endpoint URL" desc="Override LangSmith API base URL (optional)">
      <div class="flex items-center gap-2 w-full">
        <Button
          iconId={getLangSmithCheckIcon()}
          ariaLabel="Check LangSmith API key and endpoint"
          tooltip={langSmithCheckMessage}
          styles={getLangSmithCheckButtonStyles()}
          disabled={langSmithCheckState === "pending"}
          onClick={() => void handleCheckLangSmithConnection()}
        />
        <Text
          placeholder={DEFAULT_LANGSMITH_ENDPOINT}
          inputType="text"
          bind:value={langSmithEndpointDraft}
          class="flex-1"
          onblur={(v) => (pluginData.langSmithEndpoint = v)}
        />
      </div>
    </SettingItem>
  {/if}
</SettingGroup>

<style>
  :global(.langsmith-check-button) {
    color: var(--text-muted);
  }

  :global(.langsmith-check-button.is-success) {
    color: var(--text-success, #4caf50);
  }

  :global(.langsmith-check-button.is-error) {
    color: var(--text-error);
  }

  :global(.langsmith-check-button.is-pending .s2b-button-icon) {
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
