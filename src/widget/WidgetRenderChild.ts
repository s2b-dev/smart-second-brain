import { type App, type EventRef, type HoverPopover, Keymap, MarkdownRenderChild } from "obsidian";
import {
	buildWidgetFrameSrcdoc,
	collectThemeCss,
	type HoverNoteMessage,
	parseFrameMessage,
	WIDGET_FRAME_PADDING_PX,
	WIDGET_READY_EVENT,
} from "./widgetFrame";
import { resolveWidgetLibs } from "./widgetLibs";
import { runWidgetQueries } from "./widgetQueries";
import type { WidgetSpec } from "./widgetSpec";

const LIVE_UPDATE_DEBOUNCE_MS = 400;
const DEFAULT_AUTO_HEIGHT = 96;
const MIN_AUTO_HEIGHT = 24;
const MAX_AUTO_HEIGHT = 4000;

/**
 * Vault/index events that mean a query's answer may have changed. Dataview's own
 * events fire after *its* index caught up, which is when a re-run is worth doing;
 * the raw metadata-cache event covers vaults without Dataview and is harmless with it
 * (the debounce folds them together).
 */
const REFRESH_EVENTS = ["changed", "dataview:metadata-change", "dataview:index-ready"];

/** Hover-link source id registered in main.ts so page preview knows these links. */
export const WIDGET_HOVER_SOURCE = "smart-second-brain-widget";

/**
 * One rendered widget: owns the sandboxed frame, feeds it query results, keeps those
 * results live while the vault changes, and tears everything down with the block.
 *
 * `this.frame` is the trusted outer relay frame (see `viewFrame.ts`); the widget's own
 * document is nested inside it and never talks to the host directly.
 *
 * Lifecycle is Obsidian's `MarkdownRenderChild`: `onload` when the block is attached
 * to a loaded parent component, `onunload` when that parent unloads (the reading
 * widget re-renders, the chat message is replaced, the note closes).
 */
export class WidgetRenderChild extends MarkdownRenderChild {
	/** Page preview attaches its popover here (`HoverParent`). */
	hoverPopover: HoverPopover | null = null;
	private frame: HTMLIFrameElement | null = null;
	private hoverProxy: HTMLElement | null = null;
	/** The note the current proxy stands for, so a modifier press can re-trigger its preview. */
	private hoverPath: string | null = null;
	private refreshTimer: number | null = null;
	private queryGeneration = 0;

	constructor(
		containerEl: HTMLElement,
		private readonly app: App,
		private readonly spec: WidgetSpec,
		private readonly sourcePath: string,
		/** `fill`: the frame takes its container's height (a leaf) instead of sizing to content. */
		private readonly options: { fill?: boolean } = {},
	) {
		super(containerEl);
	}

	onload(): void {
		const frame = this.containerEl.createEl("iframe", {
			cls: "s2b-widget-frame",
			attr: {
				sandbox: "allow-scripts",
				referrerpolicy: "no-referrer",
				title: this.spec.title ?? "Widget",
			},
		});
		if (this.options.fill) frame.addClass("s2b-widget-fill");
		else frame.style.height = `${(this.spec.height ?? DEFAULT_AUTO_HEIGHT) + 2 * WIDGET_FRAME_PADDING_PX}px`;
		this.frame = frame;

		this.registerDomEvent(window, "message", (event: MessageEvent) => this.onMessage(event));
		// Page preview can be set to require Cmd/Ctrl per source; for a link in a note it
		// reacts to the key being pressed while already hovering. The proxy gets the same:
		// the pointer is over it (so the host owns keyboard events), and a modifier press
		// re-triggers the preview with the current modifier state.
		this.registerDomEvent(window, "keydown", (event: KeyboardEvent) => {
			if (this.hoverProxy && this.hoverPath && ["Meta", "Control", "Alt", "Shift"].includes(event.key)) {
				this.triggerHover(
					this.hoverProxy,
					this.hoverPath,
					event.ctrlKey || event.key === "Control",
					event.metaKey || event.key === "Meta",
				);
			}
		});
		this.registerEvent(this.app.workspace.on("css-change", () => this.postTheme()));

		if (Object.keys(this.spec.queries).length > 0) {
			const cache = this.app.metadataCache as unknown as { on(name: string, callback: () => void): EventRef };
			for (const name of REFRESH_EVENTS) {
				this.registerEvent(cache.on(name, () => this.scheduleRefresh()));
			}
			this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
			this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
		}

		// Set last: the frame starts loading (and may post `ready`) as soon as srcdoc is assigned.
		frame.srcdoc = buildWidgetFrameSrcdoc(
			this.spec.body,
			collectThemeCss(),
			resolveWidgetLibs(this.spec.libs).sources,
			!this.options.fill && this.spec.height === undefined,
		);
	}

	onunload(): void {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		// Invalidate any in-flight query so its result is dropped rather than posted.
		this.queryGeneration++;
		this.removeHoverProxy();
		this.frame = null;
	}

	private onMessage(event: MessageEvent): void {
		if (!this.frame || event.source !== this.frame.contentWindow) return;
		const message = parseFrameMessage(event.data);
		if (!message) return;
		switch (message.type) {
			case "ready":
				this.frame.dataset.s2bWidgetReady = "true";
				this.containerEl.dispatchEvent(new CustomEvent(WIDGET_READY_EVENT, { bubbles: true }));
				void this.postData();
				break;
			case "requery":
				this.scheduleRefresh();
				break;
			case "resize": {
				if (this.options.fill) break;
				// Auto: follow the content. Declared: the layout gets that height, but the frame
				// shrinks to the content's drawn extent when that is shorter — models over-estimate
				// heights, and the surplus would show as empty space. Percentage-sized children
				// fill the declared height, so their extent equals it and nothing changes.
				const height =
					this.spec.height === undefined
						? Math.min(MAX_AUTO_HEIGHT, Math.max(MIN_AUTO_HEIGHT, Math.ceil(message.height)))
						: Math.min(this.spec.height, Math.max(MIN_AUTO_HEIGHT, Math.ceil(message.extent)));
				this.frame.style.height = `${height + 2 * WIDGET_FRAME_PADDING_PX}px`;
				break;
			}
			case "open-note":
				// Same tab/split/window mapping a modified click gets on a link in a note.
				void this.app.workspace.openLinkText(
					message.path,
					this.sourcePath,
					Keymap.isModEvent(new MouseEvent("click", message.modifiers)),
				);
				break;
			case "hover-note":
				this.showHoverProxy(message);
				break;
			case "navigated":
				this.retireFrame();
				break;
		}
	}

	/**
	 * The outer frame reports that the widget document was replaced (a navigation the
	 * CSP backstop did not refuse). Nothing may be posted to whatever loaded in its
	 * place: drop the frame and say why in its stead.
	 */
	private retireFrame(): void {
		this.queryGeneration++;
		this.frame?.remove();
		this.frame = null;
		this.containerEl.createDiv({
			cls: "s2b-widget-blocked",
			text: "This widget was stopped because it tried to navigate away from its sandbox.",
		});
	}

	/**
	 * Lay an invisible element over the hovered link's box — the frame's content is
	 * unreachable from the host — and hand it to page preview as the link. The proxy
	 * takes pointer events, so the popover's own hover tracking works natively; it
	 * opens the note on click and removes itself when the pointer leaves it.
	 */
	private showHoverProxy({ path, rect, ctrlKey, metaKey }: HoverNoteMessage): void {
		const frame = this.frame;
		if (!frame) return;
		this.removeHoverProxy();
		const frameBox = frame.getBoundingClientRect();
		const hostBox = this.containerEl.getBoundingClientRect();
		const style = getComputedStyle(frame);
		const insetX = (Number.parseFloat(style.borderLeftWidth) || 0) + WIDGET_FRAME_PADDING_PX;
		const insetY = (Number.parseFloat(style.borderTopWidth) || 0) + WIDGET_FRAME_PADDING_PX;
		const innerWidth = frameBox.width - 2 * insetX;
		const innerHeight = frameBox.height - 2 * insetY;
		// Clamp to the visible part of the widget document.
		const x = Math.max(0, Math.min(rect.x, innerWidth));
		const y = Math.max(0, Math.min(rect.y, innerHeight));
		const width = Math.max(1, Math.min(rect.width - (x - rect.x), innerWidth - x));
		const height = Math.max(1, Math.min(rect.height - (y - rect.y), innerHeight - y));

		const proxy = this.containerEl.createDiv({ cls: "s2b-widget-hover-proxy" });
		proxy.style.left = `${frameBox.left - hostBox.left + insetX + x}px`;
		proxy.style.top = `${frameBox.top - hostBox.top + insetY + y}px`;
		proxy.style.width = `${width}px`;
		proxy.style.height = `${height}px`;
		proxy.addEventListener("mouseleave", () => this.removeHoverProxy());
		proxy.addEventListener("click", (event) => {
			void this.app.workspace.openLinkText(path, this.sourcePath, Keymap.isModEvent(event));
		});
		this.hoverProxy = proxy;
		this.hoverPath = path;
		this.triggerHover(proxy, path, ctrlKey, metaKey);
	}

	private triggerHover(proxy: HTMLElement, path: string, ctrlKey: boolean, metaKey: boolean): void {
		const proxyBox = proxy.getBoundingClientRect();
		this.app.workspace.trigger("hover-link", {
			event: new MouseEvent("mouseover", {
				ctrlKey,
				metaKey,
				clientX: proxyBox.left + proxyBox.width / 2,
				clientY: proxyBox.top + proxyBox.height / 2,
			}),
			source: WIDGET_HOVER_SOURCE,
			hoverParent: this,
			targetEl: proxy,
			linktext: path,
			sourcePath: this.sourcePath,
		});
	}

	private removeHoverProxy(): void {
		this.hoverProxy?.remove();
		this.hoverProxy = null;
		this.hoverPath = null;
	}

	private post(message: Record<string, unknown>): void {
		// The frame has an opaque origin (sandbox without allow-same-origin), so "*" is the
		// only target that reaches it; the CSP inside keeps what it receives from leaving.
		this.frame?.contentWindow?.postMessage({ s2bWidget: true, ...message }, "*");
	}

	private postTheme(): void {
		this.post({ type: "theme", css: collectThemeCss() });
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.postData();
		}, LIVE_UPDATE_DEBOUNCE_MS);
	}

	private async postData(): Promise<void> {
		const generation = ++this.queryGeneration;
		const data = await runWidgetQueries(this.app, this.spec.queries, this.sourcePath);
		if (generation !== this.queryGeneration || !this.frame) return;
		this.post({ type: "data", data });
	}
}
