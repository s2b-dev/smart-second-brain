import { type App, MarkdownRenderChild, type TFile } from "obsidian";
import type SecondBrainPlugin from "../../main";
import { WidgetRenderChild } from "../../widget/WidgetRenderChild";
import { parseWidgetSpec, WIDGET_FILE_EXTENSION } from "../../widget/widgetSpec";
import { Logger } from "../../utils/logging";

/** Shape of the context Obsidian's (internal) embed registry passes to an embed creator. */
interface WidgetEmbedContext {
	app: App;
	containerEl: HTMLElement;
	linktext: string;
	sourcePath: string;
	displayMode?: boolean;
}

type EmbedCreator = (ctx: WidgetEmbedContext, file: TFile) => MarkdownRenderChild;

interface EmbedRegistry {
	registerExtensions?: (extensions: string[], creator: EmbedCreator) => void;
	unregisterExtensions?: (extensions: string[]) => void;
}

/**
 * `![[dashboard.widget]]` inside a note, and the hover preview of a `.widget` link: the
 * file rendered the same way a fence in a note is (auto height, card border). Obsidian's
 * embed pipeline calls `loadFile()` after construction, and again when the embedded
 * file changes on disk.
 */
class WidgetEmbed extends MarkdownRenderChild {
	private child: WidgetRenderChild | null = null;
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
			this.containerEl.addClass("s2b-widget", "s2b-widget-embed");
			this.child = new WidgetRenderChild(
				this.containerEl,
				this.plugin.app,
				parseWidgetSpec(text),
				this.file.path,
			);
			this.addChild(this.child);
		} catch (error) {
			Logger.error(`Failed to render .widget embed for ${this.file.path}:`, error);
			this.containerEl.setText("Could not load widget.");
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
 * Register the `.widget` embed renderer with Obsidian's internal embed registry. Not part
 * of the public API and not torn down by the Component lifecycle: pair with
 * {@link unregisterWidgetEmbed} in onunload (see `chatEmbed.ts` for the history).
 */
export function registerWidgetEmbed(plugin: SecondBrainPlugin): void {
	const registry = (plugin.app as unknown as { embedRegistry?: EmbedRegistry }).embedRegistry;
	if (!registry?.registerExtensions) {
		if (!warnedMissingRegistry) {
			warnedMissingRegistry = true;
			Logger.warn("app.embedRegistry unavailable — .widget embed/hover previews disabled.");
		}
		return;
	}
	registry.registerExtensions([WIDGET_FILE_EXTENSION], (ctx, file) => new WidgetEmbed(ctx.containerEl, plugin, file));
}

/** Reverses {@link registerWidgetEmbed}; call from onunload. */
export function unregisterWidgetEmbed(plugin: SecondBrainPlugin): void {
	const registry = (plugin.app as unknown as { embedRegistry?: EmbedRegistry }).embedRegistry;
	registry?.unregisterExtensions?.([WIDGET_FILE_EXTENSION]);
}
