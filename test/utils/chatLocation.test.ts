import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, Platform, TFile, type WorkspaceLeaf } from "../__mocks__/obsidian";
import {
	pickChatLeaf,
	recordChatLocation,
	rememberedChatLocation,
	seedChatLocation,
	shouldRedirectChatOpen,
} from "../../src/utils/chatLocation";
import { VIEW_TYPE_CHAT } from "../../src/views/chat/viewType";
import type { App as ObsidianApp, TFile as ObsidianFile, WorkspaceLeaf as ObsidianLeaf } from "obsidian";

const leftSplit = { id: "left" };
const rightSplit = { id: "right" };
const rootSplit = { id: "root" };

type FakeLeaf = {
	name: string;
	activeTime: number;
	root: object;
	path?: string;
	deferredPath?: string;
	type: string;
	getRoot(): object;
	getViewState(): { state?: { file?: string } };
	view: { file?: { path: string } | null; getViewType(): string };
};

function leaf(name: string, opts: Partial<Pick<FakeLeaf, "activeTime" | "root" | "path" | "deferredPath" | "type">>) {
	const l: FakeLeaf = {
		name,
		activeTime: opts.activeTime ?? 0,
		root: opts.root ?? rootSplit,
		path: opts.path,
		deferredPath: opts.deferredPath,
		type: opts.type ?? VIEW_TYPE_CHAT,
		getRoot: () => l.root,
		getViewState: () => ({ state: l.deferredPath ? { file: l.deferredPath } : {} }),
		view: {
			get file() {
				return l.path ? { path: l.path } : null;
			},
			getViewType: () => l.type,
		},
	};
	return l;
}

function file(path: string): ObsidianFile {
	const f = new TFile();
	f.path = path;
	return f as unknown as ObsidianFile;
}

describe("chatLocation", () => {
	let app: App;
	let leaves: FakeLeaf[];
	let storage: Map<string, unknown>;
	const created = { left: leaf("new-left", {}), right: leaf("new-right", {}), tab: leaf("new-tab", {}) };

	beforeEach(() => {
		leaves = [];
		storage = new Map();
		app = new App();
		app.loadLocalStorage.mockImplementation((k: string) => storage.get(k) ?? null);
		app.saveLocalStorage.mockImplementation((k: string, v: unknown) => storage.set(k, v));
		Object.assign(app.workspace, {
			leftSplit,
			rightSplit,
			getLeavesOfType: (type: string) => leaves.filter((l) => l.type === type),
			getLeftLeaf: () => created.left,
			getRightLeaf: () => created.right,
			getLeaf: () => created.tab,
		});
		Platform.isMobile = false;
	});

	afterEach(() => {
		Platform.isMobile = false;
	});

	const a = () => app as unknown as ObsidianApp;
	const pick = (path: string) => (pickChatLeaf(a(), file(path)) as unknown as FakeLeaf | null)?.name;

	it("reuses the leaf already showing the thread, including a deferred one", () => {
		leaves.push(leaf("recent", { activeTime: 9, path: "Chats/b.chat" }));
		leaves.push(leaf("deferred", { activeTime: 1, deferredPath: "Chats/a.chat", root: rightSplit }));
		expect(pick("Chats/a.chat")).toBe("deferred");
	});

	it("otherwise opens in the most recently active chat, wherever it is", () => {
		leaves.push(leaf("sidebar", { activeTime: 1, path: "Chats/a.chat", root: rightSplit }));
		leaves.push(leaf("tab", { activeTime: 5, path: "Chats/b.chat" }));
		expect(pick("Chats/c.chat")).toBe("tab");
	});

	it("with no chat open, goes where the last one lived", () => {
		leaves.push(leaf("left-chat", { activeTime: 3, path: "Chats/a.chat", root: leftSplit }));
		recordChatLocation(a());
		leaves.length = 0; // closed
		expect(pick("Chats/c.chat")).toBe("new-left");
	});

	it("follows a chat that was moved into the main area", () => {
		const moved = leaf("chat", { activeTime: 3, path: "Chats/a.chat", root: rightSplit });
		leaves.push(moved);
		recordChatLocation(a());
		moved.root = rootSplit;
		recordChatLocation(a());
		leaves.length = 0;
		expect(pick("Chats/c.chat")).toBe("new-tab");
	});

	it("defaults to the right sidebar on desktop and a tab on mobile", () => {
		expect(rememberedChatLocation(a())).toBe("right");
		Platform.isMobile = true;
		expect(rememberedChatLocation(a())).toBe("tab");
	});

	it("seeds from the retired setting only when this device remembers nothing", () => {
		seedChatLocation(a(), "tab");
		expect(rememberedChatLocation(a())).toBe("tab");
		seedChatLocation(a(), "left");
		expect(rememberedChatLocation(a())).toBe("tab");
		seedChatLocation(a(), undefined);
		expect(rememberedChatLocation(a())).toBe("tab");
	});

	it("redirects only opens that would replace something other than a chat or an empty leaf", () => {
		const as = (l: FakeLeaf) => l as unknown as ObsidianLeaf;
		expect(shouldRedirectChatOpen(as(leaf("note", { type: "markdown" })))).toBe(true);
		expect(shouldRedirectChatOpen(as(leaf("empty", { type: "empty" })))).toBe(false);
		expect(shouldRedirectChatOpen(as(leaf("chat", {})))).toBe(false);
	});
});
