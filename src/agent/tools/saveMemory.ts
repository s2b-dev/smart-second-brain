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
import { type App, normalizePath } from "obsidian";
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
			"Full note content including the frontmatter block with a one-line, quoted `description` of what the note holds and when to read it.",
		),
});

/** A bare name: no separators, no traversal, nothing hidden. */
export function isSafeMemoryNoteName(name: string): boolean {
	return /^[^\\/:*?"<>|\p{Cc}]+$/u.test(name) && !name.startsWith(".") && name.trim() === name && name !== "..";
}

export function createSaveMemoryTool(app: App, memoryFolder: string) {
	const folder = normalizePath(memoryFolder);

	return tool(
		async ({ name, content }: z.infer<typeof saveMemorySchema>) => {
			const base = name.endsWith(".md") ? name.slice(0, -3) : name;
			if (!isSafeMemoryNoteName(base)) {
				return `Refused: "${name}" is not a plain note name. Give the note's name only; it is always created inside ${folder}/.`;
			}
			const path = normalizePath(`${folder}/${base}.md`);
			try {
				if (!app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
				const existing = app.vault.getFileByPath(path);
				if (existing) {
					await app.vault.modify(existing, content);
					return `Updated memory note ${path} (applied, no review needed).`;
				}
				await app.vault.create(path, content);
				return `Created memory note ${path} (applied, no review needed).`;
			} catch (error) {
				return `Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
		{
			name: "save_memory",
			description: `Create or replace one note in the memory folder (${folder}/). Applied immediately. Read the note first with read_content if it may exist, and write the merged content back — this replaces the whole note.`,
			schema: saveMemorySchema,
		},
	);
}
