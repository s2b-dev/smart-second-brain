import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

const mockIsPathAllowed = vi.fn().mockReturnValue(true);
const mockShouldBlockFile = vi.fn().mockReturnValue(false);

vi.mock("../../src/stores/pendingChangesStore.svelte", () => ({
	getPendingChangesStore: () => ({
		isPathAllowed: mockIsPathAllowed,
		shouldBlockFile: mockShouldBlockFile,
	}),
}));

const mockGetData = vi.fn();
vi.mock("../../src/agent/tools/builtInToolDefaults", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/agent/tools/builtInToolDefaults")>()),
	DEFAULT_TOOLS_CONFIG: {
		list_directory: {
			name: "list_directory",
			description: "List the vault's folder structure.",
		},
	},
}));
import { installAgentPathSource } from "../../src/utils/agentPathSource";
installAgentPathSource({ agentFolder: () => "Agents", agentName: () => undefined });
vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => mockGetData(),
}));

import type { App } from "obsidian";
import { type DirectoryListResult, createListDirectoryTool } from "../../src/agent/tools/listDirectory";

function createFile(path: string, size = 100) {
	const name = path.split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	return {
		path,
		name,
		extension: dot >= 0 ? name.slice(dot + 1) : "",
		stat: { size },
	};
}

function createMockApp(files: Array<ReturnType<typeof createFile>>): App {
	return {
		vault: {
			getFiles: vi.fn().mockReturnValue(files),
			getAbstractFileByPath: vi.fn().mockReturnValue(null),
		},
	} as unknown as App;
}

/** A selected agent with the given (or no) context window; the tool derives its budget from it. */
function mockAgent(contextWindow?: number, agentFolder?: string) {
	mockGetData.mockReturnValue({
		...(agentFolder ? { agentFolder } : {}),
		getSelectedAgent: () => ({
			chatModel: { provider: "openai", modelConfig: contextWindow ? { contextWindow } : undefined },
			toolsConfig: {
				list_directory: {
					name: "list_directory",
					// A stale persisted description: the tool must ignore it (see below).
					description: "List directories and files in the vault.",
				},
			},
		}),
	});
}

async function list(app: App, input: Record<string, unknown> = {}): Promise<DirectoryListResult> {
	const tool = createListDirectoryTool(app);
	return JSON.parse(String(await tool.invoke(input))) as DirectoryListResult;
}

describe("listDirectory tool", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsPathAllowed.mockReturnValue(true);
		mockShouldBlockFile.mockReturnValue(false);
		mockAgent();
	});

	describe("root overview", () => {
		it("lists folders with counts but no file names, two levels deep", async () => {
			const app = createMockApp([
				createFile("Inbox/today.md"),
				createFile("Projects/Roadmap.md"),
				createFile("Projects/2026/Plan.md"),
				createFile("Projects/2026/Q1/Goals.md"),
				createFile("root.md"),
			]);

			const result = await list(app);

			expect(result.root).toBe("/");
			expect(result.includeFiles).toBe(false);
			expect(result.maxDepth).toBe(2);
			expect(result.totalFolders).toBe(4);
			expect(result.totalFiles).toBe(5);
			expect(result.note).toBeUndefined();

			// Root-level files are counted, never named.
			expect(result.tree.files).toBeUndefined();
			expect(result.tree.moreFiles).toBe(1);
			expect(result.tree.fileCount).toBe(5);

			expect(Object.keys(result.tree.folders ?? {})).toEqual(["Inbox", "Projects"]);
			const projects = result.tree.folders?.Projects;
			expect(projects?.fileCount).toBe(3);
			expect(projects?.files).toBeUndefined();
			expect(projects?.moreFiles).toBe(1);
			// Depth 2 is rendered; the folder at the limit reports what lies below it.
			const y2026 = projects?.folders?.["2026"];
			expect(y2026?.fileCount).toBe(2);
			expect(y2026?.folders).toBeUndefined();
			expect(y2026?.folderCount).toBe(1);
		});

		it("lists root files when asked to", async () => {
			const app = createMockApp([createFile("Inbox/today.md"), createFile("root.md")]);

			const result = await list(app, { includeFiles: true });

			expect(result.includeFiles).toBe(true);
			expect(result.tree.files).toEqual(["root.md"]);
			expect(result.tree.moreFiles).toBeUndefined();
			expect(result.tree.folders?.Inbox?.files).toEqual(["today.md"]);
		});

		it("omits empty markers and never emits empty collections", async () => {
			const app = createMockApp([createFile("Inbox/today.md")]);

			const raw = String(await createListDirectoryTool(app).invoke({}));

			expect(raw).not.toContain('"files":[]');
			expect(raw).not.toContain('"folders":{}');
			expect(raw).not.toContain('"moreFiles":0');
			expect(raw).not.toContain('"moreFolders":0');
		});
	});

	describe("folder listing", () => {
		it("lists a folder's files and direct subfolders one level deep by default", async () => {
			const app = createMockApp([
				createFile("Projects/Roadmap.md"),
				createFile("Projects/2026/Plan.md"),
				createFile("Projects/2026/Q1/Goals.md"),
				createFile("Elsewhere/x.md"),
			]);

			const result = await list(app, { path: "Projects" });

			expect(result.root).toBe("Projects");
			expect(result.includeFiles).toBe(true);
			expect(result.maxDepth).toBe(1);
			expect(result.totalFiles).toBe(3);
			expect(result.totalFolders).toBe(2);
			expect(result.tree.files).toEqual(["Roadmap.md"]);
			const y2026 = result.tree.folders?.["2026"];
			expect(y2026?.files).toEqual(["Plan.md"]);
			expect(y2026?.fileCount).toBe(2);
			expect(y2026?.folderCount).toBe(1);
			expect(y2026?.folders).toBeUndefined();
		});

		it("descends further when maxDepth is given", async () => {
			const app = createMockApp([createFile("Projects/2026/Plan.md"), createFile("Projects/2026/Q1/Goals.md")]);

			const result = await list(app, { path: "Projects", maxDepth: 2 });

			expect(result.maxDepth).toBe(2);
			expect(result.tree.folders?.["2026"]?.folders?.Q1?.files).toEqual(["Goals.md"]);
		});

		it("sorts files and folders by name", async () => {
			const app = createMockApp([
				createFile("P/b.md"),
				createFile("P/a.md"),
				createFile("P/zeta/x.md"),
				createFile("P/alpha/x.md"),
			]);

			const result = await list(app, { path: "P" });

			expect(result.tree.files).toEqual(["a.md", "b.md"]);
			expect(Object.keys(result.tree.folders ?? {})).toEqual(["alpha", "zeta"]);
		});

		it("errors on a missing folder or a file path", async () => {
			const app = createMockApp([createFile("Notes/a.md")]);
			const tool = createListDirectoryTool(app);

			expect(String(await tool.invoke({ path: "Nope" }))).toContain("does not exist");

			(app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue({ extension: "md" });
			expect(String(await tool.invoke({ path: "Notes/a.md" }))).toContain("is a file, not a folder");
		});
	});

	describe("context budget", () => {
		/** A flat folder with `count` files whose names are long enough to blow a small budget. */
		function wideFolder(count: number, folder = "Journal") {
			return Array.from({ length: count }, (_, i) =>
				createFile(`${folder}/${String(i).padStart(4, "0")} a daily note with a descriptive title.md`),
			);
		}

		it("lists everything when it fits", async () => {
			mockAgent(128_000);
			const result = await list(createMockApp(wideFolder(300)), { path: "Journal" });

			expect(result.tree.files).toHaveLength(300);
			expect(result.tree.moreFiles).toBeUndefined();
			expect(result.note).toBeUndefined();
		});

		it("collapses files per folder rather than cutting the JSON when over budget", async () => {
			// The smallest budget the helper allows (4000 chars): ~70 of these names fit.
			mockAgent(1_000);
			const raw = String(
				await createListDirectoryTool(createMockApp(wideFolder(300))).invoke({ path: "Journal" }),
			);

			expect(raw.length).toBeLessThanOrEqual(4_000);
			const result = JSON.parse(raw) as DirectoryListResult;
			expect(result.tree.files?.length).toBeGreaterThan(0);
			expect(result.tree.files?.length).toBeLessThan(300);
			expect((result.tree.files?.length ?? 0) + (result.tree.moreFiles ?? 0)).toBe(300);
			// Exact totals survive the collapse.
			expect(result.totalFiles).toBe(300);
			expect(result.tree.fileCount).toBe(300);
			expect(result.note).toContain("collapsed");
			expect(result.note).toContain("search_notes");
		});

		it("reduces depth before giving up, and says so", async () => {
			mockAgent(1_000);
			// 40 folders × 40 subfolders: even folders-only at depth 2 is ~1600 entries.
			const files = [];
			for (let i = 0; i < 40; i++) {
				for (let j = 0; j < 40; j++) files.push(createFile(`Area ${i}/Project ${j}/note.md`));
			}
			const raw = String(await createListDirectoryTool(createMockApp(files)).invoke({}));

			expect(raw.length).toBeLessThanOrEqual(4_000);
			const result = JSON.parse(raw) as DirectoryListResult;
			expect(result.maxDepth).toBe(1);
			expect(result.note).toContain("depth was reduced");
			expect(result.totalFolders).toBe(1640);
			expect(result.totalFiles).toBe(1600);
		});

		it("caps the budget for huge context windows", async () => {
			mockAgent(2_000_000);
			const raw = String(
				await createListDirectoryTool(createMockApp(wideFolder(5_000))).invoke({ path: "Journal" }),
			);

			expect(raw.length).toBeLessThanOrEqual(40_000);
			expect((JSON.parse(raw) as DirectoryListResult).note).toContain("collapsed");
		});
	});

	it("always uses the shipped tool description, ignoring a persisted one", async () => {
		const tool = createListDirectoryTool(createMockApp([]));
		expect(tool.description).toBe("List the vault's folder structure.");
	});

	it("filters private files for the current provider", async () => {
		mockShouldBlockFile.mockImplementation((path: string) => path === "Secret/plan.md");
		const app = createMockApp([createFile("Secret/plan.md"), createFile("Public/plan.md")]);

		const result = await list(app);

		expect(result.skippedPrivateFiles).toBe(1);
		expect(result.totalFiles).toBe(1);
		expect(Object.keys(result.tree.folders ?? {})).toEqual(["Public"]);
	});

	const agentTreeFiles = () => [
		createFile("Agents/Memories/user-preferences.md"),
		createFile("Agents/Skills/web/SKILL.md"),
		createFile("Notes/todo.md"),
	];

	it("exposes the memory folder (and only it) from the agent tree", async () => {
		mockAgent(undefined, "Agents");
		// Memory notes are excluded from the search index, so this listing is the
		// agent's only way to discover them — the exemption is load-bearing. The memory
		// prompt lists the folder by path, so file names must come back here.
		const result = await list(createMockApp(agentTreeFiles()), { path: "Agents/Memories" });
		expect(result.tree.files).toEqual(["user-preferences.md"]);

		// The rest of the agent machinery stays hidden.
		const overview = await list(createMockApp(agentTreeFiles()), { maxDepth: 4 });
		expect(overview.tree.folders?.Agents?.folders?.Memories?.fileCount).toBe(1);
		expect(overview.tree.folders?.Agents?.folders?.Skills).toBeUndefined();
	});

	/**
	 * There is no per-agent memory flag any more: an agent that shouldn't use memory simply has
	 * no `# Memory` section pointing it at the folder. Everything else under the agent root
	 * stays hidden regardless.
	 */
	it("keeps the rest of the agent tree hidden", async () => {
		mockAgent(undefined, "Agents");
		const result = await list(
			createMockApp([createFile("Agents/Skills/web/SKILL.md"), createFile("Notes/todo.md")]),
		);

		expect(Object.keys(result.tree.folders ?? {})).toEqual(["Notes"]);
	});
});
