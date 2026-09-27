import { Component, MarkdownRenderer, type ViewStateResult } from "obsidian";
import changelog from "../../../CHANGELOG.md?raw";
import { type ReleaseNotesSection, parseChangelog } from "../../utils/releaseNotes";
import { SvelteItemView } from "../SvelteItemView";
import ReleaseNotes from "./ReleaseNotes.svelte";

export const VIEW_TYPE_RELEASE_NOTES = "smart-second-brain-release-notes";

/** Every section of the CHANGELOG.md bundled into this build, newest first. */
export const BUNDLED_RELEASE_NOTES: ReleaseNotesSection[] = parseChangelog(changelog);

export interface ReleaseNotesViewState extends Record<string, unknown> {
	/** How many of the newest sections start expanded (the announced ones after an update). */
	expanded: number;
}

/**
 * "What's new" tab in the main area, modelled on Obsidian's own release notes:
 * the latest release in full, earlier ones as collapsible sections below.
 */
export class ReleaseNotesView extends SvelteItemView {
	// Main-area view: lets Escape and back/forward treat it like a note tab.
	navigation = true;
	private expanded = 1;
	/** Owns the current render's markdown children; replaced (and unloaded) on re-render. */
	private renderOwner: Component | null = null;

	getViewType(): string {
		return VIEW_TYPE_RELEASE_NOTES;
	}

	getDisplayText(): string {
		return "What's new";
	}

	getIcon(): string {
		return "scroll-text";
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), expanded: this.expanded } satisfies Partial<ReleaseNotesViewState>;
	}

	async setState(state: Partial<ReleaseNotesViewState>, result: ViewStateResult): Promise<void> {
		if (typeof state.expanded === "number" && state.expanded !== this.expanded) {
			this.expanded = state.expanded;
			this.render();
		}
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	private render() {
		if (this.renderOwner) this.removeChild(this.renderOwner);
		const owner = this.addChild(new Component());
		this.renderOwner = owner;
		this.mountComponent(
			ReleaseNotes,
			{
				sections: BUNDLED_RELEASE_NOTES,
				expanded: this.expanded,
				renderMarkdown: (markdown: string, el: HTMLElement) =>
					void MarkdownRenderer.render(this.app, markdown, el, "", owner),
			},
			{ containerClass: "s2b-release-notes-container", testId: "release-notes-view" },
		);
	}
}
