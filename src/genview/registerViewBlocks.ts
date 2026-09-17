import { type App, Notice, normalizePath, setIcon, type TFile } from "obsidian";
import type SecondBrainPlugin from "../main";
import { getData } from "../stores/dataStore.svelte";
import { VIEW_TYPE_CHAT } from "../views/chat/Chat";
import { ViewRenderChild } from "./ViewRenderChild";
import { parseViewSpec, VIEW_BLOCK_LANGUAGE, type ViewSpec, viewFileBasename, wrapViewFence } from "./viewSpec";

/**
 * Set on the chat's markdown container while a reply is still streaming. An unclosed
 * fence renders as a code block on every frame of the stream, so without this guard a
 * half-written view would spin up a fresh iframe (and run half a script) per token.
 * The final, settled render has the class removed and renders the frame once.
 */
export const STREAMING_CONTAINER_CLASS = "s2b-md-streaming";

/** Register the `s2b-view` code-block processor. Applies everywhere markdown renders. */
export function registerViewBlocks(plugin: SecondBrainPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor(VIEW_BLOCK_LANGUAGE, (source, el, ctx) => {
		el.addClass("s2b-view");
		if (el.closest(`.${STREAMING_CONTAINER_CLASS}`)) {
			el.createDiv({ cls: "s2b-view-placeholder", text: "Generating view…" });
			return;
		}
		const spec = parseViewSpec(source);
		// Inside a chat the block is a proposal the user may want to keep; in a note it
		// already is the note, so the toolbar only appears in the chat.
		if (el.closest(`.workspace-leaf-content[data-type="${VIEW_TYPE_CHAT}"]`)) {
			renderChatToolbar(plugin, el, spec, source);
		}
		ctx.addChild(new ViewRenderChild(el, plugin.app, spec, ctx.sourcePath));
	});
}

function renderChatToolbar(plugin: SecondBrainPlugin, el: HTMLElement, spec: ViewSpec, source: string): void {
	const bar = el.createDiv({ cls: "s2b-view-toolbar" });
	bar.createSpan({ cls: "s2b-view-toolbar-title", text: spec.title ?? "View" });

	iconButton(bar, "copy", "Copy as block to paste into a note", async () => {
		await navigator.clipboard.writeText(wrapViewFence(source));
		new Notice("View block copied. Paste it into any note.");
	});
	iconButton(bar, "save", "Save as a note in the vault", async () => {
		try {
			const file = await saveViewAsNote(plugin.app, getData().viewsFolder, spec, source);
			new Notice(`Saved view to ${file.path}`);
			await plugin.app.workspace.getLeaf("tab").openFile(file);
		} catch (error) {
			new Notice(`Could not save view: ${error instanceof Error ? error.message : String(error)}`);
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

/** Write the view as `<folder>/<title>.md` holding the fence, suffixing the name on collision. */
export async function saveViewAsNote(app: App, folder: string, spec: ViewSpec, source: string): Promise<TFile> {
	const folderPath = normalizePath(folder || "Views");
	if (!app.vault.getFolderByPath(folderPath)) await app.vault.createFolder(folderPath);
	const base = viewFileBasename(spec.title);
	let path = normalizePath(`${folderPath}/${base}.md`);
	for (let n = 2; app.vault.getAbstractFileByPath(path); n++) {
		path = normalizePath(`${folderPath}/${base} ${n}.md`);
	}
	return app.vault.create(path, wrapViewFence(source));
}
