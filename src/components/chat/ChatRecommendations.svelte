<script lang="ts">
import I18nText from "../ui/I18nText.svelte";
import { Notice } from "obsidian";
import { editAgentAction, showActionNotice } from "../../utils/actionNotice";
import { buildPersistedChatModel } from "../../utils/persistedChatModel";
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import type { SessionRegistry } from "../../stores/chatStore.svelte";
import { useAvailableModels } from "../../hooks/useAvailableModels.svelte";
import {
	confirmEnableIntegrationPrivacy,
	getPluginIcon,
	toExecToolId,
} from "../../agent/integrations/pluginIntegrations";
import { icon } from "../../utils/utils";
import { skillsDir } from "../../utils/agentPaths";
import { Logger } from "../../utils/logging";
import { extractErrorMessage } from "../../utils/errorMessage";
import { ModelSelectionModal } from "../modal/ModelSelectionModal";
import { ProviderSetupModal } from "../../views/provider-setup/ProviderSetup";
import { isMobileUI } from "../../utils/platform";
import { t } from "../../i18n";
import {
	DISMISS_ALL_ID,
	filterIntegrationSuggestions,
	filterPluginNudges,
	filterSuggestions,
	filterUpdateNotices,
	INTEGRATION_SUGGESTIONS,
	mergeSuggestions,
	type PluginNudge,
	pluginNudgeId,
	shouldCollapsePluginNudges,
	type SuggestedQuery,
	type UpdateNotice,
} from "./chatRecommendations";

interface Props {
	registry: SessionRegistry;
	threadPath?: string | null;
}

let { registry, threadPath = null }: Props = $props();

const data = getData();
const plugin = getPlugin();
const models = useAvailableModels();

// Mirrors ModelSelectButton's resolution exactly: the session's own agent choice
// wins so this reflects the model the composer would actually use for this tab,
// not just the global default.
const session = $derived(registry.sessionFor(threadPath));
const selectedAgent = $derived(
	(session?.selectedAgentId ? data.getAgent(session.selectedAgentId) : undefined) ?? data.getSelectedAgent(),
);
// Suggested queries are dead ends without a model to run them, so they're replaced
// by a CTA to pick one rather than shown alongside a composer that can't send.
const noModelSelected = $derived(!selectedAgent?.chatModel);
// Distinguishes "no provider at all" from "provider configured, just no model
// picked yet" — ModelSelectionModal's own empty state only tells the user to go
// add one in settings with no way to get there, so that case opens the same
// ProviderSetupModal Settings' own "Add Provider" button uses, skipping the
// Settings detour entirely.
const noProviderConfigured = $derived(!models.hasProviders);

function openModelPicker(): void {
	if (noProviderConfigured) {
		new ProviderSetupModal(plugin, {}).open();
		return;
	}
	const currentSelection = selectedAgent?.chatModel
		? { provider: selectedAgent.chatModel.provider, model: selectedAgent.chatModel.model }
		: null;
	new ModelSelectionModal(plugin, "chat", currentSelection, (selected) => {
		if (!selected) return;
		const agentId = session?.selectedAgentId || data.selectedAgentId;
		data.updateAgent(agentId, {
			chatModel: buildPersistedChatModel(selected.provider, selected.model, selectedAgent?.chatModel),
		});
	}).open();
}

// resolvePluginIntegrations() reads live app.plugins state, which is not a Svelte
// signal. Bump this on the plugin manager's "changed" event and on window focus
// (returning from Obsidian's plugin settings) so newly installed/enabled plugins
// surface without a full reload — mirrors AgentEditorModal.svelte.
let pluginRefresh = $state(0);

$effect(() => {
	const refresh = () => {
		pluginRefresh++;
	};
	// @ts-ignore - app.plugins is not in the official Obsidian types
	const pluginManager = plugin.app.plugins as
		| { on?: (name: string, cb: () => void) => unknown; offref?: (ref: unknown) => void }
		| undefined;
	const changeRef = pluginManager?.on?.("changed", refresh);
	window.addEventListener("focus", refresh);
	return () => {
		if (changeRef) pluginManager?.offref?.(changeRef);
		window.removeEventListener("focus", refresh);
	};
});

/** True when the given embed index is assigned and actually populated. */
function indexPopulated(indexId: string | null): boolean {
	if (!indexId) return false;
	return (data.getEmbeddingIndex(indexId)?.documentCount ?? 0) > 0;
}

const ctx = $derived({
	hasChat: models.hasModels,
	hasSearch: indexPopulated(data.searchEmbedIndex),
});

/**
 * Whether a plugin integration is actually usable by this agent right now — the exact
 * inverse of the nudge condition below. All three must hold:
 *
 *  1. the plugin is installed and enabled in Obsidian;
 *  2. its skill is enabled for this agent (absent = off, matching the runtime
 *     `AgentManager.getEnabledPluginIds()` semantics rather than the editor's display
 *     default);
 *  3. the `exec_<plugin>` tool is approved.
 *
 * (3) is the easy one to forget and the reason this isn't just "is the skill on".
 * `AgentManager.skillHasUsableTools` documents the divergence: declining the privacy
 * confirmation leaves the skill enabled with exec approval OFF, and the curated
 * integration skills declare no `allowed-tools` at all — their bodies are entirely about
 * calling `exec_<plugin>`. Suggesting a query in that state would be a dead end.
 */
function integrationUsable(pluginId: string): boolean {
	const mgr = plugin.agentManager;
	if (!mgr?.isPluginEnabled(pluginId)) return false;

	const agent = data.getSelectedAgent();
	if (!(agent.pluginExecTools?.[toExecToolId(pluginId)] ?? false)) return false;

	// Resolve the skill from what is actually discovered on disk rather than trusting a
	// hardcoded id: curated integration skills seed on demand, so the file may not exist
	// yet even though CURATED_PLUGIN_INTEGRATIONS names one (same reasoning as
	// `enablePlugin` below, issue #382).
	const skills = plugin.skillsService?.isDiscovered() ? plugin.skillsService.getCachedSkills() : undefined;
	if (!skills) return false;
	const skillId = [...skills].find(([, metadata]) => metadata.linkedPluginId === pluginId)?.[0];
	if (!skillId) return false;
	return agent.skills[skillId]?.enabled ?? false;
}

// Starter queries for integrations that are switched on and usable. Reads live
// `app.plugins` state, so it depends on the same refresh signal the nudges use.
const integrationSuggestions = $derived.by<SuggestedQuery[]>(() => {
	const _refresh = pluginRefresh;
	return filterIntegrationSuggestions(INTEGRATION_SUGGESTIONS, data.dismissedRecommendations, integrationUsable);
});

// Suggestions are hidden (not just the `chat`-gated one) when no model is
// selected — the model-select CTA takes their place, since none of them can
// actually be sent yet.
//
// Generic starters lead and integration ones fill the remaining room, capped so a vault
// with several integrations can't undo the deliberate trim of the generic catalog.
const suggestions = $derived(
	!noModelSelected
		? mergeSuggestions(filterSuggestions(ctx, data.dismissedRecommendations), integrationSuggestions).map(
				localizeSuggestion,
			)
		: [],
);

/**
 * The catalog in `chatRecommendations.ts` stays English and import-free (it is unit-tested
 * in isolation); chip text and prefilled query are localized here, keyed by the stable id.
 */
function localizeSuggestion(s: SuggestedQuery): SuggestedQuery {
	switch (s.id) {
		case "help-overview":
			return { ...s, label: t("chat.recommendations.suggestion_help_overview") };
		case "summarize-recent":
			return { ...s, label: t("chat.recommendations.suggestion_summarize_recent") };
		case "find-notes":
			return {
				...s,
				label: t("chat.recommendations.suggestion_find_notes"),
				query: t("chat.recommendations.suggestion_find_notes_query"),
			};
		case "int-tasknotes":
			return { ...s, label: t("chat.recommendations.suggestion_tasknotes") };
		case "int-tasks":
			return { ...s, label: t("chat.recommendations.suggestion_tasks") };
		case "int-dataview":
			return { ...s, label: t("chat.recommendations.suggestion_dataview") };
		default:
			return s;
	}
}

// Installed+enabled plugins whose S2B integration isn't switched on for the
// selected agent yet. Not dismissed = eligible to nudge.
const pluginNudges = $derived.by<PluginNudge[]>(() => {
	// Depend on the live-plugin refresh signal so this recomputes on install/enable.
	const _refresh = pluginRefresh;
	const integrations = plugin.agentManager?.resolvePluginIntegrations() ?? [];
	const agent = data.getSelectedAgent();
	const candidates: PluginNudge[] = [];
	for (const integ of integrations) {
		// A skill-backed integration is only actually bound to the agent when its
		// skill state is explicitly enabled (absent = off), matching the runtime
		// AgentManager.getEnabledPluginIds() semantics — not the editor's display
		// default. Exec-only integrations (no skill) are on when their exec tool is.
		const enabled = integ.skillId
			? (agent.skills[integ.skillId]?.enabled ?? false)
			: (agent.pluginExecTools?.[toExecToolId(integ.pluginId)] ?? false);
		if (enabled) continue;
		candidates.push({
			id: pluginNudgeId(integ.pluginId),
			pluginId: integ.pluginId,
			displayName: integ.displayName,
			icon: getPluginIcon(integ.pluginId),
			skillId: integ.skillId,
		});
	}
	// Every eligible nudge, skill-backed first. Nothing is capped: the footer collapses
	// into one summary row when there are several (see `nudgesCollapsed`), which bounds
	// its height without withholding integrations from the user.
	return filterPluginNudges(candidates, data.dismissedRecommendations);
});

// Whether the nudge footer renders as a summary row rather than one row per plugin.
// Expansion is deliberately ephemeral component state, not persisted: it's a transient
// disclosure for the current empty state, not a user preference worth remembering.
let nudgesExpanded = $state(false);
// Desktop tolerates a longer run of rows than mobile, so the threshold differs. Read once
// here rather than at each call site so the summary row and the "Show less" control can
// never disagree about whether this list is collapsible.
const collapsible = $derived(shouldCollapsePluginNudges(pluginNudges.length, isMobileUI()));
const nudgesCollapsed = $derived(collapsible && !nudgesExpanded);
// Leading glyphs for the summary row. Capped purely so the cluster can't grow unbounded
// and push the label out of a narrow pane — the COUNT beside it is always exact, so this
// truncation never hides the real total from the user.
const MAX_SUMMARY_ICONS = 4;
const nudgeSummaryIcons = $derived(pluginNudges.slice(0, MAX_SUMMARY_ICONS));

function dismissAllPluginNudges(): void {
	// The summary row stands for the whole pending set, so its dismiss applies to all of
	// them — dismissing them one-by-one behind a collapsed row would be invisible work.
	for (const nudge of pluginNudges) data.dismissRecommendation(nudge.id);
}

// "Updated default" notices: agents whose customized prompt/guidance couldn't be
// auto-migrated after a default changed upstream (issue #356). staleGuidance is
// computed once at startup, so this is a plain read (not reactive to live edits).
const updateNotices = $derived<UpdateNotice[]>(filterUpdateNotices(data.staleGuidance, data.dismissedRecommendations));

const hasContent = $derived(updateNotices.length > 0 || pluginNudges.length > 0 || suggestions.length > 0);

function useSuggestion(s: SuggestedQuery): void {
	// Prefill only — the input effect mirrors this into the editor and focuses.
	registry.pendingInput = s.query ?? s.label;
}

async function enablePlugin(nudge: PluginNudge): Promise<void> {
	const agent = data.getSelectedAgent();
	// Unsandboxed main-thread `app` access bypasses per-provider privacy rules — warn before
	// seeding anything so a cancel leaves no skill and no exec tool enabled. Same gate as
	// AgentEditorModal.toggleAutoIntegration, shared via confirmEnableIntegrationPrivacy.
	if (!(await confirmEnableIntegrationPrivacy(plugin.app, data, nudge.displayName))) return;

	// Mirror AgentEditorModal.toggleAutoIntegration: resolve the skill from what is actually
	// *discovered on disk*, not from the nudge's id. A curated integration carries a hardcoded
	// skillId in CURATED_PLUGIN_INTEGRATIONS even before its SKILL.md is seeded (community
	// integration skills seed on demand, not at startup), so trusting nudge.skillId here would
	// flip the skill on for an agent while no skill file exists (issue #382).
	let skillId = plugin.skillsService?.isDiscovered()
		? [...plugin.skillsService.getCachedSkills()].find(
				([, metadata]) => metadata.linkedPluginId === nudge.pluginId,
			)?.[0]
		: undefined;
	if (!skillId) {
		const service = plugin.skillsService;
		if (!service) {
			new Notice(t("chat.recommendations.skills_initializing"));
			return;
		}
		try {
			skillId = (await service.seedIntegrationSkill(nudge.pluginId, nudge.displayName)) ?? undefined;
		} catch (error) {
			Logger.error(`[ChatRecommendations] seedIntegrationSkill failed for ${nudge.pluginId}:`, error);
			showActionNotice(
				t("chat.recommendations.skill_create_failed_detail", {
					name: nudge.displayName,
					error: extractErrorMessage(error),
				}),
				editAgentAction(agent.id, t("chat.recommendations.open_agent_skills")),
			);
			return;
		}
		if (!skillId) {
			showActionNotice(
				t("chat.recommendations.skill_create_failed", { name: nudge.displayName }),
				editAgentAction(agent.id, t("chat.recommendations.open_agent_skills")),
			);
			return;
		}
		// Re-discover so the new skill enters the cache; without this a later editor
		// open (and the runtime binding) wouldn't see it as a curated Plugin Skill.
		await service.discoverSkills();
		pluginRefresh++;
	}
	data.setAgentSkillEnabled(agent.id, skillId, true);
	data.setAgentPluginExecEnabled(agent.id, toExecToolId(nudge.pluginId), true);
	new Notice(t("chat.recommendations.enabled_notice", { name: nudge.displayName, agent: agent.name }));
	// pluginNudges recomputes off the persisted agent state and drops this entry.
}

function dismiss(id: string): void {
	// A plain dismissal, same as any per-item `x` — DISMISS_ALL_ID is just the
	// well-known id every filter checks. Deliberately does NOT touch the
	// "Show recommendations" setting: that's a separate, persistent control
	// (Settings > Agents > Chats), so a future suggestion/nudge that wasn't
	// covered by this dismissal can still surface, instead of "Dismiss all"
	// silently and permanently switching the whole surface off.
	data.dismissRecommendation(id);
}

// Opens the right editing surface for a stale-guidance notice's Review action. The two
// prompt surfaces get their diff modal (yours vs the current default); a skill is edited as
// an ordinary vault note, so it opens as one — there is no modal for skill bodies.
function reviewNotice(notice: UpdateNotice): void {
	if (notice.kind === "skill") {
		const skillName = notice.skillName;
		if (!skillName) return;
		// Bundled skills diff against the body we ship, so the user can see what moved and
		// merge it. A user-created skill has no shipped default to compare with — fall back
		// to just opening the note.
		void plugin.agentManager?.openSkillDiff(skillName).then((opened) => {
			if (!opened) plugin.app.workspace.openLinkText(`${skillsDir()}/${skillName}/SKILL.md`, "", true);
		});
		return;
	}

	const mgr = plugin.agentManager;
	if (!mgr || !notice.agentId) return;
	mgr.openSystemPromptDiff(notice.agentId);
}
</script>

<!--
  Layout note: everything shares one `.recommendation-stack` column so all three
  groups line up on a single left edge instead of each centering independently.
  Order is deliberate — the greeting and suggestions (what the user came here to
  do) sit on top; plugin nudges and update notices are maintenance chores and are
  demoted to a quiet footer below a divider.
-->
<div class="chat-recommendations recommendation-stack s2b-flex s2b-flex-col">
  <!-- Always centred, even when rows follow below: dismissing the last item is a
       normal thing to do, and anchoring the greeting to the rows' left edge means
       it visibly jumps to centre the moment that happens. A fixed position reads
       as stable. -->
  <div class="greeting">
    <p class="greeting-title">{t("chat.recommendations.greeting_title")}</p>
    <p class="greeting-sub">{t("chat.recommendations.greeting_sub")}</p>
  </div>

  {#if noModelSelected}
    <div class="recommendation-group">
      <button type="button" class="model-cta" onclick={openModelPicker}>
        <span class="model-cta-icon" use:icon={noProviderConfigured ? "plug" : "bot"} style="--icon-size: 15px"
        ></span>
        <span class="model-cta-text">
          {#if noProviderConfigured}
            <span class="model-cta-title">{t("chat.recommendations.add_provider_title")}</span>
            <span class="model-cta-sub">{t("chat.recommendations.add_provider_sub")}</span>
          {:else}
            <span class="model-cta-title">{t("chat.recommendations.select_model_title")}</span>
            <span class="model-cta-sub">{t("chat.recommendations.select_model_sub")}</span>
          {/if}
        </span>
      </button>
    </div>
  {:else if suggestions.length > 0}
    <div class="recommendation-group suggestions-group">
      {#each suggestions as s (s.id)}
        <div class="suggestion-row">
          <button
            type="button"
            class="suggestion"
            title={s.query ?? s.label}
            onclick={() => useSuggestion(s)}
          >
            <span class="suggestion-icon" use:icon={s.icon} style="--icon-size: 15px"></span>
            <span class="suggestion-label">{s.label}</span>
          </button>
          <!-- No `clickable-icon`: that class carries its own hover background, which
               would paint a second, differently-rounded box on top of the row's tint.
               The row is the hover surface here. No `title` either — it duplicated the
               aria-label, so the native tooltip repeated the label back verbatim. -->
          <button
            type="button"
            class="dismiss-chip"
            aria-label={t("chat.recommendations.dismiss_suggestion_aria", { label: s.label })}
            onclick={() => dismiss(s.id)}
          >
            <span use:icon={"x"} style="--icon-size: 13px"></span>
          </button>
        </div>
      {/each}
    </div>
  {/if}

  {#if pluginNudges.length > 0 || updateNotices.length > 0}
    <div class="s2b-notices">
      {#each updateNotices as notice (notice.id)}
        <div class="s2b-notice">
          <span class="s2b-notice-icon" use:icon={"refresh-cw"} style="--icon-size: 14px"></span>
          <span class="s2b-notice-text">
            <!-- customized === false means the file is an untouched OLD default whose silent
                 auto-update failed — claiming "your customized version was kept" there would
                 assert an edit the user never made. -->
            {#if notice.customized === false}
              {#if notice.agentName}
                <I18nText message={t("chat.recommendations.stale_agent_not_updated", { label: notice.label })}>
                  {#snippet agent()}<strong>{notice.agentName}</strong>{/snippet}
                </I18nText>
              {:else}
                {t("chat.recommendations.stale_not_updated", { label: notice.label })}
              {/if}
            {:else if notice.agentName}
              <I18nText message={t("chat.recommendations.stale_agent_kept", { label: notice.label })}>
                {#snippet agent()}<strong>{notice.agentName}</strong>{/snippet}
              </I18nText>
            {:else}
              {t("chat.recommendations.stale_kept", { label: notice.label })}
            {/if}
          </span>
          <button type="button" class="s2b-notice-action" onclick={() => reviewNotice(notice)}>
            {t("chat.recommendations.review")}
          </button>
          <button
            type="button"
            class="dismiss-chip clickable-icon"
            aria-label={t("chat.recommendations.dismiss_notice_aria", { label: notice.label })}
            title={t("chat.recommendations.dismiss_notice")}
            onclick={() => dismiss(notice.id)}
          >
            <span use:icon={"x"} style="--icon-size: 13px"></span>
          </button>
        </div>
      {/each}

      <!--
        Several pending integrations collapse into one summary row so the footer stays a
        constant height instead of out-growing the suggestions above it. The count is
        always exact and one click reveals the full list, so nothing is hidden from the
        user — unlike the hard cap this replaced. Below the threshold every nudge renders
        directly; in particular a lone nudge is never summarised. See
        PLUGIN_NUDGE_COLLAPSE_THRESHOLD_DESKTOP / _MOBILE.

        Accessibility: `aria-expanded` belongs to ONE disclosure control, not to whichever
        button happens to be on screen. Both states therefore render the same toggle
        (`.nudge-disclosure`) pointing at the same `aria-controls` target, so a screen
        reader follows a single control flipping state rather than two rival ones.
      -->
      <div class="nudge-group" id="s2b-plugin-nudges">
        {#if nudgesCollapsed}
          <div class="s2b-notice">
            <span class="nudge-summary-icons" aria-hidden="true">
              {#each nudgeSummaryIcons as nudge (nudge.id)}
                <span class="nudge-summary-icon" use:icon={nudge.icon} style="--icon-size: 14px"></span>
              {/each}
            </span>
            <span class="s2b-notice-text">
              <I18nText message={t("chat.recommendations.nudges_summary", { count: pluginNudges.length })}>
                {#snippet number()}<strong>{pluginNudges.length}</strong>{/snippet}
              </I18nText>
            </span>
            <button
              type="button"
              class="s2b-notice-action nudge-disclosure"
              aria-expanded="false"
              aria-controls="s2b-plugin-nudges"
              onclick={() => {
                nudgesExpanded = true;
              }}
            >
              {t("chat.recommendations.review")}
            </button>
            <!-- Bulk action, so it is NOT the bare `×` every other row uses: a chip
                 identical to the per-row dismiss would give no hint that it clears the
                 whole set at once. Labelled with the count and set apart visually. -->
            <button
              type="button"
              class="nudge-dismiss-all"
              aria-label={t("chat.recommendations.dismiss_all_nudges_aria", { count: pluginNudges.length })}
              title={t("chat.recommendations.dismiss_all_nudges_tooltip", { count: pluginNudges.length })}
              onclick={dismissAllPluginNudges}
            >
              {t("chat.recommendations.dismiss_all")}
            </button>
          </div>
        {:else}
          {#each pluginNudges as nudge (nudge.id)}
            <div class="s2b-notice">
              <span class="s2b-notice-icon" use:icon={nudge.icon} style="--icon-size: 14px"></span>
              <span class="s2b-notice-text">
                <I18nText message={t("chat.recommendations.nudge")}>
                  {#snippet skill()}<strong>{nudge.displayName}</strong>{/snippet}
                </I18nText>
              </span>
              <button type="button" class="s2b-notice-action" onclick={() => void enablePlugin(nudge)}>
                {t("chat.recommendations.enable")}
              </button>
              <button
                type="button"
                class="dismiss-chip clickable-icon"
                aria-label={t("chat.recommendations.dismiss_nudge_aria", { name: nudge.displayName })}
                title={t("chat.recommendations.dismiss_nudge")}
                onclick={() => dismiss(nudge.id)}
              >
                <span use:icon={"x"} style="--icon-size: 13px"></span>
              </button>
            </div>
          {/each}

          <!-- Only offered once the user expanded a collapsed group: with a naturally short
               list there is nothing to collapse back to. -->
          {#if nudgesExpanded && collapsible}
            <button
              type="button"
              class="nudge-collapse nudge-disclosure"
              aria-expanded="true"
              aria-controls="s2b-plugin-nudges"
              onclick={() => {
                nudgesExpanded = false;
              }}
            >
              {t("chat.recommendations.show_less")}
            </button>
          {/if}
        {/if}
      </div>
    </div>
  {/if}

  {#if hasContent}
    <button
      type="button"
      class="dismiss-all"
      aria-label={t("chat.recommendations.dismiss_all_aria")}
      onclick={() => dismiss(DISMISS_ALL_ID)}
    >
      {t("chat.recommendations.dismiss_all")}
    </button>
  {/if}
</div>

<style>
  /* One shared column so the greeting, suggestions and notices all align on the
     same left edge. Width is capped for readability but the box itself is fluid,
     so a narrow mobile pane just shrinks it instead of overflowing.

     `box-sizing: border-box` is load-bearing, not boilerplate: there is NO global
     preflight border-box in this plugin's bundle (Obsidian's app.css does not set
     one either), so the default `content-box` made `padding-inline` add 1rem ON TOP
     of `width: 100%`. The column was therefore always 1rem wider than its parent,
     which showed up as a horizontal scrollbar once labels wrapped on a narrow pane.
     The same reason `.dismiss-chip` sets it explicitly in the mobile block below. */
  .recommendation-stack {
    width: 100%;
    max-width: 30rem;
    margin-inline: auto;
    padding-inline: 0.5rem;
    box-sizing: border-box;
    gap: 1.25rem;
  }

  /* Always centred, never anchored to the rows' left edge — see the template
     comment: dismissing the last row would otherwise make it jump. */
  .greeting {
    text-align: center;
  }

  .greeting-title {
    font-size: var(--font-ui-large);
    font-weight: var(--font-medium);
    color: var(--text-normal);
    margin: 0;
  }

  .greeting-sub {
    font-size: var(--font-ui-small);
    color: var(--text-muted);
    margin: 0.15rem 0 0;
  }

  .suggestions-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  /* `flex-start`, not `stretch`: the suggestion pill sizes to its own text (see
     `.suggestion`), so the row must not stretch it back to full width. The trailing
     dismiss chip then sits directly beside the pill rather than at the far right of
     the column — a short label with a distant `×` reads as two unrelated controls.

     The row (not the pill) carries the hover tint, and it is `width: fit-content` so the
     tint wraps label + chip exactly. The `×` cannot live INSIDE the pill — the pill is
     itself a <button>, and nesting a button in a button is invalid HTML that breaks
     keyboard navigation — so the shared background is what makes the pair read as one
     object instead of a pill with something floating beside it. */
  .suggestion-row {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    width: fit-content;
    max-width: 100%;
    gap: 0.15rem;
    padding-right: 0.25rem;
    border-radius: var(--radius-m);
    transition: background 120ms ease;
  }

  .suggestion-row:hover {
    background: var(--background-modifier-hover);
  }

  /* Full-width rows rather than centered pills: one straight left edge for the
     icons and one for the text, so the list scans vertically. `.dismiss-chip` is
     a fixed-width column (see its own rule) shared with `.s2b-notice`'s row, so
     both dismiss buttons land on the same right edge regardless of how long the
     suggestion label or the sibling "Enable"/"Review" action is. */
  /* Shrink-to-fit, NOT `flex: 1`. A full-width pill stretched a three-word label across
     the whole column, which read as an oversized input rather than a suggestion, and it
     pushed the dismiss `×` far away from the text it belongs to. `min-width: 0` still
     allows shrinking below the intrinsic width so a long label wraps instead of
     overflowing on a narrow pane; `max-width: 100%` keeps it inside the column once the
     sibling chip is accounted for. */
  .suggestion {
    /* Shrink-to-fit but shrinkable: `min-width: 0` lets a long label wrap instead of
       forcing the row wider than the column. The column bound lives on the row
       (`.suggestion-row`'s `max-width`), so it is not repeated here. */
    flex: 0 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    /* Obsidian's base `button` rule centres flex content. Without this the icon +
       label pair is centred inside the pill, so a wrapped label's second line no
       longer lines up under the first. */
    justify-content: flex-start;
    gap: 0.6rem;
    /* Symmetric padding now that the pill ends where its text does — the old
       right-padding-free rule existed to let the row's gap stand in for it while the
       pill spanned the full column. */
    padding: 0.5rem 0.75rem;
    /* Same content-box trap as `.recommendation-stack` — this is a shrinkable flex item
       with horizontal padding, so without this the padding is added outside the
       flex-resolved width and the pill overhangs its container. */
    box-sizing: border-box;
    border: none;
    border-radius: var(--radius-m);
    background: transparent;
    box-shadow: none;
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    text-align: left;
    /* Obsidian's `button` rule pins a fixed height (~30px), which crops the second
       line once a long label wraps on a narrow pane. Content decides the height. */
    height: auto;
    cursor: pointer;
    transition: background 120ms ease;
  }

  /* The row owns the hover tint (see `.suggestion-row:hover`) so it spans the label and
     the dismiss chip as one surface. The pill itself must stay transparent on hover or
     the two tints would stack into a darker patch behind the text only.

     Keyboard parity: hovering is not the only way to reach this. `:focus-visible` paints
     the same surface so a tab-through user sees the row highlight too. */
  .suggestion:hover {
    background: transparent;
    box-shadow: none;
  }

  .suggestion-row:has(.suggestion:focus-visible) {
    background: var(--background-modifier-hover);
  }

  .suggestion-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--text-muted);
  }

  /* `.s2b-pill` set `white-space: nowrap`, which clipped or overflowed the longer
     suggestions ("What are the main themes in my vault?") in a narrow pane. These
     rows wrap instead. */
  .suggestion-label {
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  /* Replaces the suggestions list when no chat model is selected: those queries
     are dead ends without a model to run them, so this takes their place as the
     one actionable thing — styled as a clear CTA (accent border), not a muted
     suggestion row, since picking a model is required, not optional. */
  /* Intrinsically sized, not `width: 100%`: unlike the suggestion/notice rows,
     this button has no trailing dismiss chip to align against, so stretching it
     to the column's full width just reads as an oversized, oddly-stretched CTA
     rather than a normal button.

     Centred rather than left-aligned to the rows below: it replaces the whole
     suggestions list, so there is no left edge to line up with — only the
     centred greeting directly above it.

     Centring is `margin-inline: auto`, not `align-self`: the button's parent is
     a plain block `.recommendation-group` div, not a flex container, so
     `align-self` has nothing to resolve against and silently does nothing. */
  .model-cta {
    margin-inline: auto;
    /* Keeps the shrink-to-fit sizing the old `align-self: flex-start` gave it —
       a bare block-level flex container would otherwise stretch full-width and
       `margin-inline: auto` would have no slack left to centre with. */
    width: fit-content;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    /* Obsidian's app.css gives `button` a fixed `height` (~30px). With
       `box-sizing: border-box` that height SUBSUMES the padding below rather
       than adding to it, so the two text lines were pinned flush against the
       top and bottom borders and any padding increase did nothing at all.
       `height: auto` hands sizing back to the content, which is what makes the
       vertical padding take effect. */
    height: auto;
    padding: 0.55rem 0.9rem;
    border: 1px solid var(--interactive-accent);
    border-radius: var(--radius-l);
    background: color-mix(in srgb, var(--interactive-accent) 8%, transparent);
    box-shadow: none;
    text-align: left;
    cursor: pointer;
    transition: background 120ms ease;
  }

  .model-cta:hover {
    background: color-mix(in srgb, var(--interactive-accent) 14%, transparent);
    box-shadow: none;
  }

  .model-cta-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--text-accent);
  }

  .model-cta-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .model-cta-title {
    font-size: var(--font-ui-small);
    font-weight: var(--font-medium);
    color: var(--text-normal);
  }

  .model-cta-sub {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  /* Maintenance chores (plugin nudges, updated-default notices) — visually quieter
     than the suggestions and separated by a rule so they read as a footer.

     NOTE the `s2b-` prefix is load-bearing: `.notice` is Obsidian's own toast class
     in app.css (dark pill, near-white text). Svelte's scoping hash does not raise
     specificity, so a bare `.notice` here loses to it and the rows render as dark
     toast blocks. Don't drop the prefix. */
  /* No gap: `.s2b-notice`'s own block padding already separates the rows, and stacking a
     gap on top of it spread the nudges far apart (they are a compact list of related
     chores, not independent cards). Suggestions keep a small gap because their hover
     pills would otherwise touch. */
  .s2b-notices {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding-top: 1rem;
    border-top: 1px solid var(--background-modifier-border);
  }

  /* Wrapper so the disclosure toggle has a stable `aria-controls` target across both
     the collapsed and expanded states. Purely structural — it must not introduce its
     own spacing, or the footer's gap would double up between nudge rows. */
  .nudge-group {
    display: contents;
  }

  /* No right padding: like `.suggestion-row`, the trailing dismiss chip's own
     width is the right-edge reserve, so both rows' chips land on the same edge.

     Lighter vertical padding than `.suggestion`'s 0.5rem. A suggestion needs that room
     because its padding is inside a visible hover pill; a notice row is bare text, so the
     same value just pushes the rows apart and the footer sprawls. The earlier 0.1rem was
     too tight and 0.5rem too airy — this sits between, close enough to the suggestions'
     rhythm to look intentional while keeping the footer compact. */
  .s2b-notice {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.2rem 0 0.2rem 0.6rem;
  }

  .s2b-notice-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--text-muted);
  }

  /* Icon cluster standing in for the individual rows' single glyph, so the collapsed
     summary still previews WHICH integrations are waiting rather than just how many.
     Sits in the same leading slot as `.s2b-notice-icon`, so the text still starts on
     the shared left edge when only one plugin is pending and the row renders expanded. */
  .nudge-summary-icons {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    /* Slight overlap reads as a stack rather than a row of unrelated glyphs, and keeps
       four icons roughly within the width of two. */
    gap: 0.15rem;
  }

  .nudge-summary-icon {
    display: flex;
    align-items: center;
    color: var(--text-muted);
  }

  /* The collapsed row's dismiss clears EVERY pending nudge, so it must not wear the
     same bare `×` chip as the per-row dismisses — an identical glyph would give no
     hint that its scope is the whole set. A worded control makes the bulk action
     legible, and it sits in the same trailing slot so the row still lines up. */
  .nudge-dismiss-all {
    flex-shrink: 0;
    padding: 0.25rem 0.4rem;
    border: none;
    background: transparent;
    box-shadow: none;
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
    white-space: nowrap;
    cursor: pointer;
  }

  .nudge-dismiss-all:hover {
    background: transparent;
    box-shadow: none;
    color: var(--text-muted);
  }

  /* Mirrors `.dismiss-all` — a quiet tertiary control, deliberately weaker than the
     accent-coloured `.s2b-notice-action` so collapsing never competes with Enable. */
  .nudge-collapse {
    align-self: flex-start;
    margin-left: 0.6rem;
    padding: 0.25rem 0.4rem;
    border: none;
    background: transparent;
    box-shadow: none;
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
    cursor: pointer;
  }

  .nudge-collapse:hover {
    background: transparent;
    box-shadow: none;
    color: var(--text-muted);
  }

  .s2b-notice-text {
    flex: 1;
    min-width: 0;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  .s2b-notice-text strong {
    font-weight: var(--font-medium);
    color: var(--text-normal);
  }

  /* A plain accent-text action, not a filled CTA — a filled button here outranked
     the actual suggestions above it. */
  .s2b-notice-action {
    flex-shrink: 0;
    padding: 0.25rem 0.4rem;
    border: none;
    background: transparent;
    box-shadow: none;
    color: var(--text-accent);
    font-size: var(--font-ui-smaller);
    cursor: pointer;
  }

  .s2b-notice-action:hover {
    background: var(--background-modifier-hover);
    box-shadow: none;
    color: var(--text-accent-hover);
  }

  /* Fixed-width so the glyph has a stable hit box.

     No `margin-left: auto` in either row. A notice row does not need it — its
     `.s2b-notice-text` is `flex: 1` and already absorbs the slack, pushing the action
     and this chip to the right edge as a pair. A suggestion row must not have it: the
     pill is shrink-to-fit, so an auto margin would strand the `×` across an expanse of
     empty space, detached from the label it dismisses. Both rows therefore keep the
     chip adjacent to the control it belongs to. */
  .dismiss-chip {
    flex-shrink: 0;
    width: 1.75rem;
    height: 1.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Self-sufficient reset: the suggestion row's chip drops `.clickable-icon` (it would
       double-paint a hover box over the row tint), so the neutral appearance can't be
       inherited from it and is declared here instead. */
    padding: 0;
    border: none;
    background: transparent;
    box-shadow: none;
    border-radius: var(--radius-s);
    opacity: 0;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      opacity 120ms ease,
      color 120ms ease;
  }

  /* Suggestion rows only: the glyph brightens but paints no background, because the row
     already supplies the tinted surface. This is what distinguishes "about to dismiss"
     from "about to run the suggestion" when both share one surface.

     Scoped to `.suggestion-row` deliberately — notice rows have NO row-level tint, so
     their chips keep `.clickable-icon`'s own hover box as their only hover feedback. */
  .suggestion-row .dismiss-chip:hover {
    background: transparent;
    box-shadow: none;
    color: var(--text-normal);
  }

  .suggestion-row:hover .dismiss-chip,
  .s2b-notice:hover .dismiss-chip,
  .dismiss-chip:focus-visible {
    opacity: 1;
  }

  /* Touch has no hover — always show the dismiss control so rows stay
     dismissable on mobile. */
  @media (hover: none) {
    .dismiss-chip {
      opacity: 1;
    }
  }

  .dismiss-all {
    align-self: flex-start;
    padding: 0.25rem 0.4rem;
    border: none;
    background: transparent;
    box-shadow: none;
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
    cursor: pointer;
  }

  .dismiss-all:hover {
    background: transparent;
    box-shadow: none;
    color: var(--text-muted);
  }

  /* Touch floor: the dismiss "x" is the smallest target in the block. Grow the
     hit box with padding so the glyph keeps its size, matching the convention in
     styles.css for the composer's icon buttons. */
  :global(.is-mobile) .dismiss-chip {
    min-width: 44px;
    min-height: 44px;
    padding: 10px;
    box-sizing: border-box;
  }

  :global(.is-mobile) .suggestion {
    padding-block: 0.65rem;
  }

  :global(.is-mobile) .s2b-notice-action,
  :global(.is-mobile) .dismiss-all,
  :global(.is-mobile) .nudge-collapse,
  :global(.is-mobile) .nudge-dismiss-all {
    min-height: 44px;
    padding-inline: 0.6rem;
  }
</style>
