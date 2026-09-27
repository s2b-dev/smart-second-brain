import { type App, Component, MarkdownRenderer, Modal } from "obsidian";
import changelog from "../../../CHANGELOG.md?raw";
import { RELEASES_URL, type ReleaseNotesSection, linkifyReferences, parseChangelog } from "../../utils/releaseNotes";

/** Every section of the CHANGELOG.md bundled into this build, newest first. */
export const BUNDLED_RELEASE_NOTES: ReleaseNotesSection[] = parseChangelog(changelog);

/**
 * Renders release-notes sections through Obsidian's markdown renderer, one
 * collapsible `<details>` per version, with a link to the full history on GitHub.
 * The first `openCount` sections start expanded: every announced one after an
 * update (all of them are new to the user), only the latest in the full history.
 */
export class ReleaseNotesModal extends Modal {
	private renderOwner: Component | null = null;

	constructor(
		app: App,
		private readonly title: string,
		private readonly sections: ReleaseNotesSection[],
		private readonly openCount = 1,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.title);
		const owner = new Component();
		owner.load();
		this.renderOwner = owner;
		const list = this.contentEl.createDiv({ cls: "s2b-release-notes" });
		this.sections.forEach((section, index) => {
			const details = list.createEl("details", { cls: "s2b-release-notes-section" });
			details.open = index < this.openCount;
			details.createEl("summary", { text: section.version });
			const body = details.createDiv({ cls: "markdown-rendered" });
			void MarkdownRenderer.render(this.app, linkifyReferences(section.body), body, "", owner);
		});
		const footer = this.contentEl.createEl("p", { cls: "s2b-release-notes-footer" });
		footer.createEl("a", { text: "All releases on GitHub", href: RELEASES_URL });
	}

	onClose(): void {
		this.renderOwner?.unload();
		this.renderOwner = null;
		this.contentEl.empty();
	}
}
