import ModalProvider from "../../lib/QueryClientProvider.svelte";
import type SecondBrainPlugin from "../../main";
import { t } from "../../i18n";
import EmbeddingIndexSetupModalComponent from "./EmbeddingIndexSetupModal.svelte";
import type { SelectedModel } from "./ModelSelectionModal";
import { SvelteModal } from "./SvelteModal";

export interface EmbeddingIndexSetupModalOptions {
	purpose: "search" | "graph";
	currentSelection: SelectedModel | null;
	onSave: (selectedModel: SelectedModel, batchSize: number) => void;
	/** Import an already-built index from a `.msgpack` export instead of building
	 * one. Resolves true when an index was imported, false when the user cancelled
	 * or the file was rejected. Omitted where importing isn't possible (it needs
	 * Electron's file dialog and Node `fs`, so desktop only), which hides the row. */
	onImport?: () => Promise<boolean>;
}

export class EmbeddingIndexSetupModal extends SvelteModal {
	private readonly plugin: SecondBrainPlugin;
	private readonly options: EmbeddingIndexSetupModalOptions;

	constructor(plugin: SecondBrainPlugin, options: EmbeddingIndexSetupModalOptions) {
		super(plugin.app);
		this.plugin = plugin;
		this.options = options;
	}

	onOpen() {
		this.setTitle(
			this.options.purpose === "search"
				? t("modals.embedding_index_setup.title_search")
				: t("modals.embedding_index_setup.title_graph"),
		);
		// Wrapped in ModalProvider: the component calls `useAvailableModels()`, which
		// resolves a QueryClient from Svelte context. Mounting it bare threw
		// "No QueryClient was found in Svelte context" and left the modal blank.
		this.mountComponent(
			ModalProvider<{
				modal: EmbeddingIndexSetupModal;
				plugin: SecondBrainPlugin;
				currentSelection: SelectedModel | null;
				onSave: (selectedModel: SelectedModel, batchSize: number) => void;
				onImport?: () => Promise<boolean>;
			}>,
			{
				plugin: this.plugin,
				component: EmbeddingIndexSetupModalComponent,
				componentProps: {
					modal: this,
					plugin: this.plugin,
					currentSelection: this.options.currentSelection,
					onSave: this.options.onSave,
					onImport: this.options.onImport,
				},
			},
			{
				width: "min(620px, 92vw)",
				maxWidth: "90vw",
				height: "auto",
				maxHeight: "80vh",
				contentPadding: "16px",
				contentFill: false,
			},
		);
	}
}
