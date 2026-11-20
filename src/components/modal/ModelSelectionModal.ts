import { useAvailableModels } from "../../hooks/useAvailableModels.svelte";
import ModalProvider from "../../lib/QueryClientProvider.svelte";
import { t } from "../../i18n";
import type SecondBrainPlugin from "../../main";
import { isMobileUI } from "../../utils/platform";
import ModelSelectionModalComponent from "./ModelSelectionModal.svelte";
import { ModelSuggestModal } from "./ModelSuggestModal";
import { SvelteModal } from "./SvelteModal";

export type ModelType = "chat" | "embedding";

export interface SelectedModel {
	provider: string;
	model: string;
	supportsVision?: boolean;
}

export class ModelSelectionModal extends SvelteModal {
	private plugin: SecondBrainPlugin;
	private modelType: ModelType;
	private currentSelection: SelectedModel | null;
	private onSelect: (model: SelectedModel | null) => void;

	constructor(
		plugin: SecondBrainPlugin,
		modelType: ModelType,
		currentSelection: SelectedModel | null,
		onSelect: (model: SelectedModel | null) => void,
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.modelType = modelType;
		this.currentSelection = currentSelection;
		this.onSelect = onSelect;
	}

	/**
	 * On mobile, hand off to {@link ModelSuggestModal} instead of opening this
	 * one. Obsidian styles `SuggestModal` natively on a phone — input pinned
	 * above the keyboard, results flowing upward, full-bleed sheet — which this
	 * floating modal cannot match without re-implementing keyboard tracking.
	 * Dispatching here keeps all call sites on the same constructor.
	 */
	open(): void {
		if (isMobileUI()) {
			const models = useAvailableModels();
			const hydrated = this.modelType === "chat" ? models.hydratedChatModels : models.hydratedEmbeddingModels;
			new ModelSuggestModal(
				this.app,
				this.modelType,
				hydrated,
				this.currentSelection,
				models.openRouterModels,
				(model) => this.onSelect(model),
			).open();
			return;
		}
		super.open();
	}

	onOpen() {
		// Sentence case per Obsidian's plugin UI guidelines.
		this.setTitle(
			this.modelType === "chat"
				? t("modals.model_selection.title_chat")
				: t("modals.model_selection.title_embedding"),
		);
		this.mountComponent(
			ModalProvider<{
				modal: ModelSelectionModal;
				modelType: ModelType;
				currentSelection: SelectedModel | null;
				onSelect: (model: SelectedModel | null) => void;
			}>,
			{
				plugin: this.plugin,
				component: ModelSelectionModalComponent,
				componentProps: {
					modal: this,
					modelType: this.modelType,
					currentSelection: this.currentSelection,
					onSelect: (model: SelectedModel | null) => {
						this.onSelect(model);
						this.close();
					},
				},
			},
			{
				fullScreenOnPhone: true,
				width: "min(800px, 90vw)",
				maxWidth: "90vw",
				height: "min(600px, 80vh)",
				maxHeight: "80vh",
				contentPadding: "0",
				contentOverflow: "hidden",
			},
		);
	}
}
