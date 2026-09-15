import { setIcon } from "obsidian";
import PrivacyListComponent from "./PrivacyListModal.svelte";
import { SvelteModal } from "./SvelteModal";

export class PrivacyListModal extends SvelteModal {
	onOpen() {
		// `setTitle` only takes a string, so the icon is prepended to `titleEl`
		// directly. `shield-check` in `--text-accent` is the same treatment the
		// "Note access policy" setting row that opens this modal uses, so the two
		// surfaces read as the same feature.
		this.setTitle("Manage Note Access Policy");
		this.titleEl.addClass("s2b-privacy-modal-title");
		const titleIconEl = createSpan();
		titleIconEl.addClass("s2b-privacy-modal-title-icon");
		setIcon(titleIconEl, "shield-check");
		titleIconEl.setAttribute("aria-hidden", "true");
		this.titleEl.prepend(titleIconEl);

		this.mountComponent(
			PrivacyListComponent,
			{ modal: this },
			{
				fullScreenOnPhone: true,
				width: "min(960px, 96vw)",
				maxWidth: "96vw",
				height: "min(840px, 92vh)",
				contentOverflow: "hidden",
			},
		);
	}
}
