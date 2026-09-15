import { FileView, TFile, type WorkspaceLeaf } from "obsidian";
import ChatViewComponent from "./Chat.svelte";
import { mount, unmount } from "svelte";
import type SecondBrainPlugin from "../../main";
import { getSessionRegistry } from "../../stores/chatStore.svelte";
import { ThreadPathStore } from "./threadPathStore.svelte";

export const VIEW_TYPE_CHAT = "smart-second-brain-chat";

export class ChatView extends FileView {
	plugin!: SecondBrainPlugin;
	component!: ChatViewComponent;
	/** Reactive per-tab thread path. Passed into Chat.svelte so each tab
	 * renders its own session rather than following any global pointer. */
	private readonly threadPathStore = new ThreadPathStore();

	// Keep constructor signature stable for current registrations
	constructor(leaf: WorkspaceLeaf, plugin: SecondBrainPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText() {
		if (this.file) return this.file.basename;
		return "Smart Second Brain";
	}

	getIcon() {
		return "message-square";
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		this.threadPathStore.current = file.path;
		const registry = getSessionRegistry();
		// Await the session load so callers that open a chat and then submit
		// (e.g. "Ask agent" from the search modal) find a ready session rather
		// than racing against an unresolved async load.
		await registry?.loadSession(file);
	}

	protected async onOpen(): Promise<void> {
		this.component = mount(ChatViewComponent, {
			target: this.contentEl,
			props: { threadPathStore: this.threadPathStore },
		});
		// A chat renames itself after the first message (auto-title). The session
		// map is rekeyed in the registry, but this view is pinned to the old path;
		// keep threadPathStore in sync so it keeps resolving its (now renamed)
		// session instead of going blank. Obsidian updates this.file automatically.
		this.registerEvent(
			this.plugin.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && oldPath === this.threadPathStore.current) {
					this.threadPathStore.current = file.path;
				}
			}),
		);
		return super.onOpen();
	}

	async onClose() {
		await super.onClose();
		// Only unmount the view. Do NOT abort the stream or touch the session map:
		// the run keeps going in the background and reattaches when this chat is
		// reopened. Stop is reachable via the status-bar indicator.
		if (this.component) void unmount(this.component);
	}
}
