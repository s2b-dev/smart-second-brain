import { Modal } from "obsidian";
import { type Component, mount, unmount } from "svelte";
import { type ModalLayoutOptions, applyModalLayout } from "./modalLayout";

/**
 * Base class for modals whose body is a Svelte component.
 *
 * Owns the mount/unmount lifecycle and the optional layout override so a
 * subclass only has to say *what* to mount in `onOpen`. `onClose` tears the
 * component down and restores the modal chrome; a subclass that needs its own
 * close-time behaviour (resolving a promise, say) overrides it and calls
 * `super.onClose()`.
 */
export abstract class SvelteModal extends Modal {
	private mounted: ReturnType<typeof mount> | null = null;
	private restoreLayout: (() => void) | null = null;

	/**
	 * Mount `component` into the modal body. `layout` applies a size/padding
	 * override that is reverted on close (see {@link applyModalLayout}).
	 */
	protected mountComponent<Props extends Record<string, unknown>>(
		component: Component<Props, Record<string, unknown>, string>,
		props: Props,
		layout?: ModalLayoutOptions,
	): void {
		if (layout) this.restoreLayout = applyModalLayout(this, layout);
		this.mounted = mount(component, { target: this.contentEl, props });
	}

	onClose(): void {
		this.restoreLayout?.();
		this.restoreLayout = null;
		if (this.mounted) {
			void unmount(this.mounted);
			this.mounted = null;
		}
		this.contentEl.empty();
	}
}
