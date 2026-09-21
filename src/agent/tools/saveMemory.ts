/**
 * `save_memory`: write one note inside the memory folder, applied at once.
 *
 * The post-turn reviewer's only write path for memory. It deliberately does not reuse
 * `manage_notes`: that tool auto-applies inside the memory folder but stages everything
 * else for review, so a reviewer holding it could leave the user a surprise proposal for a
 * vault note. This tool cannot address anything outside the memory folder at all — the path
 * is a bare note name resolved under the folder, and anything that tries to escape it is
 * refused — which is the same guarantee the chat agent gets from `manage_notes`'s
 * auto-apply scope, expressed as a capability rather than a policy.
 */

import { tool } from "@langchain/core/tools";
import { type App, type TFile, normalizePath } from "obsidian";
import { z } from "zod";

const saveMemorySchema = z.object({
	name: z
		.string()
		.min(1)
		.describe(
			"Note name inside the memory folder, without a folder and with or without .md, e.g. 'User' or 'Projects.md'. Creates the note or replaces its whole content.",
		),
	content: z
		.string()
		.describe(
			"What to write. In append mode (the default for an existing note): the new facts only, as markdown; they are added at the end. In replace mode, or for a new note: the full note including the frontmatter block with a one-line, quoted `description` of what the note holds and when to read it.",
		),
	mode: z
		.enum(["append", "replace"])
		.optional()
		.describe(
			"How to write into a note that already exists. `append` (default) adds the content at the end and can never lose another writer's addition. `replace` rewrites the whole note — use it only for a note you read in this review, e.g. to reorganize it or update its description.",
		),
});

/** A bare name: no separators, no traversal, nothing hidden. */
export function isSafeMemoryNoteName(name: string): boolean {
	return /^[^\\/:*?"<>|\p{Cc}]+$/u.test(name) && !name.startsWith(".") && name.trim() === name && name !== "..";
}

/**
 * One write at a time per note path, across every reviewer. Two threads' reviews can finish
 * together and both merge into `User.md`; without this the second check-then-write clobbers
 * the first's merged content, or a duplicate create throws.
 */
const writeChains = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
	const previous = writeChains.get(key) ?? Promise.resolve();
	const next = previous.then(work, work);
	writeChains.set(
		key,
		next.catch(() => undefined),
	);
	return next;
}

export function createSaveMemoryTool(app: App, memoryFolder: string) {
	const folder = normalizePath(memoryFolder);

	return tool(
		async ({ name, content, mode }: z.infer<typeof saveMemorySchema>) => {
			const base = name.endsWith(".md") ? name.slice(0, -3) : name;
			if (!isSafeMemoryNoteName(base)) {
				return `Refused: "${name}" is not a plain note name. Give the note's name only; it is always created inside ${folder}/.`;
			}
			const path = normalizePath(`${folder}/${base}.md`);
			// A failure is thrown, not returned as text: the tool runner turns it into an
			// error-status result, which is what keeps a failed save out of the "learned"
			// notice (the model's own summary cannot be trusted for that).
			return serialized(path, async () => {
				if (!app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
				const existing = app.vault.getFileByPath(path);
				if (existing) return writeExisting(existing);
				try {
					await app.vault.create(path, content);
				} catch (error) {
					// Lost a race with a writer outside this serialization (a hand edit, sync):
					// the note exists now, so write into it rather than fail.
					const created = app.vault.getFileByPath(path);
					if (!created) throw error;
					return writeExisting(created);
				}
				return `Created memory note ${path} (applied, no review needed).`;
			});

			// Append is the default and the safe one: it is computed against the text on disk
			// at write time, so two reviews that both read the old note and finish together
			// both land — a replace computed from a stale read would drop whichever addition
			// came first.
			async function writeExisting(file: TFile): Promise<string> {
				if (mode === "replace") {
					await app.vault.modify(file, content);
					return `Updated memory note ${path} (applied, no review needed).`;
				}
				// `vault.process` reads and writes under Obsidian's own file lock, so the
				// append is derived from the latest on-disk text even against a writer this
				// module's serialization cannot see (sync, another plugin, a hand edit).
				await app.vault.process(file, (current) => `${current.trimEnd()}\n\n${content.trim()}\n`);
				return `Appended to memory note ${path} (applied, no review needed).`;
			}
		},
		{
			name: "save_memory",
			description: `Write one note in the memory folder (${folder}/), applied immediately. A new note is created from the content; an existing note gets the content appended by default, or replaced whole with mode "replace". Read a note with read_content before replacing it.`,
			schema: saveMemorySchema,
		},
	);
}
