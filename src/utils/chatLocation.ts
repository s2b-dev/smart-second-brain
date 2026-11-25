import type { App, TFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_CHAT } from "../views/chat/viewType";
import { isMobileUI } from "./platform";

/**
 * Where chats open. There is no setting for it: a chat opens where the user last had one.
 *
 * 1. The thread is already open: that leaf.
 * 2. The chat leaf the user last focused, if it is still open, wherever it is (left sidebar,
 *    right sidebar, a main-area tab, a popout). The new chat replaces it there, the way a
 *    sidebar chat always has. Remembered by leaf id, which survives a restart; Obsidian's own
 *    `activeTime` does not (after a reload only the restored active leaf has one, so recency
 *    alone sends chats back to the main area).
 * 3. Any other open chat, most recently active first.
 * 4. No chat is open: the place the last one lived, remembered per device (workspace layout
 *    is per device too, so a desktop sidebar must not send a phone's chats into a drawer).
 * 5. Never had one on this device: the right sidebar on desktop, a tab on mobile.
 *
 * The user picks the remembered leaf by pressing into a chat (its content or its tab header:
 * `recordChatPointer`) or switching to it from the keyboard (`KeyboardChatFocus`), and a chat
 * opened into a leaf makes that leaf the remembered one (`recordFocusedChat`, once it shows it). Obsidian's focus changes are NOT a choice: `active-leaf-change` is
 * debounced, and Obsidian focuses leaves on its own (a file-explorer click opens the file, then
 * immediately focuses the last main-area leaf), so following it made the memory flip between
 * a sidebar chat and a main-area chat on every open. Moving the remembered chat (dragging it
 * into the main area) updates where it lives (`recordChatLocation`, on `layout-change`).
 */
export type ChatLocation = "tab" | "left" | "right";

const STORAGE_KEY = "s2b-chat-location";
const LEAF_STORAGE_KEY = "s2b-chat-leaf";

function isChatLocation(value: unknown): value is ChatLocation {
	return value === "tab" || value === "left" || value === "right";
}

export function rememberedChatLocation(app: App): ChatLocation {
	const stored: unknown = app.loadLocalStorage(STORAGE_KEY);
	if (isChatLocation(stored)) return stored;
	return isMobileUI() ? "tab" : "right";
}

function rememberChatLocation(app: App, location: ChatLocation): void {
	if (app.loadLocalStorage(STORAGE_KEY) === location) return;
	app.saveLocalStorage(STORAGE_KEY, location);
}

/**
 * Carry the retired "Open new chat in" setting over as this device's starting point, so an
 * upgrade opens chats where they opened before. Only when the device has no memory yet.
 */
export function seedChatLocation(app: App, legacySetting: unknown): void {
	if (!isChatLocation(legacySetting)) return;
	if (isChatLocation(app.loadLocalStorage(STORAGE_KEY))) return;
	app.saveLocalStorage(STORAGE_KEY, legacySetting);
}

export function chatLocationOf(app: App, leaf: WorkspaceLeaf): ChatLocation {
	const root = leaf.getRoot();
	if (root === app.workspace.leftSplit) return "left";
	if (root === app.workspace.rightSplit) return "right";
	return "tab";
}

/** Open chat leaves, most recently active first. Obsidian stamps `activeTime` on focus. */
export function chatLeavesByRecency(app: App): WorkspaceLeaf[] {
	const activeTime = (leaf: WorkspaceLeaf) => (leaf as { activeTime?: number }).activeTime ?? 0;
	return [...app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)].sort((a, b) => activeTime(b) - activeTime(a));
}

/** The thread a chat leaf shows, including a deferred (not yet loaded) sidebar leaf's. */
function leafThreadPath(leaf: WorkspaceLeaf): string | undefined {
	const viewFile = (leaf.view as { file?: TFile | null }).file;
	if (viewFile) return viewFile.path;
	const stateFile = leaf.getViewState().state?.file;
	return typeof stateFile === "string" ? stateFile : undefined;
}

/** Thread paths shown by an open chat leaf (deferred ones included). */
export function openChatThreadPaths(app: App): Set<string> {
	const paths = new Set<string>();
	for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
		const path = leafThreadPath(leaf);
		if (path) paths.add(path);
	}
	return paths;
}

/** The open chat leaf showing `file`'s thread, if any. */
export function findChatLeafShowing(app: App, file: TFile): WorkspaceLeaf | undefined {
	return chatLeavesByRecency(app).find((leaf) => leafThreadPath(leaf) === file.path);
}

function leafId(leaf: WorkspaceLeaf): string | undefined {
	return (leaf as { id?: string }).id;
}

function isChatLeaf(leaf: WorkspaceLeaf | null | undefined): leaf is WorkspaceLeaf {
	return leaf?.view?.getViewType() === VIEW_TYPE_CHAT;
}

/** The chat leaf the user last focused, while it is still open as a chat. */
function rememberedChatLeaf(app: App): WorkspaceLeaf | null {
	const id: unknown = app.loadLocalStorage(LEAF_STORAGE_KEY);
	if (typeof id !== "string") return null;
	const leaf = app.workspace.getLeafById(id);
	return isChatLeaf(leaf) ? leaf : null;
}

/** A chat leaf was chosen (pressed into, or opened into): it is now the one new chats open in. */
export function recordFocusedChat(app: App, leaf: WorkspaceLeaf | null): void {
	if (!isChatLeaf(leaf)) return;
	const id = leafId(leaf);
	if (id && app.loadLocalStorage(LEAF_STORAGE_KEY) !== id) app.saveLocalStorage(LEAF_STORAGE_KEY, id);
	rememberChatLocation(app, chatLocationOf(app, leaf));
}

/** A pointer press somewhere in the app: if it landed in a chat leaf or on its tab header, the
 * user chose that chat. */
export function recordChatPointer(app: App, target: EventTarget | null): void {
	// Not `instanceof Node`: a popout window's nodes come from that window's own `Node`.
	if (!target || typeof (target as Node).nodeType !== "number") return;
	const node = target as Node;
	const leaf = app.workspace.getLeavesOfType(VIEW_TYPE_CHAT).find((candidate) => {
		const tabHeaderEl = (candidate as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
		return candidate.view.containerEl.contains(node) || tabHeaderEl?.contains(node);
	});
	if (leaf) recordFocusedChat(app, leaf);
}

/** How long after a keypress a focus change still counts as the user's doing. */
const KEYBOARD_FOCUS_WINDOW_MS = 500;

/**
 * Tells a focus change the user made from the keyboard (a tab-switch shortcut, a navigation
 * command) from one Obsidian made on its own: only the first follows a keypress closely.
 * Pointer choices go through `recordChatPointer`, so this ignores focus that follows a click.
 */
export class KeyboardChatFocus {
	private lastKeyAt = Number.NEGATIVE_INFINITY;

	constructor(private readonly app: App) {}

	onKeyDown(): void {
		this.lastKeyAt = performance.now();
	}

	/** A click is not keyboard intent: whatever focus follows it is the pointer's (or Obsidian's). */
	onPointerDown(): void {
		this.lastKeyAt = Number.NEGATIVE_INFINITY;
	}

	onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
		if (performance.now() - this.lastKeyAt > KEYBOARD_FOCUS_WINDOW_MS) return;
		recordFocusedChat(this.app, leaf);
	}
}

/** The layout changed: if the remembered chat moved, remember where it lives now. A closed
 * chat leaves the location as it was, which is what the next chat falls back to. */
export function recordChatLocation(app: App): void {
	const leaf = rememberedChatLeaf(app);
	if (leaf) rememberChatLocation(app, chatLocationOf(app, leaf));
}

/** The leaf a chat should open in, by the rules above. Creates one when no chat is open. */
export function pickChatLeaf(app: App, file: TFile, options: { reuseShowing?: boolean } = {}): WorkspaceLeaf | null {
	const chats = chatLeavesByRecency(app);
	const showing = findChatLeafShowing(app, file);
	if (showing && options.reuseShowing !== false) return showing;
	const remembered = rememberedChatLeaf(app);
	if (remembered) return remembered;
	if (chats[0]) return chats[0];
	const location = rememberedChatLocation(app);
	if (location === "left") return app.workspace.getLeftLeaf(false);
	if (location === "right") return app.workspace.getRightLeaf(false);
	return app.workspace.getLeaf("tab");
}

/**
 * Whether opening a chat in `leaf` should go to `pickChatLeaf` instead. Not when the leaf is
 * empty: a new tab, a fresh split or a drag target is where the user deliberately put it.
 * Anything else was picked by Obsidian, not the user (a file-explorer click lands in the last
 * main-area leaf, even when that is an older chat tab and the user was just in the sidebar
 * chat), so the chat goes where chats live; when that is this very leaf, nothing moves.
 */
export function shouldRedirectChatOpen(leaf: WorkspaceLeaf): boolean {
	return leaf.view?.getViewType() !== "empty";
}
