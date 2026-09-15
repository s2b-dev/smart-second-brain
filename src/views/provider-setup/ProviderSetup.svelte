<script lang="ts">
import type { Component } from "svelte";
import { mount, unmount, untrack } from "svelte";
import { Platform } from "obsidian";
import AuthConfigFields from "../../components/settings/AuthConfigFields.svelte";
import SettingItem from "../../components/settings/SettingItem.svelte";
import Button from "../../components/ui/Button.svelte";
import CircularLoader from "../../components/ui/CircularLoader.svelte";
import DocsLink from "../../components/ui/DocsLink.svelte";
import Text from "../../components/ui/Text.svelte";
import Toggle from "../../components/ui/Toggle.svelte";
import ProviderSetupHeader from "./ProviderSetupHeader.svelte";
import GenericAIIcon from "../../components/ui/logos/GenericAIIcon.svelte";
import AnthropicLogo from "../../components/ui/logos/AnthropicLogo.svelte";
import OllamaLogo from "../../components/ui/logos/OllamaLogo.svelte";
import OpenAILogo from "../../components/ui/logos/OpenAILogo.svelte";
import OpenRouterLogo from "../../components/ui/logos/OpenRouterLogo.svelte";
import OmlxLogo from "../../components/ui/logos/OmlxLogo.svelte";
import {
	createAuthStateQuery,
	getProviderStateQueryOptions,
	invalidateAuthState,
	invalidateProviderState,
} from "../../lib/query";
import type SecondBrainPlugin from "../../main";
import {
	getAllProviderTemplates,
	type LogoProps,
	type OpenAIAuthMode,
	type ProviderTemplateId,
	getProviderDefinition,
} from "../../providers/index";
import { getData, slugifyProviderName } from "../../stores/dataStore.svelte";
import { icon } from "../../utils/utils";
import type { ProviderSetupModal } from "./ProviderSetup";

interface Props {
	modal: ProviderSetupModal;
	plugin: SecondBrainPlugin;
	selectedProvider: string;
}

const { modal }: Props = $props();
const data = getData();

// Two-step flow: "pick" shows the provider grid, "configure" shows the setup form.
// Editing an existing provider skips straight to "configure".
let step = $state<"pick" | "configure">(untrack(() => (modal.startInPicker ? "pick" : "configure")));

// providerId only changes once: when a new provider is committed (renamed to slug on submit),
// or when a template is chosen from the picker. During editing it never changes.
let providerId = $state(untrack(() => modal.selectedProvider));

const query = createAuthStateQuery(() => providerId);
const providerDefinition = $derived(getProviderDefinition(providerId, data.getAllProviderMeta()));
const providerMeta = $derived(data.getProviderMeta(providerId));
// OAuth capability drives the sign-in UI uniformly (no per-provider template checks).
const oauth = $derived(providerDefinition?.oauth);
const isConfigured = $derived(data.isProviderConfigured(providerId));

// Picker display order: lead with the most-used providers so the grid scans fast.
// Templates not listed fall to the end in their registry order.
const PICKER_ORDER: ProviderTemplateId[] = ["openai-compatible", "omlx", "openrouter", "ollama", "openai", "anthropic"];
// oMLX is a macOS-native app (Apple Silicon), so its template is only offered on macOS.
const providerTemplates = [...getAllProviderTemplates()]
	.filter((t) => t.id !== "omlx" || Platform.isMacOS)
	.sort((a, b) => {
		const ai = PICKER_ORDER.indexOf(a.id);
		const bi = PICKER_ORDER.indexOf(b.id);
		return (ai === -1 ? PICKER_ORDER.length : ai) - (bi === -1 ? PICKER_ORDER.length : bi);
	});
let isSigningIn = $state(false);
let signInError = $state<string | null>(null);

// OAuth-capable providers expose two auth paths on one instance (sign-in vs API key).
// Sign-in is the primary path; the API-key field is revealed on demand via a link.
// Seed the revealed state from the stored mode so editing an instance that was set up
// with a key reopens with the field shown. New instances default to sign-in (codex).
let authMode = $state<OpenAIAuthMode>(untrack(() => data.getProviderAuthMode(providerId)));

// The API-key section is revealed when the user opted into the key path.
const revealApiKey = $derived(authMode === "apiKey");

function toggleApiKey() {
	handleAuthModeChange(revealApiKey ? "codex" : "apiKey");
}

// `authMode` is really two things at once: which auth path the UI reveals, and (for OpenAI)
// whether this instance uses ChatGPT/Codex auth. Only the latter belongs in storage. Writing
// "codex" for any OAuth provider stamped an OpenAI-specific flag onto e.g. OpenRouter, where
// isProviderEmbeddingAvailable read it as "no embeddings" and hid every embedding model the
// provider had. Keep the reveal state local; persist the mode only where codex is meaningful.
const persistsCodexAuthMode = $derived(
	data.getProviderTemplateId(providerId) === "openai" || data.getProviderTemplateId(providerId) === "openai-codex",
);

function handleAuthModeChange(mode: OpenAIAuthMode) {
	authMode = mode;
	if (persistsCodexAuthMode || mode === "apiKey") {
		data.setProviderAuthMode(providerId, mode);
	}
	signInError = null;
	invalidateAuthState(providerId);
}

// For OAuth-capable providers the sign-in CTA is always shown (it's the primary path);
// the API-key field is an optional reveal below it. For OAuth-only providers there's no
// key path at all. Non-OAuth providers show neither (plain AuthConfigFields).
// The loopback-server OAuth flow needs node:http, so it's desktop-only; providers whose
// redirect is caught via an obsidian:// protocol handler (OpenRouter) set `worksOnMobile`
// and are available everywhere. On mobile without that flag we suppress the CTA and fall
// back to the API-key path where the provider supports one.
const oauthAvailable = $derived(!!oauth && (Platform.isDesktopApp || oauth.worksOnMobile === true));
const showSignIn = $derived(oauthAvailable);
const isSignedIn = $derived(showSignIn ? (oauth?.isSignedIn?.() ?? false) : false);

// Whether this OAuth provider is already connected, so the edit view shows a "Connected"
// state instead of a misleading "Sign in" CTA. Two flavors:
//  - session-backed (Codex): connected == an active session (oauth.isSignedIn()).
//  - api-key-backed (OpenRouter): no session to check — connected == a stored apiKey.
const oauthConnected = $derived.by(() => {
	if (!oauth) return false;
	if (oauth.isSignedIn) return isSignedIn;
	const stored = data.getStoredAuthState(providerId);
	return !!(stored?.values.apiKey || stored?.secretIds.apiKey);
});

// Whether the user has actually supplied credentials yet. Suppresses the connection
// status on an untouched form (an empty required field validates to a scary "API key is
// required" error otherwise). True once any required auth field has a stored value/secret,
// once an OAuth session exists, once a sign-in attempt errored, or on the edit path where
// the provider is already configured.
const hasCredentials = $derived.by(() => {
	if (isConfigured || signInError) return true;
	if (isSignedIn) return true;
	// For an OAuth provider still on the sign-in path (key field not revealed), the only
	// credential is the OAuth session — which we've already checked above.
	if (showSignIn && !revealApiKey) return false;
	const stored = data.getStoredAuthState(providerId);
	const authFields = providerDefinition?.auth;
	if (!stored || !authFields) return false;
	return Object.entries(authFields).some(
		([key, field]) => field.required && (!!stored.values[key] || !!stored.secretIds[key]),
	);
});

async function handleOAuthSignIn() {
	if (!oauth) return;
	isSigningIn = true;
	signInError = null;
	try {
		const result = await oauth.signIn();
		if (result.kind === "apiKey") {
			// Store the OAuth-obtained key as a managed secret so validation re-runs and Save enables.
			data.setProviderAuthField(providerId, "apiKey", result.apiKey, true);
		}
		invalidateAuthState(providerId);
	} catch (error) {
		// A user-initiated cancel isn't a failure — clear the flow silently so the CTA
		// returns to "Sign in" and the user can retry. Cancellation markers set their name.
		const name = error instanceof Error ? error.name : "";
		if (name === "OpenRouterSignInCancelledError" || name === "OpenAICodexSignInCancelledError") {
			signInError = null;
		} else {
			signInError = error instanceof Error ? error.message : String(error);
		}
	} finally {
		isSigningIn = false;
	}
}

// Abort an in-progress sign-in (e.g. the user closed the browser tab before authorizing).
// This rejects the pending signIn() promise and frees its callback server/port so the flow
// can be retried immediately instead of hanging until the timeout.
function handleCancelSignIn() {
	oauth?.cancelSignIn?.();
}

// Manual code-paste fallback for the mobile headless OAuth flow (no localhost/redirect
// available): the user pastes the code shown in the browser to finish the same pending
// sign-in. Resolves the in-progress signIn() promise (see handleOAuthSignIn's await).
let manualCode = $state("");
function handleSubmitManualCode() {
	const code = manualCode.trim();
	if (!code) return;
	oauth?.submitManualCode?.(code);
	manualCode = "";
}

// On mobile, shrinking the modal to fit above the keyboard (see the
// .s2b-provider-setup-modal-container rules below) makes it scrollable, but WKWebView
// doesn't automatically scroll a newly-focused input into that new scrollable area —
// confirmed on-device. Nudge it into view once the keyboard has finished animating open.
function scrollManualCodeIntoView(e: FocusEvent) {
	if (!Platform.isMobileApp) return;
	const target = e.currentTarget;
	if (!(target instanceof HTMLElement)) return;
	window.setTimeout(() => target.scrollIntoView({ block: "nearest", behavior: "smooth" }), 350);
}

function handleOAuthDisconnect() {
	oauth?.disconnect?.();
	signInError = null;
	invalidateAuthState(providerId);
}
let headerLogoHost: HTMLSpanElement | null = null;
let headerLogoComponent: ReturnType<typeof mount> | null = null;
let headerStatusHost: HTMLSpanElement | null = null;
let headerStatusComponent: ReturnType<typeof mount> | null = null;
// Reactive prop bag for the imperatively-mounted header status component. Mutating these
// fields propagates to the mounted subtree (Svelte 5 mount props are reactive via $state).
const headerStatusProps = $state<{ provider: string }>({
	provider: untrack(() => providerId),
});
let displayName = $state("");
let displayNameError = $state<string | null>(null);
// Number of display-name saves currently in flight. `displayNameError` still holds its
// previous value until an await settles, so without this Done could enable mid-save on a
// name whose validity isn't known yet — and the commit's slug is derived from that same
// name. A counter rather than a boolean: blurring twice before the first save settles
// would otherwise let the first completion clear the flag while the second is still
// running, reopening the commit gate and letting `renameProvider` move the ID out from
// under it.
let pendingDisplayNameSaves = $state(0);
const isSavingDisplayName = $derived(pendingDisplayNameSaves > 0);
const isTrusted = $derived(data.isProviderTrusted(providerId));

// Logos per template for the picker grid. Templates without a dedicated logo
// (openai-compatible) fall back to the generic AI icon.
const TEMPLATE_LOGOS: Partial<Record<ProviderTemplateId, Component<LogoProps>>> = {
	openai: OpenAILogo,
	"openai-codex": OpenAILogo,
	anthropic: AnthropicLogo,
	ollama: OllamaLogo,
	omlx: OmlxLogo,
	openrouter: OpenRouterLogo,
};

function getTemplateLogo(id: ProviderTemplateId): Component<LogoProps> {
	return TEMPLATE_LOGOS[id] ?? GenericAIIcon;
}

$effect(() => {
	displayName = providerMeta?.displayName ?? "";
});

async function handleSelectTemplate(id: ProviderTemplateId) {
	const newId = await modal.selectTemplate(id);
	providerId = newId;
	step = "configure";
	// Promote the no-API-key path: a freshly picked OAuth provider opens on the sign-in tab.
	const def = getProviderDefinition(newId, data.getAllProviderMeta());
	if (def?.oauth) {
		handleAuthModeChange("codex");
	}
}

// Guards the one-time live commit so it never re-runs once the provider is configured
// or while a commit is already in flight (the effect can re-fire mid-await). Reactive so
// the Done button can stay disabled across the commit's awaits — closing mid-rename would
// race the ID change, and `markSubmitted` only lands after it.
let isCommitting = $state(false);

// Promotes a draft to a fully configured provider the moment its connection validates.
// This replaces the old "Add Provider" button: display name / auth / trusted all
// autosave as they change, so the only remaining commit steps are slug-finalizing the
// ID and flipping isConfigured — done here, exactly once, on first successful connection.
async function commitProvider() {
	if (isConfigured || isCommitting) return;
	isCommitting = true;
	try {
		// Rename the draft to a slug derived from the final display name — this is the
		// only point where the ID changes. Doing it once (not on every name edit) keeps
		// downstream references stable while producing a human-readable, recoverable ID.
		const name = displayName.trim() || (providerMeta?.displayName ?? "");
		const base = slugifyProviderName(name);
		if (base && base !== providerId) {
			// Collide only against configured providers (minus this draft). Unconfigured
			// providers are stale drafts, not real conflicts — counting them would push a
			// legitimately-named provider to "openai-2".
			const otherIds = new Set(data.getConfiguredProviders().filter((id) => id !== providerId));
			let finalId = base;
			let n = 2;
			while (otherIds.has(finalId)) finalId = `${base}-${n++}`;
			// `renameProvider` re-keys everything synchronously and only awaits its persist,
			// so take the promise without awaiting and point `providerId` at the new ID in
			// the same turn. Awaiting first would leave `providerId` naming a key that no
			// longer exists for the length of a settings write — the window every "Provider
			// not found" failure in this modal came from.
			const renamed = data.renameProvider(providerId, finalId);
			// Its validation guards reject rather than throw (it's async), so confirm the
			// re-key actually happened before adopting the new ID.
			const oldId = providerId;
			if (data.getProviderMeta(finalId) && !data.getProviderMeta(oldId)) {
				modal.selectedProvider = finalId;
				providerId = finalId;
			}
			try {
				await renamed;
			} catch {
				// keep whichever ID is live if the persist fails
			}
		}
		data.setProviderConfigured(providerId, true);
		// Mark submitted BEFORE any await — the provider is now committed. Otherwise closing
		// the modal during the fetchQuery below (e.g. right after seeing "Connected") would
		// hit onClose with isSubmitted still false and delete the just-configured provider.
		modal.markSubmitted();
		// The auth query re-keys on providerId, so it re-fires under the new ID after a
		// rename — refetch so the inline status stays "Connected" rather than flashing.
		await modal.plugin.queryClient.fetchQuery(getProviderStateQueryOptions(providerId));
		invalidateProviderState(providerId);
	} finally {
		isCommitting = false;
	}
}

async function handleDisplayNameBlur(nextName: string) {
	const trimmedName = nextName.trim();
	if (!trimmedName || trimmedName === providerMeta?.displayName) {
		displayName = providerMeta?.displayName ?? "";
		displayNameError = null;
		return;
	}
	pendingDisplayNameSaves += 1;
	try {
		await data.updateProviderMeta(providerId, { displayName: trimmedName });
		displayName = trimmedName;
		displayNameError = null;
		modal.refreshTitle(trimmedName);
	} catch (e) {
		displayNameError = e instanceof Error ? e.message : "Invalid name";
	} finally {
		pendingDisplayNameSaves -= 1;
	}
}

function handleTrustedChange(trusted: boolean) {
	data.setProviderTrusted(providerId, trusted);
}

function getProviderLogo(): Component<LogoProps> {
	return providerDefinition?.logo ?? GenericAIIcon;
}

function renderHeaderLogo() {
	if (step !== "configure") return;
	const title = modal.titleEl;
	const header = title.parentElement;
	// Don't let the title stretch — it would push the trust icon onto a new line, where
	// it collides with the absolutely-positioned .modal-close-button.
	// Zero the inline margins too: Obsidian's .modal-title uses auto side-margins that
	// resolve to a large value in a flex row, opening a gap on either side of the title.
	title.setCssStyles({ margin: "0", flex: "0 0 auto" });
	header?.setCssStyles({
		display: "flex",
		flexDirection: "row",
		flexWrap: "nowrap",
		gap: "0.5rem",
		alignItems: "center",
		justifyContent: "flex-start",
		// Clear the absolutely-positioned close button in the top-right corner.
		paddingInlineEnd: "2rem",
	});
	if (header) {
		// Logo before the title.
		if (!headerLogoHost || headerLogoHost.parentElement !== header) {
			headerLogoHost?.remove();
			headerLogoHost = header.createSpan({ cls: "provider-setup-header-logo" });
			header.insertBefore(headerLogoHost, title);
		}

		if (headerLogoComponent) {
			unmount(headerLogoComponent);
			headerLogoComponent = null;
		}

		headerLogoHost.empty();
		headerLogoComponent = mount(getProviderLogo(), {
			target: headerLogoHost,
			props: { width: 32, height: 32 },
		});

		// Trust icon after the title (logo → name → trust).
		// Recreating the host must also recreate the component: leaving the old one mounted
		// kept it rendering into the now-detached span while the `!headerStatusComponent`
		// guard below suppressed a remount, so the icon silently vanished from the header.
		// Tear both down together.
		if (!headerStatusHost || headerStatusHost.parentElement !== header) {
			if (headerStatusComponent) {
				unmount(headerStatusComponent);
				headerStatusComponent = null;
			}
			headerStatusHost?.remove();
			headerStatusHost = header.createSpan({ cls: "provider-setup-header-status" });
			title.after(headerStatusHost);
		}

		if (!headerStatusComponent) {
			headerStatusComponent = mount(ProviderSetupHeader, {
				target: headerStatusHost,
				props: headerStatusProps,
			});
		}
	}
}

$effect(() => {
	if (step !== "configure") return;
	providerDefinition;
	renderHeaderLogo();

	return () => {
		if (headerLogoComponent) {
			unmount(headerLogoComponent);
			headerLogoComponent = null;
		}
		headerLogoHost?.remove();
		headerLogoHost = null;
		if (headerStatusComponent) {
			unmount(headerStatusComponent);
			headerStatusComponent = null;
		}
		headerStatusHost?.remove();
		headerStatusHost = null;
	};
});

// Keep the imperatively-mounted header component's props in sync with the modal's reactive
// state (the provider id changes once, when a committed draft is renamed to its slug).
$effect(() => {
	headerStatusProps.provider = providerId;
});

// Live commit: once the connection validates on the configure step, promote the draft to
// a configured provider (no button). The commitProvider guard makes this a one-shot —
// it no-ops once configured, so later validation failures never un-configure it.
$effect(() => {
	if (step !== "configure") return;
	// Wait out an in-flight name save too: the commit slugifies the display name into the
	// provider's final ID, so committing mid-save could derive it from a name that is about
	// to be rejected. The save settling re-runs this effect.
	if (query.data?.success && !isConfigured && !displayNameError && !isSavingDisplayName) {
		untrack(() => void commitProvider());
	}
});

// In-body connection status. The header carries the same verdict as a small icon, but that
// is easy to miss — especially in onboarding, where the user has never seen this modal and
// has no "Add" button to press, so nothing tells them the provider took. The status row
// below is the primary signal; the header icon stays as a secondary cue.
type ConnectionStatus = "idle" | "checking" | "connected" | "failed";
const connectionStatus = $derived.by<ConnectionStatus>(() => {
	if (!hasCredentials) return "idle";
	if (query.isPending || query.isFetching) return "checking";
	if (query.data?.success) return "connected";
	if (query.data !== undefined) return "failed";
	return "idle";
});
const connectionError = $derived(
	query.data && !query.data.success ? (query.data.message ?? "Authentication failed") : "Authentication failed",
);

// Done must track the *commit*, not just the connection. A valid connection alone isn't
// enough to leave safely: the commit effect skips while `displayNameError` is set, so
// closing then would hit onClose with an uncommitted draft and delete it along with the
// credentials the user just entered; and closing mid-commit races `renameProvider`, whose
// ID change lands before `markSubmitted`. A name save still in flight counts as unsettled
// too — `displayNameError` lags the await, and the commit slugifies that same name.
// Editing an already-configured provider has nothing to commit, so it's ready as soon as
// it validates.
const canFinish = $derived(
	connectionStatus === "connected" && isConfigured && !isCommitting && !displayNameError && !isSavingDisplayName,
);
</script>

{#if step === "pick"}
  <div class="modal-content">
    <!-- The docs cover local setup (Ollama) and how to pick a model — the two
         things a new user stalls on before they can tell whether a failure is their
         endpoint, their key, or their model choice. -->
    <p class="provider-picker-desc">
      Choose a provider to connect. <DocsLink
        variant="inline"
        doc="providers"
        label="Setup guide"
      />
    </p>
    <div class="provider-picker-grid">
      {#each providerTemplates as template (template.id)}
        {@const Logo = getTemplateLogo(template.id)}
        <button
          type="button"
          class="provider-picker-tile"
          onclick={() => void handleSelectTemplate(template.id)}
        >
          <span class="provider-picker-logo">
            <Logo width={32} height={32} />
          </span>
          <span class="provider-picker-name">{template.displayName}</span>
        </button>
      {/each}
    </div>
  </div>
{:else}
  <div class="modal-content">
    <SettingItem
      name="Provider name"
      desc="Name this provider instance so you can distinguish it later."
    >
      <!-- Disabled while the commit runs: it derives the provider's permanent ID from this
           name, so editing it mid-flight has nothing sensible to mean. Note this is not
           what makes the rename safe — disabling a focused input fires a blur, and Svelte
           only flushes `isCommitting` to the DOM after the effect has already entered the
           commit, so that blur lands *inside* the window rather than before it. The fix is
           in commitProvider, which no longer leaves `providerId` stale across an await. -->
      <Text
        inputType="text"
        value={displayName}
        disabled={isCommitting}
        placeholder={providerDefinition?.displayName ?? "New Provider"}
        onblur={(value: string) => void handleDisplayNameBlur(value)}
      />
    </SettingItem>
    {#if displayNameError}
      <div
        style="color: var(--text-error); font-size: var(--font-smaller); padding: 0 var(--size-4-3) var(--size-4-2);"
      >
        {displayNameError}
      </div>
    {/if}

    {#if oauth && oauth.supportsApiKey}
      <!-- OAuth + API key: sign-in is the primary path; the key field is revealed on
           demand via a link, so the common (no-key) flow stays a single clean button.
           On mobile the loopback OAuth flow is unavailable, so show the key field only. -->
      {#if oauthAvailable}
        {@render oauthSignIn()}

        <div class="auth-alt-toggle">
          <button type="button" class="auth-alt-link" onclick={toggleApiKey}>
            {revealApiKey ? "Hide API key field" : "Use an API key instead →"}
          </button>
        </div>

        {#if revealApiKey}
          <AuthConfigFields provider={providerId} />
        {/if}
      {:else}
        <AuthConfigFields provider={providerId} />
      {/if}

      {@render trustedToggle()}
    {:else if oauth}
      <!-- OAuth-only provider (no manual API key): sign-in CTA only. On mobile there is
           no viable credential path (loopback OAuth needs a desktop). -->
      {#if oauth.description}
        <div class="setting-item">
          <div class="setting-item-description">{oauth.description}</div>
        </div>
      {/if}

      {#if oauthAvailable}
        {@render oauthSignIn()}
      {:else}
        <div class="setting-item">
          <div class="setting-item-description">
            {oauth.label} sign-in is only available on desktop.
          </div>
        </div>
      {/if}
      {@render trustedToggle()}
    {:else}
      <AuthConfigFields provider={providerId} afterRequired={trustedToggle} />
    {/if}

    {@render connectionStatusRow()}
  </div>
{/if}

{#snippet connectionStatusRow()}
  <!-- The modal has no submit button (auth autosaves and the provider commits itself the
       moment validation passes), so without this row a successful setup looks identical to
       an untouched form. Spell the verdict out, and give the user an explicit way to leave. -->
  <div class="provider-connection-row">
    <div class="provider-connection-status" role="status" aria-live="polite">
      {#if connectionStatus === "checking"}
        <CircularLoader size={16} color="var(--text-muted)" />
        <span class="provider-connection-text">Checking connection…</span>
      {:else if connectionStatus === "connected"}
        <span class="provider-connection-icon is-success" use:icon={"check-circle"}></span>
        <span class="provider-connection-text is-success">Connected</span>
        {#if displayNameError}
          <!-- Connected, but the commit is blocked: say why, so a disabled Done isn't a
               dead end the user has to guess at. -->
          <span class="provider-connection-text is-muted">— fix the provider name to finish</span>
        {/if}
      {:else if connectionStatus === "failed"}
        <span class="provider-connection-icon is-error" use:icon={"x-circle"}></span>
        <span class="provider-connection-text is-error">{connectionError}</span>
      {:else}
        <span class="provider-connection-text is-muted">
          Enter your credentials above — the connection is checked automatically.
        </span>
      {/if}
    </div>

    <Button buttonText="Done" cta={canFinish} disabled={!canFinish} onClick={() => modal.close()} />
  </div>
{/snippet}

{#snippet trustedToggle()}
  <SettingItem
    name="Trusted with private notes"
    desc="Allow this provider to access notes that remain private for untrusted providers."
  >
    <Toggle checked={isTrusted} onchange={handleTrustedChange} />
  </SettingItem>
{/snippet}

{#snippet oauthSignIn()}
  {#if oauth}
    <SettingItem name={`${oauth.label} Sign-In`} desc={oauth.description ?? ""}>
      <div class="flex gap-2 items-center">
        {#if isSigningIn && oauth.cancelSignIn}
          <!-- While a sign-in is pending, let the user abort it (e.g. they closed the
               browser tab) and retry, instead of waiting out the timeout. -->
          <Button buttonText="Cancel sign-in" onClick={handleCancelSignIn} />
        {:else if oauthConnected && !oauth.disconnect}
          <!-- API-key-backed OAuth (e.g. OpenRouter): the minted key doesn't expire, so
               reconnecting is needless. Show a plain connected status, no button. -->
          <span class="oauth-connected-label">Connected via {oauth.label}</span>
        {:else if oauthConnected}
          <!-- Session-backed OAuth (e.g. Codex/ChatGPT): tokens can expire or be revoked,
               so keep Reconnect (re-auth) and Disconnect available. -->
          <span class="oauth-connected-label">Connected via {oauth.label}</span>
          <Button buttonText="Reconnect" disabled={isSigningIn} onClick={() => void handleOAuthSignIn()} />
          {#if oauth.disconnect}
            <Button buttonText="Disconnect" onClick={handleOAuthDisconnect} />
          {/if}
        {:else}
          <Button
            buttonText={`Sign in with ${oauth.label}`}
            disabled={isSigningIn}
            cta={true}
            onClick={() => void handleOAuthSignIn()}
          />
        {/if}
      </div>
    </SettingItem>
    {#if isSigningIn && oauth.submitManualCode}
      <!-- On mobile the flow is headless (no localhost/redirect): OpenRouter shows the
           authorization code in the browser and the user pastes it here. On desktop this
           is a fallback if the browser doesn't return to Obsidian automatically. -->
      <SettingItem
        name="Paste authorization code"
        desc="Copy the authorization code shown in the browser and paste it here to finish connecting."
      >
        <div class="flex gap-2 items-center" onfocusin={scrollManualCodeIntoView}>
          <Text inputType="text" bind:value={manualCode} placeholder="Authorization code" />
          <Button buttonText="Submit" disabled={!manualCode.trim()} onClick={handleSubmitManualCode} />
        </div>
      </SettingItem>
    {/if}
  {/if}
{/snippet}

<style>
  .oauth-connected-label {
    display: inline-flex;
    align-items: center;
    color: var(--text-success, #4caf50);
    font-size: var(--font-ui-small);
    font-weight: 500;
  }

  .provider-connection-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--size-4-3);
    margin-top: var(--size-4-2);
    padding: var(--size-4-3);
    border-top: 1px solid var(--background-modifier-border);
  }

  .provider-connection-status {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
    min-width: 0;
  }

  .provider-connection-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  /* The action injects a bare <svg>, which defaults to 100%/auto and overflows the box. */
  .provider-connection-icon :global(svg) {
    width: 16px;
    height: 16px;
  }

  .provider-connection-text {
    font-size: var(--font-ui-small);
    overflow-wrap: anywhere;
  }

  .provider-connection-text.is-muted {
    color: var(--text-muted);
  }

  .is-success {
    color: var(--text-success, #4caf50);
  }

  .provider-connection-text.is-success {
    font-weight: 500;
  }

  .is-error {
    color: var(--text-error);
  }

  .auth-alt-toggle {
    padding: 0 var(--size-4-3) var(--size-4-2);
  }

  .auth-alt-link {
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    color: var(--text-muted);
    font-size: var(--font-smaller);
    cursor: pointer;
  }

  .auth-alt-link:hover {
    color: var(--text-accent);
  }

  .provider-picker-desc {
    color: var(--text-muted);
    margin: 0 0 var(--size-4-3);
  }

  .provider-picker-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: var(--size-4-3);
  }

  .provider-picker-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--size-4-2);
    min-height: 96px;
    padding: var(--size-4-3) var(--size-4-2);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    background: var(--background-secondary);
    cursor: pointer;
    transition: border-color 0.1s ease, background 0.1s ease;
  }

  .provider-picker-tile:hover {
    border-color: var(--interactive-accent);
    background: var(--background-modifier-hover);
  }

  .provider-picker-logo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    overflow: hidden;
  }

  .provider-picker-logo :global(svg) {
    width: 32px;
    height: 32px;
  }

  /* GenericAIIcon renders a div (Lucide action) rather than a bare <svg>. */
  .provider-picker-logo :global(> div) {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .provider-picker-name {
    font-size: var(--font-smaller);
    text-align: center;
    color: var(--text-normal);
  }

  /* Mobile keyboard avoidance for this modal only (see ProviderSetup.ts onOpen, and
     scrollManualCodeIntoView above). Obsidian's base .modal-container is pinned to the
     full pre-keyboard viewport and doesn't react to --keyboard-height, so a field near
     the bottom (the OAuth manual-code paste input) can end up hidden behind the keyboard.
     Confirmed on-device: shrinking the container to the visible area makes .modal-content
     scrollable, which is required before scrollIntoView has anything to scroll within. */
  :global(.s2b-provider-setup-modal-container) {
    top: max(var(--safe-area-inset-top, 0px), env(safe-area-inset-top, 0px));
    bottom: var(--keyboard-height, 0px);
    transition:
      top 0.15s ease-out,
      bottom 0.15s ease-out;
  }

  :global(.s2b-provider-setup-modal-container .modal) {
    max-height: calc(100% - 24px);
  }
</style>
