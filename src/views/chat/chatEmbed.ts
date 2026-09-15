import { type App, MarkdownRenderChild, type TFile } from "obsidian";
import { mount, unmount } from "svelte";
import type SecondBrainPlugin from "../../main";
import ChatEmbedPreview from "../../components/chat/ChatEmbedPreview.svelte";
import {
	buildCheckpointGraph,
	deriveMessagePairsFromActiveCheckpoint,
	resolveActiveCheckpointId,
} from "../../stores/chatTimeline";
import { Logger } from "../../utils/logging";

/** Yield to the browser so it can paint/handle input before continuing. */
const yieldToMain = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));

/**
 * Shape of the context object Obsidian's (internal) embed registry passes to an
 * embed creator. Not part of the public API, so typed locally.
 */
interface ChatEmbedContext {
	app: App;
	containerEl: HTMLElement;
	linktext: string;
	sourcePath: string;
	displayMode?: boolean;
}

type EmbedCreator = (ctx: ChatEmbedContext, file: TFile) => MarkdownRenderChild;

interface EmbedRegistry {
	registerExtensions?: (extensions: string[], creator: EmbedCreator) => void;
	unregisterExtensions?: (extensions: string[]) => void;
}

let warnedMissingRegistry = false;

// Stagger concurrent embed loads so their CPU bursts don't pile up in the
// same frame. Each embed increments this counter and resets it on idle.
let pendingLoadCount = 0;
const STAGGER_MS = 50;

/**
 * A read-only embedded/hovered preview of a `.chat` file. Reads the thread's
 * checkpoints straight from disk (no live agent needed), resolves the active
 * branch the same way the live chat view does, and mounts a Svelte transcript.
 */
class ChatEmbed extends MarkdownRenderChild {
	private component: ReturnType<typeof mount> | undefined;

	constructor(
		containerEl: HTMLElement,
		private readonly plugin: SecondBrainPlugin,
		private readonly file: TFile,
	) {
		super(containerEl);
	}

	/**
	 * Obsidian's embed pipeline calls `loadFile()` on the returned component after
	 * construction (NOT `onload`), so the render must live here. It is also called
	 * again when the embedded file changes on disk.
	 *
	 * We return synchronously after rendering a skeleton so Obsidian can lay out
	 * and paint the note immediately. The real transcript loads in the background
	 * and swaps in once ready, avoiding a freeze on large .chat files.
	 */
	loadFile(): void {
		this.containerEl.empty();
		this.containerEl.addClass("s2b-chat-embed-container");

		if (this.component) {
			void unmount(this.component);
			this.component = undefined;
		}

		// Render skeleton immediately so the note stays responsive, then load data.
		this.component = mount(ChatEmbedPreview, {
			target: this.containerEl,
			props: {
				pairs: [],
				title: this.file.basename,
				updatedAt: this.file.stat?.mtime,
				loading: true,
				onOpenChat: () => {
					void this.plugin.app.workspace.openLinkText(this.file.path, "", false);
				},
			},
		});

		// Stagger concurrent loads: each embed waits an extra STAGGER_MS per
		// already-queued embed, spreading their CPU bursts across frames.
		const delay = pendingLoadCount * STAGGER_MS;
		pendingLoadCount++;
		window.setTimeout(() => {
			pendingLoadCount = Math.max(0, pendingLoadCount - 1);
			void this.loadContent();
		}, delay);
	}

	private async loadContent(): Promise<void> {
		try {
			// readCheckpointHistory uses async gunzip — decompression happens off the
			// main thread. Yield once more after it returns so JSON.parse + graph
			// building get their own frame and don't compound with other embeds.
			const checkpoints = await this.plugin.agentManager.readCheckpointHistory(this.file.path);
			await yieldToMain();

			const graph = buildCheckpointGraph(checkpoints);
			const active = resolveActiveCheckpointId(graph, {});
			const pairs = deriveMessagePairsFromActiveCheckpoint(graph, active.checkpointId);

			if (this.component) {
				// Swap skeleton for real content via Svelte's $set equivalent.
				void unmount(this.component);
			}
			this.component = mount(ChatEmbedPreview, {
				target: this.containerEl,
				props: {
					pairs,
					title: this.file.basename,
					updatedAt: this.file.stat?.mtime,
					loading: false,
					onOpenChat: () => {
						void this.plugin.app.workspace.openLinkText(this.file.path, "", false);
					},
				},
			});
		} catch (e) {
			Logger.error(`Failed to render .chat embed for ${this.file.path}:`, e);
			if (this.component) {
				void unmount(this.component);
				this.component = undefined;
			}
			this.containerEl.setText("Could not load chat preview.");
		}
	}

	onunload(): void {
		if (this.component) {
			void unmount(this.component);
			this.component = undefined;
		}
	}
}

/**
 * Registers a read-only embed renderer for `.chat` files via Obsidian's internal
 * embed registry (`app.embedRegistry`). This powers both `![[chat.chat]]` inline
 * embeds and hover previews (the Page Preview core plugin reuses embed renderers).
 *
 * The embed registry is not part of the public API and registration is not torn
 * down by Obsidian's Component lifecycle, so it's paired with
 * {@link unregisterChatEmbed} in onunload — without that, disabling and
 * re-enabling the plugin throws "Attempting to register an embed for an already
 * registered extension" on the second onload. Guarded defensively either way — if
 * the registry is ever absent the plugin still loads, just without chat previews.
 */
export function registerChatEmbed(plugin: SecondBrainPlugin): void {
	const registry = (plugin.app as unknown as { embedRegistry?: EmbedRegistry }).embedRegistry;
	if (!registry?.registerExtensions) {
		if (!warnedMissingRegistry) {
			warnedMissingRegistry = true;
			Logger.warn("app.embedRegistry unavailable — .chat embed/hover previews disabled.");
		}
		return;
	}

	registry.registerExtensions(["chat"], (ctx, file) => new ChatEmbed(ctx.containerEl, plugin, file));
}

/** Reverses {@link registerChatEmbed}; call from onunload. See its doc comment. */
export function unregisterChatEmbed(plugin: SecondBrainPlugin): void {
	const registry = (plugin.app as unknown as { embedRegistry?: EmbedRegistry }).embedRegistry;
	registry?.unregisterExtensions?.(["chat"]);
}
