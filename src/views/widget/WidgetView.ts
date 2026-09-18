import { FileView, type Menu, Notice, setIcon, type TFile, type WorkspaceLeaf } from "obsidian";
import type SecondBrainPlugin from "../../main";
import { getPendingChangesStore } from "../../stores/pendingChangesStore.svelte";
import type { PendingChange, PendingChangeEntry } from "../../types/shared";
import { DEFAULT_WIDGET_ICON, resolveWidgetIcon } from "../../widget/widgetIcon";
import { WidgetRenderChild } from "../../widget/WidgetRenderChild";
import { parseWidgetSpec, WIDGET_FILE_EXTENSION } from "../../widget/widgetSpec";
import { RenameWidgetModal } from "./RenameWidgetModal";

export const VIEW_TYPE_WIDGET = "smart-second-brain-widget";

const RERENDER_DEBOUNCE_MS = 500;

/** A pending entry narrowed to an update, which is the only kind a leaf showing an existing file previews. */
type PendingUpdateEntry = PendingChangeEntry & { change: Extract<PendingChange, { type: "update" }> };

/**
 * A `.widget` file as a workspace leaf: the frame fills the pane, no chrome around it.
 * The file is the source of truth — the leaf re-renders when it changes on disk (which
 * is how an agent edit accepted through the review flow lands here) and follows renames
 * and deletes the way any `FileView` does. Obsidian has no text editor for the
 * extension, so the leaf carries a minimal source mode of its own (a textarea with
 * save/cancel). It and Rename live in the tab's context menu, where Obsidian keeps
 * file actions (there is no native rename for a non-markdown tab); the header stays
 * as bare as a PDF or image tab, since editing a widget's source is a rare thing to do.
 *
 * While a chat has a pending update to the file, the leaf is its review surface: it
 * renders the PROPOSED content with an accept/reject bar above (the widget equivalent of
 * the inline diff a note gets), and can flip back to the current file for comparison.
 * The latest proposal wins when several chats target the file, as in notes.
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
	/** Bumped per render; a render that awaited disk drops out if a newer one started meanwhile. */
	private renderGeneration = 0;
	private review: HTMLElement | null = null;
	/** The pending update the pane is reviewing, if any. */
	private proposal: PendingUpdateEntry | null = null;
	/** The proposal content last rendered, so store churn that left it unchanged skips a re-render. */
	private renderedProposal: string | null = null;
	/** With a proposal pending: whether the pane shows it (true) or the file as it is (false). */
	private showProposal = true;

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
		this.review = this.contentEl.createDiv({ cls: "s2b-widget-view-review" });
		this.review.hide();
		this.body = this.contentEl.createDiv({ cls: "s2b-widget-view-body" });

		this.registerEvent(
			this.plugin.app.vault.on("modify", (file) => {
				if (file.path !== this.file?.path) return;
				if (this.source) this.markSourceStale();
				else this.scheduleRender();
			}),
		);
		const onPendingChanged = () => this.onPendingChanged();
		document.addEventListener("s2b-pending-changes-updated", onPendingChanged);
		this.register(() => document.removeEventListener("s2b-pending-changes-updated", onPendingChanged));
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
		this.proposal = null;
		this.renderedProposal = null;
		this.renderReviewBar(null);
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

	/**
	 * The latest pending update to the file: what the pane previews. Several chats
	 * can stage updates to one file; like the in-note diff, only the newest renders.
	 */
	private latestProposal(path: string): PendingUpdateEntry | null {
		let entries: PendingChangeEntry[];
		try {
			entries = getPendingChangesStore().getPendingUpdatesForPath(path);
		} catch {
			return null; // store not initialized yet
		}
		const updates = entries.filter((entry): entry is PendingUpdateEntry => entry.change.type === "update");
		if (updates.length === 0) return null;
		return updates.reduce((latest, entry) => (entry.createdAt > latest.createdAt ? entry : latest));
	}

	/** Store churn: re-render only when the proposal for THIS file appeared, changed or resolved. */
	private onPendingChanged(): void {
		if (this.source || !this.file) return;
		const next = this.latestProposal(this.file.path);
		if (next?.id === this.proposal?.id && (next?.change.newContent ?? null) === this.renderedProposal) return;
		// Accepting writes the file, whose modify event queued a debounced render of the
		// same content; render now instead so the review bar doesn't linger.
		if (this.rerenderTimer !== null) {
			window.clearTimeout(this.rerenderTimer);
			this.rerenderTimer = null;
		}
		void this.render();
	}

	private async render(): Promise<void> {
		const file = this.file;
		if (!this.body || !file) return;
		const generation = ++this.renderGeneration;
		const proposal = this.latestProposal(file.path);
		if (proposal?.id !== this.proposal?.id) this.showProposal = true;
		this.proposal = proposal;
		const useProposal = proposal !== null && this.showProposal;
		const text = useProposal ? proposal.change.newContent : await this.plugin.app.vault.read(file);
		// The leaf may have moved on to another file (or closed) during the read — or a
		// newer render (a proposal staged meanwhile) already drew; its bar must stay.
		if (this.file !== file || !this.body || generation !== this.renderGeneration) return;
		this.renderedProposal = useProposal ? text : null;
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
		this.renderReviewBar(proposal);
	}

	/** The accept/reject bar above the frame while a proposal is pending; hidden otherwise. */
	private renderReviewBar(proposal: PendingUpdateEntry | null): void {
		const host = this.review;
		if (!host) return;
		host.empty();
		if (!proposal) {
			host.hide();
			return;
		}
		host.show();
		const bar = host.createDiv({ cls: "s2b-diff-actions-bar" });
		bar.createSpan({
			cls: "s2b-diff-actions-label",
			text: this.showProposal
				? "Pending change from chat — showing the proposed widget"
				: "Pending change from chat — showing the current widget",
		});
		const toggle = bar.createEl("button", {
			cls: "s2b-widget-view-review-toggle",
			text: this.showProposal ? "Show current" : "Show proposed",
		});
		toggle.addEventListener("click", () => {
			this.showProposal = !this.showProposal;
			void this.render();
		});
		const accept = reviewButton(bar, "s2b-diff-accept-btn", "check", "Accept");
		accept.addEventListener("click", () => void this.acceptProposal(proposal));
		const reject = reviewButton(bar, "s2b-diff-reject-btn", "x", "Reject");
		reject.addEventListener("click", () => {
			getPendingChangesStore().rejectChange(proposal.id);
			new Notice("Rejected the proposed change to this widget");
		});
		// Stale parity with the other review surfaces: a proposal whose file changed after
		// staging always fails the store's conflict check, so say so instead of erroring.
		void getPendingChangesStore()
			.hasConflict(proposal.id)
			.then((conflict) => {
				if (!conflict) return;
				accept.disabled = true;
				accept.title =
					"Cannot accept — the widget changed after this was proposed. Reject it and ask the agent to re-stage.";
			})
			.catch(() => {
				/* vault read failed — leave the button as-is */
			});
	}

	private async acceptProposal(proposal: PendingUpdateEntry): Promise<void> {
		try {
			await getPendingChangesStore().acceptChange(proposal.id);
			new Notice("Applied the proposed change to this widget");
		} catch (error) {
			new Notice(`Failed to apply change: ${error instanceof Error ? error.message : String(error)}`);
		}
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
		// The editor edits the file as it is; the proposal comes back once it closes.
		this.renderReviewBar(null);
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

function reviewButton(bar: HTMLElement, cls: string, iconName: string, label: string): HTMLButtonElement {
	const button = bar.createEl("button", { cls, attr: { "aria-label": label, title: label } });
	setIcon(button.createSpan({ cls: "s2b-diff-btn-icon" }), iconName);
	button.createSpan({ cls: "s2b-diff-btn-label", text: label });
	return button;
}
