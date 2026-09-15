/**
 * DISABLED FOR INITIAL RELEASE — not registered, not reachable.
 *
 * View wrapper for the per-note context graph. `main.ts` has its registerView,
 * hover-link source, `open-note-context` command and `activateNoteContextView`
 * all commented out, so this class is never instantiated.
 *
 * Kept for a later release; see the component at
 * `components/graph/NoteContextView.svelte`.
 */
import { MarkdownView, type EventRef, type TFile, type WorkspaceLeaf } from "obsidian";
import NoteContextViewComponent from "../../components/graph/NoteContextView.svelte";
import { SvelteItemView } from "../SvelteItemView";

export const VIEW_TYPE_NOTE_CONTEXT = "smart-second-brain-note-context";

export class NoteContextView extends SvelteItemView {
	workspaceRefs: EventRef[] = [];

	getViewType(): string {
		return VIEW_TYPE_NOTE_CONTEXT;
	}

	getDisplayText(): string {
		return this.getContextTitle();
	}

	getIcon(): string {
		return "git-fork";
	}

	private getContextFile(): TFile | null {
		const { workspace } = this.app;
		const activeView = workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.file) {
			return activeView.file;
		}

		for (const leaf of workspace.getLeavesOfType("markdown")) {
			if (leaf === this.leaf) continue;
			if (leaf.view instanceof MarkdownView && leaf.view.file) {
				return leaf.view.file;
			}
		}

		return null;
	}

	private getContextTitle(): string {
		const contextFile = this.getContextFile();
		if (contextFile?.extension === "md") {
			return `Context of ${contextFile.basename}`;
		}
		return "Context";
	}

	private refreshTitle(): void {
		const title = this.getContextTitle();
		const leafWithHeader = this.leaf as WorkspaceLeaf & {
			tabHeaderInnerTitleEl?: HTMLElement | null;
			tabHeaderEl?: HTMLElement | null;
		};

		leafWithHeader.tabHeaderInnerTitleEl?.setText(title);
		leafWithHeader.tabHeaderEl?.setAttribute("aria-label", title);

		const workspaceLeaf = this.contentEl.closest(".workspace-leaf");
		const titleEls = workspaceLeaf?.querySelectorAll<HTMLElement>(
			".view-header-title, .workspace-tab-header-inner-title",
		);
		for (const el of titleEls ?? []) {
			el.setText(title);
		}
	}

	private registerWorkspaceListeners(): void {
		const { workspace } = this.app;
		this.workspaceRefs = [
			workspace.on("file-open", () => {
				this.refreshTitle();
			}),
			workspace.on("active-leaf-change", () => {
				this.refreshTitle();
			}),
		];
	}

	async onOpen(): Promise<void> {
		this.refreshTitle();
		this.registerWorkspaceListeners();
		this.mountComponent(
			NoteContextViewComponent,
			{},
			{ containerClass: "note-context-container", testId: "note-context-view" },
		);
	}

	async onClose(): Promise<void> {
		for (const ref of this.workspaceRefs) {
			this.app.workspace.offref(ref);
		}
		this.workspaceRefs = [];
		await super.onClose();
	}
}
