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

/** What the fake index holds at load: path → stored mtime (undefined = indexed before mtimes existed). */
let loaded: Map<string, number | undefined>;
let vaultFiles: FakeFile[];
const addDocument = vi.fn();
const removeDocument = vi.fn();
const flush = vi.fn(async () => {});

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
		addDocument(...args: unknown[]) {
			addDocument(...args);
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
	readIndexableContent: async (_vault: unknown, f: FakeFile) => `content of ${f.path}`,
}));

import { LexicalSearchService, waitForLexicalSearch } from "../../src/search/LexicalSearchService";

function fakePlugin() {
	return {
		app: {
			workspace: { onLayoutReady: (cb: () => void) => cb() },
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
			{ path: "synced.md", content: "content of synced.md", mtime: 2_000 },
			{ path: "restored.md", content: "content of restored.md", mtime: 4_000 },
			{ path: "pre-mtime.md", content: "content of pre-mtime.md", mtime: 1_000 },
			{ path: "new.md", content: "content of new.md", mtime: 1_000 },
		]);
		expect(flush).toHaveBeenCalled();
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
