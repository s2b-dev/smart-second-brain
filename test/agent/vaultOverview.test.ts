/**
 * The vault overview is vault text copied into every system prompt, so these pin the two
 * things that matter beyond formatting: it never names anything from a private or excluded
 * file, and it stays byte-stable while the vault only grows in ways that don't reorder it
 * (no counts), so the provider's prompt cache keeps hitting.
 */

import { describe, expect, it } from "vitest";
import { App, type CachedMetadata, TFile } from "obsidian";

import {
	type VaultOverviewData,
	collectVaultOverview,
	renderVaultFolders,
	renderVaultOverview,
	renderVaultProperties,
	renderVaultTags,
} from "../../src/agent/vaultOverview";

interface FakeNote {
	path: string;
	tags?: string[];
	frontmatter?: Record<string, unknown>;
}

function fakeApp(notes: FakeNote[]): App {
	const app = new App();
	const files = notes.map((note) => {
		const file = new TFile();
		file.path = note.path;
		file.name = note.path.split("/").pop() ?? note.path;
		file.extension = file.name.split(".").pop() ?? "";
		return file;
	});
	const caches = new Map(
		notes.map((note) => [
			note.path,
			{
				tags: note.tags?.map((tag) => ({ tag })),
				frontmatter: note.frontmatter ? { ...note.frontmatter, position: {} } : undefined,
			},
		]),
	);
	app.vault.getFiles = () => files;
	app.metadataCache.getFileCache = (file: TFile) => (caches.get(file.path) ?? null) as CachedMetadata | null;
	return app;
}

const OPEN = { isExcluded: () => false, isPrivate: () => false };

describe("collectVaultOverview", () => {
	it("collects every ancestor folder, tag and property key, counting notes not occurrences", () => {
		const app = fakeApp([
			{ path: "Projects/Acme/Plan.md", tags: ["#project", "#project"], frontmatter: { status: "open" } },
			{ path: "Projects/Beta.md", tags: ["#project"], frontmatter: { status: "done", due: "x" } },
			{ path: "Inbox.md" },
		]);
		const data = collectVaultOverview(app, OPEN);
		expect(data.folders.sort()).toEqual(["Projects", "Projects/Acme"]);
		expect(data.tagCounts.get("#project")).toBe(2);
		expect(data.propertyCounts.get("status")).toBe(2);
		expect(data.propertyCounts.get("due")).toBe(1);
		// Obsidian's cache adds `position` to every frontmatter; it is not a property.
		expect(data.propertyCounts.has("position")).toBe(false);
	});

	it("names nothing that only appears in private or excluded files", () => {
		const app = fakeApp([
			{ path: "Therapy/Session.md", tags: ["#therapy"], frontmatter: { therapist: "x" } },
			{ path: "Agents/Memories/User.md", tags: ["#memory"] },
			{ path: "Work/Note.md", tags: ["#work"] },
		]);
		const data = collectVaultOverview(app, {
			isExcluded: (path) => path.startsWith("Agents/"),
			isPrivate: (path) => path.startsWith("Therapy/"),
		});
		expect(data.folders).toEqual(["Work"]);
		expect([...data.tagCounts.keys()]).toEqual(["#work"]);
		expect(data.propertyCounts.size).toBe(0);
		expect(data.skippedPrivateFiles).toBe(1);
	});

	it("lists folders of non-markdown files but reads tags only from notes", () => {
		const app = fakeApp([{ path: "Attachments/scan.pdf" }]);
		expect(collectVaultOverview(app, OPEN).folders).toEqual(["Attachments"]);
	});
});

describe("renderVaultFolders", () => {
	it("renders the tree indented, each folder directly above its children", () => {
		expect(renderVaultFolders(["Work/Clients", "Archive", "Work", "Work/Clients/Acme"])).toBe(
			"<vault_folders>\nArchive/\nWork/\n  Clients/\n    Acme/\n</vault_folders>",
		);
	});

	it("keeps the shallowest folders when capped and says how many deeper ones are hidden", () => {
		const out = renderVaultFolders(["A", "A/B", "A/B/C", "D"], 2);
		expect(out).toContain("A/\nD/");
		expect(out).not.toContain("B/");
		expect(out).toContain("(2 deeper folders not shown");
	});

	it("says when the vault has no folders", () => {
		expect(renderVaultFolders([])).toContain("No folders yet");
	});
});

describe("renderVaultTags / renderVaultProperties", () => {
	it("orders by use, ties by name, without rendering counts", () => {
		const out = renderVaultTags(
			new Map([
				["#b", 3],
				["#a", 3],
				["#c", 9],
			]),
		);
		expect(out).toBe("<vault_tags>\n#c, #a, #b\n</vault_tags>");
	});

	it("caps the list and says how many were left out", () => {
		const out = renderVaultProperties(
			new Map([
				["status", 5],
				["due", 2],
				["rare", 1],
			]),
			2,
		);
		expect(out).toBe("<vault_properties>\nstatus, due\n(1 less used properties not shown)\n</vault_properties>");
	});

	it("is unchanged when a new note only raises an existing count", () => {
		const before = renderVaultTags(
			new Map([
				["#project", 10],
				["#idea", 2],
			]),
		);
		const after = renderVaultTags(
			new Map([
				["#project", 11],
				["#idea", 2],
			]),
		);
		expect(after).toBe(before);
	});
});

describe("renderVaultOverview", () => {
	const data = (skippedPrivateFiles: number): VaultOverviewData => ({
		folders: ["Work"],
		tagCounts: new Map(),
		propertyCounts: new Map(),
		skippedPrivateFiles,
	});

	// Left silent, the model would read a short overview as the whole vault.
	it("says once when private notes were left out", () => {
		expect(renderVaultOverview(data(3)).folders).toContain("private for the current model");
		expect(renderVaultOverview(data(0)).folders).not.toContain("private");
	});

	// A note without a metadata cache entry reports no tags; "No tags in use yet" would be false.
	it("says the tag and property lists are incomplete while Obsidian is indexing", () => {
		const app = fakeApp([{ path: "Work/A.md", tags: ["#work"] }, { path: "Work/B.md" }]);
		const getFileCache = app.metadataCache.getFileCache;
		app.metadataCache.getFileCache = (file: TFile) => (file.path === "Work/B.md" ? null : getFileCache(file));
		const collected = collectVaultOverview(app, OPEN);
		expect(collected.unindexedNotes).toBe(1);
		const out = renderVaultOverview(collected);
		expect(out.tags).toContain("#work");
		expect(out.tags).toContain("still indexing 1 notes");
		expect(out.properties).not.toContain("No properties in use yet");
		expect(out.properties).toContain("still indexing");
		expect(renderVaultOverview({ ...collected, unindexedNotes: 0 }).tags).not.toContain("indexing");
	});

	it("renders empty tag and property lists as plain sentences", () => {
		const out = renderVaultOverview(data(0));
		expect(out.tags).toBe("No tags in use yet.");
		expect(out.properties).toBe("No properties in use yet.");
	});
});
