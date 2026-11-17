<script lang="ts">
import { untrack } from "svelte";
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
		error = "Secret name is required";
		return;
	}

	if (!isValidSecretId(secretId)) {
		error = "Invalid name. Use lowercase letters, numbers, and dashes only (max 64 chars)";
		return;
	}

	if (!secretValue.trim()) {
		error = "Secret value is required";
		return;
	}

	try {
		setSecret(plugin.app, secretId, secretValue);
		onSecretAdded(secretId);
		modal.close();
	} catch (e) {
		error = `Failed to save secret: ${e}`;
	}
}
</script>

<div class="modal-content">
	<!-- Description -->
	<div class="setting-item-description s2b-mb-4">
		<p>
			Secrets are stored securely in Obsidian's Keychain, separate from plugin data. This allows you
			to share API keys across multiple plugins without storing them in plaintext.
		</p>
	</div>

	<SettingContainer
		name="Secret name"
		desc={suggestedId
			? "Suggested from where you opened this. Edit it to reuse a name across providers."
			: "Unique name for this secret (lowercase letters, numbers, dashes)"}
	>
		<Text
			inputType="text"
			placeholder="my-api-key"
			bind:value={secretId}
			styles={secretId.length > 0 && !isValidId ? "!s2b-border-[--background-modifier-error]" : ""}
		/>
	</SettingContainer>

	<SettingContainer name="Secret value" desc="The API key or secret value to store securely">
		<Text inputType="password" placeholder="sk-..." bind:value={secretValue} />
	</SettingContainer>

	{#if error}
		<div class="setting-item">
			<div class="s2b-text-[--text-error] s2b-text-sm">{error}</div>
		</div>
	{/if}
</div>

<div class="modal-button-container">
	<Button buttonText="Cancel" onClick={() => modal.close()} />
	<Button buttonText="Save secret" cta={true} disabled={!isValidId || !secretValue} onClick={handleSave} />
</div>
