/**
 * The memory index is substituted into every agent's system prompt, so its shape is a
 * contract with the `# Memory` guidance: one line per note carrying the note's own
 * description, always-loaded notes in full under a budget, and an honest overflow line.
 */

import { App, TFile, TFolder } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
	DEFAULT_USER_MEMORY_NOTE,
	MEMORY_ALWAYS_BUDGET,
	MEMORY_INDEX_BUDGET,
	MEMORY_INDEX_LINE_MAX,
	type MemoryIndexEntry,
	collectMemoryIndex,
	renderMemoryIndex,
	seedMemoryFolder,
} from "../../src/agent/memoryNotes";

const entry = (path: string, summary: string | null, extra: Partial<MemoryIndexEntry> = {}): MemoryIndexEntry => ({
	path,
	summary,
	always: false,
	...extra,
});

describe("renderMemoryIndex", () => {
	it("says so when there is nothing to list", () => {
		expect(renderMemoryIndex([])).toBe("No memory notes yet.");
	});

	it("lists one line per note, sorted by path, with the description", () => {
		const out = renderMemoryIndex([
			entry("Agents/Memories/Projects.md", "Active projects and where they are tracked"),
			entry("Agents/Memories/Habits.md", "Daily routines the user mentioned"),
		]);
		expect(out).toBe(
			[
				"## Memory notes",
				"- `Agents/Memories/Habits.md` — Daily routines the user mentioned",
				"- `Agents/Memories/Projects.md` — Active projects and where they are tracked",
			].join("\n"),
		);
	});

	it("falls back to the filename when a note has no description or heading", () => {
		expect(renderMemoryIndex([entry("Agents/Memories/Old note.md", null)])).toContain(
			"- `Agents/Memories/Old note.md` — Old note",
		);
	});

	it("collapses a multi-line description and caps the line length", () => {
		const long = "a ".repeat(200);
		const out = renderMemoryIndex([entry("Agents/Memories/X.md", `first\n  second\n${long}`)]);
		const line = out.split("\n")[1]!;
		expect(line).toContain("first second a a");
		expect(line.length).toBeLessThanOrEqual(MEMORY_INDEX_LINE_MAX);
		expect(line.endsWith("…")).toBe(true);
	});

	it("marks always-loaded notes in the list and includes their body above it", () => {
		const out = renderMemoryIndex([
			entry("Agents/Memories/User.md", "Who the user is", { always: true, body: "\n# User\nName: Leo\n" }),
			entry("Agents/Memories/Projects.md", "Projects"),
		]);
		expect(out).toBe(
			[
				"## Always loaded",
				"### Agents/Memories/User.md",
				"# User\nName: Leo",
				"",
				"## Memory notes",
				"- `Agents/Memories/Projects.md` — Projects",
				"- `Agents/Memories/User.md` — Who the user is (always loaded)",
			].join("\n"),
		);
	});

	// A note flagged always-loaded whose body could not be read still appears in the list —
	// the flag alone never removes it.
	it("keeps an unreadable always-loaded note in the list without a body block", () => {
		const out = renderMemoryIndex([entry("Agents/Memories/User.md", "Who the user is", { always: true })]);
		expect(out).not.toContain("## Always loaded");
		expect(out).toContain("(always loaded)");
	});

	it("truncates always-loaded bodies at the budget and says so", () => {
		const out = renderMemoryIndex([
			entry("Agents/Memories/A.md", "a", { always: true, body: "x".repeat(MEMORY_ALWAYS_BUDGET - 10) }),
			entry("Agents/Memories/B.md", "b", { always: true, body: "y".repeat(100) }),
			entry("Agents/Memories/C.md", "c", { always: true, body: "z".repeat(100) }),
		]);
		expect(out).toContain(`${"y".repeat(10)}\n(truncated — read_content for the rest)`);
		expect(out).toContain("### Agents/Memories/C.md\n(not loaded — always-loaded budget exhausted");
		// Nothing past the budget leaks in.
		expect(out).not.toContain("y".repeat(11));
		expect(out).not.toContain("zzz");
	});

	it("stops listing at the index budget and reports how many are hidden", () => {
		const entries = Array.from({ length: 200 }, (_, i) =>
			entry(`Agents/Memories/Note ${String(i).padStart(3, "0")}.md`, "d".repeat(100)),
		);
		const out = renderMemoryIndex(entries);
		const lines = out.split("\n").slice(1);
		const listed = lines.filter((l) => l.startsWith("- "));
		const overflow = lines.at(-1)!;
		expect(listed.length).toBeLessThan(200);
		expect(listed.join("\n").length).toBeLessThanOrEqual(MEMORY_INDEX_BUDGET);
		expect(overflow).toBe(
			`(${200 - listed.length} more not shown — list_directory on the memory folder shows all)`,
		);
	});
});

/** A vault fake just big enough for the collector: a folder tree plus a per-file cache. */
function fakeApp(tree: { path: string; content?: string; cache?: unknown; folder?: boolean }[]) {
	const app = new App();
	const vault = app.vault;
	const folders = new Map<string, TFolder>();
	const contents = new Map<string, string>();
	const caches = new Map<string, unknown>();

	const folderFor = (path: string): TFolder => {
		let folder = folders.get(path);
		if (!folder) {
			folder = new TFolder();
			folder.path = path;
			folder.name = path.split("/").pop() ?? path;
			folders.set(path, folder);
			const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
			if (parentPath) folderFor(parentPath).children.push(folder);
		}
		return folder;
	};

	for (const node of tree) {
		if (node.folder) {
			folderFor(node.path);
			continue;
		}
		const file = new TFile();
		file.path = node.path;
		file.name = node.path.split("/").pop() ?? node.path;
		file.basename = file.name.replace(/\.[^.]+$/, "");
		file.extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1) : "";
		folderFor(node.path.slice(0, node.path.lastIndexOf("/"))).children.push(file);
		contents.set(node.path, node.content ?? "");
		caches.set(node.path, node.cache ?? null);
	}

	vi.mocked(vault.getFolderByPath).mockImplementation((path: string) => folders.get(path) ?? null);
	vi.mocked(vault.cachedRead).mockImplementation(async (file: TFile) => {
		const text = contents.get(file.path);
		if (text === undefined) throw new Error(`unreadable: ${file.path}`);
		return text;
	});
	vi.mocked(app.metadataCache.getFileCache).mockImplementation(
		(file: TFile) => (caches.get(file.path) as ReturnType<typeof app.metadataCache.getFileCache>) ?? null,
	);
	return { app, vault, folders };
}

const fm = (frontmatter: Record<string, unknown>, bodyOffset: number, headings: string[] = []) => ({
	frontmatter,
	frontmatterPosition: { start: { line: 0, col: 0, offset: 0 }, end: { line: 3, col: 3, offset: bodyOffset } },
	headings: headings.map((heading) => ({ heading, level: 1 })),
});

describe("collectMemoryIndex", () => {
	it("returns nothing when the folder does not exist", async () => {
		const { app } = fakeApp([]);
		expect(await collectMemoryIndex(app, "Agents/Memories")).toEqual([]);
	});

	it("reads descriptions and the always flag from the metadata cache, recursing into subfolders", async () => {
		const raw = "---\ndescription: Who the user is\nalways: true\n---\n# User\nName: Leo\n";
		const { app } = fakeApp([
			{
				path: "Agents/Memories/User.md",
				content: raw,
				cache: fm({ description: "Who the user is", always: true }, raw.indexOf("\n# User")),
			},
			{ path: "Agents/Memories/Work/Team.md", cache: fm({ description: "Team roster" }, 0) },
			{ path: "Agents/Memories/Untitled.md", cache: fm({}, 0, ["Reading list"]) },
			{ path: "Agents/Memories/attachment.png" },
		]);

		const entries = await collectMemoryIndex(app, "Agents/Memories");
		expect(entries.map((e) => e.path).sort()).toEqual([
			"Agents/Memories/Untitled.md",
			"Agents/Memories/User.md",
			"Agents/Memories/Work/Team.md",
		]);
		const user = entries.find((e) => e.path === "Agents/Memories/User.md")!;
		expect(user).toMatchObject({ summary: "Who the user is", always: true, body: "\n# User\nName: Leo\n" });
		expect(entries.find((e) => e.path === "Agents/Memories/Work/Team.md")).toMatchObject({
			summary: "Team roster",
			always: false,
			body: undefined,
		});
		// No description → first heading.
		expect(entries.find((e) => e.path === "Agents/Memories/Untitled.md")).toMatchObject({
			summary: "Reading list",
		});
	});

	it("ignores a non-boolean always flag and a non-string description", async () => {
		const { app } = fakeApp([
			{ path: "Agents/Memories/A.md", cache: fm({ description: ["x"], always: "yes" }, 0, ["Heading"]) },
		]);
		expect(await collectMemoryIndex(app, "Agents/Memories")).toEqual([
			{ path: "Agents/Memories/A.md", summary: "Heading", always: false, body: undefined },
		]);
	});

	it("keeps the index line when an always-loaded body cannot be read", async () => {
		const { app, vault } = fakeApp([{ path: "Agents/Memories/User.md", cache: fm({ always: true }, 0) }]);
		vi.mocked(vault.cachedRead).mockRejectedValue(new Error("boom"));
		expect(await collectMemoryIndex(app, "Agents/Memories")).toEqual([
			{ path: "Agents/Memories/User.md", summary: null, always: true, body: undefined },
		]);
	});
});

describe("seedMemoryFolder", () => {
	it("creates the folder and the profile note when the folder is missing", async () => {
		const { app, vault } = fakeApp([]);
		await seedMemoryFolder(app, "Agents/Memories");
		expect(vault.createFolder).toHaveBeenCalledWith("Agents/Memories");
		expect(vault.create).toHaveBeenCalledWith("Agents/Memories/User.md", DEFAULT_USER_MEMORY_NOTE);
	});

	it("seeds the profile note into an existing empty folder", async () => {
		const { app, vault } = fakeApp([{ path: "Agents/Memories", folder: true }]);
		await seedMemoryFolder(app, "Agents/Memories");
		expect(vault.createFolder).not.toHaveBeenCalled();
		expect(vault.create).toHaveBeenCalledWith("Agents/Memories/User.md", DEFAULT_USER_MEMORY_NOTE);
	});

	// The profile note is a default, not a requirement: a user who deleted it but kept other
	// memories must not get it back on every launch.
	it("leaves a folder that already holds memories alone", async () => {
		const { app, vault } = fakeApp([{ path: "Agents/Memories/Projects.md" }]);
		await seedMemoryFolder(app, "Agents/Memories");
		expect(vault.create).not.toHaveBeenCalled();
	});

	it("swallows vault errors", async () => {
		const { app, vault } = fakeApp([]);
		vi.mocked(vault.createFolder).mockRejectedValue(new Error("read-only"));
		await expect(seedMemoryFolder(app, "Agents/Memories")).resolves.toBeUndefined();
	});
});
