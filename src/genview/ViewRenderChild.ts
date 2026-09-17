import { type App, type EventRef, MarkdownRenderChild } from "obsidian";
import {
	buildViewFrameSrcdoc,
	collectThemeCss,
	parseFrameMessage,
	VIEW_FRAME_PADDING_PX,
	VIEW_READY_EVENT,
} from "./viewFrame";
import { resolveViewLibs } from "./viewLibs";
import { runViewQueries } from "./viewQueries";
import type { ViewSpec } from "./viewSpec";

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

/**
 * One rendered view: owns the sandboxed frame, feeds it query results, keeps those
 * results live while the vault changes, and tears everything down with the block.
 *
 * `this.frame` is the trusted outer relay frame (see `viewFrame.ts`); the view's own
 * document is nested inside it and never talks to the host directly.
 *
 * Lifecycle is Obsidian's `MarkdownRenderChild`: `onload` when the block is attached
 * to a loaded parent component, `onunload` when that parent unloads (the reading
 * view re-renders, the chat message is replaced, the note closes).
 */
export class ViewRenderChild extends MarkdownRenderChild {
	private frame: HTMLIFrameElement | null = null;
	private refreshTimer: number | null = null;
	private queryGeneration = 0;

	constructor(
		containerEl: HTMLElement,
		private readonly app: App,
		private readonly spec: ViewSpec,
		private readonly sourcePath: string,
	) {
		super(containerEl);
	}

	onload(): void {
		const frame = this.containerEl.createEl("iframe", {
			cls: "s2b-view-frame",
			attr: {
				sandbox: "allow-scripts",
				referrerpolicy: "no-referrer",
				title: this.spec.title ?? "View",
			},
		});
		frame.style.height = `${(this.spec.height ?? DEFAULT_AUTO_HEIGHT) + 2 * VIEW_FRAME_PADDING_PX}px`;
		this.frame = frame;

		this.registerDomEvent(window, "message", (event: MessageEvent) => this.onMessage(event));
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
		frame.srcdoc = buildViewFrameSrcdoc(
			this.spec.body,
			collectThemeCss(),
			resolveViewLibs(this.spec.libs).sources,
			this.spec.height === undefined,
		);
	}

	onunload(): void {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		// Invalidate any in-flight query so its result is dropped rather than posted.
		this.queryGeneration++;
		this.frame = null;
	}

	private onMessage(event: MessageEvent): void {
		if (!this.frame || event.source !== this.frame.contentWindow) return;
		const message = parseFrameMessage(event.data);
		if (!message) return;
		switch (message.type) {
			case "ready":
				this.frame.dataset.s2bViewReady = "true";
				this.containerEl.dispatchEvent(new CustomEvent(VIEW_READY_EVENT, { bubbles: true }));
				void this.postData();
				break;
			case "requery":
				this.scheduleRefresh();
				break;
			case "resize": {
				// Auto: follow the content. Declared: the layout gets that height, but the frame
				// shrinks to the content's drawn extent when that is shorter — models over-estimate
				// heights, and the surplus would show as empty space. Percentage-sized children
				// fill the declared height, so their extent equals it and nothing changes.
				const height =
					this.spec.height === undefined
						? Math.min(MAX_AUTO_HEIGHT, Math.max(MIN_AUTO_HEIGHT, Math.ceil(message.height)))
						: Math.min(this.spec.height, Math.max(MIN_AUTO_HEIGHT, Math.ceil(message.extent)));
				this.frame.style.height = `${height + 2 * VIEW_FRAME_PADDING_PX}px`;
				break;
			}
			case "open-note":
				void this.app.workspace.openLinkText(message.path, this.sourcePath, false);
				break;
			case "navigated":
				this.retireFrame();
				break;
		}
	}

	/**
	 * The outer frame reports that the view document was replaced (a navigation the
	 * CSP backstop did not refuse). Nothing may be posted to whatever loaded in its
	 * place: drop the frame and say why in its stead.
	 */
	private retireFrame(): void {
		this.queryGeneration++;
		this.frame?.remove();
		this.frame = null;
		this.containerEl.createDiv({
			cls: "s2b-view-blocked",
			text: "This view was stopped because it tried to navigate away from its sandbox.",
		});
	}

	private post(message: Record<string, unknown>): void {
		// The frame has an opaque origin (sandbox without allow-same-origin), so "*" is the
		// only target that reaches it; the CSP inside keeps what it receives from leaving.
		this.frame?.contentWindow?.postMessage({ s2bView: true, ...message }, "*");
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
		const data = await runViewQueries(this.app, this.spec.queries, this.sourcePath);
		if (generation !== this.queryGeneration || !this.frame) return;
		this.post({ type: "data", data });
	}
}
