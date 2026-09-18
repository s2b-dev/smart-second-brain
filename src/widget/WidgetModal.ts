import { type App, Modal } from "obsidian";
import { WidgetRenderChild } from "./WidgetRenderChild";
import type { WidgetSpec } from "./widgetSpec";

/**
 * A widget expanded to (almost) the whole window. Used from the chat toolbar for a
 * closer look without saving. It renders a fresh copy of the widget in fill mode — an
 * iframe cannot be moved in the DOM without reloading, so there is nothing to gain from
 * trying to reuse the inline one — and tears it down on close.
 */
export class WidgetModal extends Modal {
	private child: WidgetRenderChild | null = null;

	constructor(
		app: App,
		private readonly spec: WidgetSpec,
		private readonly sourcePath: string,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("s2b-widget-modal");
		this.titleEl.setText(this.spec.title ?? "Widget");
		this.contentEl.addClass("s2b-widget-modal-content");
		this.child = new WidgetRenderChild(this.contentEl, this.app, this.spec, this.sourcePath, { fill: true });
		this.child.load();
	}

	onClose(): void {
		this.child?.unload();
		this.child = null;
		this.contentEl.empty();
	}
}
