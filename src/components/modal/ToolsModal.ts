import type SecondBrainPlugin from "../../main";
import { t } from "../../i18n";
import { SvelteModal } from "./SvelteModal";
import ToolsModalComponent from "./ToolsModal.svelte";

export class ToolsModal extends SvelteModal {
	private plugin: SecondBrainPlugin;
	private agentId: string;
	private onChange?: () => void;

	constructor(plugin: SecondBrainPlugin, agentId: string, options?: { onChange?: () => void }) {
		super(plugin.app);
		this.plugin = plugin;
		this.agentId = agentId;
		this.onChange = options?.onChange;
	}

	onOpen() {
		this.setTitle(t("agents.tools.title"));
		this.mountComponent(
			ToolsModalComponent,
			{ modal: this, plugin: this.plugin, agentId: this.agentId, onChange: this.onChange },
			{
				fullScreenOnPhone: true,
				width: "min(720px, 94vw)",
				maxWidth: "94vw",
				height: "85vh",
				contentOverflow: "hidden",
			},
		);
	}
}
