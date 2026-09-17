import { type App, MarkdownRenderChild, type TFile } from "obsidian";
import type SecondBrainPlugin from "../../main";
import { ViewRenderChild } from "../../genview/ViewRenderChild";
import { parseViewSpec } from "../../genview/viewSpec";
import { Logger } from "../../utils/logging";
import { VIEW_FILE_EXTENSION } from "./GenView";

/** Shape of the context Obsidian's (internal) embed registry passes to an embed creator. */
interface ViewEmbedContext {
	app: App;
	containerEl: HTMLElement;
	linktext: string;
	sourcePath: string;
	displayMode?: boolean;
}

type EmbedCreator = (ctx: ViewEmbedContext, file: TFile) => MarkdownRenderChild;

interface EmbedRegistry {
	registerExtensions?: (extensions: string[], creator: EmbedCreator) => void;
	unregisterExtensions?: (extensions: string[]) => void;
}

/**
 * `![[dashboard.view]]` inside a note, and the hover preview of a `.view` link: the
 * file rendered the same way a fence in a note is (auto height, card border). Obsidian's
 * embed pipeline calls `loadFile()` after construction, and again when the embedded
 * file changes on disk.
 */
class ViewEmbed extends MarkdownRenderChild {
	private child: ViewRenderChild | null = null;
	/** Bumped per load and on unload so a slower, older read cannot install stale content. */
	private generation = 0;

	constructor(
		containerEl: HTMLElement,
		private readonly plugin: SecondBrainPlugin,
		private readonly file: TFile,
	) {
		super(containerEl);
	}

	loadFile(): void {
		void this.render();
	}

	private async render(): Promise<void> {
		const generation = ++this.generation;
		try {
			const text = await this.plugin.app.vault.cachedRead(this.file);
			if (generation !== this.generation) return;
			this.drop();
			this.containerEl.empty();
			this.containerEl.addClass("s2b-view", "s2b-view-embed");
			this.child = new ViewRenderChild(this.containerEl, this.plugin.app, parseViewSpec(text), this.file.path);
			this.addChild(this.child);
		} catch (error) {
			Logger.error(`Failed to render .view embed for ${this.file.path}:`, error);
			this.containerEl.setText("Could not load view.");
		}
	}

	onunload(): void {
		this.generation++;
		this.drop();
	}

	private drop(): void {
		if (this.child) {
			this.removeChild(this.child);
			this.child = null;
		}
	}
}

let warnedMissingRegistry = false;

/**
 * Register the `.view` embed renderer with Obsidian's internal embed registry. Not part
 * of the public API and not torn down by the Component lifecycle: pair with
 * {@link unregisterViewEmbed} in onunload (see `chatEmbed.ts` for the history).
 */
export function registerViewEmbed(plugin: SecondBrainPlugin): void {
	const registry = (plugin.app as unknown as { embedRegistry?: EmbedRegistry }).embedRegistry;
	if (!registry?.registerExtensions) {
		if (!warnedMissingRegistry) {
			warnedMissingRegistry = true;
			Logger.warn("app.embedRegistry unavailable — .view embed/hover previews disabled.");
		}
		return;
	}
	registry.registerExtensions([VIEW_FILE_EXTENSION], (ctx, file) => new ViewEmbed(ctx.containerEl, plugin, file));
}

/** Reverses {@link registerViewEmbed}; call from onunload. */
export function unregisterViewEmbed(plugin: SecondBrainPlugin): void {
	const registry = (plugin.app as unknown as { embedRegistry?: EmbedRegistry }).embedRegistry;
	registry?.unregisterExtensions?.([VIEW_FILE_EXTENSION]);
}
