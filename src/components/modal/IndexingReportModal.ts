import type SecondBrainPlugin from "../../main";
import { t } from "../../i18n";
import IndexingReportModalComponent from "./IndexingReportModal.svelte";
import { SvelteModal } from "./SvelteModal";

export class IndexingReportModal extends SvelteModal {
	private indexId: string;

	constructor(plugin: SecondBrainPlugin, indexId: string) {
		super(plugin.app);
		this.indexId = indexId;
	}

	onOpen() {
		this.setTitle(t("modals.indexing_report.title"));
		this.mountComponent(
			IndexingReportModalComponent,
			{ modal: this, indexId: this.indexId },
			{ width: "min(600px, 90vw)", maxWidth: "90vw", contentFill: false },
		);
	}
}
