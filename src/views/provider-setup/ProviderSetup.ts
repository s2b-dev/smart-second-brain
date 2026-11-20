import { Modal } from "obsidian";
import { mount } from "svelte";
import { t } from "../../i18n";
import ModalProvider from "../../lib/QueryClientProvider.svelte";
import { removeProviderQueries } from "../../lib/query";
import type SecondBrainPlugin from "../../main";
import { getProviderTemplate, type ProviderTemplateId } from "../../providers/index";
import { slugifyProviderName } from "../../stores/dataStore.svelte";
import ProviderSetupComponent from "./ProviderSetup.svelte";

interface ProviderSetupTarget {
	selectedProvider?: string;
	templateId?: ProviderTemplateId;
}

export class ProviderSetupModal extends Modal {
	component!: ProviderSetupComponent;
	plugin: SecondBrainPlugin;
	selectedProvider: string;
	private templateId?: ProviderTemplateId;
	private readonly createdDraft: boolean;
	private isSubmitted = false;
	private isClosed = false;
	private draftCreated = false;
	// Whether the modal opens on the provider-picker step (the "Add Provider" path
	// with no pre-selected template). Editing an existing provider skips the picker.
	readonly startInPicker: boolean;

	constructor(plugin: SecondBrainPlugin, target: string | ProviderSetupTarget) {
		super(plugin.app);
		this.plugin = plugin;
		if (typeof target === "string") {
			this.selectedProvider = target;
		} else if (target.selectedProvider) {
			this.selectedProvider = target.selectedProvider;
		} else {
			this.selectedProvider = this.generateDraftId(target.templateId);
		}
		this.templateId = typeof target === "string" ? undefined : target.templateId;
		this.createdDraft = typeof target !== "string" && !target.selectedProvider;
		// Show the picker when adding a provider without a concrete template chosen up front.
		this.startInPicker = this.createdDraft && !this.templateId;
		this.refreshTitle();
	}

	private generateDraftId(templateId?: ProviderTemplateId): string {
		const baseName = templateId ? (getProviderTemplate(templateId)?.displayName ?? "provider") : "provider";
		const baseSlug = slugifyProviderName(baseName);
		// Collide only against CONFIGURED providers. An unconfigured provider is a stale
		// draft (see ensureDraftProvider), which we reclaim rather than avoid — so it must
		// not push a fresh draft to "openai-2". A same-slug stale draft is deleted in
		// ensureDraftProvider before the new instance is created.
		const existingIds = new Set(this.plugin.pluginData.getConfiguredProviders());
		if (!existingIds.has(baseSlug)) return baseSlug;
		let n = 2;
		while (existingIds.has(`${baseSlug}-${n}`)) n++;
		return `${baseSlug}-${n}`;
	}

	private resolveDisplayName(): string {
		return (
			this.plugin.pluginData.getProviderMeta(this.selectedProvider)?.displayName ??
			(this.templateId ? getProviderTemplate(this.templateId)?.displayName : this.selectedProvider) ??
			this.selectedProvider
		);
	}

	refreshTitle(displayName = this.resolveDisplayName()) {
		// While picking a provider, keep a neutral title.
		if (this.createdDraft && !this.templateId) {
			this.setTitle(t("onboarding.provider_setup.title_add"));
			return;
		}
		if (this.createdDraft) {
			this.setTitle(t("onboarding.provider_setup.title_setup"));
			return;
		}
		this.setTitle(t("onboarding.provider_setup.title_edit", { name: displayName }));
	}

	onOpen() {
		this.isClosed = false;
		// Marker for mobile keyboard-avoidance CSS (see ProviderSetup.svelte) — Obsidian's
		// base .modal-container is pinned to the full pre-keyboard viewport and doesn't
		// reflow when the keyboard opens, so a field near the bottom (e.g. the OAuth
		// manual-code paste input) can end up hidden behind it.
		this.containerEl.addClass("s2b-provider-setup-modal-container");
		void this.openWithProvider();
	}

	onClose() {
		this.isClosed = true;
		const { contentEl } = this;
		contentEl.empty();
		// Only auto-delete a draft that was never committed. Guard on isConfigured too (not
		// just isSubmitted): a live commit flips isConfigured before its async status refetch
		// finishes, so a close mid-commit must not delete an already-configured provider.
		if (
			this.createdDraft &&
			this.draftCreated &&
			!this.isSubmitted &&
			!this.plugin.pluginData.isProviderConfigured(this.selectedProvider)
		) {
			const draftId = this.selectedProvider;
			void this.plugin.pluginData.deleteProvider(draftId);
			// Drop the draft's cached auth/state so re-adding the same template (which reuses
			// the slug ID) doesn't inherit this abandoned draft's stale validation verdict.
			removeProviderQueries(draftId);
		}
	}

	markSubmitted() {
		this.isSubmitted = true;
	}

	/**
	 * Called from the picker step once the user chooses a provider template. Generates
	 * a fresh draft ID for the template, creates the draft instance, and refreshes the
	 * title. The component then advances to the configure step.
	 */
	async selectTemplate(templateId: ProviderTemplateId): Promise<string> {
		this.templateId = templateId;
		this.selectedProvider = this.generateDraftId(templateId);
		await this.ensureDraftProvider();
		this.refreshTitle();
		return this.selectedProvider;
	}

	private async ensureDraftProvider() {
		if (!this.createdDraft || !this.templateId || this.plugin.pluginData.getProviderMeta(this.selectedProvider)) {
			return;
		}

		const template = getProviderTemplate(this.templateId);
		const baseName = template?.displayName ?? "Provider";
		const baseSlug = slugifyProviderName(baseName);
		// If draft ID has a numeric suffix (e.g. "openai-compatible-2"), reflect it in the display name
		const suffix = this.selectedProvider.slice(baseSlug.length); // "" or "-2"
		const displayName = suffix ? `${baseName} ${suffix.slice(1)}` : baseName;

		// Reclaim any stale draft holding the ID or display name we're about to use. A leaked
		// unconfigured draft (from a prior modal that skipped onClose) would otherwise block
		// addProviderInstance — it throws on a duplicate ID or case-insensitive display name.
		// Only unconfigured providers are eligible; a configured provider is a real conflict
		// and is left alone (generateDraftId already suffixed around it).
		const data = this.plugin.pluginData;
		const wantedName = displayName.trim().toLowerCase();
		const staleDrafts = Object.entries(data.getAllProviderMeta()).filter(
			([id, meta]) =>
				!data.isProviderConfigured(id) &&
				(id === this.selectedProvider || meta.displayName.trim().toLowerCase() === wantedName),
		);
		for (const [id] of staleDrafts) {
			await data.deleteProvider(id);
		}

		await this.plugin.pluginData.addProviderInstance(this.selectedProvider, {
			templateId: this.templateId,
			displayName,
		});
		this.draftCreated = true;

		if (this.isClosed && !this.isSubmitted) {
			await this.plugin.pluginData.deleteProvider(this.selectedProvider);
			this.draftCreated = false;
		}
	}

	private async openWithProvider() {
		// In picker mode the draft is created only once the user picks a template.
		if (!this.startInPicker) {
			await this.ensureDraftProvider();
		}
		if (this.isClosed) return;
		this.component = mount(
			ModalProvider<{
				modal: ProviderSetupModal;
				plugin: SecondBrainPlugin;
				selectedProvider: string;
			}>,
			{
				target: this.contentEl,
				props: {
					plugin: this.plugin,
					component: ProviderSetupComponent,
					componentProps: {
						modal: this,
						plugin: this.plugin,
						selectedProvider: this.selectedProvider,
					},
				},
			},
		);
	}
}
