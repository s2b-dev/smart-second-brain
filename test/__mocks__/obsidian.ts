/**
 * Mock for the Obsidian API
 *
 * Import this in test files that need Obsidian:
 *   vi.mock("obsidian", () => import("./__mocks__/obsidian"));
 *
 * Note: This provides minimal mocks. Extend as needed for specific tests.
 * The real Obsidian API is only available at runtime inside Obsidian.
 */

import { vi } from "vitest";

// Base classes
export class Plugin {
	app: App = new App();
	manifest = { id: "test-plugin", name: "Test Plugin", version: "1.0.0" };
	loadData = vi.fn().mockResolvedValue({});
	saveData = vi.fn().mockResolvedValue(undefined);
}

export class App {
	vault = new Vault();
	workspace = new Workspace();
	metadataCache = new MetadataCache();
	appId = "test-vault-id";
	secretStorage = {
		getSecret: vi.fn().mockReturnValue(null),
		setSecret: vi.fn(),
		listSecrets: vi.fn().mockReturnValue([]),
	};
	loadLocalStorage = vi.fn().mockReturnValue(null);
	saveLocalStorage = vi.fn();
	// Community plugins API
	plugins = {
		manifests: {} as Record<string, unknown>,
		enabledPlugins: new Set<string>(),
		plugins: {} as Record<string, unknown>,
	};
	// Internal (core) plugins API
	internalPlugins = {
		plugins: {} as Record<string, { enabled: boolean; instance?: unknown }>,
		getPluginById: vi.fn().mockReturnValue(null),
	};
}

export class Vault {
	adapter = {
		exists: vi.fn().mockResolvedValue(true),
		read: vi.fn().mockResolvedValue(""),
		write: vi.fn().mockResolvedValue(undefined),
	};
	getAbstractFileByPath = vi.fn();
	getFiles = vi.fn().mockReturnValue([]);
	getName = vi.fn().mockReturnValue("test-vault");
	read = vi.fn().mockResolvedValue("");
	modify = vi.fn().mockResolvedValue(undefined);
	// Delegates to the mocked read/modify (writes only when the callback changed
	// the data), mirroring Vault.process's read → transform → write contract.
	process = vi.fn().mockImplementation(async (file: unknown, fn: (data: string) => string) => {
		const data = await this.read(file);
		const result = fn(data);
		if (result !== data) await this.modify(file, result);
		return result;
	});
	create = vi.fn().mockImplementation(() => Promise.resolve(new TFile()));
	delete = vi.fn().mockResolvedValue(undefined);
}

export class Workspace {
	getActiveFile = vi.fn().mockReturnValue(null);
	getLeaf = vi.fn();
	on = vi.fn();
	off = vi.fn();
}

export class MetadataCache {
	getFileCache = vi.fn().mockReturnValue(null);
	getCache = vi.fn().mockReturnValue(null);
	on = vi.fn();
	off = vi.fn();
}

export class TFile {
	path = "test.md";
	name = "test.md";
	basename = "test";
	extension = "md";
	stat = { ctime: Date.now(), mtime: Date.now(), size: 0 };
	vault: unknown = null;
	parent = null;
}

export class TFolder {
	path = "test-folder";
	name = "test-folder";
	children: (TFile | TFolder)[] = [];
	parent = null;
	isRoot = () => false;
}

export class Modal {
	app: App;
	containerEl = document.createElement("div");

	constructor(app: App) {
		this.app = app;
	}

	open = vi.fn();
	close = vi.fn();
	onOpen = vi.fn();
	onClose = vi.fn();
}

/**
 * Base for the suggester modals (`ModelSuggestModal` and friends). Present so importing a
 * module that transitively pulls in a suggester — e.g. anything reaching AgentManager —
 * doesn't fail at class-definition time; the suggester behaviour itself isn't exercised.
 */
export class SuggestModal<T> {
	app: App;
	containerEl = document.createElement("div");
	inputEl = document.createElement("input");
	limit = 0;
	emptyStateText = "";

	constructor(app: App) {
		this.app = app;
	}

	open = vi.fn();
	close = vi.fn();
	setPlaceholder = vi.fn();
	setInstructions = vi.fn();
	getSuggestions = vi.fn((_query: string): T[] => []);
	renderSuggestion = vi.fn();
	onChooseSuggestion = vi.fn();
}

export class Notice {
	message: string;
	timeout?: number;
	messageEl = document.createElement("div");

	constructor(message: string, timeout?: number) {
		this.message = message;
		this.timeout = timeout;
	}

	hide = vi.fn();
	setMessage = vi.fn((message: string) => {
		this.message = message;
		return this;
	});
}

export class PluginSettingTab {
	app: App;
	plugin: Plugin;
	containerEl = document.createElement("div");

	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
	}

	display = vi.fn();
	hide = vi.fn();
}

// View classes
export class ItemView {
	app: App;
	containerEl = document.createElement("div");
	contentEl = document.createElement("div");
	leaf: WorkspaceLeaf;
	// Real Obsidian defaults this to false; the workspace treats non-navigation
	// views as sidebar utilities (its Escape handler jumps away from them).
	navigation = false;

	constructor(leaf: WorkspaceLeaf) {
		this.leaf = leaf;
		this.app = leaf.app;
	}

	getViewType = vi.fn().mockReturnValue("item-view");
	getDisplayText = vi.fn().mockReturnValue("Item View");
	onOpen = vi.fn().mockResolvedValue(undefined);
	onClose = vi.fn().mockResolvedValue(undefined);
}

export class FileView extends ItemView {
	file: TFile | null = null;
	navigation = true;

	getViewType = vi.fn().mockReturnValue("file-view");
	canAcceptExtension = vi.fn().mockReturnValue(true);
	getFile = vi.fn().mockReturnValue(null);
}

export class WorkspaceLeaf {
	view: ItemView;
	app: App;

	constructor() {
		this.app = new App();
		this.view = {} as ItemView;
	}
}

// Utility functions
export const Platform = {
	isMobile: false,
	isMobileApp: false,
	isDesktop: true,
	isDesktopApp: true,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
};

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function debounce<T extends (...args: unknown[]) => unknown>(fn: T, delay: number): T & { cancel: () => void } {
	let timeout: ReturnType<typeof setTimeout>;
	const debounced = ((...args: unknown[]) => {
		clearTimeout(timeout);
		timeout = setTimeout(() => fn(...args), delay);
	}) as T & { cancel: () => void };
	debounced.cancel = () => clearTimeout(timeout);
	return debounced;
}

export const setIcon = vi.fn((node: HTMLElement, iconId: string) => {
	node.innerHTML = `<svg data-icon="${iconId}"></svg>`;
	node.setAttribute("data-icon", iconId);
});

export function getAllTags(cache: CachedMetadata | null): string[] {
	if (!cache) return [];
	const tags: string[] = [];
	if (cache.tags) {
		tags.push(...cache.tags.map((t) => t.tag));
	}
	if (cache.frontmatter?.tags) {
		const fmTags = cache.frontmatter.tags;
		if (Array.isArray(fmTags)) {
			tags.push(...fmTags.map((t) => `#${t}`));
		}
	}
	return tags;
}

export interface RequestUrlParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	throw?: boolean;
}

export const requestUrl = vi.fn(async (_param: RequestUrlParam) => ({
	status: 200,
	headers: {} as Record<string, string>,
	text: "{}",
	json: {},
}));

// Types (matching Obsidian's types)
export interface CachedMetadata {
	tags?: { tag: string; position: { start: { line: number } } }[];
	frontmatter?: Record<string, unknown>;
	links?: { link: string; original: string }[];
	headings?: { heading: string; level: number }[];
}

export type DataAdapter = Vault["adapter"];

export function getLanguage(): string {
	return "en";
}
