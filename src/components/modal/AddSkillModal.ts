import type SecondBrainPlugin from "../../main";
import { t } from "../../i18n";
import AddSkillModalComponent from "./AddSkillModal.svelte";
import { SvelteModal } from "./SvelteModal";

export class AddSkillModal extends SvelteModal {
	private plugin: SecondBrainPlugin;
	private agentId: string;
	private onSave: (skillId: string) => void | Promise<void>;

	constructor(plugin: SecondBrainPlugin, agentId: string, onSave: (skillId: string) => void | Promise<void>) {
		super(plugin.app);
		this.plugin = plugin;
		this.agentId = agentId;
		this.onSave = onSave;
	}

	onOpen() {
		this.setTitle(t("agents.add_skill.title"));
		// The modal is just a couple of text fields now (instructions are written in the opened
		// note), so let it size to its content instead of forcing a tall fixed height.
		this.mountComponent(
			AddSkillModalComponent,
			{ modal: this, plugin: this.plugin, agentId: this.agentId, onSave: this.onSave },
			{
				width: "min(560px, 90vw)",
				maxWidth: "90vw",
				maxHeight: "85vh",
				contentOverflow: "auto",
				contentFill: false,
			},
		);
	}
}
