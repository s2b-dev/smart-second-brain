/**
 * The new-note settings placeholder reports Obsidian settings to the model. These pin the reading of
 * the (internal) core-plugin options, including the shapes Obsidian leaves when a setting was
 * never touched, and the rendering of each line.
 */

import { describe, expect, it } from "vitest";
import { App } from "obsidian";

import {
	type NewNoteSettingsData,
	collectNewNoteSettings,
	redactNewNoteSettings,
	renderNewNoteSettings,
} from "../../src/agent/newNoteSettings";

function fakeApp(
	config: Record<string, unknown>,
	plugins: Record<string, { enabled: boolean; options?: Record<string, unknown> }>,
): App {
	const app = new App() as App & { internalPlugins: unknown };
	(app.vault as unknown as { getConfig: (key: string) => unknown }).getConfig = (key) => config[key];
	app.internalPlugins = {
		getPluginById: (id: string) => {
			const plugin = plugins[id];
			return plugin ? { enabled: plugin.enabled, instance: { options: plugin.options } } : null;
		},
	};
	return app;
}

describe("collectNewNoteSettings", () => {
	it("reads the daily-notes and templates options and the new-note settings", () => {
		const app = fakeApp(
			{ newFileLocation: "folder", newFileFolderPath: "/Inbox/", useMarkdownLinks: true },
			{
				"daily-notes": {
					enabled: true,
					options: { folder: "Journal/Daily/", format: "DD.MM.YYYY", template: "Templates/Day" },
				},
				templates: { enabled: true, options: { folder: "Templates" } },
			},
		);
		const data = collectNewNoteSettings(app, (format) => (format === "DD.MM.YYYY" ? "18.11.2026" : "?"));
		expect(data).toEqual({
			dailyNotes: {
				folder: "Journal/Daily",
				format: "DD.MM.YYYY",
				template: "Templates/Day",
				todayPath: "Journal/Daily/18.11.2026.md",
			},
			templates: { folder: "Templates" },
			newNoteLocation: "folder",
			newNoteFolder: "Inbox",
			useMarkdownLinks: true,
		});
	});

	// Obsidian stores no options until the user changes one: the defaults are the vault root and YYYY-MM-DD.
	it("falls back to Obsidian's defaults for an untouched daily-notes plugin", () => {
		const app = fakeApp({}, { "daily-notes": { enabled: true } });
		const data = collectNewNoteSettings(app, () => "2026-11-18");
		expect(data.dailyNotes).toEqual({
			folder: "",
			format: "YYYY-MM-DD",
			template: undefined,
			todayPath: "2026-11-18.md",
		});
		expect(data.newNoteLocation).toBe("root");
		expect(data.useMarkdownLinks).toBe(false);
	});

	it("reports nothing for disabled core plugins", () => {
		const app = fakeApp({}, { "daily-notes": { enabled: false }, templates: { enabled: false } });
		const data = collectNewNoteSettings(app);
		expect(data.dailyNotes).toBeUndefined();
		expect(data.templates).toBeUndefined();
	});

	it("leaves out today's path when there is no formatter or it throws", () => {
		const app = fakeApp({}, { "daily-notes": { enabled: true } });
		expect(collectNewNoteSettings(app).dailyNotes?.todayPath).toBeUndefined();
		expect(
			collectNewNoteSettings(app, () => {
				throw new Error("bad format");
			}).dailyNotes?.todayPath,
		).toBeUndefined();
	});
});

describe("renderNewNoteSettings", () => {
	const base: NewNoteSettingsData = { newNoteLocation: "root", newNoteFolder: "", useMarkdownLinks: false };

	it("renders daily notes with today's path and template, and the templates folder", () => {
		const out = renderNewNoteSettings({
			...base,
			dailyNotes: {
				folder: "Daily",
				format: "YYYY-MM-DD",
				template: "Templates/Day.md",
				todayPath: "Daily/2026-11-18.md",
			},
			templates: { folder: "Templates" },
		});
		expect(out).toContain(
			"- Daily notes: in `Daily/`, named by the date format `YYYY-MM-DD` (today's is `Daily/2026-11-18.md`), created from the template `Templates/Day.md`.",
		);
		expect(out).toContain("- Templates: in `Templates/`.");
		expect(out).toContain("at the vault root");
		expect(out).toContain("wikilinks (`[[Note]]`)");
	});

	it("says when daily notes are off and names a Markdown-link vault", () => {
		const out = renderNewNoteSettings({
			...base,
			newNoteLocation: "folder",
			newNoteFolder: "Inbox",
			useMarkdownLinks: true,
		});
		expect(out).toContain("Daily notes core plugin is off");
		expect(out).not.toContain("Templates:");
		expect(out).toContain("in `Inbox/`");
		expect(out).toContain("Markdown links");
	});
});

describe("redactNewNoteSettings", () => {
	const data: NewNoteSettingsData = {
		dailyNotes: {
			folder: "Journal",
			format: "YYYY-MM-DD",
			template: "Private/Day",
			todayPath: "Journal/2026-11-18.md",
		},
		templates: { folder: "Private" },
		newNoteLocation: "folder",
		newNoteFolder: "Journal",
		useMarkdownLinks: false,
	};

	it("hides private folders and files, and says a private folder exists", () => {
		const out = redactNewNoteSettings(data, {
			isFolderVisible: (folder) => folder !== "Journal" && folder !== "Private",
			isPrivate: () => false,
		});
		expect(out.dailyNotes).toEqual({
			folder: "",
			format: "YYYY-MM-DD",
			template: undefined,
			todayPath: undefined,
			folderPrivate: true,
		});
		expect(out.templates).toEqual({ folder: "", folderPrivate: true });
		expect(out.newNoteFolder).toBe("");
		const rendered = renderNewNoteSettings(out);
		expect(rendered).not.toContain("Journal");
		expect(rendered).not.toContain("Private");
		expect(rendered).toContain("- Daily notes: in a folder that is private for this model");
		expect(rendered).toContain("- Templates: in a folder that is private for this model");
	});

	// Obsidian stores the template path without `.md`; privacy rules match the file itself.
	it("hides a private template file named without its extension", () => {
		const out = redactNewNoteSettings(data, {
			isFolderVisible: () => true,
			isPrivate: (path) => path === "Private/Day.md",
		});
		expect(out.dailyNotes?.template).toBeUndefined();
		expect(out.dailyNotes?.todayPath).toBe("Journal/2026-11-18.md");
	});

	// Private-by-default sharing matches the exact file path, so each file must be checked once, by that path.
	it("keeps a file that is shared by its exact path", () => {
		const shared = new Set(["Journal/2026-11-18.md", "Private/Day.md"]);
		const out = redactNewNoteSettings(data, {
			isFolderVisible: () => true,
			isPrivate: (path) => !shared.has(path),
		});
		expect(out.dailyNotes?.todayPath).toBe("Journal/2026-11-18.md");
		expect(out.dailyNotes?.template).toBe("Private/Day");
	});

	it("changes nothing when everything is visible", () => {
		expect(redactNewNoteSettings(data, { isFolderVisible: () => true, isPrivate: () => false })).toEqual({
			...data,
			dailyNotes: { ...data.dailyNotes, folderPrivate: undefined },
			templates: { folder: "Private", folderPrivate: undefined },
		});
	});
});
