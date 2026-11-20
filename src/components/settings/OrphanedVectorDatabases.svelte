<script module lang="ts">
/*
 * Scan results live at module level: the row is rendered once per settings
 * tab that embeds `EmbeddingIndexSection` (search and graph), and a deletion
 * from one tab must not leave the other showing databases that are gone.
 */
let orphans = $state<OrphanedDatabase[]>([]);
let originUsage = $state<number | null>(null);
let deleting = $state(false);
</script>

<script lang="ts">
import { untrack } from "svelte";
import { Notice } from "obsidian";
import SettingContainer from "./SettingContainer.svelte";
import Button from "../ui/Button.svelte";
import { ConfirmModal } from "../modal/ConfirmModal";
import { getData } from "../../stores/dataStore.svelte";
import { t } from "../../i18n";
import { getPlugin } from "../../stores/state.svelte";
import { Logger } from "../../utils/logging";
import {
	deleteOrphanedDatabases,
	estimateOriginStorage,
	formatBytes,
	listOrphanedVectorDatabases,
	type OrphanedDatabase,
} from "../../vectorstore/orphanedDatabases";

/*
 * Vector databases outlive their index configuration by design (#432, step 5):
 * removing a provider or an index config leaves its vectors on disk until an
 * explicit delete. This row lists the leftovers for this vault and deletes them
 * after confirmation. It renders nothing when there is nothing to clean up or
 * when the runtime cannot enumerate databases.
 */

const pluginData = getData();
const plugin = getPlugin();

const configuredIds = $derived(pluginData.embeddingIndexes.map((index) => index.id));
// A value signature: `embeddingIndexes` is a fresh array on every store write,
// and keying the effect on its identity would rescan on unrelated saves.
const configuredSignature = $derived(configuredIds.join("|"));

async function scan(): Promise<void> {
	try {
		const found = await listOrphanedVectorDatabases(pluginData.vaultSlug, configuredIds);
		orphans = found ?? [];
		originUsage = (await estimateOriginStorage())?.usage ?? null;
	} catch (error) {
		Logger.error("[OrphanedVectorDatabases] Scan failed:", error);
		orphans = [];
	}
}

$effect(() => {
	// Rescan whenever the configured set changes (an index was deleted or added).
	void configuredSignature;
	untrack(() => void scan());
});

const totalEstimatedBytes = $derived(orphans.reduce((sum, orphan) => sum + (orphan.estimatedBytes ?? 0), 0));

function describe(orphan: OrphanedDatabase): string {
	if (orphan.kind === "legacy-sidecar") return t("settings.orphaned.legacy", { label: orphan.label });
	return t("settings.orphaned.chunks", { id: String(orphan.indexId), count: orphan.chunkCount ?? 0 });
}

const description = $derived.by(() => {
	const count = orphans.length;
	const parts = [
		t("settings.orphaned.summary", {
			count,
			size:
				totalEstimatedBytes > 0 ? t("settings.orphaned.size", { size: formatBytes(totalEstimatedBytes) }) : "",
			list: orphans.map(describe).join(", "),
		}),
	];
	if (originUsage !== null) {
		parts.push(t("settings.orphaned.origin_usage", { size: formatBytes(originUsage) }));
	}
	return parts.join(" ");
});

async function deleteOrphans(): Promise<void> {
	const names = orphans.map((orphan) => orphan.name);
	if (names.length === 0) return;
	const modal = new ConfirmModal(
		plugin.app,
		t("settings.orphaned.confirm_title"),
		t("settings.orphaned.confirm_desc", { count: names.length }),
		t("common.delete"),
	);
	modal.open();
	const { confirmed } = await modal.promise;
	if (!confirmed) return;

	deleting = true;
	try {
		const outcome = await deleteOrphanedDatabases(names);
		if (outcome.failed.length === 0) {
			new Notice(
				t("settings.orphaned.deleted", { count: outcome.deleted.length }),
			);
		} else {
			for (const failure of outcome.failed) {
				Logger.error(`[OrphanedVectorDatabases] Could not delete ${failure.name}: ${failure.reason}`);
			}
			new Notice(
				t("settings.orphaned.deleted_partial", {
					deleted: outcome.deleted.length,
					failed: outcome.failed.length,
					reason: outcome.failed[0].reason,
				}),
			);
		}
	} finally {
		deleting = false;
		await scan();
	}
}
</script>

{#if orphans.length > 0}
  <SettingContainer name={t("settings.orphaned.name")} desc={description}>
    <Button buttonText={t("settings.orphaned.delete_button")} disabled={deleting} onClick={() => void deleteOrphans()} />
  </SettingContainer>
{/if}
