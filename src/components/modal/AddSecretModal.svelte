<script lang="ts">
import { untrack } from "svelte";
import { t } from "../../i18n";
import { getPlugin } from "../../stores/state.svelte";
import { isValidSecretId, setSecret } from "../../lib/secretStorage";
import SettingContainer from "../settings/SettingContainer.svelte";
import Button from "../ui/Button.svelte";
import Text from "../ui/Text.svelte";
import type { AddSecretModal } from "./AddSecretModal";

interface Props {
	modal: AddSecretModal;
	onSecretAdded: (secretId: string) => void;
	/** Pre-filled ID derived from the opening context (provider, tool, ...). Still editable. */
	suggestedId?: string;
}

const { modal, onSecretAdded, suggestedId }: Props = $props();

const plugin = getPlugin();

// Seeded once, then owned by the input: the suggestion is a starting point the
// user is free to edit, not a value to stay in sync with.
let secretId = $state(untrack(() => suggestedId) ?? "");
let secretValue = $state("");
let error = $state("");

// Validate the secret ID in real-time
let isValidId = $derived(secretId.length > 0 && isValidSecretId(secretId));

function handleSave() {
	error = "";

	if (!secretId.trim()) {
		error = t("modals.add_secret.error_name_required");
		return;
	}

	if (!isValidSecretId(secretId)) {
		error = t("modals.add_secret.error_name_invalid");
		return;
	}

	if (!secretValue.trim()) {
		error = t("modals.add_secret.error_value_required");
		return;
	}

	try {
		setSecret(plugin.app, secretId, secretValue);
		onSecretAdded(secretId);
		modal.close();
	} catch (e) {
		error = t("modals.add_secret.error_save_failed", { error: String(e) });
	}
}
</script>

<div class="modal-content">
	<!-- Description -->
	<div class="setting-item-description s2b-mb-4">
		<p>{t("modals.add_secret.intro")}</p>
	</div>

	<SettingContainer
		name={t("modals.add_secret.name_label")}
		desc={suggestedId
			? t("modals.add_secret.name_desc_suggested")
			: t("modals.add_secret.name_desc")}
	>
		<Text
			inputType="text"
			placeholder="my-api-key"
			bind:value={secretId}
			styles={secretId.length > 0 && !isValidId ? "!s2b-border-[--background-modifier-error]" : ""}
		/>
	</SettingContainer>

	<SettingContainer name={t("modals.add_secret.value_label")} desc={t("modals.add_secret.value_desc")}>
		<Text inputType="password" placeholder="sk-..." bind:value={secretValue} />
	</SettingContainer>

	{#if error}
		<div class="setting-item">
			<div class="s2b-text-[--text-error] s2b-text-sm">{error}</div>
		</div>
	{/if}
</div>

<div class="modal-button-container">
	<Button buttonText={t("common.cancel")} onClick={() => modal.close()} />
	<Button buttonText={t("modals.add_secret.save_button")} cta={true} disabled={!isValidId || !secretValue} onClick={handleSave} />
</div>
