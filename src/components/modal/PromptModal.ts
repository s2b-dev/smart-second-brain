import { type App, Modal } from "obsidian";

/**
 * Obsidian-native single-line text prompt that replaces `window.prompt()`.
 * Resolves to the trimmed input value on confirm, or `null` on cancel/close.
 */
class PromptModal extends Modal {
	private resolved = false;
	private resolve!: (value: string | null) => void;
	readonly promise: Promise<string | null>;

	constructor(
		app: App,
		private readonly title: string,
		private readonly initialValue = "",
		private readonly confirmLabel = "Confirm",
	) {
		super(app);
		this.promise = new Promise<string | null>((resolve) => {
			this.resolve = resolve;
		});
	}

	onOpen(): void {
		this.setTitle(this.title);

		const input = this.contentEl.createEl("input", {
			type: "text",
			value: this.initialValue,
		});
		input.classList.add("s2b-prompt-input");
		input.focus();
		input.select();

		const submit = () => {
			const value = input.value.trim();
			if (!value) return;
			this.resolved = true;
			this.resolve(value);
			this.close();
		};

		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				submit();
			}
		});

		const buttonRow = this.contentEl.createDiv({ cls: "modal-button-container" });

		buttonRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
			this.resolved = true;
			this.resolve(null);
			this.close();
		});

		buttonRow.createEl("button", { text: this.confirmLabel, cls: "mod-cta" }).addEventListener("click", submit);
	}

	onClose(): void {
		if (!this.resolved) {
			this.resolve(null);
		}
	}
}

/** Show an Obsidian-native text prompt. Resolves to the trimmed value or `null`. */
export function promptText(
	app: App,
	title: string,
	initialValue = "",
	confirmLabel = "Confirm",
): Promise<string | null> {
	const modal = new PromptModal(app, title, initialValue, confirmLabel);
	modal.open();
	return modal.promise;
}
