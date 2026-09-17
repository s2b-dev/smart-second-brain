import { type App, Notice, normalizePath, setIcon, type TFile } from "obsidian";
import type SecondBrainPlugin from "../main";
import { getData } from "../stores/dataStore.svelte";
import { VIEW_TYPE_CHAT } from "../views/chat/Chat";
import { resolveWidgetIcon } from "./widgetIcon";
import { WidgetRenderChild } from "./WidgetRenderChild";
import { resolveWidgetLibs, WIDGET_LIBS } from "./widgetLibs";
import {
	parseWidgetSpec,
	WIDGET_BLOCK_LANGUAGE,
	WIDGET_FILE_EXTENSION,
	type WidgetSpec,
	widgetFileBasename,
	wrapWidgetFence,
} from "./widgetSpec";

/**
 * Set on the chat renderer's staging element for the still-streaming tail of a reply
 * (`MarkdownRenderer.svelte`). An unclosed fence renders as a code block on every
 * frame of the stream, so without this guard a half-written widget would spin up a
 * fresh iframe (and run half a script) per token. Once the fence closes and its
 * paragraph is sealed it renders outside the tail, and the frame appears right then —
 * not only when the whole reply has settled.
 */
export const STREAMING_TAIL_CLASS = "s2b-md-tail";

/** Must match the `s2b-widget-sweep` keyframes duration in styles.css. */
const SWEEP_PERIOD_MS = 1800;

/** Register the `s2b-widget` code-block processor. Applies everywhere markdown renders. */
export function registerWidgetBlocks(plugin: SecondBrainPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor(WIDGET_BLOCK_LANGUAGE, (source, el, ctx) => {
		el.addClass("s2b-widget");
		if (el.closest(`.${STREAMING_TAIL_CLASS}`)) {
			renderPlaceholder(el);
			return;
		}
		const spec = parseWidgetSpec(source);
		const { unknown } = resolveWidgetLibs(spec.libs);
		if (unknown.length > 0) {
			el.createDiv({
				cls: "s2b-widget-blocked",
				text: `This widget asks for a library that is not bundled: ${unknown.join(", ")}. Available: ${Object.keys(WIDGET_LIBS).join(", ")}.`,
			});
			return;
		}
		// Inside a chat the block is a proposal the user may want to keep, so it gets a
		// toolbar; in a note it already is the note's content.
		if (el.closest(`.workspace-leaf-content[data-type="${VIEW_TYPE_CHAT}"]`)) {
			renderChatToolbar(plugin, el, spec, source, ctx.sourcePath);
		}
		ctx.addChild(new WidgetRenderChild(el, plugin.app, spec, ctx.sourcePath));
	});
}

/**
 * Placeholder shown while the fence is still being streamed: one blank card with the
 * label centred in it, both carrying the sweep the thinking-process header uses. The
 * streaming tail is re-rendered on every frame, so this element is recreated many times
 * a second; the sweep's phase is pinned to wall-clock time so it reads as one continuous
 * animation rather than restarting with each rebuild.
 */
function renderPlaceholder(el: HTMLElement): void {
	const placeholder = el.createDiv({ cls: "s2b-widget-placeholder" });
	const phase = `-${Math.round(performance.now() % SWEEP_PERIOD_MS)}ms`;
	placeholder.style.animationDelay = phase;
	placeholder.createDiv({ cls: "s2b-widget-placeholder-label", text: "Generating widget…" }).style.animationDelay =
		phase;
}

/**
 * From the chat a widget can be expanded for a closer look, copied as a fence to paste
 * inline into a note, or saved as a standalone `.widget` file — which opens as its own
 * pane, is embeddable with `![[name.widget]]`, and stays out of the search indexes.
 */
function renderChatToolbar(
	plugin: SecondBrainPlugin,
	el: HTMLElement,
	spec: WidgetSpec,
	source: string,
	sourcePath: string,
): void {
	const bar = el.createDiv({ cls: "s2b-widget-toolbar" });
	setIcon(bar.createSpan({ cls: "s2b-widget-toolbar-icon" }), resolveWidgetIcon(spec.icon));
	bar.createSpan({ cls: "s2b-widget-toolbar-title", text: spec.title ?? "Widget" });
	// Saving twice from the same block would create a second file: share one in-flight
	// save, and forget it only if it failed.
	let saving: Promise<TFile> | null = null;
	const save = (): Promise<TFile> => {
		saving ??= saveWidgetFile(plugin.app, getData().widgetsFolder, spec, source).catch((error: unknown) => {
			saving = null;
			throw error;
		});
		return saving;
	};

	iconButton(bar, "maximize-2", "Expand", async () => {
		plugin.openWidgetModal(spec, sourcePath);
	});
	iconButton(bar, "copy", "Copy as block to paste into a note", async () => {
		await navigator.clipboard.writeText(wrapWidgetFence(source));
		new Notice("Widget block copied. Paste it into any note.");
	});
	iconButton(bar, "save", "Save as a widget file and open it", async () => {
		try {
			const file = await save();
			await plugin.app.workspace.getLeaf("tab").openFile(file);
		} catch (error) {
			new Notice(`Could not save widget: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}

function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => Promise<void>): void {
	const button = parent.createDiv({
		cls: "clickable-icon",
		attr: { role: "button", tabindex: "0", "aria-label": label },
	});
	setIcon(button, icon);
	button.addEventListener("click", () => void onClick());
	button.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			void onClick();
		}
	});
}

/** Write the widget as `<folder>/<title>.widget`, suffixing the name on collision. */
export async function saveWidgetFile(app: App, folder: string, spec: WidgetSpec, source: string): Promise<TFile> {
	const folderPath = normalizePath(folder || "Widgets");
	await ensureFolder(app, folderPath);
	const base = widgetFileBasename(spec.title);
	let path = normalizePath(`${folderPath}/${base}.${WIDGET_FILE_EXTENSION}`);
	for (let n = 2; app.vault.getAbstractFileByPath(path); n++) {
		path = normalizePath(`${folderPath}/${base} ${n}.${WIDGET_FILE_EXTENSION}`);
	}
	return app.vault.create(path, `${source.trim()}\n`);
}

/** Create `folderPath` and any missing ancestors, one segment at a time. */
async function ensureFolder(app: App, folderPath: string): Promise<void> {
	let current = "";
	for (const segment of folderPath.split("/").filter(Boolean)) {
		current = current ? `${current}/${segment}` : segment;
		if (!app.vault.getFolderByPath(current)) await app.vault.createFolder(current);
	}
}
