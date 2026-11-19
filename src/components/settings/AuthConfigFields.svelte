<script lang="ts">
import type { Snippet } from "svelte";
import { createAuthStateQuery, invalidateAuthState } from "../../lib/query";
import { suggestSecretId } from "../../lib/secretStorage";
import { type AuthFieldDefinition, getProviderDefinition } from "../../providers/index";
import { getPlugin } from "../../stores/state.svelte";
import { getData } from "../../stores/dataStore.svelte";
import Text from "../ui/Text.svelte";
import SecretSelect from "./SecretSelect.svelte";
import SettingItem from "./SettingItem.svelte";

interface Props {
	provider: string;
	// Optional content rendered after the required fields (and setup link) but before the
	// Advanced disclosure — e.g. the "Trusted with private notes" toggle in provider setup.
	afterRequired?: Snippet;
}

const { provider, afterRequired }: Props = $props();

const data = getData();
const plugin = getPlugin();

// Local state for advanced disclosure
let showAdvanced = $state(false);

// Name the suggested secret after the instance's display name, so a renamed
// "Work OpenAI" yields "work-openai-api-key" rather than the raw instance ID.
let providerLabel = $derived(data.getProviderMeta(provider)?.displayName ?? provider);

// Query for provider auth state
const query = createAuthStateQuery(() => provider);
let isCheckingAuth = $derived(query.isPending || query.isFetching);

// Get provider definition using the function from providers/index
let providerDefinition = $derived(getProviderDefinition(provider, data.getAllProviderMeta()));

// Get stored auth state for this provider
let storedAuth = $derived(data.getStoredAuthState(provider));

// Get auth fields from provider definition
let authFields = $derived(providerDefinition?.auth ?? null);

// Optional link to where the user can obtain credentials (e.g. an API-key page)
let setupLink = $derived(providerDefinition?.setupInstructions?.link ?? null);

// Split fields into required and optional
let requiredFields = $derived((): [string, AuthFieldDefinition][] => {
	if (!authFields) return [];
	return (Object.entries(authFields) as [string, AuthFieldDefinition][]).filter(([_, field]) => field.required);
});

let optionalFields = $derived((): [string, AuthFieldDefinition][] => {
	if (!authFields) return [];
	return (Object.entries(authFields) as [string, AuthFieldDefinition][]).filter(([_, field]) => !field.required);
});

let hasOptionalFields = $derived(optionalFields().length > 0);

// Auto-expand advanced when optional fields have configured values
$effect(() => {
	if (!storedAuth || !authFields) return;

	for (const [fieldKey, field] of Object.entries(authFields) as [string, AuthFieldDefinition][]) {
		if (!field.required) {
			const hasValue = storedAuth.values[fieldKey] || storedAuth.secretIds[fieldKey];
			if (hasValue) {
				showAdvanced = true;
				break;
			}
		}
	}
});

// Get the current value for a field from stored auth
function getFieldValue(fieldKey: string): string {
	if (!storedAuth) return "";

	// For secret fields, return the secret ID (not the actual secret value)
	// The SecretSelect component will use this to show the correct selection
	if (storedAuth.secretIds[fieldKey]) {
		return storedAuth.secretIds[fieldKey];
	}

	// For non-secret fields, return the stored value
	return storedAuth.values[fieldKey] ?? "";
}

// Handle secret selection/change (for secret fields)
function handleSecretChange(fieldKey: string, secretId: string) {
	data.assignSecretIdToProviderField(provider, fieldKey, secretId);
	invalidateAuthState(provider);
}

// Handle text/textarea field changes (for non-secret fields)
function handleFieldChange(fieldKey: string, value: string) {
	data.setProviderAuthField(provider, fieldKey, value, false);
	invalidateAuthState(provider);
}

// Get validation state styling for a field
function getFieldStyles(fieldKey: string): string {
	// The base URL isn't validated on its own — the auth query checks the whole
	// connection — so don't paint a success/error border on it; it reads as if the
	// URL itself passed/failed. Keep the status border on the credential fields.
	if (fieldKey === "baseUrl") return "";
	const value = getFieldValue(fieldKey);
	if (value === "") return "";
	if (isCheckingAuth || !query.data) {
		return "";
	}
	return query.data.success
		? "!s2b-border-[--background-modifier-success]"
		: "!s2b-border-[--background-modifier-error]";
}
</script>

{#snippet fieldRenderer(fieldKey: string, field: AuthFieldDefinition)}
    {#if field.kind === "secret"}
        <!-- Secret field using custom dropdown + add button -->
        <SettingItem name={field.label} desc={field.description}>
            <SecretSelect
                value={getFieldValue(fieldKey)}
                suggestedId={suggestSecretId(plugin.app, providerLabel, fieldKey)}
                onChange={(value) => handleSecretChange(fieldKey, value)}
            />
        </SettingItem>
    {:else if field.kind === "textarea"}
        <!-- Textarea field (e.g., headers JSON) -->
        <SettingItem name={field.label} desc={field.description}>
            <textarea
                class="setting-textarea s2b-w-full s2b-min-h-[80px] s2b-p-2 s2b-font-mono s2b-text-sm s2b-resize-y {getFieldStyles(
                    fieldKey,
                )}"
                placeholder={field.placeholder ?? ""}
                value={getFieldValue(fieldKey)}
                onblur={(e) =>
                    handleFieldChange(fieldKey, e.currentTarget.value)}
            ></textarea>
        </SettingItem>
    {:else}
        <!-- Regular text field -->
        <SettingItem name={field.label} desc={field.description}>
            <Text
                inputType="text"
                value={getFieldValue(fieldKey)}
                placeholder={field.placeholder ?? ""}
                styles={getFieldStyles(fieldKey)}
                onblur={(value: string) => handleFieldChange(fieldKey, value)}
            />
        </SettingItem>
    {/if}
{/snippet}

{#if storedAuth && authFields}
    <!-- Required fields first -->
    {#each requiredFields() as [fieldKey, field]}
        {@render fieldRenderer(fieldKey, field)}
    {/each}

    <!-- Link to where credentials can be obtained (e.g. API-key page) -->
    {#if setupLink}
        <div class="auth-setup-link">
            <a href={setupLink.url} target="_blank" rel="noopener noreferrer">
                → {setupLink.text}
            </a>
        </div>
    {/if}

    <!-- Caller-supplied content between the required fields and Advanced. -->
    {@render afterRequired?.()}

    <!-- Advanced disclosure (only if there are optional fields) -->
    {#if hasOptionalFields}
        <details class="auth-advanced" bind:open={showAdvanced}>
            <summary class="auth-advanced-summary">Advanced</summary>
            {#each optionalFields() as [fieldKey, field]}
                {@render fieldRenderer(fieldKey, field)}
            {/each}
        </details>
    {/if}
{/if}

<style>
    .auth-setup-link {
        padding: 0 var(--size-4-3) var(--size-4-2);
        font-size: var(--font-smaller);
    }

    .auth-advanced {
        margin-top: var(--size-4-2);
    }

    .auth-advanced-summary {
        cursor: pointer;
        color: var(--text-muted);
        font-size: var(--font-smaller);
        padding: var(--size-4-1) var(--size-4-3);
        user-select: none;
    }

    .auth-advanced-summary:hover {
        color: var(--text-normal);
    }
</style>
