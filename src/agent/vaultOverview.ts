/**
 * The vault overview: what the model knows about the shape of the vault without calling a tool.
 *
 * Filing, naming and tagging a new note well means knowing which folders, tags and properties
 * already exist. Before this the model learned that only by calling `list_directory`,
 * `get_all_tags` and `get_properties` — and only if it thought to. The overview puts the three
 * lists in front of it on every turn, substituted for the `{{vaultFolders}}`, `{{vaultTags}}`
 * and `{{vaultProperties}}` placeholders of an agent's `# Vault` section.
 *
 * Everything is read from Obsidian's metadata cache, so it is always current and costs no disk
 * reads. Two rules keep it cheap to carry:
 *
 *  - The lists are capped. Cutting here loses nothing: the tools return the full set on demand,
 *    and each capped list says how much it left out.
 *  - No counts are rendered. A note count changes with every new note, which would change the
 *    system prompt — and so miss the provider's prompt cache — on almost every turn. Ordering by
 *    use carries the same signal and only moves when two entries swap rank.
 *
 * Folder, tag and property names are content: one that exists only in private notes names
 * something about them. The collector therefore takes the same per-provider privacy filter the
 * read tools apply (see `getAllTags.ts`), and a folder is listed only when it holds at least one
 * file the model may see.
 */

import { type App, getAllTags } from "obsidian";

/** Most folders listed. Shallow folders win, so the top of the tree is always complete. */
export const VAULT_FOLDERS_MAX = 200;

/** Most tags listed, by use. */
export const VAULT_TAGS_MAX = 100;

/** Most property keys listed, by use. */
export const VAULT_PROPERTIES_MAX = 60;

const NO_TAGS = "No tags in use yet.";
const NO_PROPERTIES = "No properties in use yet.";

/** Which files the overview may draw on. */
export interface VaultOverviewFilter {
	/** Plugin machinery and other paths that are never part of the user's vault view. */
	isExcluded(path: string): boolean;
	/** Notes the current provider may not see. */
	isPrivate(path: string): boolean;
}

/** The raw facts, before capping and rendering. */
export interface VaultOverviewData {
	/** Every folder holding at least one visible file, vault-relative, without a trailing slash. */
	folders: string[];
	/** Tag (with its `#`) → number of visible notes using it. */
	tagCounts: Map<string, number>;
	/** Frontmatter key → number of visible notes carrying it. */
	propertyCounts: Map<string, number>;
	/** How many files the privacy filter held back. */
	skippedPrivateFiles: number;
	/** How many files the model may see. */
	visibleFiles: number;
	/** Visible notes Obsidian has not indexed yet (no metadata cache entry), so their tags and properties are missing. */
	unindexedNotes?: number;
}

/** The three rendered placeholder values. */
export interface VaultOverviewText {
	folders: string;
	tags: string;
	properties: string;
}

function bump(counts: Map<string, number>, key: string): void {
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Read the overview facts from the vault and the metadata cache. */
export function collectVaultOverview(app: App, filter: VaultOverviewFilter): VaultOverviewData {
	const folders = new Set<string>();
	const tagCounts = new Map<string, number>();
	const propertyCounts = new Map<string, number>();
	let skippedPrivateFiles = 0;
	let unindexedNotes = 0;
	let visibleFiles = 0;
	let lastFolder: string | null = null;

	for (const file of app.vault.getFiles()) {
		if (filter.isExcluded(file.path)) continue;
		if (filter.isPrivate(file.path)) {
			skippedPrivateFiles++;
			continue;
		}
		visibleFiles++;

		const slash = file.path.lastIndexOf("/");
		const folder = slash === -1 ? "" : file.path.slice(0, slash);
		// Files arrive grouped by folder often enough that skipping a repeat saves most of the work.
		if (folder !== lastFolder) {
			lastFolder = folder;
			let end = folder.length;
			while (end > 0) {
				const ancestor = folder.slice(0, end);
				if (folders.has(ancestor)) break;
				folders.add(ancestor);
				end = ancestor.lastIndexOf("/");
			}
		}

		if (file.extension !== "md") continue;
		const cache = app.metadataCache.getFileCache(file);
		if (!cache) {
			// Right after startup — on mobile for a long while in a large vault — Obsidian is still
			// indexing, and an unindexed note reports no tags or properties at all.
			unindexedNotes++;
			continue;
		}
		for (const tag of new Set(getAllTags(cache) ?? [])) bump(tagCounts, tag);
		if (cache.frontmatter) {
			for (const key of Object.keys(cache.frontmatter)) {
				if (key !== "position") bump(propertyCounts, key);
			}
		}
	}

	return { folders: [...folders], tagCounts, propertyCounts, skippedPrivateFiles, unindexedNotes, visibleFiles };
}

/** Compare two folder paths segment by segment, so a folder always sorts directly before its children. */
function compareFolderPaths(a: string[], b: string[]): number {
	const shared = Math.min(a.length, b.length);
	for (let i = 0; i < shared; i++) {
		const order = a[i].localeCompare(b[i]);
		if (order !== 0) return order;
	}
	return a.length - b.length;
}

/**
 * Render the folder tree: one folder per line, indented by depth. When the vault has more
 * folders than `max`, the shallowest are kept — every listed folder's parents are listed too —
 * and a closing line says how many deeper ones were left out.
 */
export function renderVaultFolders(folders: readonly string[], max = VAULT_FOLDERS_MAX): string {
	if (folders.length === 0) return "No folders yet; every note is at the vault root.";
	const split = folders.map((path) => path.split("/"));
	const kept = [...split].sort((a, b) => a.length - b.length || compareFolderPaths(a, b)).slice(0, max);
	const lines = kept
		.sort(compareFolderPaths)
		.map((segments) => `${"  ".repeat(segments.length - 1)}${segments[segments.length - 1]}/`);
	const hidden = folders.length - kept.length;
	if (hidden > 0) lines.push(`(${hidden} deeper folders not shown; list a folder to see inside it)`);
	return `<vault_folders>\n${lines.join("\n")}\n</vault_folders>`;
}

/** The `max` most used keys, most used first; ties in name order so the output is stable. */
function mostUsed(counts: ReadonlyMap<string, number>, max: number): string[] {
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, max)
		.map(([key]) => key);
}

function renderMostUsed(
	counts: ReadonlyMap<string, number>,
	max: number,
	element: string,
	noun: string,
	empty: string,
): string {
	if (counts.size === 0) return empty;
	const listed = mostUsed(counts, max);
	const hidden = counts.size - listed.length;
	const more = hidden > 0 ? `\n(${hidden} less used ${noun} not shown)` : "";
	return `<${element}>\n${listed.join(", ")}${more}\n</${element}>`;
}

/** Render the tag list, most used first. */
export function renderVaultTags(tagCounts: ReadonlyMap<string, number>, max = VAULT_TAGS_MAX): string {
	return renderMostUsed(tagCounts, max, "vault_tags", "tags", NO_TAGS);
}

/** Render the property-key list, most used first. */
export function renderVaultProperties(propertyCounts: ReadonlyMap<string, number>, max = VAULT_PROPERTIES_MAX): string {
	return renderMostUsed(propertyCounts, max, "vault_properties", "properties", NO_PROPERTIES);
}

/**
 * Render all three placeholder values. A privacy skip is said once, on the folder list — left
 * silent, the model would read a short overview as the whole vault and reason from it.
 */
export function renderVaultOverview(data: VaultOverviewData): VaultOverviewText {
	// Private-by-default with nothing shared, and a provider that isn't trusted: every list is
	// empty, and "No folders yet" or "No tags in use yet" would be false. Say what is true.
	if (data.skippedPrivateFiles > 0 && data.visibleFiles === 0) {
		const allPrivate =
			"None listed: every note in the vault is private for the current model, so nothing from it is shown here and your tools cannot read it either.";
		return { folders: allPrivate, tags: allPrivate, properties: allPrivate };
	}
	const privacyNote =
		data.skippedPrivateFiles > 0
			? "\n(Notes that are private for the current model are left out of this overview.)"
			: "";
	// Said on both lists it affects, so "no tags" is never read as a fact while indexing runs.
	const unindexed = data.unindexedNotes ?? 0;
	const indexingNote =
		unindexed > 0
			? `(Obsidian is still indexing ${unindexed} notes, so this list may be incomplete; get_all_tags and get_properties return the current set.)`
			: "";
	const withIndexingNote = (text: string, emptyText: string) =>
		!indexingNote ? text : text === emptyText ? indexingNote : `${text}\n${indexingNote}`;
	return {
		folders: `${renderVaultFolders(data.folders)}${privacyNote}`,
		tags: withIndexingNote(renderVaultTags(data.tagCounts), NO_TAGS),
		properties: withIndexingNote(renderVaultProperties(data.propertyCounts), NO_PROPERTIES),
	};
}
