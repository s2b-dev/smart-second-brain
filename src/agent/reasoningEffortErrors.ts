import { t } from "../i18n";
import { getData } from "../stores/dataStore.svelte";
import { showActionNotice } from "../utils/actionNotice";
import { Logger } from "../utils/logging";

/**
 * Wordings a provider uses when a model refuses the reasoning effort the plugin sent.
 * Observed live: LiteLLM/Azure for gpt-4.1-mini ("Unrecognized request argument supplied:
 * reasoning_effort") and Anthropic for Claude Haiku 4.5 ("adaptive thinking is not
 * supported on this model"). The rest cover the same refusal in the other parameter names
 * the plugin sends (`reasoning`, `output_config.effort`). Only consulted when the agent
 * has an effort set, so a loose match can't misfire on an unrelated failure.
 */
const REJECTION_PATTERNS = [
	/reasoning[_.\s]?effort/i,
	/adaptive thinking/i,
	/output_config/i,
	/\beffort\b.*\bnot supported\b/i,
	/\bnot supported\b.*\beffort\b/i,
	/\breasoning\b.*\bnot supported\b/i,
	/\bnot supported\b.*\breasoning\b/i,
];

/** Whether a failed run's error reads as the model rejecting the reasoning effort. */
export function isReasoningEffortRejection(message: string | undefined): boolean {
	return !!message && REJECTION_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * After a failed run: if the agent had an effort set and the provider's error says the
 * model refused it, offer to put the agent back on the model's default. Not every
 * provider says up front which models take an effort, so this is how the setting is
 * recovered from where it can't be hidden in advance (`providers/reasoningSupport.ts`).
 */
export function offerReasoningEffortReset(agentId: string, errorMessage: string | undefined): void {
	if (!isReasoningEffortRejection(errorMessage)) return;
	// Runs inside a failed run's error handler, which must not throw over the real error.
	try {
		showResetNotice(agentId);
	} catch (err) {
		Logger.warn("[reasoningEffort] Could not offer the reset:", err);
	}
}

function showResetNotice(agentId: string): void {
	const data = getData();
	const agent = agentId ? data.getAgent(agentId) : data.getSelectedAgent();
	const chatModel = agent?.chatModel;
	if (!agent || !chatModel?.modelConfig?.reasoningEffort) return;

	const { model, provider } = chatModel;
	showActionNotice(t("plugin.agent.reasoning_effort_rejected", { model }), {
		label: t("plugin.agent.reasoning_effort_use_default"),
		run: () => {
			// Re-read: the agent may have changed model since the notice appeared.
			const current = data.getAgent(agent.id)?.chatModel;
			if (current?.provider !== provider || current.model !== model) return;
			const { reasoningEffort: _, ...modelConfig } = current.modelConfig;
			data.updateAgent(agent.id, { chatModel: { ...current, modelConfig } });
		},
	});
}
