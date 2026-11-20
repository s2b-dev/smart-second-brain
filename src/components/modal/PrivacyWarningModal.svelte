<script lang="ts">
import { t } from "../../i18n";
import Button from "../ui/Button.svelte";
import type { PrivacyWarningModal } from "./PrivacyWarningModal";

interface Props {
	modal: PrivacyWarningModal;
	onConfirm: () => void;
	onCancel: () => void;
}

let { modal, onConfirm, onCancel }: Props = $props();

// Split on `{placeholder}` tokens so the bold phrases sit wherever the translation puts them.
const historyParts = t("modals.privacy_warning.history").split(/(\{\w+\})/);
</script>

<div class="modal-title">{t("modals.privacy_warning.title")}</div>
<div class="modal-content">
  <p>
    {#each historyParts as part}{#if part === "{private_notes}"}<strong>{t("modals.privacy_warning.history_private_notes")}</strong>{:else if part === "{not_trusted}"}<strong>{t("modals.privacy_warning.history_not_trusted")}</strong>{:else}{part}{/if}{/each}
  </p>
  <p>{t("modals.privacy_warning.exposure")}</p>
</div>

<div class="modal-button-container">
  <Button buttonText={t("common.cancel")} onClick={onCancel} />
  <Button buttonText={t("modals.privacy_warning.continue_button")} styles="mod-warning" onClick={onConfirm} />
</div>
