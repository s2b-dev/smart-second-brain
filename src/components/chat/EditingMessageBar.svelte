<script lang="ts">
import type { SessionRegistry } from "../../stores/chatStore.svelte";
import { isMobileUI } from "../../utils/platform";
import { icon } from "../../utils/utils";
import { t } from "../../i18n";

interface Props {
	registry: SessionRegistry;
	threadPath: string | null;
	onCancel: () => void;
}

const { registry, threadPath, onCancel }: Props = $props();

const session = $derived(registry.sessionFor(threadPath));
// Desktop only: the composer has room for this quiet label, and cancel lives
// right on it. On mobile the same info would sit directly above a floating,
// keyboard-repositioned composer with no space to spare, so cancel instead
// lives as its own icon button at the far end of the composer's action row
// (see Input.svelte) — away from the save button, to avoid a mis-tap between
// "cancel" and "save" on a cramped row.
const isEditing = $derived(!isMobileUI() && Boolean(session?.editingPairId));
</script>

{#if isEditing}
  <div class="emb-row s2b-text-xs s2b-text-text-muted">
    <div class="emb-icon" use:icon={"pencil"} style="--icon-size: 11px"></div>
    <span>{t("chat.editing.label")}</span>
    <button class="emb-cancel clickable-icon" onclick={onCancel} title={t("chat.editing.cancel")} aria-label={t("chat.editing.cancel")} type="button">
      <div use:icon={"x"} style="--icon-size: 12px"></div>
    </button>
  </div>
{/if}

<style>
  .emb-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 5px;
    padding: 0 2px;
  }

  .emb-icon {
    display: flex;
    align-items: center;
  }

  .emb-cancel {
    display: flex;
    align-items: center;
    justify-content: center;
    margin-left: 2px;
    padding: 2px;
  }
</style>
