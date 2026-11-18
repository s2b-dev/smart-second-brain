/**
 * The agent's AGENT.md body is used verbatim as its system prompt, so anything that must stay
 * live is written as a placeholder and substituted at assembly time. These are the guards on
 * that substitution: a placeholder that survives into the assembled prompt is shown to the
 * model as literal `{{...}}` text, and a body that loses a section silently changes behaviour.
 */

import { describe, expect, it } from "vitest";

import {
	DATE_PLACEHOLDER,
	DEFAULT_AGENT_PROMPT,
	MEMORY_FOLDER_PLACEHOLDER,
	MEMORY_INDEX_PLACEHOLDER,
	VAULT_FOLDERS_PLACEHOLDER,
	VAULT_PLACEHOLDERS,
	VAULT_PROPERTIES_PLACEHOLDER,
	NEW_NOTE_SETTINGS_PLACEHOLDER,
	VAULT_TAGS_PLACEHOLDER,
	buildDateSection,
	buildMemorySection,
	currentDateValue,
	buildVaultSection,
	substitutePromptPlaceholders,
	usesVaultOverview,
} from "../../src/agent/prompts";

const VALUES = {
	memoryFolder: "Agents/Memories",
	date: "Monday, 2026-09-01",
	memoryIndex: "## Memory notes\n- `Agents/Memories/User.md` — who the user is",
	newNoteSettings: "- Daily notes: in `Daily/`",
	vaultFolders: "<vault_folders>\nMeetings/\n</vault_folders>",
	vaultTags: "<vault_tags>\n#project\n</vault_tags>",
	vaultProperties: "<vault_properties>\nstatus\n</vault_properties>",
};

describe("substitutePromptPlaceholders", () => {
	it("substitutes every placeholder in the shipped default", () => {
		const result = substitutePromptPlaceholders(DEFAULT_AGENT_PROMPT, VALUES);

		expect(result).not.toContain(MEMORY_FOLDER_PLACEHOLDER);
		expect(result).not.toContain(DATE_PLACEHOLDER);
		expect(result).not.toContain(MEMORY_INDEX_PLACEHOLDER);
		for (const placeholder of VAULT_PLACEHOLDERS) expect(result).not.toContain(placeholder);
		expect(result).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
		expect(result).toContain("- Daily notes: in `Daily/`");
		expect(result).toContain("Meetings/");
		expect(result).toContain("#project");
		expect(result).toContain("status");
		expect(result).toContain("`Agents/Memories/`");
		expect(result).toContain("Monday, 2026-09-01");
		expect(result).toContain("- `Agents/Memories/User.md` — who the user is");
	});

	// The index carries note descriptions the user or the model wrote, so it needs the same
	// literal treatment as the folder path.
	it("inserts the memory index literally", () => {
		const result = substitutePromptPlaceholders(MEMORY_INDEX_PLACEHOLDER, { ...VALUES, memoryIndex: "$& $1" });
		expect(result).toBe("$& $1");
	});

	// Folder, tag and property names are vault text; a folder named "$&" must not re-inject the placeholder.
	it("inserts the vault overview literally", () => {
		const body = `${VAULT_FOLDERS_PLACEHOLDER}|${VAULT_TAGS_PLACEHOLDER}|${VAULT_PROPERTIES_PLACEHOLDER}`;
		const result = substitutePromptPlaceholders(body, {
			...VALUES,
			vaultFolders: "$&",
			vaultTags: "$1",
			vaultProperties: "$$",
		});
		expect(result).toBe("$&|$1|$$");
	});

	it("replaces every occurrence, not just the first", () => {
		const body = `${MEMORY_FOLDER_PLACEHOLDER} and again ${MEMORY_FOLDER_PLACEHOLDER}`;
		expect(substitutePromptPlaceholders(body, VALUES)).toBe("Agents/Memories and again Agents/Memories");
	});

	/**
	 * Deleting the `# Memory` section is how a user disables memory now that there is no
	 * toggle, so a body without the placeholder must pass through untouched rather than have
	 * anything re-injected.
	 */
	it("is a no-op on a body with no placeholders", () => {
		const body = "just my own instructions, no memory section";
		expect(substitutePromptPlaceholders(body, VALUES)).toBe(body);
	});

	it("substitutes a reconfigured memory folder", () => {
		const result = substitutePromptPlaceholders(DEFAULT_AGENT_PROMPT, {
			...VALUES,
			memoryFolder: "Meta/Agents/Memories",
		});
		expect(result).toContain("`Meta/Agents/Memories/`");
	});

	// A `$`-sequence in a replacement value is a pattern to String.replace but must be literal
	// here — a vault folder named e.g. "$&" would otherwise inject the matched placeholder back.
	it("treats replacement values literally", () => {
		const result = substitutePromptPlaceholders(MEMORY_FOLDER_PLACEHOLDER, { ...VALUES, memoryFolder: "A$&B" });
		expect(result).toBe("A$&B");
	});
});

describe("prompt section builders", () => {
	it("names the memory folder via the placeholder, never a literal path", () => {
		const section = buildMemorySection("instructions here");
		expect(section.startsWith("# Memory")).toBe(true);
		expect(section).toContain(MEMORY_FOLDER_PLACEHOLDER);
		expect(section).toContain("instructions here");
	});

	// Inside the section, not appended after it: deleting `# Memory` must take the index with it.
	it("closes the memory section with the index placeholder", () => {
		const section = buildMemorySection("instructions here");
		expect(section.endsWith(MEMORY_INDEX_PLACEHOLDER)).toBe(true);
	});

	it("keeps the date section free of a baked-in date", () => {
		const section = buildDateSection();
		expect(section.startsWith("# Current Date")).toBe(true);
		expect(section).toContain(DATE_PLACEHOLDER);
		expect(section).not.toMatch(/\d{4}-\d{2}-\d{2}/);
	});

	it("renders the date as weekday and ISO date", () => {
		expect(currentDateValue(new Date(2026, 8, 1))).toBe("Tuesday, 2026-09-01");
	});
});

describe("vault section", () => {
	it("carries each vault placeholder under its own heading, so one list can be dropped alone", () => {
		const section = buildVaultSection();
		expect(section.startsWith("# Vault")).toBe(true);
		expect(section).toContain(`## Obsidian's settings for new notes\n${NEW_NOTE_SETTINGS_PLACEHOLDER}`);
		expect(section).toContain(`## Folders in the vault\n${VAULT_FOLDERS_PLACEHOLDER}`);
		expect(section).toContain(`## Tags in use, most used first\n${VAULT_TAGS_PLACEHOLDER}`);
		expect(section).toContain(`## Properties in use, most used first\n${VAULT_PROPERTIES_PLACEHOLDER}`);
	});

	// The scan is skipped for a body without any vault placeholder; a body keeping only one
	// list must still get it.
	it("detects a body that asks for any part of the overview", () => {
		expect(usesVaultOverview(DEFAULT_AGENT_PROMPT)).toBe(true);
		expect(usesVaultOverview(`my prompt\n${VAULT_TAGS_PLACEHOLDER}`)).toBe(true);
		expect(usesVaultOverview("my prompt without a vault section")).toBe(false);
	});
});
