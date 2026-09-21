/**
 * `save_memory` is the reviewer's only write path, and its whole safety story is that it
 * cannot address anything outside the memory folder, and cannot lose another reviewer's
 * addition to the same note.
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

	// Append is the default for an existing note: computed against the text on disk inside
	// the write lock, so two reviews that both read the old note cannot lose each other's facts.
	it("appends to an existing note by default, reading it at write time", async () => {
		const app = makeApp(["Agents/Memories/User.md"]);
		vi.mocked(app.vault.read).mockResolvedValue('---\ndescription: "x"\n---\n# User\nName: Leo\n');
		const t = createSaveMemoryTool(app, "Agents/Memories");
		const res = await t.invoke({ name: "User.md", content: "Prefers short answers." });
		expect(res).toMatch(/Appended to memory note/);
		expect(app.vault.modify).toHaveBeenCalledWith(
			expect.objectContaining({ path: "Agents/Memories/User.md" }),
			'---\ndescription: "x"\n---\n# User\nName: Leo\n\nPrefers short answers.\n',
		);
		expect(app.vault.create).not.toHaveBeenCalled();
	});

	it("replaces an existing note only when asked to", async () => {
		const app = makeApp(["Agents/Memories/User.md"]);
		const t = createSaveMemoryTool(app, "Agents/Memories");
		const res = await t.invoke({ name: "User", content: "new", mode: "replace" });
		expect(res).toMatch(/Updated memory note/);
		expect(app.vault.modify).toHaveBeenCalledWith(
			expect.objectContaining({ path: "Agents/Memories/User.md" }),
			"new",
		);
		expect(app.vault.read).not.toHaveBeenCalled();
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

	// Two reviews can finish together and both write the same note; the second must wait
	// for the first, not race it.
	it("serializes writes to the same note", async () => {
		const app = makeApp(["Agents/Memories/User.md"]);
		const order: string[] = [];
		vi.mocked(app.vault.modify).mockImplementation(async (_file: unknown, data: string) => {
			order.push(`start ${data}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push(`end ${data}`);
		});
		const t = createSaveMemoryTool(app, "Agents/Memories");

		await Promise.all([
			t.invoke({ name: "User", content: "a", mode: "replace" }),
			t.invoke({ name: "User", content: "b", mode: "replace" }),
		]);

		expect(order).toEqual(["start a", "end a", "start b", "end b"]);
	});

	// Two reviews that both read the old note and append: neither addition is lost.
	it("keeps both additions when two appends race", async () => {
		const app = makeApp(["Agents/Memories/User.md"]);
		let disk = "# User\n";
		vi.mocked(app.vault.read).mockImplementation(async () => disk);
		vi.mocked(app.vault.modify).mockImplementation(async (_file: unknown, data: string) => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			disk = data;
		});
		const t = createSaveMemoryTool(app, "Agents/Memories");
		await Promise.all([
			t.invoke({ name: "User", content: "fact one" }),
			t.invoke({ name: "User", content: "fact two" }),
		]);
		expect(disk).toBe("# User\n\nfact one\n\nfact two\n");
	});

	// A failed write must surface as a tool error so the review notice cannot claim it.
	it("throws when the vault write fails", async () => {
		const app = makeApp();
		vi.mocked(app.vault.create).mockRejectedValue(new Error("read-only vault"));
		const t = createSaveMemoryTool(app, "Agents/Memories");
		await expect(t.invoke({ name: "User", content: "x" })).rejects.toThrow(/read-only vault/);
	});

	it("falls back to writing into a note created underneath it", async () => {
		const app = makeApp();
		const file = new TFile();
		file.path = "Agents/Memories/User.md";
		vi.mocked(app.vault.create).mockRejectedValue(new Error("File already exists"));
		vi.mocked(app.vault.getFileByPath).mockReturnValueOnce(null).mockReturnValue(file);
		vi.mocked(app.vault.read).mockResolvedValue("existing");
		const t = createSaveMemoryTool(app, "Agents/Memories");
		expect(await t.invoke({ name: "User", content: "x" })).toMatch(/Appended to memory note/);
		expect(app.vault.modify).toHaveBeenCalledWith(file, "existing\n\nx\n");
	});
});
