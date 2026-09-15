/**
 * Notices that carry their own fix.
 *
 * A notice that reports a problem almost always knows which surface resolves it —
 * "add a provider" means `ProviderSetupModal`, "select a graph chat model" means the
 * Graph settings tab. Spelling that out in prose ("… in Settings → Graph") makes the
 * user dismiss the toast, remember the breadcrumb, and navigate by hand. These helpers
 * attach the destination as a link instead, so the message and the way out are the
 * same object.
 *
 * Conventions:
 * - **Navigation only.** An action opens a surface; it never mutates state. A notice is
 *   transient and often fires from something the user didn't initiate, so it is the wrong
 *   place to commit a change — the user decides once they can see the full context.
 * - **Actionable sites only.** Confirmations ("Copied to Clipboard") and transient guards
 *   ("wait for attachments to finish saving") stay plain `new Notice`; a link there is noise.
 */

import type { App } from "obsidian";
import { Notice } from "obsidian";
import { getPlugin, requestSettingsTab } from "../stores/state.svelte";
import type SecondBrainPlugin from "../main";

export type PluginSettingsTabId = "general" | "search" | "agents" | "graph" | "troubleshooting";

/** A single labelled link rendered inside a notice. */
export type NoticeAction = {
	label: string;
	run: () => void | Promise<void>;
};

type SettingsNoticeOptions = {
	tab: PluginSettingsTabId;
	linkText: string;
	duration?: number;
};

function openPluginSettingsTab(app: App, tab: PluginSettingsTabId): void {
	requestSettingsTab(tab);

	const appWithSettings = app as App & {
		setting?: { open: () => void; openTabById: (id: string) => void };
	};

	appWithSettings.setting?.open();
	appWithSettings.setting?.openTabById("smart-second-brain");
}

/** Open one of Obsidian's own settings tabs (hotkeys, community-plugins, …). */
function openObsidianSettingsTab(app: App, tabId: string): void {
	const appWithSettings = app as App & {
		setting?: { open: () => void; openTabById: (id: string) => void };
	};

	appWithSettings.setting?.open();
	appWithSettings.setting?.openTabById(tabId);
}

/**
 * The plugin singleton, or `null` if it isn't wired yet.
 *
 * `getPlugin()` throws when unset. Every action here is a nicety layered on top of a
 * message that must still be delivered, so a missing plugin degrades to a plain text
 * notice rather than throwing out of a notice call and losing the message entirely.
 */
function tryGetPlugin(): SecondBrainPlugin | null {
	try {
		return getPlugin();
	} catch {
		return null;
	}
}

/**
 * Show a notice whose message is followed by one or more inline action links.
 *
 * Actions that can't resolve their target (no plugin singleton) are dropped, and a
 * notice left with no actions renders as plain text — the message always survives.
 */
export function showActionNotice(message: string, actions: NoticeAction | NoticeAction[], duration = 10000): Notice {
	const list = (Array.isArray(actions) ? actions : [actions]).filter(Boolean);

	const notice = new Notice("", duration);
	const el = notice.messageEl;
	el.empty();
	el.appendText(list.length > 0 ? `${message} ` : message);

	list.forEach((action, index) => {
		if (index > 0) el.appendText(" · ");

		const link = el.createEl("a", { text: action.label, href: "#" });
		link.addEventListener("click", (evt) => {
			evt.preventDefault();
			// Obsidian dismisses a notice when its body is clicked. Without this the
			// click reaches that handler and the toast can tear down around us.
			evt.stopPropagation();
			notice.hide();
			void action.run();
		});
	});

	return notice;
}

/**
 * Backwards-compatible wrapper over {@link showActionNotice} for the settings-tab case.
 * Takes an explicit `app` (rather than the singleton) so existing call sites are unchanged.
 */
export function showSettingsLinkNotice(
	app: App,
	message: string,
	{ tab, linkText, duration = 10000 }: SettingsNoticeOptions,
): Notice {
	return showActionNotice(message, { label: linkText, run: () => openPluginSettingsTab(app, tab) }, duration);
}

// ---------------------------------------------------------------------------
// Action factories
//
// Each opens a surface the codebase already opens elsewhere; the referenced call
// site is the precedent being reused, not a new pattern.
// ---------------------------------------------------------------------------

/** Navigate to one of the plugin's own settings tabs. */
export function settingsAction(tab: PluginSettingsTabId, label = "Open settings"): NoticeAction {
	return {
		label,
		run: () => {
			const plugin = tryGetPlugin();
			if (plugin) openPluginSettingsTab(plugin.app, tab);
		},
	};
}

/** Navigate to one of Obsidian's own settings tabs, e.g. `hotkeys`, `community-plugins`. */
export function obsidianSettingsAction(tabId: string, label: string): NoticeAction {
	return {
		label,
		run: () => {
			const plugin = tryGetPlugin();
			if (plugin) openObsidianSettingsTab(plugin.app, tabId);
		},
	};
}

/** Open the provider setup modal on the picker step (precedent: ChatRecommendations.svelte). */
export function addProviderAction(label = "Add a provider"): NoticeAction {
	return {
		label,
		run: async () => {
			const plugin = tryGetPlugin();
			if (!plugin) return;
			const { ProviderSetupModal } = await import("../views/provider-setup/ProviderSetup");
			new ProviderSetupModal(plugin, {}).open();
		},
	};
}

/** Open the provider setup modal for an existing provider (precedent: ProviderItem.svelte). */
export function editProviderAction(providerId: string, label = "Check provider settings"): NoticeAction {
	return {
		label,
		run: async () => {
			const plugin = tryGetPlugin();
			if (!plugin) return;
			const { ProviderSetupModal } = await import("../views/provider-setup/ProviderSetup");
			new ProviderSetupModal(plugin, providerId).open();
		},
	};
}

/**
 * Open the chat model picker and persist the choice, so picking a model here behaves
 * exactly as it does from the composer's model pill (precedent: ModelSelectButton.svelte).
 * This is the one action that writes, and only because the write *is* what the user came
 * to the picker to do.
 *
 * `agentId` MUST be passed whenever the caller knows which agent produced the notice.
 * A chat tab can run a per-session agent that isn't `getSelectedAgent()`, so defaulting
 * to the global selection would write the model onto an unrelated agent and leave the
 * one the user was actually using still broken. The global fallback applies only when no
 * `agentId` was given at all — an `agentId` that no longer resolves (the agent was deleted
 * between the notice appearing and the click) must NOT fall through to the global agent,
 * or a stale notice silently rewrites an unrelated one.
 */
export function selectChatModelAction(label = "Select a model", agentId?: string): NoticeAction {
	return {
		label,
		run: async () => {
			const plugin = tryGetPlugin();
			if (!plugin) return;

			const [{ ModelSelectionModal }, { getData }, { buildPersistedChatModel }] = await Promise.all([
				import("../components/modal/ModelSelectionModal"),
				import("../stores/dataStore.svelte"),
				import("./persistedChatModel"),
			]);

			const data = getData();
			const agent = agentId ? data.getAgent(agentId) : data.getSelectedAgent();
			if (!agent) {
				// Only reachable when the targeted agent was deleted after the notice fired.
				// Say so rather than dropping the click, which would read as a dead link.
				new Notice("That agent no longer exists. Pick a model from the agent you want to use.");
				return;
			}

			const currentSelection = agent.chatModel
				? { provider: agent.chatModel.provider, model: agent.chatModel.model }
				: null;

			new ModelSelectionModal(plugin, "chat", currentSelection, (selected) => {
				if (!selected) return;
				// Re-resolve rather than reusing the agent captured above: the picker is a
				// modal the user can sit in, and `updateAgent` throws on a deleted id. This
				// also picks up a chatModel that changed while the picker was open.
				const target = data.getAgent(agent.id);
				if (!target) {
					new Notice("That agent no longer exists, so the model wasn't saved.");
					return;
				}
				data.updateAgent(target.id, {
					chatModel: buildPersistedChatModel(selected.provider, selected.model, target.chatModel),
				});
			}).open();
		},
	};
}

/**
 * Open the embedding-index setup modal (precedent: EmbeddingIndexSection.svelte), including
 * the same post-save `ensureIndex` kick so configuring from a notice actually starts indexing.
 */
export function configureEmbedIndexAction(
	purpose: "search" | "graph",
	label = "Configure embedding index",
): NoticeAction {
	return {
		label,
		run: async () => {
			const plugin = tryGetPlugin();
			if (!plugin) return;

			const [{ EmbeddingIndexSetupModal }, { getData }, vectorStore] = await Promise.all([
				import("../components/modal/EmbeddingIndexSetupModal"),
				import("../stores/dataStore.svelte"),
				import("../vectorstore/VectorStoreService"),
			]);

			const data = getData();
			const indexId = purpose === "search" ? data.searchEmbedIndex : data.graphEmbedIndex;
			const indexConfig = indexId ? data.getEmbeddingIndex(indexId) : null;
			const currentSelection = indexConfig ? { provider: indexConfig.provider, model: indexConfig.model } : null;

			new EmbeddingIndexSetupModal(plugin, {
				purpose,
				currentSelection,
				onSave: (selectedModel, batchSize) => {
					data.setEmbedIndex(purpose, selectedModel.provider, selectedModel.model, { batchSize });
					if (vectorStore.isVectorStoreInitialized()) {
						void vectorStore
							.getVectorStoreService()
							.ensureIndex(`${selectedModel.provider}:${selectedModel.model}`);
					}
				},
			}).open();
		},
	};
}

/** Open the agent editor (precedent: AgentPopover.svelte). */
export function editAgentAction(agentId: string, label = "Edit agent"): NoticeAction {
	return {
		label,
		run: async () => {
			const plugin = tryGetPlugin();
			if (!plugin) return;
			const { AgentEditorModal } = await import("../components/modal/AgentEditorModal");
			new AgentEditorModal(plugin, agentId).open();
		},
	};
}

/** Open the indexing report for an index (precedent: EmbeddingIndexSection.svelte). */
export function indexingReportAction(indexId: string, label = "View report"): NoticeAction {
	return {
		label,
		run: async () => {
			const plugin = tryGetPlugin();
			if (!plugin) return;
			const { IndexingReportModal } = await import("../components/modal/IndexingReportModal");
			new IndexingReportModal(plugin, indexId).open();
		},
	};
}

/** Open a vault note in a new tab (precedent: AgentEditorModal.svelte's `openSkillNote`). */
export function openNoteAction(path: string, label = "Open note"): NoticeAction {
	return {
		label,
		run: () => {
			const plugin = tryGetPlugin();
			void plugin?.app.workspace.openLinkText(path, "", true);
		},
	};
}

/** Reveal an existing chat or create one (precedent: SmartGraphView.svelte's chat reveal). */
export function openChatAction(label = "Open chat"): NoticeAction {
	return {
		label,
		run: async () => {
			const plugin = tryGetPlugin();
			if (!plugin) return;

			const { VIEW_TYPE_CHAT } = await import("../views/chat/Chat");
			const { workspace } = plugin.app;
			const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
			if (existing) {
				await workspace.revealLeaf(existing);
				return;
			}
			await plugin.createNewChat();
		},
	};
}
