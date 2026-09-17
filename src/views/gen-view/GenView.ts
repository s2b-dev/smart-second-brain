import { ItemView, Notice, TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type SecondBrainPlugin from "../../main";
import { findViewFences, type ViewFence } from "../../genview/viewFences";
import { ViewRenderChild } from "../../genview/ViewRenderChild";

export const VIEW_TYPE_GEN_VIEW = "smart-second-brain-view";

/**
 * Which fence of which note this leaf shows; persisted with the workspace layout. The
 * fence's `title` (when it has one) is stored beside its ordinal so an edit that inserts
 * or removes an earlier fence does not silently redirect the leaf: a fence with the
 * stored title wins, the ordinal is the fallback, and a target that no longer exists
 * shows as missing rather than as some other view.
 */
export interface GenViewState {
	path: string;
	index: number;
	title?: string;
}

const RERENDER_DEBOUNCE_MS = 500;

/**
 * A note's `s2b-view` fence as its own workspace leaf: the frame fills the pane, no
 * note chrome around it. The note stays the source of truth — the leaf re-renders when
 * the note changes on disk (which is how an agent edit accepted through the review
 * flow lands here) and follows renames. Header actions open the source note and
 * refresh; there is deliberately no editing surface of its own.
 */
export class GenView extends ItemView {
	navigation = true;
	private state: GenViewState | null = null;
	private body: HTMLElement | null = null;
	private child: ViewRenderChild | null = null;
	private title: string | null = null;
	private rerenderTimer: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: SecondBrainPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_GEN_VIEW;
	}

	getDisplayText(): string {
		if (this.title) return this.title;
		const path = this.state?.path;
		return path ? (path.split("/").pop() ?? path).replace(/\.md$/i, "") : "View";
	}

	getIcon(): string {
		return "layout-dashboard";
	}

	getState(): Record<string, unknown> {
		return { ...(this.state ?? { path: "", index: 0 }) };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const next = toState(state);
		if (next) {
			this.state = next;
			await this.render();
		}
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("s2b-gen-view");
		this.body = this.contentEl.createDiv({ cls: "s2b-gen-view-body" });

		this.addAction("file-text", "Open source note", () => void this.openSource());
		this.addAction("refresh-cw", "Refresh", () => void this.render());

		this.registerEvent(
			this.plugin.app.vault.on("modify", (file) => {
				if (file.path === this.state?.path) this.scheduleRender();
			}),
		);
		this.registerEvent(
			this.plugin.app.vault.on("rename", (file, oldPath) => {
				if (this.state && oldPath === this.state.path && file instanceof TFile) {
					this.state = { ...this.state, path: file.path };
					// The renderer resolves queries and note links against its source path;
					// rebuild it so the view follows the note to its new folder.
					void this.render();
				}
			}),
		);
		this.registerEvent(
			this.plugin.app.vault.on("delete", (file) => {
				if (file.path === this.state?.path) this.showMessage("The note behind this view was deleted.");
			}),
		);
		if (this.state) await this.render();
	}

	async onClose(): Promise<void> {
		if (this.rerenderTimer !== null) window.clearTimeout(this.rerenderTimer);
		this.dropChild();
	}

	private scheduleRender(): void {
		if (this.rerenderTimer !== null) window.clearTimeout(this.rerenderTimer);
		this.rerenderTimer = window.setTimeout(() => {
			this.rerenderTimer = null;
			void this.render();
		}, RERENDER_DEBOUNCE_MS);
	}

	private async render(): Promise<void> {
		if (!this.body || !this.state) return;
		const file = this.plugin.app.vault.getFileByPath(this.state.path);
		if (!file) {
			this.showMessage(`Note not found: ${this.state.path}`);
			return;
		}
		const fences = findViewFences(await this.plugin.app.vault.read(file));
		const fence = resolveFence(fences, this.state);
		if (!fence) {
			this.showMessage(
				fences.length === 0
					? "This note has no view block."
					: "The view this pane was opened for is no longer in the note.",
			);
			return;
		}
		this.state = { ...this.state, index: fence.index, title: fence.spec.title };
		this.dropChild();
		this.body.empty();
		this.title = fence.spec.title ?? null;
		this.refreshHeader();
		this.child = new ViewRenderChild(this.body, this.plugin.app, fence.spec, file.path, { fill: true });
		this.addChild(this.child);
	}

	/** Re-read the display text into the tab header. Internal leaf API, absent from the typings. */
	private refreshHeader(): void {
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
	}

	private showMessage(text: string): void {
		this.dropChild();
		this.body?.empty();
		this.body?.createDiv({ cls: "s2b-view-blocked", text });
	}

	private dropChild(): void {
		if (this.child) {
			this.removeChild(this.child);
			this.child = null;
		}
	}

	private async openSource(): Promise<void> {
		const file = this.state ? this.plugin.app.vault.getFileByPath(this.state.path) : null;
		if (!file) {
			new Notice("The source note is gone.");
			return;
		}
		await this.plugin.app.workspace.getLeaf("tab").openFile(file);
	}
}

function toState(value: unknown): GenViewState | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.path !== "string" || !record.path) return null;
	const index =
		typeof record.index === "number" && Number.isInteger(record.index) && record.index >= 0 ? record.index : 0;
	const title = typeof record.title === "string" && record.title ? record.title : undefined;
	return { path: record.path, index, title };
}

/** The fence `state` refers to: by stored title first, then by ordinal; null when neither holds. */
export function resolveFence(fences: readonly ViewFence[], state: GenViewState): ViewFence | null {
	if (state.title) {
		const byTitle = fences.find((fence) => fence.spec.title === state.title);
		if (byTitle) return byTitle;
	}
	const byIndex = fences[state.index];
	if (!byIndex) return null;
	// A stored title that matches nothing but whose ordinal is still a view: the user most
	// likely retitled it. A stored title that matches nothing while the ordinal now shows a
	// *different* titled view is a redirect; refuse it.
	if (state.title && byIndex.spec.title && byIndex.spec.title !== state.title && fences.length > 1) return null;
	return byIndex;
}

/** Show `path`'s `index`-th view in its own leaf, reusing one already showing it. */
export async function openGenView(plugin: SecondBrainPlugin, state: GenViewState): Promise<void> {
	const workspace = plugin.app.workspace;
	const existing = workspace.getLeavesOfType(VIEW_TYPE_GEN_VIEW).find((leaf) => {
		const shown = leaf.view instanceof GenView ? toState(leaf.view.getState()) : null;
		return shown?.path === state.path && shown.index === state.index;
	});
	if (existing) {
		// The requested target is authoritative (a fresh index/title from the note).
		await existing.setViewState({ type: VIEW_TYPE_GEN_VIEW, state: { ...state }, active: true });
	}
	const leaf = existing ?? workspace.getLeaf("tab");
	if (!existing) await leaf.setViewState({ type: VIEW_TYPE_GEN_VIEW, state: { ...state }, active: true });
	await workspace.revealLeaf(leaf);
}
