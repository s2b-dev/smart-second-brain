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
		suspendScheduledSaves() {}
		resumeScheduledSaves() {}
		flush = flush;
		close() {}
	},
}));
vi.mock("../../src/stores/dataStore.svelte", () => ({ getData: () => ({ vaultSlug: "vault-1" }) }));
vi.mock("../../src/utils/fileFiltering", () => ({
	getIndexableVaultFiles: () => vaultFiles,
	isIndexableFile: () => true,
	isBinaryTextFile: () => false,
	readIndexableContent: async (_vault: unknown, f: FakeFile) => {
		await readGates.get(f.path);
		return `content of ${f.path}@${f.stat.mtime}`;
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
			loadLocalStorage: () => null,
			saveLocalStorage: () => {},
		},
		registerEvent: () => {},
	} as never;
}

let service: LexicalSearchService | null = null;

beforeEach(() => {
	vi.useFakeTimers();
	(Platform as { isMobile: boolean }).isMobile = false;
	loaded = new Map();
	vaultFiles = [];
	readGates = new Map();
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

	it("leaves an index that matches the vault alone", async () => {
		loaded = new Map([["a.md", 1_000]]);
		vaultFiles = [file("a.md", 1_000)];

		service = LexicalSearchService.startInitialize(fakePlugin());
		expect(await waitForLexicalSearch()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(addDocument).not.toHaveBeenCalled();
		expect(removeDocument).not.toHaveBeenCalled();
	});
});
