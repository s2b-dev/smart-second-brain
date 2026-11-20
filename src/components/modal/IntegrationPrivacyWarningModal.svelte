<script lang="ts">
import { t } from "../../i18n";
import Button from "../ui/Button.svelte";
import Toggle from "../ui/Toggle.svelte";

interface Props {
	displayName: string;
	onConfirm: (dontAskAgain: boolean) => void;
	onCancel: () => void;
}

let { displayName, onConfirm, onCancel }: Props = $props();

let dontAskAgain = $state(false);

// Split on `{placeholder}` tokens so the inline markup sits wherever the translation puts it.
const placeholder = /(\{\w+\})/;
const enablingParts = t("modals.integration_privacy_warning.enabling").split(placeholder);
const rulesDetailParts = t("modals.integration_privacy_warning.rules_detail").split(placeholder);
const toolNames = new Map([
	["{search_notes}", "search_notes"],
	["{read_content}", "read_content"],
	["{manage_notes}", "manage_notes"],
]);
</script>

<div class="modal-title">{t("modals.privacy_warning.title")}</div>
<div class="modal-content">
  <p>
    {#each enablingParts as part}{#if part === "{name}"}<strong>{displayName}</strong>{:else}{part}{/if}{/each}
  </p>
  <p>
    <strong>{t("modals.integration_privacy_warning.rules_not_applied")}</strong>
    {#each rulesDetailParts as part}{#if toolNames.has(part)}<code>{toolNames.get(part)}</code>{:else}{part}{/if}{/each}
  </p>
</div>

<label class="s2b-dont-ask-again">
  <Toggle checked={dontAskAgain} onchange={(checked) => (dontAskAgain = checked)} />
  <span>{t("modals.integration_privacy_warning.dont_ask_again")}</span>
</label>

<div class="modal-button-container">
  <Button buttonText={t("common.cancel")} onClick={onCancel} />
  <Button buttonText={t("modals.integration_privacy_warning.enable_button")} styles="mod-warning" onClick={() => onConfirm(dontAskAgain)} />
</div>

<style>
  .s2b-dont-ask-again {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    cursor: pointer;
  }

  .s2b-dont-ask-again span {
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }
</style>
