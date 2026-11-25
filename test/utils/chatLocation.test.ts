import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, Platform, TFile, type WorkspaceLeaf } from "../__mocks__/obsidian";
import {
	pickChatLeaf,
	recordChatLocation,
	recordChatPointer,
	recordFocusedChat,
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
	id: string;
	name: string;
	activeTime: number;
	root: object;
	path?: string;
	deferredPath?: string;
	type: string;
	getRoot(): object;
	getViewState(): { state?: { file?: string } };
	tabHeaderEl: HTMLElement;
	view: { file?: { path: string } | null; getViewType(): string; containerEl: HTMLElement };
};

function leaf(name: string, opts: Partial<Pick<FakeLeaf, "activeTime" | "root" | "path" | "deferredPath" | "type">>) {
	const l: FakeLeaf = {
		id: `id-${name}`,
		name,
		activeTime: opts.activeTime ?? 0,
		root: opts.root ?? rootSplit,
		path: opts.path,
		deferredPath: opts.deferredPath,
		type: opts.type ?? VIEW_TYPE_CHAT,
		getRoot: () => l.root,
		getViewState: () => ({ state: l.deferredPath ? { file: l.deferredPath } : {} }),
		tabHeaderEl: document.createElement("div"),
		view: {
			containerEl: document.createElement("div"),
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
			getLeafById: (id: string) => leaves.find((l) => l.id === id) ?? null,
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
		const left = leaf("left-chat", { activeTime: 3, path: "Chats/a.chat", root: leftSplit });
		leaves.push(left);
		recordFocusedChat(a(), left as unknown as ObsidianLeaf);
		leaves.length = 0; // closed
		recordChatLocation(a()); // the close is a layout change; the location stays
		expect(pick("Chats/c.chat")).toBe("new-left");
	});

	it("follows a chat that was moved into the main area", () => {
		const moved = leaf("chat", { activeTime: 3, path: "Chats/a.chat", root: rightSplit });
		leaves.push(moved);
		recordFocusedChat(a(), moved as unknown as ObsidianLeaf);
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

	it("redirects every open except into an empty leaf", () => {
		const as = (l: FakeLeaf) => l as unknown as ObsidianLeaf;
		expect(shouldRedirectChatOpen(as(leaf("note", { type: "markdown" })))).toBe(true);
		expect(shouldRedirectChatOpen(as(leaf("older chat tab", {})))).toBe(true);
		expect(shouldRedirectChatOpen(as(leaf("empty", { type: "empty" })))).toBe(false);
	});

	it("sends a file-explorer click on an older chat tab to the focused sidebar chat", () => {
		const tab = leaf("tab", { activeTime: 1, path: "Chats/a.chat" });
		const sidebar = leaf("sidebar", { activeTime: 5, path: "Chats/b.chat", root: rightSplit });
		leaves.push(tab, sidebar);
		expect(shouldRedirectChatOpen(tab as unknown as ObsidianLeaf)).toBe(true);
		expect(pick("Chats/c.chat")).toBe("sidebar");
	});

	it("records the focused chat before Obsidian stamps its activeTime", () => {
		const tab = leaf("tab", { activeTime: 9, path: "Chats/a.chat" });
		const sidebar = leaf("sidebar", { activeTime: 1, path: "Chats/b.chat", root: leftSplit });
		leaves.push(tab, sidebar);
		recordFocusedChat(a(), sidebar as unknown as ObsidianLeaf);
		expect(rememberedChatLocation(a())).toBe("left");
		expect(pick("Chats/c.chat")).toBe("sidebar");
	});

	// After a reload only the restored active leaf carries an activeTime, so recency alone
	// would send the next chat to the main area even though the sidebar chat was the last used.
	it("keeps the remembered chat leaf across a restart that reset activeTime", () => {
		const tab = leaf("tab", { activeTime: 0, path: "Chats/a.chat" });
		const sidebar = leaf("sidebar", { activeTime: 0, path: "Chats/b.chat", root: rightSplit });
		leaves.push(tab, sidebar);
		recordFocusedChat(a(), sidebar as unknown as ObsidianLeaf);
		tab.activeTime = 100; // restored as the active leaf
		recordChatLocation(a()); // the restore's layout change
		expect(rememberedChatLocation(a())).toBe("right");
		expect(pick("Chats/c.chat")).toBe("sidebar");
	});

	it("ignores focus on a leaf that is not a chat", () => {
		const sidebar = leaf("sidebar", { path: "Chats/b.chat", root: leftSplit });
		leaves.push(sidebar);
		recordFocusedChat(a(), sidebar as unknown as ObsidianLeaf);
		recordFocusedChat(a(), leaf("note", { type: "markdown" }) as unknown as ObsidianLeaf);
		expect(pick("Chats/c.chat")).toBe("sidebar");
	});

	// Obsidian focuses leaves on its own (a file-explorer click focuses the last main-area leaf
	// right after opening the file), so only a press into a chat counts as choosing it.
	it("a press into a chat's content or tab header chooses it; elsewhere does not", () => {
		const tab = leaf("tab", { activeTime: 9, path: "Chats/a.chat" });
		const sidebar = leaf("sidebar", { activeTime: 1, path: "Chats/b.chat", root: rightSplit });
		leaves.push(tab, sidebar);
		const inside = document.createElement("span");
		sidebar.view.containerEl.appendChild(inside);
		recordChatPointer(a(), inside);
		expect(pick("Chats/c.chat")).toBe("sidebar");

		recordChatPointer(a(), document.createElement("div")); // the file explorer, say
		expect(pick("Chats/c.chat")).toBe("sidebar");

		const header = document.createElement("span");
		tab.tabHeaderEl.appendChild(header);
		recordChatPointer(a(), header);
		expect(pick("Chats/c.chat")).toBe("tab");
	});
});
