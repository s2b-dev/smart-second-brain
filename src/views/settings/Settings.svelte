<script lang="ts">
import { Tabs } from "bits-ui";
import { consumePendingSettingsTab } from "../../stores/state.svelte";
import SlidingTabs, { type SlidingTab } from "../../components/ui/SlidingTabs.svelte";
import { t } from "../../i18n";
import AgentsSettings from "./AgentsSettings.svelte";
import DeveloperSettings from "./DeveloperSettings.svelte";
import GeneralSettings from "./GeneralSettings.svelte";
import GraphSettings from "./GraphSettings.svelte";
import SearchSettings from "./SearchSettings.svelte";
import TroubleshootingSettings from "./TroubleshootingSettings.svelte";

// Check if there's a pending tab request (e.g., from "Manage Agents" button)
const pendingTab = consumePendingSettingsTab();
let activeTab = $state(pendingTab ?? "general");

const SETTINGS_TABS: SlidingTab<string>[] = [
	{ id: "general", label: t("settings.tabs.general"), icon: "settings" },
	{ id: "search", label: t("settings.tabs.search"), icon: "search" },
	{ id: "agents", label: t("settings.tabs.agents"), icon: "brain" },
	{ id: "graph", label: t("settings.tabs.graph"), icon: "git-fork" },
	{ id: "troubleshooting", label: t("settings.tabs.troubleshooting"), icon: "wrench" },
	...(import.meta.env.DEV ? [{ id: "developer", label: t("settings.tabs.developer"), icon: "code" }] : []),
];
</script>

<div class="s2b-settings-logo">
  <svg viewBox="0 0 39 11" fill="var(--text-normal)" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Smart Second Brain">
    <path d="M0.255127 10.8804V8.92945L8.88443 8.94446C9.32465 8.94446 9.65981 8.84441 9.88993 8.64431C10.13 8.4342 10.2501 8.09904 10.2501 7.63881C10.2501 7.17858 10.13 6.84841 9.88993 6.64831C9.65981 6.43821 9.32465 6.33316 8.88443 6.33316H3.51175C2.4012 6.33316 1.53577 6.06802 0.915456 5.53776C0.305152 4.99749 0 4.2071 0 3.16658C0 2.12606 0.305152 1.34067 0.915456 0.810404C1.53577 0.270135 2.4012 0 3.51175 0H11.946V1.95097L3.76688 1.93596C3.33666 1.93596 3.0015 2.03601 2.76138 2.23611C2.52126 2.42621 2.4012 2.73636 2.4012 3.16658C2.4012 3.59679 2.52126 3.91195 2.76138 4.11205C3.0015 4.30214 3.33666 4.39719 3.76688 4.39719H9.13955C10.2501 4.39719 11.1105 4.67233 11.7208 5.2226C12.3411 5.76287 12.6513 6.56827 12.6513 7.63881C12.6513 8.69933 12.3411 9.50474 11.7208 10.055C11.1105 10.6053 10.2501 10.8804 9.13955 10.8804H0.255127Z" />
    <path d="M13.1523 10.7983V7.61676C13.1523 6.61626 13.4325 5.84088 13.9928 5.2906C14.553 4.74033 15.3684 4.46519 16.439 4.46519H21.3764C22.3269 4.46519 22.8022 4.05999 22.8022 3.24959C22.8022 2.43918 22.3269 2.03398 21.3764 2.03398H13.3925V0.0830078H21.8417C22.8822 0.0830078 23.6876 0.363147 24.2579 0.923426C24.8382 1.48371 25.1283 2.25909 25.1283 3.24959C25.1283 4.24008 24.8382 5.01547 24.2579 5.57574C23.6876 6.13602 22.8822 6.41616 21.8417 6.41616H16.7691C16.3389 6.41616 16.0138 6.52622 15.7937 6.74633C15.5836 6.95643 15.4785 7.25658 15.4785 7.64678V8.86238H24.8432V10.7983H13.1523Z" />
    <path d="M25.6289 10.8055V0.10521L34.6634 0.0751953C35.854 0.0751953 36.7344 0.32532 37.3047 0.825569C37.885 1.31581 38.1752 2.05618 38.1752 3.04668C38.1752 4.03717 37.845 4.76253 37.1847 5.22276C37.6249 5.46288 37.95 5.78304 38.1601 6.18324C38.3703 6.57343 38.4753 7.07868 38.4753 7.69899C38.4753 8.7095 38.1852 9.47988 37.6049 10.0101C37.0346 10.5304 36.1542 10.7905 34.9636 10.7905L25.6289 10.8055ZM34.3783 1.99615H28.0301V4.39735H34.3783C35.2887 4.39735 35.7439 3.98715 35.7439 3.16674C35.7439 2.38635 35.2887 1.99615 34.3783 1.99615ZM34.6784 6.31831H28.0301V8.86958H34.6784C35.5889 8.86958 36.0441 8.43936 36.0441 7.57893C36.0441 6.73852 35.5889 6.31831 34.6784 6.31831Z" />
  </svg>
</div>

<SlidingTabs bind:value={activeTab} tabs={SETTINGS_TABS} collapseInactiveOnPhone>
  <Tabs.Content value="general">
    <GeneralSettings />
  </Tabs.Content>

  <Tabs.Content value="search">
    <SearchSettings />
  </Tabs.Content>

  <Tabs.Content value="agents">
    <AgentsSettings />
  </Tabs.Content>

  <Tabs.Content value="graph">
    <GraphSettings />
  </Tabs.Content>

  <Tabs.Content value="troubleshooting">
    <TroubleshootingSettings />
  </Tabs.Content>

  {#if import.meta.env.DEV}
    <Tabs.Content value="developer">
      <DeveloperSettings />
    </Tabs.Content>
  {/if}
</SlidingTabs>

<style>
  .s2b-settings-logo {
    display: flex;
    justify-content: center;
    margin-bottom: 1.25rem;
  }

  .s2b-settings-logo svg {
    height: 28px;
    width: auto;
  }
</style>
