/**
 * The memory index: what the model sees of its memory folder without opening a note.
 *
 * Memory notes are excluded from search and the embedding index (they are plugin machinery,
 * see `utils/fileFiltering`), so before this the model's only way to learn what it remembered
 * was `list_directory` — names and sizes, no hint of relevance, and only if it thought to
 * look. The index turns recall from a decision into something in front of the model on every
 * turn: one line per note carrying the note's own `description` frontmatter, plus the few
 * notes marked `always: true` in full. Everything is read from Obsidian's metadata cache, so
 * assembling it costs no disk reads on either platform; only always-loaded bodies are read,
 * through the vault's own cache.
 *
 * Two properties are all the plugin knows about. There is no magic filename: `User.md` is
 * seeded as a default note carrying `always: true`, and renaming or deleting it breaks
 * nothing. Budgets are constants rather than settings — they bound the prompt, not the
 * folder, and the model is told to read a listed note when it needs the rest.
 */

import { type App, type CachedMetadata, TFile, TFolder, normalizePath } from "obsidian";
import { Logger as Log } from "../utils/logging";

/** Upper bound on the rendered list of index lines, in characters. */
export const MEMORY_INDEX_BUDGET = 4000;

/** Upper bound on always-loaded note bodies combined, in characters. */
export const MEMORY_ALWAYS_BUDGET = 3000;

/** Upper bound on one index line, in characters; longer descriptions are cut with an ellipsis. */
export const MEMORY_INDEX_LINE_MAX = 160;

/** Frontmatter key holding a note's one-line summary for the index. */
export const MEMORY_DESCRIPTION_KEY = "description";

/** Frontmatter key that, when `true`, loads the note in full into every conversation. */
export const MEMORY_ALWAYS_KEY = "always";

/** Filename of the seeded profile note (a default, not a rule — see module doc). */
export const USER_MEMORY_NOTE_FILENAME = "User.md";

/** Contents of the seeded profile note. */
export const DEFAULT_USER_MEMORY_NOTE = `---
description: "Who the user is — name, role, preferences, and how they like answers. Loaded into every conversation."
always: true
---
# User
Nothing recorded yet. Add facts here as you learn them: identity, role, preferences, how they like answers.
`;

/** One memory note as the collector sees it. */
export interface MemoryIndexEntry {
	/** Vault path of the note. */
	path: string;
	/** `description` frontmatter, else the first heading, else null (the renderer falls back to the filename). */
	summary: string | null;
	/** Whether the note carries `always: true`. */
	always: boolean;
	/** Frontmatter-stripped body; present only for always-loaded notes that could be read. */
	body?: string;
}

const EMPTY_INDEX = "No memory notes yet.";

/** Collapse a summary onto one line and cut it so the whole index line fits the budget. */
function indexLine(entry: MemoryIndexEntry): string {
	const prefix = `- \`${entry.path}\` — `;
	const suffix = entry.always ? " (always loaded)" : "";
	const fallback = entry.path.split("/").pop()?.replace(/\.md$/i, "") ?? entry.path;
	const summary = (entry.summary ?? fallback).replace(/\s+/g, " ").trim() || fallback;
	const room = Math.max(MEMORY_INDEX_LINE_MAX - prefix.length - suffix.length, 20);
	const cut = summary.length > room ? `${summary.slice(0, room - 1).trimEnd()}…` : summary;
	return `${prefix}${cut}${suffix}`;
}

/**
 * Render the index text substituted for `{{memoryIndex}}`: always-loaded notes in full under
 * `## Always loaded`, then one line per note under `## Memory notes`. Pure, so the format is
 * unit-testable without a vault. Entries are sorted by path so the prompt prefix stays stable
 * between assemblies (provider prompt caches key on it).
 */
export function renderMemoryIndex(entries: readonly MemoryIndexEntry[]): string {
	if (entries.length === 0) return EMPTY_INDEX;
	const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
	const parts: string[] = [];

	const alwaysLoaded = sorted.filter((entry) => entry.always && entry.body !== undefined);
	if (alwaysLoaded.length > 0) {
		let remaining = MEMORY_ALWAYS_BUDGET;
		const blocks: string[] = [];
		for (const entry of alwaysLoaded) {
			const body = (entry.body ?? "").trim();
			if (body.length <= remaining) {
				blocks.push(`### ${entry.path}\n${body}`);
				remaining -= body.length;
			} else {
				// Cut rather than drop: the opening of a profile note is the part worth having,
				// and the marker tells the model the rest exists. An exhausted budget still
				// gets the heading so the note is visibly always-loaded, just not here.
				const head = body.slice(0, remaining).trimEnd();
				blocks.push(
					head
						? `### ${entry.path}\n${head}\n(truncated — read_content for the rest)`
						: `### ${entry.path}\n(not loaded — always-loaded budget exhausted; read_content to see it)`,
				);
				remaining = 0;
			}
		}
		parts.push(`## Always loaded\n${blocks.join("\n\n")}`);
	}

	const lines: string[] = [];
	let used = 0;
	for (const entry of sorted) {
		const line = indexLine(entry);
		if (used + line.length + 1 > MEMORY_INDEX_BUDGET) break;
		lines.push(line);
		used += line.length + 1;
	}
	const hidden = sorted.length - lines.length;
	if (hidden > 0) lines.push(`(${hidden} more not shown — list_directory on the memory folder shows all)`);
	parts.push(`## Memory notes\n${lines.join("\n")}`);

	return parts.join("\n\n");
}

/** Every markdown note under a folder, recursively. */
function markdownFilesUnder(folder: TFolder): TFile[] {
	const files: TFile[] = [];
	const walk = (dir: TFolder) => {
		for (const child of dir.children) {
			if (child instanceof TFolder) walk(child);
			else if (child instanceof TFile && child.extension === "md") files.push(child);
		}
	};
	walk(folder);
	return files;
}

/** The body after the frontmatter block, using the cache's parsed position (no YAML parsing here). */
function stripFrontmatter(raw: string, cache: CachedMetadata | null): string {
	const end = cache?.frontmatterPosition?.end.offset;
	return end === undefined ? raw : raw.slice(end);
}

/**
 * Read every memory note's index entry from the metadata cache. Never throws: a note whose
 * always-loaded body cannot be read still gets its index line, so one bad note never costs
 * the model the whole list.
 */
export async function collectMemoryIndex(app: App, memoryFolder: string): Promise<MemoryIndexEntry[]> {
	const folder = app.vault.getFolderByPath(normalizePath(memoryFolder));
	if (!folder) return [];

	const entries: MemoryIndexEntry[] = [];
	for (const file of markdownFilesUnder(folder)) {
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		const description = frontmatter?.[MEMORY_DESCRIPTION_KEY];
		const heading = cache?.headings?.[0]?.heading;
		const always = frontmatter?.[MEMORY_ALWAYS_KEY] === true;

		let body: string | undefined;
		if (always) {
			try {
				body = stripFrontmatter(await app.vault.cachedRead(file), cache);
			} catch (error) {
				Log.warn(`[memory] Could not read always-loaded note ${file.path}:`, error);
			}
		}

		entries.push({
			path: file.path,
			summary: typeof description === "string" ? description : (heading ?? null),
			always,
			body,
		});
	}
	return entries;
}

/**
 * Create the memory folder with the default profile note when nothing has been written there
 * yet — missing or empty folder only. A vault whose user deleted the profile note but kept
 * other memories is left alone; the note is a default, not a requirement.
 */
export async function seedMemoryFolder(app: App, memoryFolder: string): Promise<void> {
	const path = normalizePath(memoryFolder);
	try {
		const existing = app.vault.getFolderByPath(path);
		if (existing && existing.children.length > 0) return;
		if (!existing) await app.vault.createFolder(path);
		const notePath = `${path}/${USER_MEMORY_NOTE_FILENAME}`;
		if (!app.vault.getFileByPath(notePath)) await app.vault.create(notePath, DEFAULT_USER_MEMORY_NOTE);
	} catch (error) {
		// Best effort: the folder is created on first memory write anyway, and the index
		// simply reads as empty until then.
		Log.warn("[memory] Could not seed the memory folder:", error);
	}
}
