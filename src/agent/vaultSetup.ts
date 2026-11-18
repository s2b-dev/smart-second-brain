/**
 * The vault's note setup: the Obsidian settings that decide where a new note goes and what it
 * is called, substituted for the `{{vaultSetup}}` placeholder of an agent's `# Vault` section.
 *
 * The folder/tag/property overview (`vaultOverview.ts`) is inferred from the notes; these are
 * settings, so they are read rather than guessed: the Daily notes core plugin's folder, file
 * name format and template, the Templates core plugin's folder, where Obsidian puts new notes,
 * and whether links are written as wikilinks or Markdown links. Read live on every assembly, so
 * a changed setting is picked up on the next turn.
 *
 * The core plugins' options are an internal API (`app.internalPlugins`), read defensively: a
 * shape this code does not recognise leaves its line out rather than failing assembly.
 *
 * Folder and file names are content, so {@link redactVaultSetup} applies the same per-provider
 * privacy rules the folder overview does before anything is rendered.
 */

import type { App } from "obsidian";

/** Obsidian's default daily-note file name format. */
const DEFAULT_DAILY_FORMAT = "YYYY-MM-DD";

/** The settings the placeholder reports. Undefined plugin blocks mean the core plugin is off. */
export interface VaultSetupData {
	dailyNotes?: {
		/** Folder, vault-relative; empty for the vault root. */
		folder: string;
		/** Moment.js file name format. */
		format: string;
		/** Template note path, if one is set. */
		template?: string;
		/** Today's daily note path, when a date formatter was available. */
		todayPath?: string;
		/** The folder is private for the current model; `folder` is not shown. */
		folderPrivate?: boolean;
	};
	templates?: {
		/** Folder, vault-relative; empty when unset. */
		folder: string;
		/** The folder is private for the current model; `folder` is not shown. */
		folderPrivate?: boolean;
	};
	/** Obsidian's "Default location for new notes". */
	newNoteLocation: "root" | "current" | "folder";
	/** Folder for new notes when {@link newNoteLocation} is `"folder"`. */
	newNoteFolder: string;
	/** The new-notes folder is private for the current model; `newNoteFolder` is not shown. */
	newNoteFolderPrivate?: boolean;
	/** Whether Obsidian writes Markdown links instead of wikilinks. */
	useMarkdownLinks: boolean;
}

interface InternalPluginLike {
	enabled?: boolean;
	instance?: { options?: Record<string, unknown> };
}

/** A core plugin's options when it is enabled, else undefined. */
function corePluginOptions(app: App, pluginId: string): Record<string, unknown> | undefined {
	const internal = (
		app as unknown as {
			internalPlugins?: {
				getPluginById?: (id: string) => InternalPluginLike | null | undefined;
				plugins?: Record<string, InternalPluginLike | undefined>;
			};
		}
	).internalPlugins;
	const plugin = internal?.getPluginById?.(pluginId) ?? internal?.plugins?.[pluginId];
	if (!plugin?.enabled) return undefined;
	return plugin.instance?.options ?? {};
}

function stringOption(options: Record<string, unknown>, key: string): string {
	const value = options[key];
	return typeof value === "string" ? value.trim() : "";
}

/** Strip leading and trailing slashes so every folder renders the same way. */
function cleanFolder(folder: string): string {
	return folder.replace(/^\/+|\/+$/g, "");
}

function vaultConfig(app: App, key: string): unknown {
	return (app.vault as unknown as { getConfig?: (key: string) => unknown }).getConfig?.(key);
}

/**
 * Read the setup from the app. `formatToday` turns a Moment.js format into today's file name;
 * Obsidian provides Moment as `window.moment`, and without it the "today" line is left out.
 */
export function collectVaultSetup(app: App, formatToday?: (format: string) => string): VaultSetupData {
	const data: VaultSetupData = {
		newNoteLocation: "root",
		newNoteFolder: "",
		useMarkdownLinks: vaultConfig(app, "useMarkdownLinks") === true,
	};

	const location = vaultConfig(app, "newFileLocation");
	if (location === "current" || location === "folder") data.newNoteLocation = location;
	const newFolder = vaultConfig(app, "newFileFolderPath");
	if (typeof newFolder === "string") data.newNoteFolder = cleanFolder(newFolder);

	const daily = corePluginOptions(app, "daily-notes");
	if (daily) {
		const folder = cleanFolder(stringOption(daily, "folder"));
		const format = stringOption(daily, "format") || DEFAULT_DAILY_FORMAT;
		const template = stringOption(daily, "template");
		let todayPath: string | undefined;
		if (formatToday) {
			try {
				const name = formatToday(format);
				if (name) todayPath = `${folder ? `${folder}/` : ""}${name}.md`;
			} catch {
				// a format Moment rejects leaves the line out
			}
		}
		data.dailyNotes = { folder, format, template: template || undefined, todayPath };
	}

	const templates = corePluginOptions(app, "templates");
	if (templates) data.templates = { folder: cleanFolder(stringOption(templates, "folder")) };

	return data;
}

/** What the current model may see, for {@link redactVaultSetup}. */
export interface VaultSetupPrivacy {
	/** Whether a folder's name may be shown (the vault root always may). */
	isFolderVisible(folder: string): boolean;
	/** Whether a file is private for the current model. */
	isPrivate(path: string): boolean;
}

/**
 * Hide every configured folder and file the current model may not see. A hidden folder is
 * reported as private rather than dropped, so the model still knows the setting exists and
 * doesn't invent a location; a hidden file (template, today's note) is left out.
 */
export function redactVaultSetup(data: VaultSetupData, privacy: VaultSetupPrivacy): VaultSetupData {
	const folderHidden = (folder: string) => folder !== "" && !privacy.isFolderVisible(folder);
	const fileVisible = (path: string | undefined, folderPrivate: boolean) =>
		// Obsidian stores the template path without its extension, while privacy rules match files.
		path && !folderPrivate && !privacy.isPrivate(path) && !privacy.isPrivate(`${path}.md`) ? path : undefined;
	const out: VaultSetupData = { ...data };

	if (data.dailyNotes) {
		const folderPrivate = folderHidden(data.dailyNotes.folder);
		const templateFolder = data.dailyNotes.template?.includes("/")
			? data.dailyNotes.template.slice(0, data.dailyNotes.template.lastIndexOf("/"))
			: "";
		out.dailyNotes = {
			folder: folderPrivate ? "" : data.dailyNotes.folder,
			format: data.dailyNotes.format,
			template: fileVisible(data.dailyNotes.template, folderHidden(templateFolder)),
			todayPath: fileVisible(data.dailyNotes.todayPath, folderPrivate),
			folderPrivate: folderPrivate || undefined,
		};
	}
	if (data.templates) {
		const folderPrivate = folderHidden(data.templates.folder);
		out.templates = {
			folder: folderPrivate ? "" : data.templates.folder,
			folderPrivate: folderPrivate || undefined,
		};
	}
	if (folderHidden(data.newNoteFolder)) {
		out.newNoteFolder = "";
		out.newNoteFolderPrivate = true;
	}
	return out;
}

/** Today's file name formatter from Obsidian's global Moment, when present. */
export function windowMomentFormatter(): ((format: string) => string) | undefined {
	const moment = (globalThis as { moment?: () => { format(format: string): string } }).moment;
	return typeof moment === "function" ? (format) => moment().format(format) : undefined;
}

const PRIVATE_FOLDER = "a folder that is private for this model";

const folderLabel = (folder: string, folderPrivate?: boolean) =>
	folderPrivate ? PRIVATE_FOLDER : folder ? `\`${folder}/\`` : "the vault root";

/** Render the placeholder value: one line per setting. */
export function renderVaultSetup(data: VaultSetupData): string {
	const lines: string[] = [];

	if (data.dailyNotes) {
		const { folder, format, template, todayPath, folderPrivate } = data.dailyNotes;
		let line = `- Daily notes: in ${folderLabel(folder, folderPrivate)}, named by the date format \`${format}\``;
		if (todayPath) line += ` (today's is \`${todayPath}\`)`;
		if (template) line += `, created from the template \`${template}\``;
		lines.push(`${line}.`);
	} else {
		lines.push("- Daily notes: the Daily notes core plugin is off.");
	}

	if (data.templates) {
		lines.push(
			data.templates.folder || data.templates.folderPrivate
				? `- Templates: in ${folderLabel(data.templates.folder, data.templates.folderPrivate)}. These are templates, not notes; don't file new notes there.`
				: "- Templates: the core plugin is on, but no template folder is set.",
		);
	}

	const newNotes =
		data.newNoteLocation === "folder"
			? `in ${folderLabel(data.newNoteFolder, data.newNoteFolderPrivate)}`
			: data.newNoteLocation === "current"
				? "next to the note the user is working in"
				: "at the vault root";
	lines.push(
		`- New notes: Obsidian puts notes created without a better place ${newNotes}. When a note clearly belongs in a folder above, put it there instead.`,
	);

	lines.push(
		data.useMarkdownLinks
			? "- Links: this vault writes Markdown links (`[text](path.md)`), not wikilinks; use them inside notes you write."
			: "- Links: this vault writes wikilinks (`[[Note]]`).",
	);

	return lines.join("\n");
}
