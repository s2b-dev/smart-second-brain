import { type App, Notice, normalizePath, setIcon, type TFile } from "obsidian";
import type SecondBrainPlugin from "../main";
import { getData } from "../stores/dataStore.svelte";
import { VIEW_TYPE_CHAT } from "../views/chat/Chat";
import { openGenView } from "../views/gen-view/GenView";
import { viewFenceAtLine } from "./viewFences";
import { ViewRenderChild } from "./ViewRenderChild";
import { resolveViewLibs, VIEW_LIBS } from "./viewLibs";
import { parseViewSpec, VIEW_BLOCK_LANGUAGE, type ViewSpec, viewFileBasename, wrapViewFence } from "./viewSpec";

/**
 * Set on the chat renderer's staging element for the still-streaming tail of a reply
 * (`MarkdownRenderer.svelte`). An unclosed fence renders as a code block on every
 * frame of the stream, so without this guard a half-written view would spin up a
 * fresh iframe (and run half a script) per token. Once the fence closes and its
 * paragraph is sealed it renders outside the tail, and the frame appears right then —
 * not only when the whole reply has settled.
 */
export const STREAMING_TAIL_CLASS = "s2b-md-tail";

/** Must match the `s2b-view-sweep` keyframes duration in styles.css. */
const SWEEP_PERIOD_MS = 1800;

/** Register the `s2b-view` code-block processor. Applies everywhere markdown renders. */
export function registerViewBlocks(plugin: SecondBrainPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor(VIEW_BLOCK_LANGUAGE, (source, el, ctx) => {
		el.addClass("s2b-view");
		if (el.closest(`.${STREAMING_TAIL_CLASS}`)) {
			renderPlaceholder(el);
			return;
		}
		const spec = parseViewSpec(source);
		const { unknown } = resolveViewLibs(spec.libs);
		if (unknown.length > 0) {
			el.createDiv({
				cls: "s2b-view-blocked",
				text: `This view asks for a library that is not bundled: ${unknown.join(", ")}. Available: ${Object.keys(VIEW_LIBS).join(", ")}.`,
			});
			return;
		}
		// Inside a chat the block is a proposal the user may want to keep, so it gets a
		// toolbar; in a note it already is the note and only offers to open as a pane.
		if (el.closest(`.workspace-leaf-content[data-type="${VIEW_TYPE_CHAT}"]`)) {
			renderChatToolbar(plugin, el, spec, source);
		} else {
			renderNoteAction(plugin, el, ctx.sourcePath, ctx.getSectionInfo(el));
		}
		ctx.addChild(new ViewRenderChild(el, plugin.app, spec, ctx.sourcePath));
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
	const placeholder = el.createDiv({ cls: "s2b-view-placeholder" });
	const phase = `-${Math.round(performance.now() % SWEEP_PERIOD_MS)}ms`;
	placeholder.style.animationDelay = phase;
	placeholder.createDiv({ cls: "s2b-view-placeholder-label", text: "Generating view…" }).style.animationDelay = phase;
}

/**
 * In a note, a hover-revealed corner button that opens this block as its own pane.
 * The block's index among the note's view fences comes from the section info Obsidian
 * hands the processor; without it (some embed contexts) there is no safe target.
 */
function renderNoteAction(
	plugin: SecondBrainPlugin,
	el: HTMLElement,
	sourcePath: string,
	section: { text: string; lineStart: number } | null,
): void {
	if (!section || !sourcePath) return;
	const fence = viewFenceAtLine(section.text, section.lineStart);
	if (!fence) return;
	iconButton(
		el,
		"maximize-2",
		"Open as view",
		() => openGenView(plugin, { path: sourcePath, index: fence.index }),
		"s2b-view-open",
	);
}

function renderChatToolbar(plugin: SecondBrainPlugin, el: HTMLElement, spec: ViewSpec, source: string): void {
	const bar = el.createDiv({ cls: "s2b-view-toolbar" });
	bar.createSpan({ cls: "s2b-view-toolbar-title", text: spec.title ?? "View" });
	// Saving twice from the same block would create a second note; remember the first.
	let saved: TFile | null = null;
	const save = async (): Promise<TFile> => {
		saved ??= await saveViewAsNote(plugin.app, getData().viewsFolder, spec, source);
		return saved;
	};
	const report = (error: unknown) =>
		new Notice(`Could not save view: ${error instanceof Error ? error.message : String(error)}`);

	iconButton(bar, "copy", "Copy as block to paste into a note", async () => {
		await navigator.clipboard.writeText(wrapViewFence(source));
		new Notice("View block copied. Paste it into any note.");
	});
	iconButton(bar, "save", "Save as a note in the vault", async () => {
		try {
			const file = await save();
			new Notice(`Saved view to ${file.path}`);
			await plugin.app.workspace.getLeaf("tab").openFile(file);
		} catch (error) {
			report(error);
		}
	});
	iconButton(bar, "maximize-2", "Save and open as its own view", async () => {
		try {
			const file = await save();
			await openGenView(plugin, { path: file.path, index: 0 });
		} catch (error) {
			report(error);
		}
	});
}

function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => Promise<void>, cls = ""): void {
	const button = parent.createDiv({
		cls: `clickable-icon ${cls}`.trim(),
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
	await ensureFolder(app, folderPath);
	const base = viewFileBasename(spec.title);
	let path = normalizePath(`${folderPath}/${base}.md`);
	for (let n = 2; app.vault.getAbstractFileByPath(path); n++) {
		path = normalizePath(`${folderPath}/${base} ${n}.md`);
	}
	return app.vault.create(path, wrapViewFence(source));
}

/** Create `folderPath` and any missing ancestors, one segment at a time. */
async function ensureFolder(app: App, folderPath: string): Promise<void> {
	let current = "";
	for (const segment of folderPath.split("/").filter(Boolean)) {
		current = current ? `${current}/${segment}` : segment;
		if (!app.vault.getFolderByPath(current)) await app.vault.createFolder(current);
	}
}
