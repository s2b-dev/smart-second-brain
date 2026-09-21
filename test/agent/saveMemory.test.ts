/**
 * `save_memory` is the reviewer's only write path, and its whole safety story is that it
 * cannot address anything outside the memory folder.
 */

import { App, TFile, TFolder } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { createSaveMemoryTool, isSafeMemoryNoteName } from "../../src/agent/tools/saveMemory";

describe("isSafeMemoryNoteName", () => {
	it("accepts plain names and refuses paths, traversal and hidden files", () => {
		expect(isSafeMemoryNoteName("User")).toBe(true);
		expect(isSafeMemoryNoteName("Work projects")).toBe(true);
		expect(isSafeMemoryNoteName("../AGENT")).toBe(false);
		expect(isSafeMemoryNoteName("..")).toBe(false);
		expect(isSafeMemoryNoteName("sub/note")).toBe(false);
		expect(isSafeMemoryNoteName("C:\\note")).toBe(false);
		expect(isSafeMemoryNoteName(".hidden")).toBe(false);
		expect(isSafeMemoryNoteName(" padded")).toBe(false);
	});
});

describe("save_memory tool", () => {
	function makeApp(existing: string[] = [], folderExists = true) {
		const app = new App();
		vi.mocked(app.vault.getFolderByPath).mockImplementation((p: string) =>
			folderExists && p === "Agents/Memories" ? new TFolder() : null,
		);
		vi.mocked(app.vault.getFileByPath).mockImplementation((p: string) => {
			if (!existing.includes(p)) return null;
			const f = new TFile();
			f.path = p;
			return f;
		});
		return app;
	}

	it("creates a note inside the memory folder and reports it as applied", async () => {
		const app = makeApp();
		const t = createSaveMemoryTool(app, "Agents/Memories");
		const res = await t.invoke({ name: "Projects", content: '---\ndescription: "x"\n---\n# Projects' });
		expect(res).toMatch(/Created memory note Agents\/Memories\/Projects\.md/);
		expect(app.vault.create).toHaveBeenCalledWith(
			"Agents/Memories/Projects.md",
			expect.stringContaining("# Projects"),
		);
		expect(app.vault.modify).not.toHaveBeenCalled();
	});

	it("replaces an existing note in place and tolerates a .md suffix", async () => {
		const app = makeApp(["Agents/Memories/User.md"]);
		const t = createSaveMemoryTool(app, "Agents/Memories");
		const res = await t.invoke({ name: "User.md", content: "new" });
		expect(res).toMatch(/Updated memory note/);
		expect(app.vault.modify).toHaveBeenCalledWith(
			expect.objectContaining({ path: "Agents/Memories/User.md" }),
			"new",
		);
		expect(app.vault.create).not.toHaveBeenCalled();
	});

	it("creates the folder when it is missing", async () => {
		const app = makeApp([], false);
		const t = createSaveMemoryTool(app, "Agents/Memories");
		await t.invoke({ name: "User", content: "x" });
		expect(app.vault.createFolder).toHaveBeenCalledWith("Agents/Memories");
	});

	it("refuses anything that is not a bare note name", async () => {
		const app = makeApp();
		const t = createSaveMemoryTool(app, "Agents/Memories");
		for (const name of ["../S2B Agent/AGENT", "Skills/x", "..", ".env"]) {
			expect(await t.invoke({ name, content: "x" })).toMatch(/Refused/);
		}
		expect(app.vault.create).not.toHaveBeenCalled();
		expect(app.vault.modify).not.toHaveBeenCalled();
	});
});
