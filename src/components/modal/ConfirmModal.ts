import { type App, Modal } from "obsidian";
import { t } from "../../i18n";

/** An optional opt-in checkbox rendered between the message and the buttons. */
export interface ConfirmCheckbox {
	label: string;
	/** Sub-label under the checkbox, for spelling out the cost of opting in. */
	description?: string;
	/** Unchecked by default — an extra destructive step should never be pre-armed. */
	initial?: boolean;
}

export interface ConfirmResult {
	confirmed: boolean;
	/** State of the opt-in checkbox. Always false when no checkbox was configured. */
	checked: boolean;
}

/**
 * Obsidian-native confirmation modal that replaces `window.confirm()`.
 * `promise` resolves to a {@link ConfirmResult}; cancel and close (Esc, backdrop) both
 * resolve `{ confirmed: false, checked: false }`, so a caller can never hang on it.
 */
export class ConfirmModal extends Modal {
	private resolved = false;
	private resolve!: (value: ConfirmResult) => void;
	private checked: boolean;
	readonly promise: Promise<ConfirmResult>;

	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly confirmLabel = t("common.delete"),
		private readonly checkbox?: ConfirmCheckbox,
	) {
		super(app);
		this.checked = checkbox?.initial ?? false;
		this.promise = new Promise<ConfirmResult>((resolve) => {
			this.resolve = resolve;
		});
	}

	onOpen(): void {
		this.setTitle(this.title);

		this.contentEl.createEl("p", { text: this.message });

		if (this.checkbox) {
			const wrapper = this.contentEl.createDiv({ cls: "s2b-confirm-checkbox" });
			const label = wrapper.createEl("label");
			const input = label.createEl("input", { type: "checkbox" });
			input.checked = this.checked;
			label.createSpan({ text: this.checkbox.label });
			input.addEventListener("change", () => {
				this.checked = input.checked;
			});
			if (this.checkbox.description) {
				wrapper.createDiv({
					cls: "s2b-confirm-checkbox-desc",
					text: this.checkbox.description,
				});
			}
		}

		const buttonRow = this.contentEl.createDiv({ cls: "modal-button-container" });

		buttonRow.createEl("button", { text: t("common.cancel") }).addEventListener("click", () => {
			this.resolved = true;
			this.resolve({ confirmed: false, checked: false });
			this.close();
		});

		const confirmBtn = buttonRow.createEl("button", {
			text: this.confirmLabel,
			cls: "mod-warning",
		});
		confirmBtn.addEventListener("click", () => {
			this.resolved = true;
			this.resolve({ confirmed: true, checked: this.checked });
			this.close();
		});
	}

	onClose(): void {
		if (!this.resolved) {
			this.resolve({ confirmed: false, checked: false });
		}
	}
}

/** Show an Obsidian-native confirmation dialog. Resolves `true` if confirmed. */
export async function confirmDelete(app: App, entityName: string): Promise<boolean> {
	const modal = new ConfirmModal(
		app,
		t("modals.confirm.deletion_title"),
		t("modals.confirm.delete_entity", { name: entityName }),
	);
	modal.open();
	return (await modal.promise).confirmed;
}

/**
 * Confirmation dialog with an extra opt-in checkbox, for a secondary destructive
 * action the user may or may not want bundled with the deletion.
 */
export function confirmDeleteWithOption(
	app: App,
	entityName: string,
	checkbox: ConfirmCheckbox,
	message = t("modals.confirm.delete_entity", { name: entityName }),
): Promise<ConfirmResult> {
	const modal = new ConfirmModal(app, t("modals.confirm.deletion_title"), message, t("common.delete"), checkbox);
	modal.open();
	return modal.promise;
}
