import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

const mockGetData = vi.fn();
vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => mockGetData(),
}));

import type { App } from "obsidian";
import type { SkillsService } from "../../src/skills/SkillsService";
import { createManageSkillsTool } from "../../src/agent/tools/manageSkills";
import { recordSkillLoaded, resetSkillLoadRegistry } from "../../src/agent/tools/skillLoadRegistry";
import { parseFrontmatter } from "../../src/skills/SkillsService";

const RUN_CONFIG = { configurable: { thread_id: "t1" }, runId: "run-1" };
const recordSkillRevision = vi.fn();
const forgetSkillUsage = vi.fn();

const DATAVIEW_MD = `---
name: dataview
description: Old description
license: MIT
metadata:
  linkedPlugin: "dataview"
  displayName: "Dataview"
---

# Dataview

Old body.
`;

// The service mock writes through whichever app the test built last (tests build the service
// first, then the app), so the existing `write` spy on the adapter still sees every write and
// the cache gains the entry the real writeSkillFile would add.
let lastApp: App | undefined;

function makeSkillsService(cache: Map<string, unknown>) {
	return {
		getCachedSkills: () => cache,
		writeSkillFile: vi.fn(async (name: string, content: string) => {
			await lastApp?.vault.adapter.write(`Agents/Skills/${name}/SKILL.md`, content);
			cache.set(name, { path: `Agents/Skills/${name}`, frontmatter: parseFrontmatter(content).frontmatter });
		}),
	} as unknown as SkillsService;
}

function makeApp(files: Record<string, string>) {
	const store = { ...files };
	const write = vi.fn(async (p: string, content: string) => {
		store[p] = content;
	});
	const mkdir = vi.fn(async () => {});
	const rmdir = vi.fn(async (p: string) => {
		for (const key of Object.keys(store)) {
			if (key === p || key.startsWith(`${p}/`)) delete store[key];
		}
	});
	const app = {
		vault: {
			adapter: {
				read: vi.fn(async (p: string) => {
					if (!(p in store)) throw new Error(`ENOENT ${p}`);
					return store[p];
				}),
				exists: vi.fn(async (p: string) => p in store),
				write,
				mkdir,
				rmdir,
			},
		},
	} as unknown as App;
	lastApp = app;
	return { app, store, write, mkdir, rmdir };
}

function dataviewCache() {
	return new Map<string, unknown>([
		[
			"dataview",
			{
				path: "Agents/Skills/dataview",
				frontmatter: {
					name: "dataview",
					description: "Old description",
					metadata: { linkedPlugin: "dataview", displayName: "Dataview" },
				},
			},
		],
		[
			"other",
			{
				path: "Agents/Skills/other",
				frontmatter: { name: "other", description: "Another skill" },
			},
		],
		[
			"explore-vault",
			{
				path: "Agents/Skills/explore-vault",
				frontmatter: { name: "explore-vault", description: "Core skill" },
			},
		],
	]);
}

function agentWithSkills(skills: Record<string, { enabled: boolean }>) {
	return { skills };
}

describe("manage_skills tool", () => {
	beforeEach(() => {
		// Agent has dataview + explore-vault attached (enabled by default), "other" explicitly disabled.
		mockGetData.mockReturnValue({
			getAgent: () => agentWithSkills({ other: { enabled: false } }),
			getSelectedAgent: () => agentWithSkills({ other: { enabled: false } }),
			recordSkillRevision,
			forgetSkillUsage,
		});
		recordSkillRevision.mockClear();
		forgetSkillUsage.mockClear();
		// Revisions require the skill to have been loaded in this thread; most tests below
		// exercise what happens after that, so satisfy the gate up front.
		resetSkillLoadRegistry();
		recordSkillLoaded("t1", "dataview", parseFrontmatter(DATAVIEW_MD).body);
		recordSkillLoaded("t1", "other", "");
	});

	describe("read-before-write gate", () => {
		it("refuses to patch or update a skill not loaded in this thread", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");
			const otherThread = { configurable: { thread_id: "t2" } };

			const patched = await t.invoke(
				{ type: "patch", skillName: "dataview", oldText: "Old body.", newText: "New body." },
				otherThread,
			);
			const updated = await t.invoke({ type: "update", skillName: "dataview", newBody: "x" }, otherThread);

			expect(patched).toMatch(/load_skill first/);
			expect(updated).toMatch(/load_skill first/);
			expect(write).not.toHaveBeenCalled();
		});

		it("treats a skill created in this thread as loaded", async () => {
			const cache = dataviewCache();
			const svc = makeSkillsService(cache);
			const { app, store } = makeApp({});
			const t = createManageSkillsTool(svc, app, "agent-1");

			await t.invoke({ type: "create", name: "weekly-review", description: "d", body: "Step one." }, RUN_CONFIG);
			// No manual cache insert: create goes through writeSkillFile, which caches the entry.
			expect(cache.has("weekly-review")).toBe(true);

			const res = await t.invoke(
				{ type: "patch", skillName: "weekly-review", oldText: "Step one.", newText: "Step one, then two." },
				RUN_CONFIG,
			);
			expect(res).toMatch(/patched/i);
			expect(store["Agents/Skills/weekly-review/SKILL.md"]).toContain("Step one, then two.");
		});

		// A load authorizes a revision of the text that was loaded, not of whatever the file
		// holds later: a whole-body update against a stale copy would discard the newer edit.
		it("refuses a revision when the skill changed after it was loaded", async () => {
			const svc = makeSkillsService(dataviewCache());
			const changed = DATAVIEW_MD.replace("Old body.", "Old body.\n\nEdited by hand meanwhile.");
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": changed });
			const t = createManageSkillsTool(svc, app, "agent-1");

			const patched = await t.invoke(
				{ type: "patch", skillName: "dataview", oldText: "Old body.", newText: "x" },
				RUN_CONFIG,
			);
			const updated = await t.invoke({ type: "update", skillName: "dataview", newBody: "x" }, RUN_CONFIG);

			expect(patched).toMatch(/changed since you loaded it/);
			expect(updated).toMatch(/changed since you loaded it/);
			expect(write).not.toHaveBeenCalled();
		});

		it("counts a revision as a load, so a second patch in the same turn needs no reload", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, store } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");

			await t.invoke(
				{ type: "patch", skillName: "dataview", oldText: "Old body.", newText: "Step one." },
				RUN_CONFIG,
			);
			const res = await t.invoke(
				{ type: "patch", skillName: "dataview", oldText: "Step one.", newText: "Step one and two." },
				RUN_CONFIG,
			);

			expect(res).toMatch(/patched/i);
			expect(store["Agents/Skills/dataview/SKILL.md"]).toContain("Step one and two.");
		});
	});

	describe("patch operation", () => {
		it("replaces exactly one passage in the body and leaves the frontmatter alone", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");

			const res = await t.invoke(
				{ type: "patch", skillName: "dataview", oldText: "Old body.", newText: "Use api.pages()." },
				RUN_CONFIG,
			);

			expect(res).toMatch(/patched/i);
			const [path, newContent] = write.mock.calls[0];
			expect(path).toBe("Agents/Skills/dataview/SKILL.md");
			expect(newContent).toBe(DATAVIEW_MD.replace("Old body.", "Use api.pages()."));
		});

		// A patch is a splice, not a rewrite: trailing spaces, blank lines, indentation and CRLF
		// line endings outside the passage must come back byte for byte (indentation changes
		// Markdown meaning; a rewritten line ending is a whole-file change to sync).
		it("leaves every byte outside the passage untouched", async () => {
			const raw = DATAVIEW_MD.replace("Old body.", "  - indented  \n\n\nOld body.  \n\n").replace(/\n/g, "\r\n");
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": raw });
			recordSkillLoaded("t1", "dataview", parseFrontmatter(raw).body);
			const t = createManageSkillsTool(svc, app, "agent-1");

			const res = await t.invoke(
				{ type: "patch", skillName: "dataview", oldText: "Old body.", newText: "New body." },
				RUN_CONFIG,
			);

			expect(res).toMatch(/patched/i);
			expect(write.mock.calls[0][1]).toBe(raw.replace("Old body.", "New body."));
		});

		// load_skill shows the model an LF body whatever the file uses, so a multi-line passage
		// it copies back carries LF; it must still match a CRLF file, and the replacement must
		// land in the file's own ending rather than mix the two.
		it("matches and writes multi-line text in the file's line ending", async () => {
			const raw = DATAVIEW_MD.replace(/\n/g, "\r\n");
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": raw });
			recordSkillLoaded("t1", "dataview", parseFrontmatter(raw).body);
			const t = createManageSkillsTool(svc, app, "agent-1");

			const res = await t.invoke(
				{
					type: "patch",
					skillName: "dataview",
					oldText: "# Dataview\n\nOld body.",
					newText: "# Dataview\n\nOne.\nTwo.",
				},
				RUN_CONFIG,
			);

			expect(res).toMatch(/patched/i);
			const written = String(write.mock.calls[0][1]);
			expect(written).toBe(raw.replace("Old body.", "One.\r\nTwo."));
			expect(written).not.toMatch(/[^\r]\n/);
		});

		// `$&` in a replacement is a pattern to String.replace; a skill about regexes would
		// otherwise have its own text spliced back in.
		it("inserts the replacement literally", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");
			await t.invoke(
				{ type: "patch", skillName: "dataview", oldText: "Old body.", newText: "$& $1" },
				RUN_CONFIG,
			);
			expect(write.mock.calls[0][1]).toContain("$& $1");
		});

		it("deletes the passage when the replacement is empty", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");
			await t.invoke({ type: "patch", skillName: "dataview", oldText: "\n\nOld body.", newText: "" }, RUN_CONFIG);
			const [, newContent] = write.mock.calls[0];
			expect(newContent).not.toContain("Old body.");
			expect(newContent).toContain("# Dataview");
		});

		it("refuses a passage that is missing, and says so when it lives in the frontmatter", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");

			const missing = await t.invoke(
				{ type: "patch", skillName: "dataview", oldText: "not in there", newText: "x" },
				RUN_CONFIG,
			);
			const frontmatter = await t.invoke(
				{ type: "patch", skillName: "dataview", oldText: "Old description", newText: "x" },
				RUN_CONFIG,
			);

			expect(missing).toMatch(/could not find/i);
			expect(frontmatter).toMatch(/frontmatter/i);
			expect(write).not.toHaveBeenCalled();
		});

		it("refuses an ambiguous passage", async () => {
			const svc = makeSkillsService(dataviewCache());
			const twice = DATAVIEW_MD.replace("Old body.", "Step.\n\nStep.");
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": twice });
			recordSkillLoaded("t1", "dataview", parseFrontmatter(twice).body);
			const t = createManageSkillsTool(svc, app, "agent-1");
			const res = await t.invoke(
				{ type: "patch", skillName: "dataview", oldText: "Step.", newText: "x" },
				RUN_CONFIG,
			);
			expect(res).toMatch(/appears 2 times/);
			expect(write).not.toHaveBeenCalled();
		});

		it("rejects patching a skill not attached to this agent", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/other/SKILL.md": "" });
			const t = createManageSkillsTool(svc, app, "agent-1");
			const res = await t.invoke({ type: "patch", skillName: "other", oldText: "a", newText: "b" }, RUN_CONFIG);
			expect(res).toMatch(/not attached/i);
			expect(write).not.toHaveBeenCalled();
		});
	});

	describe("usage and provenance", () => {
		it("stamps metadata.author: agent on a created skill", async () => {
			const cache = dataviewCache();
			const svc = makeSkillsService(cache);
			const { app, store } = makeApp({});
			const t = createManageSkillsTool(svc, app, "agent-1");

			await t.invoke({ type: "create", name: "weekly-review", description: "d", body: "Step one." }, RUN_CONFIG);

			const written = store["Agents/Skills/weekly-review/SKILL.md"];
			expect(written).toContain("metadata:\n  author: agent\n---");
			expect(parseFrontmatter(written).frontmatter.metadata?.author).toBe("agent");
		});

		it("counts a patch and an update as revisions", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");

			await t.invoke({ type: "patch", skillName: "dataview", oldText: "Old body.", newText: "A." }, RUN_CONFIG);
			await t.invoke({ type: "update", skillName: "dataview", newBody: "# Dataview\n\nB." }, RUN_CONFIG);

			expect(recordSkillRevision).toHaveBeenCalledTimes(2);
			expect(recordSkillRevision).toHaveBeenCalledWith("dataview");
		});

		it("does not count a refused or no-op revision", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");

			await t.invoke({ type: "patch", skillName: "dataview", oldText: "missing", newText: "x" }, RUN_CONFIG);
			await t.invoke({ type: "update", skillName: "dataview", newBody: "# Dataview\n\nOld body." }, RUN_CONFIG);

			expect(recordSkillRevision).not.toHaveBeenCalled();
		});

		it("forgets a deleted skill's counters", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");

			await t.invoke({ type: "delete", name: "dataview" }, RUN_CONFIG);

			expect(forgetSkillUsage).toHaveBeenCalledWith("dataview");
		});
	});

	describe("update operation", () => {
		it("applies a valid body edit immediately", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");

			const res = await t.invoke(
				{ type: "update", skillName: "dataview", newBody: "# Dataview\n\nVerified: use api.pages()." },
				RUN_CONFIG,
			);

			expect(write).toHaveBeenCalledTimes(1);
			const [path, newContent] = write.mock.calls[0];
			expect(path).toBe("Agents/Skills/dataview/SKILL.md");
			expect(newContent).toContain("Verified: use api.pages().");
			// Frontmatter preserved verbatim (name + linkedPlugin intact).
			expect(newContent).toContain("name: dataview");
			expect(newContent).toContain('linkedPlugin: "dataview"');
			expect(res).toMatch(/updated/i);
		});

		it("updates the description line when provided, preserving other frontmatter", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");

			await t.invoke(
				{
					type: "update",
					skillName: "dataview",
					newBody: "# Dataview\n\nBody.",
					newDescription: "New verified description",
				},
				RUN_CONFIG,
			);

			const [, newContent] = write.mock.calls[0];
			expect(newContent).toContain("description: New verified description");
			expect(newContent).not.toContain("description: Old description");
			expect(newContent).toContain('linkedPlugin: "dataview"');
		});

		it("writes a multi-line body in the file's line ending", async () => {
			const raw = DATAVIEW_MD.replace(/\n/g, "\r\n");
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": raw });
			recordSkillLoaded("t1", "dataview", parseFrontmatter(raw).body);
			const t = createManageSkillsTool(svc, app, "agent-1");

			await t.invoke({ type: "update", skillName: "dataview", newBody: "# Dataview\n\nOne.\nTwo." }, RUN_CONFIG);

			const written = String(write.mock.calls[0][1]);
			expect(written).toContain("One.\r\nTwo.");
			expect(written).not.toMatch(/[^\r]\n/);
		});

		it("makes no write when the content is unchanged", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");
			const res = await t.invoke(
				{ type: "update", skillName: "dataview", newBody: "# Dataview\n\nOld body." },
				RUN_CONFIG,
			);
			expect(write).not.toHaveBeenCalled();
			expect(res).toMatch(/no changes/i);
		});

		it("rejects editing a skill not attached to this agent", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/other/SKILL.md": "" });
			const t = createManageSkillsTool(svc, app, "agent-1");
			const res = await t.invoke({ type: "update", skillName: "other", newBody: "x" }, RUN_CONFIG);
			expect(res).toMatch(/not attached/i);
			expect(write).not.toHaveBeenCalled();
		});
	});

	describe("create operation", () => {
		it("writes the new skill file and does not write an agent.skills entry (attach-on-exist)", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write, mkdir } = makeApp({});
			const t = createManageSkillsTool(svc, app, "agent-1");

			const res = await t.invoke(
				{ type: "create", name: "weekly-review", description: "Reviews the week", body: "Do the review." },
				RUN_CONFIG,
			);

			expect(mkdir).toHaveBeenCalledWith("Agents/Skills/weekly-review");
			expect(write).toHaveBeenCalledTimes(1);
			const [path, content] = write.mock.calls[0];
			expect(path).toBe("Agents/Skills/weekly-review/SKILL.md");
			expect(content).toContain("name: weekly-review");
			expect(content).toContain("description: Reviews the week");
			expect(res).toMatch(/created and attached/i);
		});

		it("rejects a duplicate skill name", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");

			const res = await t.invoke({ type: "create", name: "dataview", description: "x", body: "y" }, RUN_CONFIG);

			expect(res).toMatch(/already exists/i);
			expect(write).not.toHaveBeenCalled();
		});

		it("rejects an invalid skill name", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({});
			const t = createManageSkillsTool(svc, app, "agent-1");
			const res = await t.invoke({ type: "create", name: "Not Valid!", description: "x", body: "y" }, RUN_CONFIG);
			expect(res).toMatch(/invalid name/i);
			expect(write).not.toHaveBeenCalled();
		});

		it("grants only allow-listed tools and drops the rest", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, write } = makeApp({});
			const t = createManageSkillsTool(svc, app, "agent-1");

			const res = await t.invoke(
				{
					type: "create",
					name: "my-skill",
					description: "x",
					body: "y",
					allowedTools: ["search_notes", "manage_notes", "execute_javascript", "manage_skills"],
				},
				RUN_CONFIG,
			);

			const [, content] = write.mock.calls[0];
			expect(content).toContain("allowed-tools: search_notes");
			expect(content).not.toContain("manage_notes");
			expect(content).not.toContain("execute_javascript");
			expect(res).toMatch(/dropped/i);
			expect(res).toMatch(/manage_notes/);
		});
	});

	describe("delete operation", () => {
		it("refuses to delete a core skill", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, rmdir } = makeApp({});
			const t = createManageSkillsTool(svc, app, "agent-1");
			const res = await t.invoke({ type: "delete", name: "explore-vault" }, RUN_CONFIG);
			expect(res).toMatch(/cannot be deleted/i);
			expect(rmdir).not.toHaveBeenCalled();
		});

		it("refuses to delete a skill not attached to this agent", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, rmdir } = makeApp({ "Agents/Skills/other/SKILL.md": "" });
			const t = createManageSkillsTool(svc, app, "agent-1");
			const res = await t.invoke({ type: "delete", name: "other" }, RUN_CONFIG);
			expect(res).toMatch(/not attached/i);
			expect(rmdir).not.toHaveBeenCalled();
		});

		it("removes the whole folder for an attached, non-core skill", async () => {
			const svc = makeSkillsService(dataviewCache());
			const { app, rmdir, store } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");
			const res = await t.invoke({ type: "delete", name: "dataview" }, RUN_CONFIG);

			expect(rmdir).toHaveBeenCalledWith("Agents/Skills/dataview", true);
			expect(store["Agents/Skills/dataview/SKILL.md"]).toBeUndefined();
			expect(res).toMatch(/deleted/i);
		});

		it("drops the agent's stale skills entry after delete", async () => {
			const svc = makeSkillsService(dataviewCache());
			const agent = agentWithSkills({ other: { enabled: false }, dataview: { enabled: true } });
			mockGetData.mockReturnValue({
				getAgent: () => agent,
				recordSkillRevision,
				forgetSkillUsage,
				getSelectedAgent: () => agent,
			});
			const { app } = makeApp({ "Agents/Skills/dataview/SKILL.md": DATAVIEW_MD });
			const t = createManageSkillsTool(svc, app, "agent-1");
			await t.invoke({ type: "delete", name: "dataview" }, RUN_CONFIG);

			expect("dataview" in agent.skills).toBe(false);
		});
	});
});
