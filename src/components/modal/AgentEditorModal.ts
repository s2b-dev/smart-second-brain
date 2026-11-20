import ModalProvider from "../../lib/QueryClientProvider.svelte";
import type SecondBrainPlugin from "../../main";
import { t } from "../../i18n";
import AgentEditorModalComponent from "./AgentEditorModal.svelte";
import { SvelteModal } from "./SvelteModal";

export class AgentEditorModal extends SvelteModal {
	private readonly plugin: SecondBrainPlugin;
	private readonly agentId: string;

	constructor(plugin: SecondBrainPlugin, agentId: string) {
		super(plugin.app);
		this.plugin = plugin;
		this.agentId = agentId;
	}

	onOpen() {
		this.setTitle(t("agents.editor.title"));
		this.mountComponent(
			ModalProvider<{
				modal: AgentEditorModal;
				plugin: SecondBrainPlugin;
				agentId: string;
			}>,
			{
				plugin: this.plugin,
				component: AgentEditorModalComponent,
				componentProps: {
					modal: this,
					plugin: this.plugin,
					agentId: this.agentId,
				},
			},
			{
				fullScreenOnPhone: true,
				width: "min(720px, 94vw)",
				maxWidth: "94vw",
				height: "90vh",
				contentOverflow: "auto",
			},
		);
	}
}
