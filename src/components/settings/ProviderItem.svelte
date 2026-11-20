<script lang="ts">
import { Notice } from "obsidian";
import type { Component } from "svelte";
import { createProviderStateQuery, invalidateProviderState, removeProviderQueries } from "../../lib/query";
import { type LogoProps, getProviderDefinition } from "../../providers/index";
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import { formatNumber, t } from "../../i18n";
import ManagedEntityItem from "./ManagedEntityItem.svelte";
import GenericAIIcon from "../ui/logos/GenericAIIcon.svelte";
import CircularLoader from "../ui/CircularLoader.svelte";
import Button from "../ui/Button.svelte";
import { icon } from "../../utils/utils";
import { Logger } from "../../utils/logging";
import { ProviderSetupModal } from "../../views/provider-setup/ProviderSetup";
import { confirmDelete, confirmDeleteWithOption } from "../modal/ConfirmModal";

interface Props {
	provider: string;
}

const { provider }: Props = $props();

const data = getData();
const plugin = getPlugin();
let providerDefinition = $derived(getProviderDefinition(provider, data.getAllProviderMeta()));

const query = createProviderStateQuery(() => provider);
let isCheckingAuth = $derived(query.isPending || query.isFetching);
let displayName = $derived(providerDefinition?.displayName ?? provider);
let isTrusted = $derived(data.isProviderTrusted(provider));
let authFailureMessage = $derived(
	query.data && !query.data.auth.success ? query.data.auth.message : t("settings.providers.auth_failed"),
);
let Logo: Component<LogoProps> = $derived.by(() => {
	if (providerDefinition?.logo) {
		return providerDefinition.logo;
	}
	return GenericAIIcon;
});

function refetch() {
	invalidateProviderState(provider);
}

function handleOpenSettings() {
	new ProviderSetupModal(plugin, provider).open();
}

async function handleRemoveProvider() {
	// Embeddings this provider built are expensive to recompute, so deleting them is a
	// separate, opt-in decision rather than a side effect of removing the provider —
	// re-adding the same provider and model later reuses the vectors as they are.
	// The checkbox only appears when there is actually something to delete.
	const ownedIndexes = data.embeddingIndexes.filter((index) => index.provider === provider);
	const indexedNotes = ownedIndexes.reduce((sum, index) => sum + (index.documentCount ?? 0), 0);

	if (ownedIndexes.length === 0) {
		if (!(await confirmDelete(plugin.app, displayName))) return;
		await removeProvider();
		return;
	}

	const { confirmed, checked } = await confirmDeleteWithOption(plugin.app, displayName, {
		label: t("settings.providers.delete_embeddings"),
		description: t("settings.providers.delete_embeddings_desc", {
			count: indexedNotes,
			formatted: formatNumber(indexedNotes),
		}),
	});
	if (!confirmed) return;
	await removeProvider(checked);
}

async function removeProvider(purgeEmbeddings = false) {
	let orphanedIndexIds: string[];
	try {
		orphanedIndexIds = await data.deleteProvider(provider);
		// Drop cached auth/state entirely (not just invalidate) so re-adding a provider with
		// the same slug ID doesn't inherit this one's stale "connected" verdict from cache.
		removeProviderQueries(provider);
	} catch (error) {
		new Notice(error instanceof Error ? error.message : t("settings.providers.remove_failed"));
		return;
	}

	if (!purgeEmbeddings) return;

	// Separate error scope: the provider IS removed by now, so a purge failure must not
	// report "Failed to remove provider" — that would misstate what happened.
	//
	// The vector store is only assigned at onLayoutReady, so it can genuinely be absent
	// (its type asserts non-null, but `onunload` guards it for the same reason). Deleting
	// embeddings is an explicit destructive choice the user opted into, so a missing
	// service must be reported rather than optional-chained away — silently completing
	// the dialog would leave every vector on disk with no sign anything was skipped.
	const vectorStore = plugin.vectorStoreService;
	if (!vectorStore) {
		new Notice(t("settings.providers.embeddings_kept_starting"));
		return;
	}

	// Each index is attempted independently: `deleteIndex` awaits `store.clear()` and
	// `store.close()` before it reaches the IndexedDB drop, so one rejection would
	// otherwise abandon every index after it — and their config records are already gone,
	// which makes the survivors much harder to reach again. Failures are collected and
	// reported together instead.
	const failed: string[] = [];
	for (const indexId of orphanedIndexIds) {
		try {
			await vectorStore.deleteIndex(indexId);
		} catch (error) {
			failed.push(indexId);
			Logger.error(`[ProviderItem] Failed to delete embedding index ${indexId}:`, error);
		}
	}

	if (failed.length > 0) {
		new Notice(
			t("settings.providers.embeddings_delete_failed", {
				count: orphanedIndexIds.length,
				failed: failed.length,
				ids: failed.join(", "),
			}),
		);
	}
}
</script>

<ManagedEntityItem name={displayName}>
  {#snippet leading()}
    <Logo width={16} height={16} />
  {/snippet}

  {#snippet badges()}
    <div class="provider-status-group">
      {#if isCheckingAuth}
        <button
          type="button"
          class="s2b-provider-icon-button provider-status-indicator"
          title={t("settings.providers.checking_auth")}
          aria-label={t("settings.providers.checking_auth")}
          disabled
        >
          <CircularLoader size={12} color="var(--text-muted)" />
        </button>
      {:else if query.data?.auth.success}
        <button
          type="button"
          class="s2b-provider-icon-button provider-status-indicator provider-icon-indicator-success"
          title={t("settings.providers.authenticated")}
          aria-label={t("settings.providers.authenticated")}
          onclick={refetch}
        >
          <span class="provider-status-icon" use:icon={"check-circle"}></span>
        </button>
      {:else}
        <button
          type="button"
          class="s2b-provider-icon-button provider-status-indicator provider-icon-indicator-error"
          title={t("settings.providers.auth_error_retry", { message: authFailureMessage })}
          aria-label={t("settings.providers.auth_error_retry", { message: authFailureMessage })}
          onclick={refetch}
        >
          <span class="provider-status-icon" use:icon={"x-circle"}></span>
        </button>
      {/if}

      {#if isTrusted}
        <span
          class="provider-trust-tooltip"
          title={t("settings.providers.trusted")}
          aria-label={t("settings.providers.trusted")}
        >
          <span class="provider-icon-indicator provider-icon-indicator-accent">
            <span class="provider-trust-icon" use:icon={"shield-check"}></span>
          </span>
        </span>
      {/if}
    </div>
  {/snippet}

  {#snippet actions()}
    <Button
      iconId="settings"
      ariaLabel={t("settings.providers.configure")}
      tooltip={t("settings.providers.configure")}
      onClick={handleOpenSettings}
    />
    <Button
      iconId="trash"
      ariaLabel={t("settings.providers.remove")}
      tooltip={t("settings.providers.remove")}
      onClick={() => void handleRemoveProvider()}
    />
  {/snippet}
</ManagedEntityItem>

<style>
  .provider-status-group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .provider-trust-tooltip {
    display: inline-flex;
  }

  .provider-status-indicator,
  .provider-icon-indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    min-width: 16px;
    min-height: 16px;
  }

  .provider-icon-indicator-error {
    color: var(--text-error);
  }

  .provider-icon-indicator-accent {
    color: var(--text-accent);
  }

  .provider-icon-indicator-success {
    color: var(--text-success, #4caf50);
  }

  .s2b-provider-icon-button {
    padding: 0;
    margin: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    cursor: pointer;
    /* Size the button to its icon — the theme's default button height (30px) would
       otherwise inflate the header row and push the leading logo off-center. */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 16px;
    line-height: 1;
  }

  .s2b-provider-icon-button:disabled {
    cursor: default;
  }

  /* Touch: keep the icon visually 16px but grow the tap area to ~44px via
     padding, cancelled by negative margin so the header row layout is unchanged. */
  :global(.is-mobile) .s2b-provider-icon-button {
    padding: 14px;
    margin: -14px;
  }

  .s2b-provider-icon-button:not(:disabled):hover {
    filter: brightness(1.05);
  }

  /* --icon-size drives the injected svg too: Obsidian's .svg-icon reads it for
     both axes, so sizing only the span leaves the glyph at the inherited 18px
     height and it overflows the box. */
  .provider-trust-icon,
  .provider-status-icon {
    --icon-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--icon-size);
    height: var(--icon-size);
  }

  .provider-status-icon {
    flex-shrink: 0;
  }

  .provider-trust-icon :global(svg.svg-icon),
  .provider-status-icon :global(svg.svg-icon) {
    width: var(--icon-size);
    height: var(--icon-size);
  }
</style>
