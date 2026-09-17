import { FileView, type Menu, Notice, setIcon, type TFile, type WorkspaceLeaf } from "obsidian";
import type SecondBrainPlugin from "../../main";
import { DEFAULT_WIDGET_ICON, resolveWidgetIcon } from "../../widget/widgetIcon";
import { WidgetRenderChild } from "../../widget/WidgetRenderChild";
import { parseWidgetSpec } from "../../widget/widgetSpec";
import { RenameWidgetModal } from "./RenameWidgetModal";

export const VIEW_TYPE_WIDGET = "smart-second-brain-widget";
/** Extension of a standalone widget file. Its content is a widget fence's body: optional frontmatter, then HTML. */
export const WIDGET_FILE_EXTENSION = "widget";

const RERENDER_DEBOUNCE_MS = 500;

/**
 * A `.widget` file as a workspace leaf: the frame fills the pane, no chrome around it.
 * The file is the source of truth — the leaf re-renders when it changes on disk (which
 * is how an agent edit accepted through the review flow lands here) and follows renames
 * and deletes the way any `FileView` does. Obsidian has no text editor for the
 * extension, so the leaf carries a minimal source mode of its own (a textarea with
 * save/cancel). It and Rename live in the tab's context menu, where Obsidian keeps
 * file actions (there is no native rename for a non-markdown tab); the header stays
 * as bare as a PDF or image tab, since editing a widget's source is a rare thing to do.
 */
export class WidgetView extends FileView {
	navigation = true;
	private body: HTMLElement | null = null;
	private child: WidgetRenderChild | null = null;
	private source: HTMLElement | null = null;
	private tabIcon = DEFAULT_WIDGET_ICON;
	/** mtime of the file when the source editor loaded it; a save refuses if the file moved on. */
	private sourceMtime = 0;
	private sourceStaleHint: HTMLElement | null = null;
	private rerenderTimer: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: SecondBrainPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_WIDGET;
	}

	getIcon(): string {
		return this.tabIcon;
	}

	canAcceptExtension(extension: string): boolean {
		return extension === WIDGET_FILE_EXTENSION;
	}

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.contentEl.empty();
		this.contentEl.addClass("s2b-widget-view");
		this.body = this.contentEl.createDiv({ cls: "s2b-widget-view-body" });

		this.registerEvent(
			this.plugin.app.vault.on("modify", (file) => {
				if (file.path !== this.file?.path) return;
				if (this.source) this.markSourceStale();
				else this.scheduleRender();
			}),
		);
	}

	onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		if (!this.file) return;
		menu.addItem((item) =>
			item
				.setSection("action")
				.setTitle(this.source ? "Show widget" : "Edit source")
				.setIcon(this.source ? "layout-template" : "code")
				.onClick(() => void this.toggleSource()),
		);
		menu.addItem((item) =>
			item
				.setSection("action")
				.setTitle("Rename...")
				.setIcon("pencil")
				.onClick(() => this.promptRename()),
		);
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		this.closeSource();
		await this.render();
	}

	async onUnloadFile(file: TFile): Promise<void> {
		this.closeSource();
		this.dropChild();
		this.body?.empty();
		await super.onUnloadFile(file);
	}

	async onClose(): Promise<void> {
		if (this.rerenderTimer !== null) window.clearTimeout(this.rerenderTimer);
		this.dropChild();
		await super.onClose();
	}

	private scheduleRender(): void {
		if (this.rerenderTimer !== null) window.clearTimeout(this.rerenderTimer);
		this.rerenderTimer = window.setTimeout(() => {
			this.rerenderTimer = null;
			void this.render();
		}, RERENDER_DEBOUNCE_MS);
	}

	private async render(): Promise<void> {
		const file = this.file;
		if (!this.body || !file) return;
		const text = await this.plugin.app.vault.read(file);
		// The leaf may have moved on to another file (or closed) during the read.
		if (this.file !== file || !this.body) return;
		this.dropChild();
		this.body.empty();
		const spec = parseWidgetSpec(text);
		const icon = resolveWidgetIcon(spec.icon);
		if (icon !== this.tabIcon) {
			this.tabIcon = icon;
			// The tab header read getIcon() before the file was parsed; internal leaf API.
			(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		}
		this.child = new WidgetRenderChild(this.body, this.plugin.app, spec, file.path, { fill: true });
		this.addChild(this.child);
	}

	private dropChild(): void {
		if (this.child) {
			this.removeChild(this.child);
			this.child = null;
		}
	}

	/** Swap the rendered frame for a plain-text editor of the file, or back. */
	private async toggleSource(): Promise<void> {
		if (this.source) {
			this.closeSource();
			await this.render();
			return;
		}
		const file = this.file;
		if (!file || !this.body) return;
		const text = await this.plugin.app.vault.read(file);
		if (this.file !== file || !this.body) return;
		this.dropChild();
		this.body.empty();
		this.sourceMtime = file.stat.mtime;
		this.source = this.body.createDiv({ cls: "s2b-widget-view-source" });
		const textarea = this.source.createEl("textarea", {
			cls: "s2b-widget-view-source-text",
			attr: { spellcheck: "false", "aria-label": "Widget source" },
		});
		textarea.value = text;
		const bar = this.source.createDiv({ cls: "s2b-widget-view-source-bar" });
		const save = bar.createEl("button", { text: "Save", cls: "mod-cta" });
		const cancel = bar.createEl("button", { text: "Cancel" });
		const hint = bar.createSpan({ cls: "s2b-widget-view-source-hint" });
		setIcon(hint, "info");
		hint.createSpan({ text: "Frontmatter (title, height, queries, libs), then the HTML." });
		this.sourceStaleHint = bar.createSpan({ cls: "s2b-widget-view-source-hint s2b-widget-view-source-stale" });
		this.sourceStaleHint.hide();
		save.addEventListener("click", () => void this.saveSource(textarea.value));
		cancel.addEventListener("click", () => void this.toggleSource());
		textarea.addEventListener("keydown", (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key === "s") {
				event.preventDefault();
				void this.saveSource(textarea.value);
			}
		});
		textarea.focus();
	}

	/** The file changed on disk while the editor holds an older copy: say so, and refuse to save over it. */
	private markSourceStale(): void {
		const hint = this.sourceStaleHint;
		if (!hint || !hint.isShown()) {
			if (hint) {
				setIcon(hint, "alert-triangle");
				hint.createSpan({ text: "Changed on disk while editing — Cancel to reload; Save is disabled." });
				hint.show();
			}
		}
	}

	private isSourceStale(): boolean {
		return this.file !== null && this.file.stat.mtime !== this.sourceMtime;
	}

	private async saveSource(text: string): Promise<void> {
		const file = this.file;
		if (!file) return;
		if (this.isSourceStale()) {
			this.markSourceStale();
			new Notice("This widget changed on disk while you were editing. Cancel to reload it, then edit again.");
			return;
		}
		try {
			await this.plugin.app.vault.modify(file, text.endsWith("\n") ? text : `${text}\n`);
		} catch (error) {
			new Notice(`Could not save widget: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		this.closeSource();
		await this.render();
	}

	private promptRename(): void {
		if (this.file) new RenameWidgetModal(this.plugin.app, this.file).open();
	}

	private closeSource(): void {
		this.source?.remove();
		this.source = null;
		this.sourceStaleHint = null;
	}
}
