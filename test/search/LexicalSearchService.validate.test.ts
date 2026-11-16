import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

/*
 * The startup validation of the lexical index used to check presence only, so
 * a note modified while Obsidian was closed — every sync client's daily case —
 * kept serving its pre-sync content until the user edited it inside Obsidian.
 * It now compares the stored mtime with the file's.
 */

interface FakeFile {
	path: string;
	basename: string;
	extension: string;
	stat: { mtime: number; size: number };
}

function file(path: string, mtime: number): FakeFile {
	return { path, basename: path.replace(/\.md$/, ""), extension: "md", stat: { mtime, size: 10 } };
}

/** What the fake index holds: path → stored mtime (undefined = indexed before mtimes existed). */
let loaded: Map<string, number | undefined>;
let vaultFiles: FakeFile[];
const addDocument = vi.fn();
const removeDocument = vi.fn();
const flush = vi.fn(async () => {});
/** Per-path gate on `readIndexableContent`; a path without one reads at once. */
let readGates: Map<string, Promise<void>>;
/** The content-group switches as the settings hold them now. */
let contentIndexing: { pdfs: boolean; chats: boolean; data: boolean };
/** Vault-local storage (`App.loadLocalStorage`), where the index records the groups it applied. */
let localStore: Map<string, string>;
const contentIndexingListeners = new Set<() => void>();
/** Paths whose read throws. */
let readFailures: Set<string>;
/** Per-path content group, over the mock's PDF-only default. */
const contentGroupOverride = new Map<string, string>();

vi.mock("../../src/vectorstore/MiniSearchService", () => ({
	MiniSearchService: class {
		async open() {}
		async loadFromStorage() {
			return true;
		}
		get documentCount() {
			return loaded.size;
		}
		lastLoadedBytes = 0;
		hasDocument(path: string) {
			return loaded.has(path);
		}
		getDocumentMtime(path: string) {
			return loaded.get(path);
		}
		getDocumentPaths() {
			return loaded.keys();
		}
		addDocument(path: string, title: string, content: string, tags: string[], mtime?: number) {
			addDocument(path, title, content, tags, mtime);
			loaded.set(path, mtime);
		}
		removeDocument(path: string) {
			removeDocument(path);
			loaded.delete(path);
		}
		markStale(path: string) {
			if (loaded.has(path)) loaded.set(path, undefined);
		}
		suspendScheduledSaves() {}
		resumeScheduledSaves() {}
		flush = flush;
		close() {}
	},
}));
vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => ({
		vaultSlug: "vault-1",
		onContentIndexingChange: (listener: () => void) => {
			contentIndexingListeners.add(listener);
			return () => contentIndexingListeners.delete(listener);
		},
	}),
}));
vi.mock("../../src/utils/fileFiltering", () => ({
	CONTENT_GROUPS: ["pdfs", "chats", "data"],
	contentGroupOf: (f: FakeFile) => contentGroupOverride.get(f.path) ?? (f.extension === "pdf" ? "pdfs" : null),
	getContentIndexing: () => contentIndexing,
	needsExtraction: (f: FakeFile) => f.extension === "pdf" && contentIndexing.pdfs,
	DRAWING_MODIFY_DEBOUNCE_MS: 30_000,
	isExcalidrawPath: (path: string) => path.endsWith(".excalidraw.md"),
	getIndexableVaultFiles: () => vaultFiles,
	isIndexableFile: () => true,
	isBinaryTextFile: () => false,
	readIndexableContent: async (_vault: unknown, f: FakeFile) => {
		// Decided at the start of the read, like the real reader: a PDF extraction
		// already under way finishes even if PDFs are switched off meanwhile.
		const text = f.extension === "pdf" && !contentIndexing.pdfs ? "" : `content of ${f.path}@${f.stat.mtime}`;
		const failing = readFailures.has(f.path);
		await readGates.get(f.path);
		if (failing) throw new Error(`cannot read ${f.path}`);
		return text;
	},
}));

import { LexicalSearchService, waitForLexicalSearch } from "../../src/search/LexicalSearchService";

/** The layout-ready callback, when `fakePlugin` is told to hold it back. */
let layoutReady: (() => void) | null = null;

function fakePlugin(options: { deferLayoutReady?: boolean } = {}) {
	return {
		app: {
			workspace: {
				onLayoutReady: (cb: () => void) => {
					if (options.deferLayoutReady) layoutReady = cb;
					else cb();
				},
			},
			vault: { getFiles: () => vaultFiles, on: () => ({}) },
			metadataCache: { getFileCache: () => null },
			loadLocalStorage: (key: string) => localStore.get(key) ?? null,
			saveLocalStorage: (key: string, value: string | null) => {
				if (value === null) localStore.delete(key);
				else localStore.set(key, value);
			},
		},
		registerEvent: () => {},
		register: () => {},
	} as never;
}

let service: LexicalSearchService | null = null;

beforeEach(() => {
	vi.useFakeTimers();
	(Platform as { isMobile: boolean }).isMobile = false;
	loaded = new Map();
	vaultFiles = [];
	readGates = new Map();
	contentIndexing = { pdfs: false, chats: false, data: false };
	localStore = new Map();
	readFailures = new Set();
	contentGroupOverride.clear();
	contentIndexingListeners.clear();
	layoutReady = null;
	addDocument.mockClear();
	removeDocument.mockClear();
	flush.mockClear();
});

afterEach(async () => {
	await service?.cleanup();
	service = null;
	vi.useRealTimers();
});

describe("LexicalSearchService.validateIndex", () => {
	it("re-indexes notes whose mtime differs from the stored one, and those of unknown age", async () => {
		loaded = new Map([
			["current.md", 1_000],
			["synced.md", 1_000],
			["restored.md", 5_000],
			["pre-mtime.md", undefined],
			["gone.md", 1_000],
		]);
		vaultFiles = [
			file("current.md", 1_000), // unchanged
			file("synced.md", 2_000), // modified while Obsidian was closed
			file("restored.md", 4_000), // put back from a backup: *older* than the index
			file("pre-mtime.md", 1_000), // indexed before mtimes were tracked
			file("new.md", 1_000), // never indexed
		];

		service = LexicalSearchService.startInitialize(fakePlugin());
		expect(await waitForLexicalSearch()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(removeDocument).toHaveBeenCalledWith("gone.md");
		const indexed = addDocument.mock.calls.map(([path, , content, , mtime]) => ({ path, content, mtime }));
		expect(indexed).toEqual([
			{ path: "synced.md", content: "content of synced.md@2000", mtime: 2_000 },
			{ path: "restored.md", content: "content of restored.md@4000", mtime: 4_000 },
			{ path: "pre-mtime.md", content: "content of pre-mtime.md@1000", mtime: 1_000 },
			{ path: "new.md", content: "content of new.md@1000", mtime: 1_000 },
		]);
		expect(flush).toHaveBeenCalled();
	});

	it("a read that finishes after a newer snapshot was indexed is discarded, whichever writer it came from", async () => {
		// The modify handler reads a.md while it is at mtime 2000, slowly. The
		// note changes again (3000) and the startup validation indexes that
		// snapshot first. When the handler's older read finally lands it must
		// not put the 2000 content — and the 2000 stamp — back over it, or
		// search serves the stale snapshot for the rest of the session.
		loaded = new Map([["a.md", 1_000]]);
		vaultFiles = [file("a.md", 2_000)];
		let releaseHandlerRead: (() => void) | null = null;
		readGates.set(
			"a.md",
			new Promise<void>((resolve) => {
				releaseHandlerRead = resolve;
			}),
		);

		service = LexicalSearchService.startInitialize(fakePlugin({ deferLayoutReady: true }));
		expect(await waitForLexicalSearch()).toBe(true);
		const handlerRead = (
			service as unknown as { handleFileModify(file: FakeFile): Promise<void> }
		).handleFileModify(vaultFiles[0]);

		vaultFiles[0].stat.mtime = 3_000;
		readGates.delete("a.md");
		if (!layoutReady) throw new Error("layout-ready callback was not captured");
		layoutReady();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(addDocument).toHaveBeenCalledTimes(1);
		expect(addDocument).toHaveBeenLastCalledWith("a.md", "a", "content of a.md@3000", [], 3_000);

		if (!releaseHandlerRead) throw new Error("handler read never started");
		(releaseHandlerRead as () => void)();
		await handlerRead;
		expect(addDocument).toHaveBeenCalledTimes(1);
		expect(loaded.get("a.md")).toBe(3_000);
	});

	it("debounces re-indexing of a modified note: a burst of saves reads and indexes it once", async () => {
		loaded = new Map([["a.md", 1_000]]);
		vaultFiles = [file("a.md", 1_000)];
		service = LexicalSearchService.startInitialize(fakePlugin());
		expect(await waitForLexicalSearch()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000); // startup validation: nothing to do
		addDocument.mockClear();
		const hooks = service as unknown as {
			handleFileModify(file: FakeFile): void;
			handleFileRename(file: FakeFile, oldPath: string): Promise<void>;
		};

		vaultFiles[0].stat.mtime = 2_000;
		hooks.handleFileModify(vaultFiles[0]);
		await vi.advanceTimersByTimeAsync(1_500);
		vaultFiles[0].stat.mtime = 3_000;
		hooks.handleFileModify(vaultFiles[0]);
		await vi.advanceTimersByTimeAsync(1_500);
		// 1.5 s after the last save: still waiting, and the first save was folded in.
		expect(addDocument).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(500);
		expect(addDocument).toHaveBeenCalledTimes(1);
		expect(addDocument.mock.calls[0][4]).toBe(3_000);

		// A rename while a re-index is pending drops it: the old path is gone.
		addDocument.mockClear();
		hooks.handleFileModify(vaultFiles[0]);
		const renamed = file("b.md", 3_000);
		vaultFiles = [renamed];
		await hooks.handleFileRename(renamed, "a.md");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(removeDocument).toHaveBeenCalledWith("a.md");
		expect(addDocument.mock.calls.map(([path]) => path)).toEqual(["b.md"]);
	});

	it("waits for a drawing to be left alone before re-reading it, not for each autosave (#541)", async () => {
		loaded = new Map([["Sketch.excalidraw.md", 1_000]]);
		vaultFiles = [file("Sketch.excalidraw.md", 1_000)];
		service = LexicalSearchService.startInitialize(fakePlugin());
		expect(await waitForLexicalSearch()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		addDocument.mockClear();
		const hooks = service as unknown as { handleFileModify(file: FakeFile): void };

		for (let mtime = 2_000; mtime <= 6_000; mtime += 1_000) {
			vaultFiles[0].stat.mtime = mtime;
			hooks.handleFileModify(vaultFiles[0]);
			await vi.advanceTimersByTimeAsync(5_000);
		}
		expect(addDocument).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(25_000);
		expect(addDocument).toHaveBeenCalledTimes(1);
	});

	it("leaves an index that matches the vault alone", async () => {
		loaded = new Map([["a.md", 1_000]]);
		vaultFiles = [file("a.md", 1_000)];

		service = LexicalSearchService.startInitialize(fakePlugin());
		expect(await waitForLexicalSearch()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(addDocument).not.toHaveBeenCalled();
		expect(removeDocument).not.toHaveBeenCalled();
	});

	it("re-reads the files of a content group whose switch changed, even with unchanged mtimes", async () => {
		const pdf = (path: string): FakeFile => ({ ...file(path, 1_000), extension: "pdf" });
		loaded = new Map([
			["a.md", 1_000],
			["paper.pdf", 1_000],
		]);
		vaultFiles = [file("a.md", 1_000), pdf("paper.pdf")];
		// An index with no record predates the setting: built with PDF contents in it.
		service = LexicalSearchService.startInitialize(fakePlugin());
		expect(await waitForLexicalSearch()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);

		// PDFs are off by default, so the PDF is re-read (now title-only); the note is not.
		expect(addDocument.mock.calls.map((call) => call[0])).toEqual(["paper.pdf"]);
		expect(JSON.parse(localStore.get("s2b-lexical-content-groups") ?? "null")).toEqual(contentIndexing);

		// Switching PDFs on re-reads it again; nothing else moves.
		addDocument.mockClear();
		contentIndexing = { ...contentIndexing, pdfs: true };
		for (const listener of contentIndexingListeners) listener();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(addDocument.mock.calls.map((call) => call[0])).toEqual(["paper.pdf"]);

		// With the record matching the settings, the next validation leaves it alone.
		addDocument.mockClear();
		for (const listener of contentIndexingListeners) listener();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(addDocument).not.toHaveBeenCalled();
	});

	it("an extraction still in flight when its group is switched off does not put the contents back", async () => {
		const pdf: FakeFile = { ...file("paper.pdf", 1_000), extension: "pdf" };
		contentIndexing = { pdfs: true, chats: false, data: false };
		localStore.set("s2b-lexical-content-groups", JSON.stringify(contentIndexing));
		loaded = new Map([["paper.pdf", 1_000]]);
		vaultFiles = [pdf];
		service = LexicalSearchService.startInitialize(fakePlugin());
		expect(await waitForLexicalSearch()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(addDocument).not.toHaveBeenCalled();

		// A modify handler starts extracting the PDF, slowly.
		let release: (() => void) | null = null;
		readGates.set(
			"paper.pdf",
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		const handlerRead = (
			service as unknown as { handleFileModify(file: FakeFile): Promise<void> }
		).handleFileModify(pdf);

		// PDFs are switched off; the validation it schedules writes the title-only document.
		readGates.delete("paper.pdf");
		contentIndexing = { ...contentIndexing, pdfs: false };
		for (const listener of contentIndexingListeners) listener();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(addDocument).toHaveBeenLastCalledWith("paper.pdf", "paper.pdf", "", [], 1_000);

		// The old extraction lands with the same mtime and must be discarded.
		(release as unknown as () => void)();
		await handlerRead;
		expect(addDocument).toHaveBeenCalledTimes(1);
	});

	it("a changed group's file whose re-read fails is retried by a later validation", async () => {
		const json: FakeFile = { ...file("export.json", 1_000), extension: "json" };
		localStore.set("s2b-lexical-content-groups", JSON.stringify(contentIndexing));
		loaded = new Map([["export.json", 1_000]]);
		vaultFiles = [json];
		service = LexicalSearchService.startInitialize(fakePlugin());
		expect(await waitForLexicalSearch()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);

		// Data files switched on (the mock groups only PDFs, so give JSON a group too).
		contentGroupOverride.set("export.json", "data");
		contentIndexing = { ...contentIndexing, data: true };
		readFailures.add("export.json");
		for (const listener of contentIndexingListeners) listener();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(addDocument).not.toHaveBeenCalled();
		expect(loaded.get("export.json")).toBeUndefined();

		// Readable again: the record matches, but the stale stamp gets it re-read.
		readFailures.clear();
		await (service as unknown as { validateIndex(): Promise<void> }).validateIndex();
		expect(addDocument).toHaveBeenCalledWith(
			"export.json",
			"export.json",
			"content of export.json@1000",
			[],
			1_000,
		);
	});
});
