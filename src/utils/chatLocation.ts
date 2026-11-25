import type { App, TFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_CHAT } from "../views/chat/viewType";
import { isMobileUI } from "./platform";

/**
 * Where chats open. There is no setting for it: a chat opens where the user last had one.
 *
 * 1. The thread is already open: that leaf.
 * 2. Another chat is open: the most recently active chat leaf, wherever it is (left sidebar,
 *    right sidebar, a main-area tab, a popout). The new chat replaces it there, the way a
 *    sidebar chat always has.
 * 3. No chat is open: the place the last one lived, remembered per device (workspace layout
 *    is per device too, so a desktop sidebar must not send a phone's chats into a drawer).
 * 4. Never had one on this device: the right sidebar on desktop, a tab on mobile.
 *
 * Moving a chat (dragging it from the sidebar into the main area, say) is how the user
 * chooses; `recordChatLocation` runs on every layout and active-leaf change to notice it.
 */
export type ChatLocation = "tab" | "left" | "right";

const STORAGE_KEY = "s2b-chat-location";

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

/** Remember where the most recently active chat lives. Cheap; call on every layout change. */
export function recordChatLocation(app: App): void {
	const [latest] = chatLeavesByRecency(app);
	if (latest) rememberChatLocation(app, chatLocationOf(app, latest));
}

/** The leaf a chat should open in, by the rules above. Creates one when no chat is open. */
export function pickChatLeaf(app: App, file: TFile): WorkspaceLeaf | null {
	const chats = chatLeavesByRecency(app);
	const showing = chats.find((leaf) => leafThreadPath(leaf) === file.path);
	if (showing) return showing;
	if (chats[0]) return chats[0];
	const location = rememberedChatLocation(app);
	if (location === "left") return app.workspace.getLeftLeaf(false);
	if (location === "right") return app.workspace.getRightLeaf(false);
	return app.workspace.getLeaf("tab");
}

/**
 * Whether opening a chat in `leaf` should go to `pickChatLeaf` instead. Only when it would
 * replace something else: a note clicked into the active leaf, a chat link followed from a note.
 * A leaf that is empty (a new tab, a fresh split, a drag target) or already a chat is where the
 * user deliberately put it, so that is left alone.
 */
export function shouldRedirectChatOpen(leaf: WorkspaceLeaf): boolean {
	const type = leaf.view?.getViewType();
	return type !== VIEW_TYPE_CHAT && type !== "empty";
}
