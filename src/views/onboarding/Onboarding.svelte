<script lang="ts">
import { Notice } from "obsidian";
import { ModelSelectionModal } from "../../components/modal/ModelSelectionModal";
import { PrivacyListModal } from "../../components/modal/PrivacyListModal";
import Button from "../../components/ui/Button.svelte";
import Toggle from "../../components/ui/Toggle.svelte";
import { useAvailableModels } from "../../hooks/useAvailableModels.svelte";
import type SecondBrainPlugin from "../../main";
import { DOCS } from "../../utils/docs";
import { buildPersistedChatModel } from "../../utils/persistedChatModel";
import { getData } from "../../stores/dataStore.svelte";
import { isMobileUI } from "../../utils/platform";
import { icon } from "../../utils/utils";
import { ProviderSetupModal } from "../provider-setup/ProviderSetup";
// Inlined at build time (?raw) so it ships inside main.js — the single-file
// CJS bundle has no companion asset dir to serve a separate SVG from. The
// wordmark's fixed fill is overridden to currentColor via CSS below so it
// adapts to the active theme.
import logoSvg from "../../../assets/logo-light.svg?raw";

// Mirrors the CSS stagger constants (base delay, per-step increment) and the
// highest --s2b-order used on any element below, so the click-to-skip timeout
// stays in sync with the animation instead of being a hand-copied number that
// silently goes stale whenever an element is added, removed, or reordered.
const SPLASH_HOLD_MS = 2100;
const STAGGER_STEP_MS = 80;
const FADE_DURATION_MS = 500;
const MAX_ORDER = 8; // highest --s2b-order in the markup below (the footer)

interface Props {
	plugin: SecondBrainPlugin;
	close: () => void;
}

let { plugin, close }: Props = $props();

const data = getData();
const models = useAvailableModels();

// The intro (splash + content cascade) plays only the FIRST time onboarding is
// opened. Snapshot the persisted flag at construction so flipping it below
// doesn't retroactively change this run's decision; on every later open the
// view renders in its settled state with no animation.
const playIntro = !data.onboardingSplashSeen;
if (playIntro) {
	data.onboardingSplashSeen = true;
}

// The splash animation lifts the wordmark from true viewport center up to its
// resting header position. We can't express that offset in `vh` — the resting
// position depends on layout (padding, header height, viewport size), so any
// fixed `vh` is a guess. Instead we measure it: after mount, compute the delta
// between the logo's resting center and the viewport center, feed that exact
// pixel distance into the keyframe via `--s2b-splash-offset`, then start the
// animation. This is a legitimate $effect (DOM measurement + one-time init).
let logoEl = $state<HTMLElement | null>(null);
let rootEl = $state<HTMLElement | null>(null);
let splashReady = $state(false);
// Guards against a flash of unstyled content: when the plugin's onload runs
// mid-workspace-render (e.g. re-enabling from Community plugins), this component's
// DOM can be mounted and painted before the plugin's stylesheet lands in the
// document — so .s2b-fade-in's `opacity: 0` isn't there yet and everything briefly
// renders as plain, fully-visible text. An inline style applies instantly
// regardless of stylesheet load timing, so hide the whole tree that way.
//
// Waiting a fixed number of frames doesn't work: a frame tick says nothing about
// whether the *external* styles.css Obsidian loads has been parsed yet. Instead,
// probe for a sentinel custom property that only the scoped rule below defines,
// and reveal once it's actually computed. Capped so a future rename of the
// sentinel degrades to "reveal anyway" rather than a permanently blank view.
let stylesReady = $state(false);
$effect(() => {
	const el = rootEl;
	if (!el) return;
	let frames = 0;
	let raf = 0;
	const probe = () => {
		if (getComputedStyle(el).getPropertyValue("--s2b-styles-loaded").trim() === "1" || ++frames > 30) {
			stylesReady = true;
			return;
		}
		raf = window.requestAnimationFrame(probe);
	};
	raf = window.requestAnimationFrame(probe);
	return () => cancelAnimationFrame(raf);
});
// Lets an impatient user jump straight to the settled page instead of waiting out
// the ~2.8s intro. Reuses the same "skip all animation" styling as
// prefers-reduced-motion rather than duplicating it, since the end state is
// identical either way.
let introSkipped = $state(false);
// The full-page click catcher only needs to exist while something is still
// animating — once the intro finishes on its own it must stop intercepting
// clicks meant for the real page underneath.
let introPlaying = $state(false);

$effect(() => {
	if (!playIntro || !logoEl) return;
	// Measure BEFORE the splash transform is applied, so the rect reflects the
	// logo's resting (final) layout position. Then start the animation.
	const rect = logoEl.getBoundingClientRect();
	const logoCenterY = rect.top + rect.height / 2;
	const viewportCenterY = window.innerHeight / 2;
	const offset = viewportCenterY - logoCenterY;
	logoEl.style.setProperty("--s2b-splash-offset", `${offset}px`);
	splashReady = true;
	introPlaying = true;
	const timer = window.setTimeout(
		() => {
			introPlaying = false;
		},
		SPLASH_HOLD_MS + MAX_ORDER * STAGGER_STEP_MS + FADE_DURATION_MS,
	);
	return () => window.clearTimeout(timer);
});

function skipIntro() {
	introSkipped = true;
}

// Reactive completion signals derived from the data store — no $effect for state sync.
let configuredProviders = $derived(data.getConfiguredProviders());
let hasProvider = $derived(configuredProviders.length > 0);

// Privacy-note state. The note is advice about a decision the user can only act
// on once a provider exists, and its meaning inverts under public-by-default —
// so derive the case rather than asserting one static claim.
let isPublicByDefault = $derived(data.privacyMode === "public-by-default");
// Local providers (ollama/omlx) seed trustedForPrivateData, so a user who
// connected one is already unblocked and needs no call to action.
let trustedProviders = $derived(configuredProviders.filter((p) => data.isProviderTrusted(p)));
let privacyCase = $derived(
	!hasProvider
		? "no-provider"
		: isPublicByDefault
			? "public"
			: trustedProviders.length === configuredProviders.length
				? "all-trusted"
				: trustedProviders.length > 0
					? "some-trusted"
					: "none-trusted",
);

// Providers still blocked from private notes, named so the copy can point at
// something concrete instead of "a provider".
let untrustedNames = $derived(
	configuredProviders.filter((p) => !data.isProviderTrusted(p)).map((p) => data.getProviderMeta(p)?.displayName ?? p),
);
let untrustedLabel = $derived(
	untrustedNames.length === 1
		? untrustedNames[0]
		: untrustedNames.length === 2
			? `${untrustedNames[0]} and ${untrustedNames[1]}`
			: `${untrustedNames.slice(0, -1).join(", ")}, and ${untrustedNames[untrustedNames.length - 1]}`,
);
// Onboarding sets the model on the selected agent (same as the chat header
// selector), so completion tracks the agent's chat model, not added configs.
let selectedAgent = $derived(data.getSelectedAgent());
let hasChatModel = $derived(Boolean(selectedAgent?.chatModel));

function openProviderSetup() {
	new ProviderSetupModal(plugin, {}).open();
}

function openPrivacySettings() {
	new PrivacyListModal(plugin.app).open();
}

// Reuse the same picker + agent-update flow as the chat header's model selector.
function openChatModelSetup() {
	if (!hasProvider) return;
	const currentSelection = selectedAgent?.chatModel
		? { provider: selectedAgent.chatModel.provider, model: selectedAgent.chatModel.model }
		: null;
	new ModelSelectionModal(plugin, "chat", currentSelection, (selected) => {
		if (!selected) return;
		data.updateAgent(data.selectedAgentId, {
			chatModel: buildPersistedChatModel(selected.provider, selected.model, selectedAgent?.chatModel),
		});
	}).open();
}

// Every exit completes onboarding so it never auto-opens again — reopening on
// each restart would nag users who deliberately skipped (search and graph need
// no provider at all). Reachable afterwards via the "Show Welcome" command.
function skip() {
	data.onboardingComplete = true;
	close();
}

async function startChatting() {
	data.onboardingComplete = true;
	await plugin.agentManager.createNewChat();
	close();
}

async function exploreGraph() {
	data.onboardingComplete = true;
	await plugin.activateSmartGraphView();
	close();
}

// Deep-links into Obsidian's Hotkeys tab and pre-filters it to the search command.
// This walks undocumented internals (app.setting.*), so every hop is checked: if
// the shape changes in a future Obsidian release the click must explain itself
// rather than silently doing nothing.
function openHotkeysSettings() {
	const app = plugin.app as typeof plugin.app & {
		setting?: {
			open: () => void;
			openTabById: (id: string) => void;
			activeTab?: { searchComponent?: { setValue: (v: string) => void; changeCallback: (v: string) => void } };
		};
	};
	const setting = app.setting;
	if (!setting?.open || !setting?.openTabById) {
		new Notice("Couldn't open Hotkeys — open Settings → Hotkeys and search for “Search notes”.");
		return;
	}

	setting.open();
	setting.openTabById("hotkeys");

	// Pre-filtering is a nicety: landing on the Hotkeys tab is already useful, so
	// a missing search component isn't worth a warning.
	const search = setting.activeTab?.searchComponent;
	if (!search) return;
	const query = "search notes";
	search.setValue(query);
	search.changeCallback(query);
}
</script>

{#if playIntro && introPlaying && !introSkipped}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="s2b-onboarding-skip-intro" onclick={skipIntro} aria-hidden="true"></div>
{/if}

<div
	bind:this={rootEl}
	class="s2b-onboarding"
	class:s2b-intro-skipped={introSkipped}
	style="--s2b-splash-hold: {SPLASH_HOLD_MS}ms; --s2b-stagger-step: {STAGGER_STEP_MS}ms; opacity: {stylesReady
		? 1
		: 0}"
>
	<header class="s2b-onboarding-header">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- static, build-inlined asset -->
		<div
			bind:this={logoEl}
			class="s2b-onboarding-logo"
			class:s2b-logo-splash={splashReady}
			class:s2b-logo-settled={!playIntro}
			role="presentation"
		>
			{@html logoSvg}
		</div>
		<h1 class="s2b-onboarding-title" class:s2b-fade-in={playIntro} style="--s2b-order: 0">
			Welcome to Smart Second Brain
		</h1>
		<p class="s2b-onboarding-subtitle" class:s2b-fade-in={playIntro} style="--s2b-order: 1">
			Turn your vault into an AI-assisted second brain — search smarter, explore connections in a graph,
			and chat with your notes.
		</p>
	</header>

	<section class="s2b-onboarding-pillars">
		<div class="s2b-onboarding-pillar" class:s2b-fade-in={playIntro} style="--s2b-order: 2">
			<span class="s2b-onboarding-pillar-icon" use:icon={"search"} aria-hidden="true"></span>
			<div>
				<div class="s2b-onboarding-pillar-title">Smarter search</div>
				<div class="s2b-onboarding-pillar-desc">
					Find notes by title, content, tags, and folders — with fuzzy matching. No setup needed. Add
					an embedding model later for semantic search.
					{#if !isMobileUI()}
						Or <button class="s2b-onboarding-link" onclick={openHotkeysSettings}>set a hotkey</button
						> for instant access.
					{/if}
				</div>
				<!-- A hotkey is meaningless on a phone with no keyboard, so the quick
				     way in there is the navbar magnifier instead. Same setting as
				     Settings → Search; offered here because this is where a new user
				     is being told how to reach search fast.

				     Laid out label-left / control-right like a settings row (and like
				     the step rows below), rather than switch-then-text stacked under
				     the description where it read as another paragraph. -->
				{#if isMobileUI()}
					<label class="s2b-onboarding-navbar-toggle">
						<span>Open from the navbar magnifier instead of the quick switcher</span>
						<Toggle
							checked={data.overrideMobileNavbarSearch}
							onchange={(checked) => (data.overrideMobileNavbarSearch = checked)}
						/>
					</label>
				{/if}
			</div>
		</div>
		<div class="s2b-onboarding-pillar" class:s2b-fade-in={playIntro} style="--s2b-order: 3">
			<span class="s2b-onboarding-pillar-icon" use:icon={"git-fork"} aria-hidden="true"></span>
			<div>
				<div class="s2b-onboarding-pillar-title">Smarter graph</div>
				<div class="s2b-onboarding-pillar-desc">
					See how your notes connect and cluster into topics. No setup needed.
				</div>
			</div>
		</div>
		<div class="s2b-onboarding-pillar" class:s2b-fade-in={playIntro} style="--s2b-order: 4">
			<span class="s2b-onboarding-pillar-icon" use:icon={"message-square"} aria-hidden="true"></span>
			<div>
				<div class="s2b-onboarding-pillar-title">Chat with your notes</div>
				<div class="s2b-onboarding-pillar-desc">
					Ask questions grounded in your vault, with web search and plugins like Dataview and Tasks
					integrated in. Needs an AI provider — set one up below.
				</div>
			</div>
		</div>
	</section>

	<section class="s2b-onboarding-steps">
		<!-- Step 1: Connect a provider -->
		<div
			class="s2b-onboarding-step"
			class:s2b-fade-in={playIntro}
			style="--s2b-order: 5"
			class:s2b-onboarding-step--done={hasProvider}
		>
			<span
				class="s2b-onboarding-step-status"
				use:icon={hasProvider ? "check" : "circle"}
				aria-hidden="true"
			></span>
			<div class="s2b-onboarding-step-body">
				<div class="s2b-onboarding-step-title">Connect an AI provider</div>
				<div class="s2b-onboarding-step-desc">
					{#if hasProvider}
						Provider connected. You can add or manage providers in settings.
					{:else}
						Connect OpenAI, Anthropic, Ollama, OpenRouter, or any OpenAI-compatible endpoint.
					{/if}
				</div>
			</div>
			<Button
				buttonText={hasProvider ? "Add another" : "Connect provider"}
				cta={!hasProvider}
				onClick={openProviderSetup}
			/>
		</div>

		<!-- Step 2: Add a chat model -->
		<div
			class="s2b-onboarding-step"
			class:s2b-fade-in={playIntro}
			style="--s2b-order: 6"
			class:s2b-onboarding-step--done={hasChatModel}
			class:s2b-onboarding-step--disabled={!hasProvider}
		>
			<span
				class="s2b-onboarding-step-status"
				use:icon={hasChatModel ? "check" : "circle"}
				aria-hidden="true"
			></span>
			<div class="s2b-onboarding-step-body">
				<div class="s2b-onboarding-step-title">Choose a chat model</div>
				<div class="s2b-onboarding-step-desc">
					{#if !hasProvider}
						Connect a provider first, then pick a model to chat with.
					{:else if hasChatModel}
						Using <strong>{selectedAgent?.chatModel?.model}</strong>. You're all set to start chatting.
					{:else}
						Pick a model from your connected provider to enable chat.
					{/if}
				</div>
			</div>
			<Button
				buttonText={hasChatModel ? "Change model" : "Choose model"}
				cta={hasProvider && !hasChatModel}
				disabled={!hasProvider}
				onClick={openChatModelSetup}
			/>
		</div>
	</section>

	<!-- Privacy note — copy tracks the actual provider/trust state, since the
	     advice only becomes actionable once a provider exists and its meaning
	     inverts entirely under public-by-default. -->
	<div
		class="s2b-onboarding-privacy"
		class:s2b-onboarding-privacy--ok={privacyCase === "all-trusted"}
		class:s2b-fade-in={playIntro}
		style="--s2b-order: 7"
	>
		<span
			class="s2b-onboarding-privacy-icon"
			use:icon={privacyCase === "all-trusted" ? "shield-check" : privacyCase === "public" ? "shield-alert" : "shield"}
			aria-hidden="true"
		></span>
		<div>
			<div class="s2b-onboarding-privacy-title">
				{#if privacyCase === "public"}
					Your notes are shared by default
				{:else if privacyCase === "all-trusted"}
					Note access is granted
				{:else if privacyCase === "none-trusted" || privacyCase === "some-trusted"}
					Your notes are still private
				{:else}
					Note access is private by default
				{/if}
			</div>
			<div class="s2b-onboarding-privacy-desc">
				{#if privacyCase === "no-provider"}
					Your notes are <strong>not</strong> shared with AI providers unless you allow it. Once you
					connect a provider above, you can grant it access — nothing leaves your vault before then.
				{:else if privacyCase === "public"}
					Note access is set to <strong>public by default</strong>, so providers can read your notes
					except the ones you exclude. <button class="s2b-onboarding-link" onclick={openPrivacySettings}
						>Review note access</button
					>.
				{:else if privacyCase === "all-trusted"}
					{configuredProviders.length === 1 ? "Your provider is" : "Your providers are"} marked
					<strong>trusted</strong>, so the agent can read your notes. <button
						class="s2b-onboarding-link"
						onclick={openPrivacySettings}>Review note access</button
					> to keep specific notes private.
				{:else}
					<strong>{untrustedLabel}</strong> can't read your notes yet — chat will work, but answers
					won't be grounded in your vault. Mark
					{untrustedNames.length === 1 ? "it" : "them"} as <strong>trusted</strong> in provider settings,
					or <button class="s2b-onboarding-link" onclick={openPrivacySettings}>change note access</button
					> to allow all providers.
				{/if}
			</div>
		</div>
	</div>

	<footer class="s2b-onboarding-footer" class:s2b-fade-in={playIntro} style="--s2b-order: 8">
		<!-- Docs sit with Skip rather than among the CTAs: this is the one screen every
		     user sees, so it is where a link to the full documentation has the most
		     reach, but it must not compete with the two actions on the right. -->
		<div class="s2b-onboarding-footer-secondary">
			<Button buttonText="Skip" onClick={skip} />
			<a
				class="s2b-onboarding-link"
				href={DOCS.home}
				target="_blank"
				rel="noopener noreferrer">Documentation ↗</a
			>
		</div>
		<div class="s2b-onboarding-footer-primary">
			<Button buttonText="Explore the graph" onClick={exploreGraph} />
			<Button
				buttonText="Start chatting"
				cta={true}
				disabled={!hasChatModel}
				tooltip={hasChatModel ? undefined : "Connect a provider and add a chat model first"}
				onClick={startChatting}
			/>
		</div>
	</footer>
</div>

<style>
	/* Staggered entrance: each element fades up in document order. Delay is derived
	   from a small per-element `--s2b-order` index (0, 1, 2, ...) rather than a
	   hand-tuned millisecond value, so inserting/reordering/removing an element
	   only means renumbering small integers. --s2b-splash-hold/--s2b-stagger-step
	   are set inline from the script's SPLASH_HOLD_MS/STAGGER_STEP_MS constants
	   (see script block), which the click-to-skip timeout also reads — one source
	   of truth for both the visual timing and when the skip-catcher unmounts.
	   `both` fill keeps elements hidden until their delay elapses (no flash of the
	   full layout on mount). */
	.s2b-fade-in {
		opacity: 0;
		animation: s2b-onboarding-fade-in 0.5s ease-out
			calc(var(--s2b-splash-hold) + var(--s2b-order, 0) * var(--s2b-stagger-step)) both;
	}

	@keyframes s2b-onboarding-fade-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	/* Splash intro: the wordmark fades in near screen-center (scaled up), holds a
	   beat, then glides up to its resting header position. The rest of the page
	   (delays >= 1500ms) fades in only once the logo has settled. Transform-only
	   so it stays on the GPU and never reflows the layout below it.

	   The container drives the center → hold → rise motion; the individual glyphs
	   (S, 2, B — one <path> each) cascade in on top of it, so during the initial
	   hold the letters reveal one after another before the whole wordmark rises. */
	.s2b-logo-splash {
		animation: s2b-logo-splash 2s cubic-bezier(0.22, 1, 0.36, 1) both;
		will-change: transform;
	}

	/* Per-glyph cascade: each of the three paths starts hidden and eases in with a
	   staggered delay. transform-box/transform-origin keep the scale-up anchored to
	   each glyph's own box rather than the SVG viewBox. */
	.s2b-logo-splash :global(svg path) {
		opacity: 0;
		transform-box: fill-box;
		transform-origin: center;
		animation: s2b-logo-letter 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
	}

	.s2b-logo-splash :global(svg path:nth-of-type(1)) {
		animation-delay: 0.3s;
	}

	.s2b-logo-splash :global(svg path:nth-of-type(2)) {
		animation-delay: 0.65s;
	}

	.s2b-logo-splash :global(svg path:nth-of-type(3)) {
		animation-delay: 1s;
	}

	@keyframes s2b-logo-letter {
		from {
			opacity: 0;
			transform: translateY(30%) scale(0.7);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	/* Shared "settle instantly" end-state: reached either via prefers-reduced-motion
	   (accessibility) or by clicking through the intro (impatience). Both want the
	   exact same result — everything visible, nothing animating — so one rule set
	   serves both triggers instead of duplicating it per-trigger. */
	.s2b-intro-skipped .s2b-fade-in,
	.s2b-intro-skipped .s2b-logo-splash {
		opacity: 1;
		animation: none;
	}

	.s2b-intro-skipped .s2b-logo-splash :global(svg path) {
		opacity: 1;
		animation: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.s2b-fade-in {
			opacity: 1;
			animation: none;
		}

		.s2b-logo-splash {
			opacity: 1;
			animation: none;
		}

		.s2b-logo-splash :global(svg path) {
			opacity: 1;
			animation: none;
		}
	}

	/* Invisible full-view click catcher, shown only while the intro is still
	   playing. .s2b-onboarding-container is set on the view's contentEl by
	   OnboardingView.ts, so this covers exactly the scrollable view area. */
	:global(.s2b-onboarding-container) {
		position: relative;
	}

	.s2b-onboarding-skip-intro {
		position: absolute;
		inset: 0;
		z-index: 1;
		cursor: pointer;
	}

	.s2b-onboarding {
		/* Sentinel probed from the script: its presence in the computed style is
		   proof this stylesheet is live, which a frame tick alone can't tell us. */
		--s2b-styles-loaded: 1;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		max-width: 640px;
		margin: 0 auto;
		padding: 2.5rem 1.5rem;
	}

	.s2b-onboarding-header {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 0.5rem;
	}

	.s2b-onboarding-logo {
		color: var(--text-normal);
		margin-bottom: 2rem;
		/* Hidden until the splash $effect measures the offset and applies
		   .s2b-logo-splash, so the wordmark never flashes at its resting spot.
		   On reopen (intro already seen) .s2b-logo-settled forces it visible. */
		opacity: 0;
	}

	.s2b-onboarding-logo.s2b-logo-splash,
	.s2b-onboarding-logo.s2b-logo-settled {
		opacity: 1;
	}

	/* Reopen path: glyphs are shown at rest with no per-letter animation. */
	.s2b-logo-settled :global(svg path) {
		opacity: 1;
		animation: none;
	}

	@keyframes s2b-logo-splash {
		0% {
			transform: translateY(var(--s2b-splash-offset, 44vh)) scale(1.6);
		}
		72% {
			transform: translateY(var(--s2b-splash-offset, 44vh)) scale(1.6);
		}
		100% {
			transform: translateY(0) scale(1);
		}
	}

	.s2b-onboarding-logo :global(svg) {
		display: block;
		width: 110px;
		height: auto;
	}

	/* Override the wordmark's baked-in fill so it tracks the theme. */
	.s2b-onboarding-logo :global(svg path) {
		fill: currentColor;
	}

	.s2b-onboarding-title {
		margin: 0;
		font-size: 1.6rem;
	}

	.s2b-onboarding-subtitle {
		margin: 0;
		color: var(--text-muted);
		max-width: 30rem;
	}

	.s2b-onboarding-pillars {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.s2b-onboarding-pillar {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
	}

	.s2b-onboarding-pillar-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		color: var(--text-accent);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.s2b-onboarding-pillar-title {
		font-weight: var(--font-semibold);
	}

	.s2b-onboarding-pillar-desc {
		color: var(--text-muted);
		font-size: var(--font-ui-small);
	}

	.s2b-onboarding-steps {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.s2b-onboarding-step {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem;
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-m);
	}

	.s2b-onboarding-navbar-toggle {
		display: flex;
		align-items: center;
		/* Label takes the slack, switch keeps its intrinsic width on the right —
		   the same shape as a settings row. */
		justify-content: space-between;
		gap: 0.75rem;
		margin-top: 0.5rem;
		font-size: var(--font-ui-smaller);
		color: var(--text-muted);
		cursor: pointer;
	}

	.s2b-onboarding-navbar-toggle > span {
		min-width: 0;
	}

	.s2b-onboarding-navbar-toggle :global(.checkbox-container) {
		flex-shrink: 0;
	}

	/* On a phone the three-column row (status | body | action) leaves the button
	   a sliver of width, so its label wraps or truncates. Break it onto its own
	   full-width line under the description instead: the status icon keeps its
	   column beside the text, and the action gets the whole row. */
	:global(.is-mobile) .s2b-onboarding-step {
		flex-wrap: wrap;
		align-items: flex-start;
	}

	:global(.is-mobile) .s2b-onboarding-step-body {
		/* Force the action past the icon+body pair onto the next line. */
		min-width: calc(100% - 1.75rem);
	}

	:global(.is-mobile) .s2b-onboarding-step :global(button) {
		width: 100%;
		justify-content: center;
	}

	.s2b-onboarding-step--disabled {
		opacity: 0.6;
	}

	.s2b-onboarding-step-status {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.s2b-onboarding-step--done .s2b-onboarding-step-status {
		color: var(--text-success, var(--interactive-accent));
	}

	.s2b-onboarding-step-body {
		flex: 1;
		min-width: 0;
	}

	.s2b-onboarding-step-title {
		font-weight: var(--font-semibold);
	}

	.s2b-onboarding-step-desc {
		color: var(--text-muted);
		font-size: var(--font-ui-small);
	}

	.s2b-onboarding-privacy {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem;
		border-radius: var(--radius-m);
		background: color-mix(in srgb, var(--color-blue) 10%, var(--background-secondary));
		border: 1px solid color-mix(in srgb, var(--color-blue) 25%, transparent);
	}

	/* Granted state reads as resolved rather than as a standing warning. Uses the
	   hex --color-green with color-mix; the --color-green-hsl variant is undefined
	   in some themes (e.g. Cupertino) and would render fully transparent. */
	.s2b-onboarding-privacy--ok {
		background: color-mix(in srgb, var(--color-green) 10%, var(--background-secondary));
		border-color: color-mix(in srgb, var(--color-green) 25%, transparent);
	}

	.s2b-onboarding-privacy-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		color: var(--color-blue);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.s2b-onboarding-privacy--ok .s2b-onboarding-privacy-icon {
		color: var(--color-green);
	}

	.s2b-onboarding-privacy-title {
		font-weight: var(--font-semibold);
		margin-bottom: 0.25rem;
	}

	.s2b-onboarding-privacy-desc {
		color: var(--text-muted);
		font-size: var(--font-ui-small);
	}

	.s2b-onboarding-link {
		all: unset;
		color: var(--text-accent);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.s2b-onboarding-link:hover {
		color: var(--text-accent-hover);
	}

	.s2b-onboarding-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.s2b-onboarding-footer-primary {
		display: flex;
		gap: 0.5rem;
		margin-left: auto;
	}

	.s2b-onboarding-footer-secondary {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	/* On a phone the three buttons don't fit on one line, and `flex-wrap` on a
	   `space-between` row broke them into a ragged stack — Skip alone on one line,
	   the other two sharing the next, each a different width.

	   Stack deliberately instead, ordered by intent rather than by source order:
	   the primary action (Start chatting) on top, then the secondary, with Skip
	   last and visually quiet. `order` does the reordering so the DOM keeps
	   Skip-first for tab order and screen readers. */
	:global(.is-mobile) .s2b-onboarding-footer {
		flex-direction: column;
		align-items: stretch;
		gap: 0.5rem;
	}

	/* The floating `.mobile-navbar` overlays the bottom of the view, leaving the
	   last footer button (Skip) tucked underneath it — measured on-device as a
	   5px overlap. The scroll container is `.view-content`, whose own 34px bottom
	   padding is short of the navbar's ~52px + home-indicator inset, so the
	   clearance has to go there: padding on the footer itself just extends a box
	   that is already scrolled to its end. */
	:global(.is-mobile .view-content.s2b-onboarding-container) {
		padding-bottom: calc(52px + env(safe-area-inset-bottom) + 12px) !important;
	}

	/* Both groups dissolve on mobile so their children become direct flex items of
	   the stacked footer and the `order` rules below can interleave them. */
	:global(.is-mobile) .s2b-onboarding-footer-primary,
	:global(.is-mobile) .s2b-onboarding-footer-secondary {
		display: contents;
	}

	:global(.is-mobile) .s2b-onboarding-footer :global(button) {
		width: 100%;
		justify-content: center;
	}

	/* Start chatting is the CTA — first. */
	:global(.is-mobile) .s2b-onboarding-footer-primary :global(button:last-child) {
		order: -2;
	}

	:global(.is-mobile) .s2b-onboarding-footer-primary :global(button:first-child) {
		order: -1;
	}

	/* Skip stays last and reads as the low-emphasis way out.

	   Matched through `-secondary`, not as a child of the footer: `display: contents`
	   removes that wrapper from *layout* (so Skip does become a flex item of the
	   stacked footer, and `order` below works), but it does NOT change the DOM tree
	   the selector walks — Skip's parent element is still the wrapper. Selecting
	   `.s2b-onboarding-footer > button` therefore stops matching and Skip renders
	   with its default solid background instead of quiet. */
	:global(.is-mobile) .s2b-onboarding-footer-secondary > :global(button) {
		order: 0;
		background: transparent;
		box-shadow: none;
		color: var(--text-muted);
	}

	/* The docs link trails Skip, centred to match the stacked full-width buttons
	   rather than hugging the left edge. `all: unset` leaves it `display: inline`;
	   as a flex item that blockifies anyway, but say so explicitly so the
	   text-align actually has a box to work on. */
	:global(.is-mobile) .s2b-onboarding-footer-secondary > .s2b-onboarding-link {
		order: 1;
		display: block;
		text-align: center;
		padding-block: 0.25rem;
	}
</style>
