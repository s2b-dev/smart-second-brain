import { tool } from "@langchain/core/tools";
import { type App, normalizePath } from "obsidian";
import { z } from "zod";
import { DEFAULT_TOOLS_CONFIG } from "./builtInToolDefaults";
import { getPendingChangesStore } from "../../stores/pendingChangesStore.svelte";
import {
	LIST_DIRECTORY_BUDGET_FRACTION,
	LIST_DIRECTORY_MAX_CHARS,
	contextWindowToCharBudget,
} from "../../utils/contentBudget";
import { isPathInFolder, normalizeFolderPrefix, normalizeVaultPath } from "../../utils/pathUtils";
import { isAgentFilePath } from "../../utils/fileFiltering";
import { memoriesDir } from "../../utils/agentPaths";
import { resolveToolAgent, resolveToolProvider } from "./toolAgentContext";

/**
 * One folder in the model-facing listing. Deliberately compact: file entries are bare names
 * (the extension is part of the name; sizes were never acted on), and every folder carries a
 * recursive `fileCount` so an unexpanded subtree still conveys its weight.
 *
 * `moreFiles` / `moreFolders` are the collapse markers — direct children that exist but are
 * not listed, either because file names were not requested (the root overview) or because the
 * listing had to shrink to fit the context budget. `folderCount` appears only on a folder at
 * the depth limit, where its subfolders are not rendered at all.
 */
export interface DirectoryListNode {
	fileCount: number;
	folderCount?: number;
	files?: string[];
	moreFiles?: number;
	folders?: Record<string, DirectoryListNode>;
	moreFolders?: number;
}

export interface DirectoryListResult {
	root: string;
	maxDepth: number;
	includeFiles: boolean;
	/** Every folder below the root, at any depth — not just the rendered ones. */
	totalFolders: number;
	/** Every visible file below the root, at any depth. */
	totalFiles: number;
	skippedPrivateFiles: number;
	tree: DirectoryListNode;
	/** Set when the listing was collapsed, telling the model how to see what was left out. */
	note?: string;
}

interface MutableNode {
	folders: Map<string, MutableNode>;
	files: string[];
	fileCount: number;
}

interface RenderOptions {
	maxDepth: number;
	includeFiles: boolean;
	fileCap: number;
	folderCap: number;
}

/** Default depth of the root overview (folders + counts) — enough to see how a vault is organised. */
const ROOT_OVERVIEW_DEPTH = 2;
/** Default depth inside a folder — its direct contents. */
const FOLDER_LISTING_DEPTH = 1;

/**
 * Successively tighter per-folder caps tried, in order, until the serialized listing fits the
 * budget. The first rung is uncapped so a listing that fits is never collapsed at all; the
 * last rung (no files, a handful of folders) is small enough at any depth to always fit.
 */
const COLLAPSE_LADDER: ReadonlyArray<readonly [fileCap: number, folderCap: number]> = [
	[Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
	[500, 500],
	[100, 200],
	[30, 100],
	[10, 50],
	[0, 20],
];

const listDirectorySchema = z.object({
	path: z
		.string()
		.optional()
		.describe(
			"Vault-relative folder to list (e.g. 'Projects/research'). Omit for an overview of the whole vault: folders with file counts, no file names.",
		),
	maxDepth: z
		.number()
		.int()
		.min(1)
		.max(8)
		.optional()
		.describe(
			`How many folder levels to descend. Default: ${ROOT_OVERVIEW_DEPTH} for the vault overview, ${FOLDER_LISTING_DEPTH} inside a folder.`,
		),
	includeFiles: z
		.boolean()
		.optional()
		.describe(
			"Whether to list file names. Default: false for the vault overview (folders and counts only), true inside a folder. Pass true with no path to also list files at the vault root.",
		),
});

type ListDirectoryInput = z.infer<typeof listDirectorySchema>;

function getListDirectoryToolConfig(agentId: string): { name: string; description: string } {
	const selectedConfig = resolveToolAgent(agentId).toolsConfig.list_directory;
	const defaultConfig = DEFAULT_TOOLS_CONFIG.list_directory;

	return {
		name: selectedConfig?.name ?? defaultConfig.name,
		// Always the shipped default. Tool descriptions aren't user-editable (ToolConfigForm
		// renders no input for them), so a stored value is only ever an older default, and
		// honouring it would keep describing the previous output shape to the model.
		description: defaultConfig.description,
	};
}

/** Character budget for one listing, derived from the model's context window but capped. */
function resolveListBudget(agentId: string): number {
	const contextWindow = resolveToolAgent(agentId).chatModel?.modelConfig?.contextWindow;
	return Math.min(contextWindowToCharBudget(contextWindow, LIST_DIRECTORY_BUDGET_FRACTION), LIST_DIRECTORY_MAX_CHARS);
}

function getRelativePath(root: string, filePath: string): string {
	if (!root) return normalizeVaultPath(filePath);
	const normalizedRoot = normalizeFolderPrefix(root);
	return normalizeVaultPath(filePath).slice(normalizedRoot.length);
}

function isDirectoryFileVisible(
	filePath: string,
	rootPath: string,
	store: ReturnType<typeof getPendingChangesStore>,
	currentProvider?: string,
	visibleMemoryFolder?: string,
): "include" | "skip" | "private" {
	if (!isPathInFolder(filePath, rootPath)) return "skip";
	// Skills live in a vault folder but are plugin machinery, not user notes — hide them.
	// Exception: the agent's memory folder. It is excluded from the search index, so this
	// listing is the agent's only discovery path for memories.
	const isMemoryFile = visibleMemoryFolder ? isPathInFolder(filePath, visibleMemoryFolder) : false;
	if (!isMemoryFile && isAgentFilePath(filePath)) return "skip";
	if (!store.isPathAllowed(filePath)) return "skip";
	if (currentProvider && store.shouldBlockFile(filePath, currentProvider)) return "private";
	return "include";
}

function newNode(): MutableNode {
	return { folders: new Map(), files: [], fileCount: 0 };
}

/**
 * The complete visible subtree under `rootPath`, at every depth. Depth limits and caps are
 * applied at render time, so recursive counts stay exact however much is shown.
 */
function scanTree(
	app: App,
	rootPath: string,
	agentId: string,
): { root: MutableNode; totalFolders: number; skippedPrivateFiles: number } {
	const store = getPendingChangesStore();
	const currentProvider = resolveToolProvider(agentId);
	// The one re-inclusion in the otherwise fully excluded agent folder: memory notes are
	// absent from the search index, so listing them here is the agent's only way to
	// discover what it remembers. Always visible — there is no per-agent memory flag;
	// an agent that shouldn't use memory simply has no `# Memory` section telling it the
	// folder exists. Resolved per call because the agent root can change mid-session.
	const visibleMemoryFolder = normalizePath(memoriesDir());

	const root = newNode();
	let totalFolders = 0;
	let skippedPrivateFiles = 0;

	for (const file of app.vault.getFiles()) {
		const visibility = isDirectoryFileVisible(file.path, rootPath, store, currentProvider, visibleMemoryFolder);
		if (visibility === "skip") continue;
		if (visibility === "private") {
			skippedPrivateFiles++;
			continue;
		}

		const segments = getRelativePath(rootPath, file.path).split("/").filter(Boolean);
		let node = root;
		node.fileCount++;
		for (const segment of segments.slice(0, -1)) {
			let child = node.folders.get(segment);
			if (!child) {
				child = newNode();
				node.folders.set(segment, child);
				totalFolders++;
			}
			child.fileCount++;
			node = child;
		}
		node.files.push(file.name);
	}

	return { root, totalFolders, skippedPrivateFiles };
}

/** Render one folder, applying the depth limit and per-folder caps; `depth` is 0 at the root. */
function renderNode(node: MutableNode, depth: number, options: RenderOptions): DirectoryListNode {
	const out: DirectoryListNode = { fileCount: node.fileCount };

	if (node.files.length > 0) {
		const shown = options.includeFiles ? Math.min(node.files.length, options.fileCap) : 0;
		if (shown > 0) {
			out.files = node.files.toSorted((a, b) => a.localeCompare(b)).slice(0, shown);
		}
		if (node.files.length > shown) out.moreFiles = node.files.length - shown;
	}

	if (node.folders.size > 0) {
		if (depth >= options.maxDepth) {
			out.folderCount = node.folders.size;
		} else {
			const names = Array.from(node.folders.keys()).toSorted((a, b) => a.localeCompare(b));
			const shown = Math.min(names.length, options.folderCap);
			if (shown > 0) {
				out.folders = {};
				for (const name of names.slice(0, shown)) {
					out.folders[name] = renderNode(node.folders.get(name) as MutableNode, depth + 1, options);
				}
			}
			if (names.length > shown) out.moreFolders = names.length - shown;
		}
	}

	return out;
}

function collapseNote(requestedPath: string, includeFiles: boolean, depthReduced: boolean): string {
	const parts: string[] = [];
	if (depthReduced) parts.push("depth was reduced");
	if (includeFiles) parts.push("some entries are omitted (see moreFiles / moreFolders)");
	const cause = parts.length > 0 ? ` — ${parts.join("; ")}` : "";
	const scope = requestedPath === "/" ? "" : ` under ${requestedPath}`;
	return `Listing collapsed to fit the context budget${cause}. Call list_directory with a subfolder path${scope} to see its contents, or use search_notes / grep_notes to find specific notes instead of walking the tree.`;
}

function hasCollapse(node: DirectoryListNode): boolean {
	if ((node.moreFiles ?? 0) > 0 || (node.moreFolders ?? 0) > 0) return true;
	return Object.values(node.folders ?? {}).some(hasCollapse);
}

/**
 * Render the listing, shrinking it structurally until it fits `budget` characters: first
 * tighter per-folder caps at the requested depth, then one level shallower, and so on. The
 * result is always a well-formed tree with explicit markers for what was left out — never a
 * listing cut off mid-JSON.
 */
function renderWithinBudget(
	scan: ReturnType<typeof scanTree>,
	base: Omit<DirectoryListResult, "tree" | "note" | "maxDepth">,
	requestedDepth: number,
	budget: number,
): string {
	let last = "";
	for (let maxDepth = requestedDepth; maxDepth >= 1; maxDepth--) {
		for (const [fileCap, folderCap] of COLLAPSE_LADDER) {
			const tree = renderNode(scan.root, 0, { maxDepth, includeFiles: base.includeFiles, fileCap, folderCap });
			const result: DirectoryListResult = { ...base, maxDepth, tree };
			const depthReduced = maxDepth < requestedDepth;
			// Only the root overview legitimately omits files without being "collapsed"; any
			// marker in a file-listing run, or a reduced depth, means something was cut.
			if (depthReduced || (base.includeFiles && hasCollapse(tree))) {
				result.note = collapseNote(base.root, base.includeFiles, depthReduced);
			}
			last = JSON.stringify(result);
			if (last.length <= budget) return last;
		}
	}
	return last;
}

export function createListDirectoryTool(app: App, agentId = "") {
	const toolConfig = getListDirectoryToolConfig(agentId);

	return tool(
		async ({ path, maxDepth, includeFiles }: ListDirectoryInput) => {
			const rootPath = normalizeVaultPath(path ?? "");
			const requestedPath = rootPath || "/";
			const rootEntity = rootPath ? app.vault.getAbstractFileByPath(rootPath) : null;

			if (rootEntity && "extension" in rootEntity) {
				return `Error: "${requestedPath}" is a file, not a folder. Use read_content for file contents.`;
			}

			// Check if the requested path exists as a folder in the vault.
			// In Obsidian, folders may not have explicit entities, so also check
			// if any file has this as a path prefix.
			if (rootPath && !rootEntity) {
				const folderPrefix = normalizeFolderPrefix(rootPath);
				const hasChildren = app.vault.getFiles().some((f) => f.path.startsWith(folderPrefix));
				if (!hasChildren) {
					return `Error: The folder "${requestedPath}" does not exist in the vault.`;
				}
			}

			// The root call is an orientation call: folders and counts tell the model how the
			// vault is organised at a few hundred tokens regardless of size, whereas file names
			// at the root would scale with the vault. Inside a folder, files are the point.
			const isRoot = rootPath === "";
			const effectiveIncludeFiles = includeFiles ?? !isRoot;
			const effectiveDepth = maxDepth ?? (isRoot ? ROOT_OVERVIEW_DEPTH : FOLDER_LISTING_DEPTH);

			const scan = scanTree(app, rootPath, agentId);
			return renderWithinBudget(
				scan,
				{
					root: requestedPath,
					includeFiles: effectiveIncludeFiles,
					totalFolders: scan.totalFolders,
					totalFiles: scan.root.fileCount,
					skippedPrivateFiles: scan.skippedPrivateFiles,
				},
				effectiveDepth,
				resolveListBudget(agentId),
			);
		},
		{
			name: toolConfig.name,
			description: toolConfig.description,
			schema: listDirectorySchema,
		},
	);
}
