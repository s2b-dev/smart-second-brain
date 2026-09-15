import { ItemView, type WorkspaceLeaf } from "obsidian";
import { type Component, mount, unmount } from "svelte";
import type SecondBrainPlugin from "../main";

/**
 * Base class for workspace views whose body is a Svelte component.
 *
 * Owns the mount/unmount lifecycle (the same shape `SvelteModal` gives modals):
 * a subclass calls `mountComponent` from `onOpen` and gets the unmount in
 * `onClose` for free. A subclass with its own close-time work overrides
 * `onClose` and calls `super.onClose()`.
 */
export abstract class SvelteItemView extends ItemView {
	readonly plugin: SecondBrainPlugin;
	private mounted: ReturnType<typeof mount> | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: SecondBrainPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	/**
	 * Reset the content element, tag it for tests, and mount `component` into it.
	 * `containerClass` is the view's root CSS class; `testId` lands in `data-testid`.
	 */
	protected mountComponent<Props extends Record<string, unknown>>(
		component: Component<Props, Record<string, unknown>, string>,
		props: Props,
		chrome: { containerClass: string; testId: string },
	): void {
		this.contentEl.empty();
		this.contentEl.addClass(chrome.containerClass);
		this.contentEl.setAttribute("data-testid", chrome.testId);
		this.mounted = mount(component, { target: this.contentEl, props });
	}

	async onClose(): Promise<void> {
		if (this.mounted) {
			void unmount(this.mounted);
			this.mounted = null;
		}
	}
}
