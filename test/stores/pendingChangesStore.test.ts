import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

// Mock dataStore.svelte to provide getData()
vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: vi.fn(() => ({
		targetFolder: "Chats",
		isFilePrivate: vi.fn(() => false),
		isProviderTrusted: vi.fn(() => false),
	})),
}));

// We test only the pure utility functions and public API.
// shouldIncludePart & buildPartialContent are module-private, so we test
// them indirectly through rejectChangeGroup (which does not touch the vault).

import { PendingChangesStore } from "../../src/stores/pendingChangesStore.svelte";
import { getData } from "../../src/stores/dataStore.svelte";
import { TFile } from "obsidian";
import { Logger } from "../../src/utils/logging";

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------*/

/** Create a TFile instance with the given path (uses the mocked TFile class). */
function makeTFile(path: string) {
	const f = new TFile();
	f.path = path;
	f.name = path.split("/").pop()!;
	return f;
}

function createMockPlugin() {
	const vault = {
		adapter: {
			exists: vi.fn().mockResolvedValue(false),
			read: vi.fn().mockResolvedValue(""),
			write: vi.fn().mockResolvedValue(undefined),
			mkdir: vi.fn().mockResolvedValue(undefined),
		},
		getAbstractFileByPath: vi.fn(),
		read: vi.fn().mockResolvedValue(""),
		modify: vi.fn().mockResolvedValue(undefined),
		create: vi.fn().mockResolvedValue(makeTFile("created.md")),
		createFolder: vi.fn().mockResolvedValue(undefined),
		trash: vi.fn().mockResolvedValue(undefined),
		on: vi.fn().mockReturnValue({ id: "ref" }),
		// Mirrors Vault.process's read → transform → write contract by delegating
		// to the mocked read/modify, so tests keep simulating external edits via
		// `read` and asserting writes via `modify`. Writes only when the callback
		// changed the data — the store's conflict paths return it unchanged.
		process: vi.fn(),
	};
	vault.process.mockImplementation(async (file: unknown, fn: (data: string) => string) => {
		const data = await vault.read(file);
		const result = fn(data);
		if (result !== data) await vault.modify(file, result);
		return result;
	});
	return {
		manifest: { dir: "test-plugin" },
		app: {
			vault,
			fileManager: {
				renameFile: vi.fn().mockResolvedValue(undefined),
				trashFile: vi.fn().mockResolvedValue(undefined),
			},
		},
		registerEvent: vi.fn(),
		saveData: vi.fn().mockResolvedValue(undefined),
	} as unknown as ConstructorParameters<typeof PendingChangesStore>[0];
}

/* --------------------------------------------------------------------------
 * PendingChangesStore – addChanges / getters
 * ------------------------------------------------------------------------*/

describe("PendingChangesStore", () => {
	let store: PendingChangesStore;
	let plugin: ReturnType<typeof createMockPlugin>;

	beforeEach(() => {
		plugin = createMockPlugin();
		store = new PendingChangesStore(plugin);
	});

	describe("addChanges & getters", () => {
		it("should add a single create change", () => {
			const ids = store.addChanges(
				[{ type: "create", path: "new.md", content: "Hello world" }],
				"tc-1",
				"thread-1",
			);

			expect(ids).toHaveLength(1);
			expect(store.getPendingCount("thread-1")).toBe(1);

			const entry = store.getEntry(ids[0]);
			expect(entry).toBeDefined();
			expect(entry?.change.type).toBe("create");
			expect(entry?.status).toBe("pending");
			expect(entry?.toolCallId).toBe("tc-1");
			expect(entry?.threadId).toBe("thread-1");
		});

		it("should add multiple changes at once", () => {
			const changes = [
				{ type: "create" as const, path: "a.md", content: "A" },
				{ type: "create" as const, path: "b.md", content: "B" },
				{ type: "create" as const, path: "c.md", content: "C" },
			];

			const ids = store.addChanges(changes, "tc-2", "thread-1");
			expect(ids).toHaveLength(3);
			expect(store.getPendingCount("thread-1")).toBe(3);
		});

		it("should auto-reject older pending updates for the same path and thread", () => {
			store.addChanges(
				[{ type: "update", path: "note.md", originalContent: "old", newContent: "new1" }],
				"tc-1",
				"thread-1",
			);

			const [id2] = store.addChanges(
				[{ type: "update", path: "note.md", originalContent: "old", newContent: "new2" }],
				"tc-2",
				"thread-1",
			);

			// Only the latest should be pending
			expect(store.getPendingCount("thread-1")).toBe(1);
			const entry = store.getEntry(id2);
			expect(entry?.status).toBe("pending");
		});

		it("should not auto-reject updates from different threads", () => {
			store.addChanges(
				[{ type: "update", path: "note.md", originalContent: "old", newContent: "new1" }],
				"tc-1",
				"thread-1",
			);

			store.addChanges(
				[{ type: "update", path: "note.md", originalContent: "old", newContent: "new2" }],
				"tc-2",
				"thread-2",
			);

			expect(store.getPendingCount("thread-1")).toBe(1);
			expect(store.getPendingCount("thread-2")).toBe(1);
		});

		it("should retrieve entries by thread", () => {
			store.addChanges([{ type: "create", path: "a.md", content: "A" }], "tc-1", "thread-1");
			store.addChanges([{ type: "create", path: "b.md", content: "B" }], "tc-2", "thread-2");

			expect(store.getEntriesForThread("thread-1")).toHaveLength(1);
			expect(store.getEntriesForThread("thread-2")).toHaveLength(1);
			expect(store.getEntriesForThread("thread-3")).toHaveLength(0);
		});

		it("should retrieve entries by tool call ID", () => {
			store.addChanges(
				[
					{ type: "create", path: "a.md", content: "A" },
					{ type: "create", path: "b.md", content: "B" },
				],
				"tc-unique",
				"thread-1",
			);
			store.addChanges([{ type: "create", path: "c.md", content: "C" }], "tc-other", "thread-1");

			const entries = store.getEntriesByToolCallId("tc-unique");
			expect(entries).toHaveLength(2);
			expect(entries.map((e) => e.change.path)).toEqual(["a.md", "b.md"]);
		});

		it("should return pending updates for a specific path", () => {
			store.addChanges(
				[{ type: "update", path: "target.md", originalContent: "old", newContent: "new" }],
				"tc-1",
				"thread-1",
			);
			store.addChanges([{ type: "create", path: "other.md", content: "X" }], "tc-2", "thread-1");

			const updates = store.getPendingUpdatesForPath("target.md");
			expect(updates).toHaveLength(1);
			expect(updates[0].change.path).toBe("target.md");
		});
	});

	/* --------------------------------------------------------------------------
	 * rejectChange
	 * ------------------------------------------------------------------------*/

	describe("rejectChange", () => {
		it("should reject a pending change", () => {
			const [id] = store.addChanges([{ type: "create", path: "a.md", content: "A" }], "tc-1", "thread-1");

			store.rejectChange(id);

			expect(store.getEntry(id)?.status).toBe("rejected");
			expect(store.getPendingCount("thread-1")).toBe(0);
		});

		it("should be a no-op for already-rejected changes", () => {
			const [id] = store.addChanges([{ type: "create", path: "a.md", content: "A" }], "tc-1", "thread-1");

			store.rejectChange(id);
			store.rejectChange(id); // should not throw

			expect(store.getEntry(id)?.status).toBe("rejected");
		});
	});

	/* --------------------------------------------------------------------------
	 * acceptChange
	 * ------------------------------------------------------------------------*/

	describe("acceptChange", () => {
		it("should accept and apply a create change", async () => {
			const [id] = store.addChanges(
				[{ type: "create", path: "notes/new.md", content: "Hello" }],
				"tc-1",
				"thread-1",
			);

			await store.acceptChange(id);

			expect(store.getEntry(id)?.status).toBe("accepted");
			expect(plugin.app.vault.create).toHaveBeenCalledWith("notes/new.md", "Hello");
		});

		it("should accept and apply an update change", async () => {
			const file = makeTFile("note.md");
			(plugin.app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(file);
			(plugin.app.vault.read as ReturnType<typeof vi.fn>).mockResolvedValue("original content");

			const [id] = store.addChanges(
				[
					{
						type: "update",
						path: "note.md",
						originalContent: "original content",
						newContent: "updated content",
					},
				],
				"tc-1",
				"thread-1",
			);

			await store.acceptChange(id);

			expect(store.getEntry(id)?.status).toBe("accepted");
			expect(plugin.app.vault.modify).toHaveBeenCalledWith(file, "updated content");
		});

		it("should detect conflict when file was modified externally", async () => {
			const file = makeTFile("note.md");
			(plugin.app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(file);
			// File content has changed since the change was proposed
			(plugin.app.vault.read as ReturnType<typeof vi.fn>).mockResolvedValue("externally modified");

			const [id] = store.addChanges(
				[
					{
						type: "update",
						path: "note.md",
						originalContent: "original content",
						newContent: "new content",
					},
				],
				"tc-1",
				"thread-1",
			);

			await expect(store.acceptChange(id)).rejects.toThrow("was modified after the change was proposed");
			expect(store.getEntry(id)?.status).toBe("pending"); // Should remain pending
		});

		it("should accept and apply a delete change", async () => {
			const file = makeTFile("delete-me.md");
			(plugin.app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(file);
			(plugin.app.vault.read as ReturnType<typeof vi.fn>).mockResolvedValue("content");

			const [id] = store.addChanges(
				[{ type: "delete", path: "delete-me.md", originalContent: "content" }],
				"tc-1",
				"thread-1",
			);

			await store.acceptChange(id);

			expect(store.getEntry(id)?.status).toBe("accepted");
			// trashFile, not vault.trash: honours the user's "Deleted files" preference.
			expect(plugin.app.fileManager.trashFile).toHaveBeenCalledWith(file);
		});

		it("should refuse a delete when the file was modified after staging", async () => {
			const file = makeTFile("delete-me.md");
			(plugin.app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(file);
			// The preview shows the staged snapshot; the note has since changed.
			(plugin.app.vault.read as ReturnType<typeof vi.fn>).mockResolvedValue("edited since staging");

			const [id] = store.addChanges(
				[{ type: "delete", path: "delete-me.md", originalContent: "content" }],
				"tc-1",
				"thread-1",
			);

			await expect(store.acceptChange(id)).rejects.toThrow("was modified after the delete was proposed");
			expect(store.getEntry(id)?.status).toBe("pending");
			expect(plugin.app.fileManager.trashFile).not.toHaveBeenCalled();
		});

		it("should accept and apply a move change", async () => {
			const file = makeTFile("old-path.md");
			(plugin.app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>)
				.mockReturnValueOnce(file) // source exists
				.mockReturnValueOnce(null); // destination doesn't exist

			const [id] = store.addChanges(
				[{ type: "move", path: "old-path.md", newPath: "new-path.md" }],
				"tc-1",
				"thread-1",
			);

			await store.acceptChange(id);

			expect(store.getEntry(id)?.status).toBe("accepted");
			expect(plugin.app.fileManager.renameFile).toHaveBeenCalledWith(file, "new-path.md");
		});
	});

	/* --------------------------------------------------------------------------
	 * rejectChangeGroup (tests buildPartialContent indirectly)
	 * ------------------------------------------------------------------------*/

	describe("rejectChangeGroup", () => {
		it("should reject a specific diff group from an update", () => {
			const original = "line1\nline2\nline3\n";
			const updated = "line1\nmodified2\nline3\nadded4\n";

			const [id] = store.addChanges(
				[{ type: "update", path: "note.md", originalContent: original, newContent: updated }],
				"tc-1",
				"thread-1",
			);

			// Reject group 0 (line2 → modified2 change)
			store.rejectChangeGroup(id, 0);

			const entry = store.getEntry(id);
			expect(entry).toBeDefined();
			if (!entry) throw new Error("Expected pending change entry");
			expect(entry.status).toBe("pending");
			// After rejecting the first group, the newContent should revert group 0
			// but keep group 1 (the added4 line)
			const change = entry.change as { type: "update"; newContent: string; originalContent: string };
			expect(change.newContent).toContain("line2");
			expect(change.newContent).toContain("added4");
		});

		it("should auto-reject entry when all groups are rejected", () => {
			const original = "line1\nline2\n";
			const updated = "line1\nchanged\n";

			const [id] = store.addChanges(
				[{ type: "update", path: "note.md", originalContent: original, newContent: updated }],
				"tc-1",
				"thread-1",
			);

			// Only one diff group, rejecting it should make newContent == originalContent
			store.rejectChangeGroup(id, 0);

			const entry = store.getEntry(id);
			expect(entry).toBeDefined();
			if (!entry) throw new Error("Expected pending change entry");
			expect(entry.status).toBe("rejected");
		});

		it("should be a no-op for non-update changes", () => {
			const [id] = store.addChanges([{ type: "create", path: "a.md", content: "A" }], "tc-1", "thread-1");

			store.rejectChangeGroup(id, 0);
			expect(store.getEntry(id)?.status).toBe("pending");
		});
	});

	/* --------------------------------------------------------------------------
	 * Batch operations: acceptAll / rejectAll
	 * ------------------------------------------------------------------------*/

	describe("batch operations", () => {
		it("rejectAll should reject all pending changes for a thread", async () => {
			const ids = store.addChanges(
				[
					{ type: "create", path: "a.md", content: "A" },
					{ type: "create", path: "b.md", content: "B" },
				],
				"tc-1",
				"thread-1",
			);

			await store.rejectAll("thread-1");

			expect(store.getEntry(ids[0])?.status).toBe("rejected");
			expect(store.getEntry(ids[1])?.status).toBe("rejected");
			expect(store.getPendingCount("thread-1")).toBe(0);
		});

		it("rejectAll should not affect a different thread", async () => {
			store.addChanges([{ type: "create", path: "a.md", content: "A" }], "tc-1", "thread-1");
			const [id2] = store.addChanges([{ type: "create", path: "b.md", content: "B" }], "tc-2", "thread-2");

			await store.rejectAll("thread-1");

			expect(store.getEntry(id2)?.status).toBe("pending");
		});

		/**
		 * `rejectAll` restores a note that had groups partially accepted. That restore
		 * used to be an unconditional `vault.modify`, which silently destroyed any edit
		 * the user made by hand in between — `modify` doesn't go through trash, so the
		 * work was unrecoverable.
		 */
		describe("rejectAll revert of partially-accepted groups", () => {
			/** Stage a 2-group update and accept the first group, leaving the file
			 *  partially applied (the state that arms the revert path). */
			async function stagePartiallyAccepted() {
				const original = "line1\nline2\nline3\n";
				const proposed = "CHANGED1\nline2\nCHANGED3\n";
				const file = makeTFile("note.md");
				plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
				plugin.app.vault.read = vi.fn().mockResolvedValue(original);

				const [id] = store.addChanges(
					[{ type: "update", path: "note.md", originalContent: original, newContent: proposed }],
					"tc-1",
					"thread-1",
				);

				await store.acceptChangeGroup(id, 0);

				const afterGroupAccept = (plugin.app.vault.modify as ReturnType<typeof vi.fn>).mock.calls[0][1];
				return { id, original, afterGroupAccept, file };
			}

			/**
			 * Regression (review of PR #411): accepting one group and then rejecting the
			 * remaining ones drives `newContent` back to `originalContent`, so
			 * `rejectChangeGroup` flips the entry to `rejected` — while the accepted group
			 * is still written to the note. `rejectAll` filtered on `status === "pending"`
			 * and therefore skipped exactly those entries, stranding the applied text on
			 * disk while reporting that everything had been rejected.
			 */
			it("reverts an entry already marked rejected by group-level rejections", async () => {
				const { id, original, afterGroupAccept } = await stagePartiallyAccepted();

				// Reject the one remaining group. Groups are recomputed from the advanced
				// originalContent, so the remaining change is index 0.
				store.rejectChangeGroup(id, 0);
				expect(store.getEntry(id)?.status).toBe("rejected");
				expect(store.getPendingCount("thread-1")).toBe(0);

				// The accepted group is still on disk at this point.
				plugin.app.vault.read = vi.fn().mockResolvedValue(afterGroupAccept);
				(plugin.app.vault.modify as ReturnType<typeof vi.fn>).mockClear();

				const skipped = await store.rejectAll("thread-1");

				expect(skipped).toEqual([]);
				expect(plugin.app.vault.modify).toHaveBeenCalledWith(expect.anything(), original);
			});

			it("does not re-revert on a second rejectAll", async () => {
				const { id, original, afterGroupAccept } = await stagePartiallyAccepted();
				store.rejectChangeGroup(id, 0);

				plugin.app.vault.read = vi.fn().mockResolvedValue(afterGroupAccept);
				await store.rejectAll("thread-1");

				// The user edits the note after the revert. A second rejectAll must not
				// clobber that with the now-stale pre-proposal snapshot.
				plugin.app.vault.read = vi.fn().mockResolvedValue("my own later edits\n");
				(plugin.app.vault.modify as ReturnType<typeof vi.fn>).mockClear();

				const skipped = await store.rejectAll("thread-1");

				expect(plugin.app.vault.modify).not.toHaveBeenCalled();
				expect(skipped).toEqual([]);
				void original;
			});

			/**
			 * The bar renders `getActionableForThread`. If that returned only pending
			 * entries, a thread whose sole entry was fully resolved at group level would
			 * render nothing — stranding the applied text with no way to reach the undo.
			 */
			/**
			 * Regression (review of PR #411): accepting EVERY group flips the entry to
			 * `accepted` while `initialOriginalContent` stayed set, so `rejectAll` — which
			 * selects on that snapshot — reverted a change the user had explicitly
			 * accepted, silently discarding it. The snapshot is now cleared the moment the
			 * outcome settles, so it only ever means "unreviewed partial write present".
			 */
			it("does not revert an update whose groups were ALL accepted", async () => {
				const { id, afterGroupAccept } = await stagePartiallyAccepted();

				// Accept the one remaining group; the entry completes.
				plugin.app.vault.read = vi.fn().mockResolvedValue(afterGroupAccept);
				await store.acceptChangeGroup(id, 0);
				expect(store.getEntry(id)?.status).toBe("accepted");

				// A second, unrelated entry keeps the thread's Reject All live.
				store.addChanges([{ type: "create", path: "other.md", content: "X" }], "tc-2", "thread-1");

				expect(store.hasUnrevertedApplication(store.getEntry(id)!)).toBe(false);
				expect(store.getActionableForThread("thread-1").map((e) => e.id)).not.toContain(id);

				(plugin.app.vault.modify as ReturnType<typeof vi.fn>).mockClear();
				await store.rejectAll("thread-1");

				// The accepted note must be left exactly as the user accepted it.
				expect(plugin.app.vault.modify).not.toHaveBeenCalled();
			});

			it("does not revert after a whole-entry accept following a group accept", async () => {
				const { id, afterGroupAccept } = await stagePartiallyAccepted();

				// Accept the rest of the entry via the row-level action rather than groups.
				plugin.app.vault.read = vi.fn().mockResolvedValue(afterGroupAccept);
				await store.acceptChange(id);
				expect(store.getEntry(id)?.status).toBe("accepted");

				store.addChanges([{ type: "create", path: "other.md", content: "X" }], "tc-2", "thread-1");
				expect(store.hasUnrevertedApplication(store.getEntry(id)!)).toBe(false);

				(plugin.app.vault.modify as ReturnType<typeof vi.fn>).mockClear();
				await store.rejectAll("thread-1");

				expect(plugin.app.vault.modify).not.toHaveBeenCalled();
			});

			/**
			 * Regression (review of PR #411): `#handleFileRename` skipped non-pending
			 * entries, so a group-resolved entry kept a stale path after its note was
			 * renamed. The revert then looked up a file that no longer existed there and
			 * reported success while the applied content sat at the new path.
			 */
			it("follows a rename of a note that still has applied content", async () => {
				// `load()` is what registers the vault rename handler.
				await store.load();
				const { id, original, afterGroupAccept } = await stagePartiallyAccepted();
				store.rejectChangeGroup(id, 0);
				expect(store.getEntry(id)?.status).toBe("rejected");

				// The vault rename handler fires for the non-pending entry too.
				const renameCb = (plugin.app.vault.on as ReturnType<typeof vi.fn>).mock.calls.find(
					(c) => c[0] === "rename",
				)?.[1] as (file: { path: string }, oldPath: string) => void;
				renameCb({ path: "renamed.md" }, "note.md");

				expect(store.getEntry(id)?.change.path).toBe("renamed.md");

				// The undo now targets the note where it actually lives.
				plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(makeTFile("renamed.md"));
				plugin.app.vault.read = vi.fn().mockResolvedValue(afterGroupAccept);
				(plugin.app.vault.modify as ReturnType<typeof vi.fn>).mockClear();

				const skipped = await store.undoAppliedGroups(id);

				expect(skipped).toBeUndefined();
				expect(plugin.app.vault.modify).toHaveBeenCalledWith(expect.anything(), original);
			});

			/**
			 * Regression (same review): a missing target returned `undefined` — the
			 * "success" signal — so the UI said the note was restored when nothing had
			 * been written, and the entry stayed actionable forever because the snapshot
			 * is only cleared on a real write.
			 */
			it("reports a missing note instead of claiming it was restored", async () => {
				const { id } = await stagePartiallyAccepted();
				store.rejectChangeGroup(id, 0);

				// The note was deleted (or moved while the plugin was unloaded).
				plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);
				(plugin.app.vault.modify as ReturnType<typeof vi.fn>).mockClear();

				const skipped = await store.undoAppliedGroups(id);

				expect(skipped).toEqual({ path: "note.md", reason: "missing" });
				expect(plugin.app.vault.modify).not.toHaveBeenCalled();
				// And it must not remain permanently unresolvable.
				expect(store.getActionableForThread("thread-1")).toEqual([]);
			});

			/*
			 * Audit of every path that resolves or discards an entry, to pin down the
			 * `initialOriginalContent` invariant ("applied content the user has not
			 * signed off on"). Three consecutive review escapes came from changing what
			 * that flag was used for without re-checking every reader, so each site is
			 * asserted here rather than reasoned about.
			 */
			it("keeps an entry actionable after a row-level reject", async () => {
				const { id } = await stagePartiallyAccepted();

				// rejectChange writes nothing to the vault, so the applied text remains.
				store.rejectChange(id);

				expect(store.getEntry(id)?.status).toBe("rejected");
				expect(store.hasUnrevertedApplication(store.getEntry(id)!)).toBe(true);
				expect(store.getActionableForThread("thread-1").map((e) => e.id)).toContain(id);
			});

			it("keeps an entry actionable when superseded by a newer proposal", async () => {
				const { id } = await stagePartiallyAccepted();

				// addChanges auto-rejects an older pending update for the same path+thread.
				store.addChanges(
					[{ type: "update", path: "note.md", originalContent: "x", newContent: "y" }],
					"tc-2",
					"thread-1",
				);

				expect(store.getEntry(id)?.status).toBe("rejected");
				// Its applied content is still on disk, so the undo must stay reachable.
				expect(store.getActionableForThread("thread-1").map((e) => e.id)).toContain(id);
			});

			it("survives a save/load round-trip", async () => {
				const { id } = await stagePartiallyAccepted();
				store.rejectChangeGroup(id, 0);

				// Persist, then rehydrate into a fresh store from the same serialized blob.
				let written = "";
				plugin.app.vault.adapter.write = vi.fn(async (_p: string, data: string) => {
					written = data;
				});
				await (store as unknown as { saveToDisk(): Promise<void> }).saveToDisk();

				plugin.app.vault.adapter.exists = vi.fn().mockResolvedValue(true);
				plugin.app.vault.adapter.read = vi.fn(async () => written);
				const reloaded = new PendingChangesStore(plugin);
				await reloaded.load();

				// The applied content is still in the vault after a restart, so the entry
				// must come back actionable rather than being forgotten.
				expect(reloaded.hasUnrevertedApplication(reloaded.getEntry(id)!)).toBe(true);
				expect(reloaded.getActionableForThread("thread-1").map((e) => e.id)).toContain(id);
			});

			it("removeThread discards stranded content but says so", async () => {
				const warn = vi.spyOn(Logger, "warn").mockImplementation(() => {});
				const { id } = await stagePartiallyAccepted();
				store.rejectChangeGroup(id, 0);

				// Deleting the chat removes its rows — there is no surface left to review
				// them on — but the note keeps the applied text, so that must not be silent.
				store.removeThread("thread-1");

				expect(store.getEntry(id)).toBeUndefined();
				expect(warn).toHaveBeenCalledWith(expect.stringContaining("note.md"));
				warn.mockRestore();
			});

			it("reports a group-resolved entry as still actionable", async () => {
				const { id } = await stagePartiallyAccepted();
				store.rejectChangeGroup(id, 0);

				expect(store.getPendingCount("thread-1")).toBe(0);
				// ...but the note still holds the accepted group, so the UI must show it.
				expect(store.getActionableForThread("thread-1").map((e) => e.id)).toEqual([id]);
				expect(store.hasUnrevertedApplication(store.getEntry(id)!)).toBe(true);
			});

			it("stops reporting it once the content has been undone", async () => {
				const { id, afterGroupAccept } = await stagePartiallyAccepted();
				store.rejectChangeGroup(id, 0);
				plugin.app.vault.read = vi.fn().mockResolvedValue(afterGroupAccept);

				await store.rejectAll("thread-1");

				expect(store.getActionableForThread("thread-1")).toEqual([]);
				expect(store.hasUnrevertedApplication(store.getEntry(id)!)).toBe(false);
			});

			it("undoAppliedGroups restores a single entry", async () => {
				const { id, original, afterGroupAccept } = await stagePartiallyAccepted();
				store.rejectChangeGroup(id, 0);
				plugin.app.vault.read = vi.fn().mockResolvedValue(afterGroupAccept);
				(plugin.app.vault.modify as ReturnType<typeof vi.fn>).mockClear();

				const skipped = await store.undoAppliedGroups(id);

				expect(skipped).toBeUndefined();
				expect(plugin.app.vault.modify).toHaveBeenCalledWith(expect.anything(), original);
				expect(store.getActionableForThread("thread-1")).toEqual([]);
			});

			it("undoAppliedGroups reports a skip without overwriting user edits", async () => {
				const { id } = await stagePartiallyAccepted();
				store.rejectChangeGroup(id, 0);
				plugin.app.vault.read = vi.fn().mockResolvedValue("my own later edits\n");
				(plugin.app.vault.modify as ReturnType<typeof vi.fn>).mockClear();

				const skipped = await store.undoAppliedGroups(id);

				expect(skipped).toEqual({ path: "note.md", reason: "conflict" });
				expect(plugin.app.vault.modify).not.toHaveBeenCalled();
			});

			it("reverts to the pre-proposal content when the file is untouched since", async () => {
				const { id, original, afterGroupAccept } = await stagePartiallyAccepted();

				// File still holds exactly what the group accept wrote.
				plugin.app.vault.read = vi.fn().mockResolvedValue(afterGroupAccept);
				(plugin.app.vault.modify as ReturnType<typeof vi.fn>).mockClear();

				const skipped = await store.rejectAll("thread-1");

				expect(skipped).toEqual([]);
				expect(plugin.app.vault.modify).toHaveBeenCalledWith(expect.anything(), original);
				expect(store.getEntry(id)?.status).toBe("rejected");
			});

			it("does NOT overwrite a note the user edited after the group accept", async () => {
				const { id } = await stagePartiallyAccepted();

				// User hand-edits the note in the editor after accepting the group.
				plugin.app.vault.read = vi.fn().mockResolvedValue("my own precious edits\n");
				(plugin.app.vault.modify as ReturnType<typeof vi.fn>).mockClear();

				const skipped = await store.rejectAll("thread-1");

				// Regression: this used to unconditionally modify() back to the
				// pre-proposal content, destroying the user's edits.
				expect(plugin.app.vault.modify).not.toHaveBeenCalled();
				expect(skipped).toEqual([{ path: "note.md", reason: "conflict" }]);
				// The proposal is still dead either way.
				expect(store.getEntry(id)?.status).toBe("rejected");
			});

			it("rejects every entry even when one revert is skipped", async () => {
				const { id } = await stagePartiallyAccepted();
				const [plainId] = store.addChanges(
					[{ type: "create", path: "other.md", content: "X" }],
					"tc-2",
					"thread-1",
				);

				plugin.app.vault.read = vi.fn().mockResolvedValue("conflicting content\n");

				const skipped = await store.rejectAll("thread-1");

				expect(skipped).toEqual([{ path: "note.md", reason: "conflict" }]);
				expect(store.getEntry(id)?.status).toBe("rejected");
				expect(store.getEntry(plainId)?.status).toBe("rejected");
				expect(store.getPendingCount("thread-1")).toBe(0);
			});

			it("reports the path when the revert write itself throws", async () => {
				const { afterGroupAccept } = await stagePartiallyAccepted();

				plugin.app.vault.read = vi.fn().mockResolvedValue(afterGroupAccept);
				plugin.app.vault.modify = vi.fn().mockRejectedValue(new Error("disk full"));

				const skipped = await store.rejectAll("thread-1");

				expect(skipped).toEqual([{ path: "note.md", reason: "failed" }]);
			});
		});
	});

	/* --------------------------------------------------------------------------
	 * hasConflict
	 * ------------------------------------------------------------------------*/

	describe("hasConflict", () => {
		it("should return false for create changes", async () => {
			const [id] = store.addChanges([{ type: "create", path: "new.md", content: "Hello" }], "tc-1", "thread-1");

			expect(await store.hasConflict(id)).toBe(false);
		});

		it("should return true when file content has changed", async () => {
			const file = makeTFile("note.md");
			(plugin.app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(file);
			(plugin.app.vault.read as ReturnType<typeof vi.fn>).mockResolvedValue("externally modified");

			const [id] = store.addChanges(
				[
					{
						type: "update",
						path: "note.md",
						originalContent: "original",
						newContent: "new",
					},
				],
				"tc-1",
				"thread-1",
			);

			expect(await store.hasConflict(id)).toBe(true);
		});

		it("should return false when file content matches", async () => {
			const file = makeTFile("note.md");
			(plugin.app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(file);
			(plugin.app.vault.read as ReturnType<typeof vi.fn>).mockResolvedValue("original");

			const [id] = store.addChanges(
				[
					{
						type: "update",
						path: "note.md",
						originalContent: "original",
						newContent: "new",
					},
				],
				"tc-1",
				"thread-1",
			);

			expect(await store.hasConflict(id)).toBe(false);
		});

		it("should return true when file was deleted externally", async () => {
			(plugin.app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(null);

			const [id] = store.addChanges(
				[{ type: "delete", path: "deleted.md", originalContent: "content" }],
				"tc-1",
				"thread-1",
			);

			expect(await store.hasConflict(id)).toBe(true);
		});
	});

	/* --------------------------------------------------------------------------
	 * removeThread
	 * ------------------------------------------------------------------------*/

	describe("cleanup", () => {
		it("removeThread should remove all entries for a thread", () => {
			store.addChanges([{ type: "create", path: "a.md", content: "A" }], "tc-1", "thread-1");
			store.addChanges([{ type: "create", path: "b.md", content: "B" }], "tc-2", "thread-1");
			store.addChanges([{ type: "create", path: "c.md", content: "C" }], "tc-3", "thread-2");

			store.removeThread("thread-1");

			expect(store.getEntriesForThread("thread-1")).toHaveLength(0);
			expect(store.getEntriesForThread("thread-2")).toHaveLength(1);
		});

		/**
		 * `AgentManager.deleteThread` calls this. Before that wiring, a deleted chat
		 * left its staged changes in pending-changes.json forever: the vault `delete`
		 * handler in main.ts is gated on `isAgentFilePath`, so a removed `.chat` never
		 * reached this store. The entries stayed keyed to a thread that no longer
		 * existed, kept being tracked by the rename handler, and were unreachable from
		 * any UI.
		 */
		it("clears entries that no UI could otherwise reach again", () => {
			const [pendingId] = store.addChanges(
				[{ type: "update", path: "note.md", originalContent: "a", newContent: "b" }],
				"tc-1",
				"Chats/gone.chat",
			);
			const [resolvedId] = store.addChanges(
				[{ type: "create", path: "other.md", content: "X" }],
				"tc-2",
				"Chats/gone.chat",
			);
			store.rejectChange(resolvedId);

			store.removeThread("Chats/gone.chat");

			// Both statuses go — the thread is gone, so neither is reviewable.
			expect(store.getEntry(pendingId)).toBeUndefined();
			expect(store.getEntry(resolvedId)).toBeUndefined();
			expect(store.getPendingCount("Chats/gone.chat")).toBe(0);
		});
	});

	/* --------------------------------------------------------------------------
	 * takeReviewOutcomesForThread — model feedback
	 * ------------------------------------------------------------------------*/

	describe("takeReviewOutcomesForThread", () => {
		it("reports resolved entries once and pending proposals every time", async () => {
			const file = makeTFile("a.md");
			(plugin.app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(file);
			(plugin.app.vault.read as ReturnType<typeof vi.fn>).mockResolvedValue("x");

			const [acceptedId] = store.addChanges(
				[{ type: "update", path: "a.md", originalContent: "x", newContent: "y" }],
				"tc-1",
				"thread-1",
			);
			const [rejectedId] = store.addChanges([{ type: "create", path: "b.md", content: "B" }], "tc-2", "thread-1");
			store.addChanges([{ type: "create", path: "c.md", content: "C" }], "tc-3", "thread-1");
			// Another thread's entry must not leak into this thread's report.
			store.addChanges([{ type: "create", path: "d.md", content: "D" }], "tc-4", "thread-2");

			await store.acceptChange(acceptedId);
			store.rejectChange(rejectedId);

			const first = store.takeReviewOutcomesForThread("thread-1");
			expect(first.outcomes).toEqual([
				{ path: "a.md", outcome: "accepted" },
				{ path: "b.md", outcome: "rejected" },
			]);
			// Pending proposals carry the id the model discards by — this repeating
			// every turn is what keeps an id reachable once the staging tool result
			// has fallen out of context.
			expect(first.pendingProposals).toEqual([{ path: "c.md", shortId: expect.any(String) }]);

			// Resolved outcomes are delivered exactly once; pending repeats.
			const second = store.takeReviewOutcomesForThread("thread-1");
			expect(second.outcomes).toEqual([]);
			expect(second.pendingProposals).toEqual(first.pendingProposals);
		});

		it("reports a group-resolved entry with applied text as partially applied", async () => {
			const original = "line1\nline2\nline3\n";
			const updated = "line1\nCHANGED\nline3\nADDED\n";
			const file = makeTFile("note.md");
			(plugin.app.vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(file);
			(plugin.app.vault.read as ReturnType<typeof vi.fn>).mockResolvedValue(original);

			const [id] = store.addChanges(
				[{ type: "update", path: "note.md", originalContent: original, newContent: updated }],
				"tc-1",
				"thread-1",
			);
			await store.acceptChangeGroup(id, 0);
			store.rejectChangeGroup(id, 0);
			expect(store.getEntry(id)?.status).toBe("rejected");
			expect(store.hasUnrevertedApplication(store.getEntry(id)!)).toBe(true);

			const { outcomes } = store.takeReviewOutcomesForThread("thread-1");
			expect(outcomes).toEqual([{ path: "note.md", outcome: "partially" }]);
		});
	});

	/* --------------------------------------------------------------------------
	 * load — orphaned-thread pruning
	 * ------------------------------------------------------------------------*/

	describe("load orphan pruning", () => {
		/**
		 * A `.chat` deleted outside the app (or while the plugin was unloaded) never
		 * reaches `removeThread`. Its entries were invisible in every per-thread bar
		 * yet still counted by `countOtherThreadsPendingUpdate` — a permanent
		 * "another chat is editing this file" banner with no chat to resolve it from.
		 */
		it("drops entries whose chat file no longer exists", async () => {
			const persisted = JSON.stringify([
				{
					id: "01a00000-0000-7000-8000-000000000001",
					change: { type: "update", path: "note.md", originalContent: "a", newContent: "b" },
					status: "pending",
					toolCallId: "tc-1",
					threadId: "Chats/alive.chat",
					createdAt: 1,
				},
				{
					id: "01a00000-0000-7000-8000-000000000002",
					change: { type: "update", path: "note.md", originalContent: "a", newContent: "c" },
					status: "pending",
					toolCallId: "tc-2",
					threadId: "Chats/gone.chat",
					createdAt: 2,
				},
				{
					// Non-.chat thread key (api staging path) — never existence-checked.
					id: "01a00000-0000-7000-8000-000000000003",
					change: { type: "create", path: "api.md", content: "X" },
					status: "pending",
					toolCallId: "tc-3",
					threadId: "api-thread",
					createdAt: 3,
				},
			]);
			(plugin.app.vault.adapter.read as ReturnType<typeof vi.fn>).mockResolvedValue(persisted);
			(plugin.app.vault.adapter.exists as ReturnType<typeof vi.fn>).mockImplementation(
				async (path: string) => path !== "Chats/gone.chat",
			);

			await store.load();

			expect(store.getPendingCount("Chats/alive.chat")).toBe(1);
			expect(store.getPendingCount("Chats/gone.chat")).toBe(0);
			expect(store.getPendingCount("api-thread")).toBe(1);
			// The orphan no longer inflates cross-thread collision counts.
			expect(store.countOtherThreadsPendingUpdate("note.md", "Chats/alive.chat")).toBe(0);
		});
	});

	/* --------------------------------------------------------------------------
	 * isPathAllowed / isFilePrivate / shouldBlockFile
	 * ------------------------------------------------------------------------*/

	describe("path filtering", () => {
		it("isPathAllowed should allow normal vault files", () => {
			expect(store.isPathAllowed("any/path.md")).toBe(true);
		});

		it("isPathAllowed should exclude internal chat files", () => {
			const mockGetData = getData as ReturnType<typeof vi.fn>;
			mockGetData.mockReturnValue({
				targetFolder: "Chats",
				isFilePrivate: vi.fn(() => false),
				isProviderTrusted: vi.fn(() => false),
			});

			expect(store.isPathAllowed("Chats/test.md")).toBe(false);
			expect(store.isPathAllowed("Notes/test.md")).toBe(true);
		});

		it("isPathAllowed should allow Excalidraw files", () => {
			expect(store.isPathAllowed("Canvas/diagram.excalidraw.md")).toBe(true);
		});

		it("isFilePrivate should delegate to the data store privacy check", () => {
			const mockGetData = getData as ReturnType<typeof vi.fn>;
			mockGetData.mockReturnValue({
				targetFolder: "Chats",
				isFilePrivate: vi.fn((path: string) => path.startsWith("secret/")),
				isProviderTrusted: vi.fn(() => false),
			});

			expect(store.isFilePrivate("secret/diary.md")).toBe(true);
			expect(store.isFilePrivate("public/note.md")).toBe(false);
		});

		it("shouldBlockFile should block private files for untrusted providers", () => {
			const mockGetData = getData as ReturnType<typeof vi.fn>;
			mockGetData.mockReturnValue({
				targetFolder: "Chats",
				isFilePrivate: vi.fn((path: string) => path.startsWith("secret/")),
				isProviderTrusted: vi.fn(() => false),
			});

			expect(store.shouldBlockFile("secret/diary.md", "openai")).toBe(true);
			expect(store.shouldBlockFile("public/note.md", "openai")).toBe(false);
		});

		it("shouldBlockFile should allow private files for trusted providers", () => {
			const mockGetData = getData as ReturnType<typeof vi.fn>;
			mockGetData.mockReturnValue({
				targetFolder: "Chats",
				isFilePrivate: vi.fn((path: string) => path.startsWith("secret/")),
				isProviderTrusted: vi.fn(() => true),
			});

			expect(store.shouldBlockFile("secret/diary.md", "ollama")).toBe(false);
		});

		it("isFilePrivate should respect whatever policy the data store exposes", () => {
			const mockGetData = getData as ReturnType<typeof vi.fn>;
			mockGetData.mockReturnValue({
				targetFolder: "Chats",
				isFilePrivate: vi.fn((path: string) => path.toLowerCase().endsWith(".pdf")),
				isProviderTrusted: vi.fn(() => false),
			});

			expect(store.isFilePrivate("Docs/spec.pdf")).toBe(true);
			expect(store.isFilePrivate("Docs/spec.md")).toBe(false);
		});
	});

	/* ----------------------------------------------------------------------
	 * discardPendingById — the agent's retraction path (manage_notes discard)
	 * --------------------------------------------------------------------*/

	describe("discardPendingById", () => {
		function stage(path: string, threadId = "thread-1") {
			const [id] = store.addChanges([{ type: "create", path, content: "x" }], "tc-1", threadId);
			return store.getEntry(id)!;
		}

		it("withdraws the entry with that short id", () => {
			const entry = stage("note.md");

			expect(store.discardPendingById(entry.shortId!, "thread-1")).toBe("discarded");
			expect(store.getEntry(entry.id)?.status).toBe("rejected");
			expect(store.getPendingCount("thread-1")).toBe(0);
		});

		it("withdraws only that entry, not others in the thread", () => {
			const target = stage("a.md");
			const other = stage("b.md");

			store.discardPendingById(target.shortId!, "thread-1");

			expect(store.getEntry(other.id)?.status).toBe("pending");
		});

		it("will not reach another thread's proposal", () => {
			const theirs = stage("note.md", "thread-2");

			// Correct id, wrong thread — another chat's proposal is not ours to drop.
			expect(store.discardPendingById(theirs.shortId!, "thread-1")).toBe("not_found");
			expect(store.getEntry(theirs.id)?.status).toBe("pending");
		});

		it("reports not_found for an unknown id rather than throwing", () => {
			expect(store.discardPendingById("nosuch", "thread-1")).toBe("not_found");
		});

		it("refuses an entry whose groups the user already partly applied", async () => {
			// Two separated change groups, so accepting one leaves the entry pending
			// with applied content on disk (a single group would accept it outright).
			const original = "a\nkeep\nb\n";
			const [id] = store.addChanges(
				[{ type: "update", path: "note.md", originalContent: original, newContent: "A\nkeep\nB\n" }],
				"tc-1",
				"thread-1",
			);
			vi.mocked(plugin.app.vault.getAbstractFileByPath).mockReturnValue(makeTFile("note.md"));
			vi.mocked(plugin.app.vault.read).mockResolvedValue(original);
			await store.acceptChangeGroup(id, 0);

			const entry = store.getEntry(id)!;
			expect(store.hasUnrevertedApplication(entry)).toBe(true);
			// That text is on disk because the USER accepted it; resolving the entry
			// would discard their only undo record.
			expect(store.discardPendingById(entry.shortId!, "thread-1")).toBe("partially_applied");
			expect(store.getEntry(id)?.status).toBe("pending");
		});

		it("getPendingByShortId is scoped the same way", () => {
			const entry = stage("note.md");

			expect(store.getPendingByShortId(entry.shortId!, "thread-1")?.id).toBe(entry.id);
			expect(store.getPendingByShortId(entry.shortId!, "other-thread")).toBeUndefined();

			store.discardPendingById(entry.shortId!, "thread-1");
			// Resolved entries are not pending, so they are no longer addressable.
			expect(store.getPendingByShortId(entry.shortId!, "thread-1")).toBeUndefined();
		});
	});

	/**
	 * Short ids ARE the retraction mechanism — `discard` takes one and the model
	 * has no other handle on a proposal. A collision would aim a discard at the
	 * wrong note; a missing id would make one unreachable.
	 */
	describe("short ids", () => {
		it("are unique across a same-millisecond batch", () => {
			// UUIDv7's leading bits are a timestamp, so entries staged together share
			// a long prefix — a leading-slice id would collide on every one of these.
			const ids = store.addChanges(
				Array.from({ length: 25 }, (_, i) => ({
					type: "create" as const,
					path: `note-${i}.md`,
					content: "x",
				})),
				"tc-1",
				"thread-1",
			);

			const shortIds = ids.map((id) => store.getEntry(id)?.shortId);
			expect(shortIds.every(Boolean)).toBe(true);
			expect(new Set(shortIds).size).toBe(ids.length);
		});

		it("do not collide with ids staged in an earlier batch", () => {
			const first = store.addChanges([{ type: "create", path: "a.md", content: "x" }], "tc-1", "thread-1");
			const second = store.addChanges([{ type: "create", path: "b.md", content: "x" }], "tc-2", "thread-1");

			expect(store.getEntry(first[0])?.shortId).not.toBe(store.getEntry(second[0])?.shortId);
		});

		it("survive a save/load round-trip", async () => {
			await store.load();
			const [id] = store.addChanges([{ type: "create", path: "a.md", content: "x" }], "tc-1", "thread-1");
			const shortId = store.getEntry(id)?.shortId;

			// Through the store's OWN save path and the persistence schema, which
			// would silently strip an unknown key and make the entry undiscardable.
			store.cleanup();
			await vi.waitFor(() => expect(plugin.app.vault.adapter.write).toHaveBeenCalled());
			const written = vi.mocked(plugin.app.vault.adapter.write).mock.calls.at(-1)?.[1] as string;
			expect(written).toContain("shortId");

			const fresh = new PendingChangesStore(plugin);
			vi.mocked(plugin.app.vault.adapter.exists).mockResolvedValue(true);
			vi.mocked(plugin.app.vault.adapter.read).mockResolvedValue(written);
			await fresh.load();

			expect(fresh.getPendingByShortId(shortId!, "thread-1")).toBeDefined();
		});

		it("are backfilled for entries persisted before short ids existed", async () => {
			// Without this such an entry could never be named, so it would sit in the
			// review queue permanently undiscardable.
			const legacy = JSON.stringify([
				{
					id: "01a0430a-d52a-702a-8711-8436ab485534",
					change: { type: "create", path: "old.md", content: "x" },
					status: "pending",
					toolCallId: "tc-old",
					threadId: "thread-1",
					createdAt: 1,
				},
			]);
			vi.mocked(plugin.app.vault.adapter.exists).mockResolvedValue(true);
			vi.mocked(plugin.app.vault.adapter.read).mockResolvedValue(legacy);

			await store.load();

			const entry = store.getPendingForThread("thread-1")[0];
			expect(entry?.shortId).toBeTruthy();
			expect(store.discardPendingById(entry.shortId!, "thread-1")).toBe("discarded");
		});
	});

	describe("replace_pending-style supersede keeps the undo reachable", () => {
		it("keeps the superseded entry's applied content resolvable", async () => {
			const original = "a\nkeep\nb\n";
			const [id] = store.addChanges(
				[{ type: "update", path: "note.md", originalContent: original, newContent: "A\nkeep\nB\n" }],
				"tc-1",
				"thread-1",
			);
			vi.mocked(plugin.app.vault.getAbstractFileByPath).mockReturnValue(makeTFile("note.md"));
			vi.mocked(plugin.app.vault.read).mockResolvedValue(original);
			await store.acceptChangeGroup(id, 0);

			// What `replace_pending` produces: a proposal staged against DISK, which
			// already contains the accepted group.
			store.addChanges(
				[{ type: "update", path: "note.md", originalContent: "A\nkeep\nb\n", newContent: "A\nkeep\nZ\n" }],
				"tc-2",
				"thread-1",
			);

			const superseded = store.getEntry(id)!;
			expect(superseded.status).toBe("rejected");
			// Both invariants: the text is on disk, so the undo record must survive.
			expect(store.hasUnrevertedApplication(superseded)).toBe(true);
			expect(store.getActionableForThread("thread-1").map((e) => e.id)).toContain(id);
		});
	});

	describe("withdrawForToolCalls (edit/regenerate fork)", () => {
		it("rejects pending entries staged by the abandoned tool calls and marks them reported", () => {
			const [id] = store.addChanges(
				[{ type: "update", path: "a.md", originalContent: "x", newContent: "y" }],
				"tc-abandoned",
				"thread-1",
			);

			const result = store.withdrawForToolCalls("thread-1", new Set(["tc-abandoned"]));

			expect(result).toEqual({ withdrawn: 1, keptPartiallyApplied: 0 });
			const entry = store.getEntry(id)!;
			expect(entry.status).toBe("rejected");
			// The new branch's model never made this proposal, so it must NOT be
			// told "rejected by the user" in the next review-outcome block.
			expect(entry.reportedToModel).toBe(true);
			expect(store.takeReviewOutcomesForThread("thread-1")).toEqual({ outcomes: [], pendingProposals: [] });
		});

		it("leaves other threads' and other tool calls' entries pending", () => {
			const [keptSameThread] = store.addChanges(
				[{ type: "create", path: "kept.md", content: "c" }],
				"tc-kept",
				"thread-1",
			);
			const [otherThread] = store.addChanges(
				[{ type: "create", path: "other.md", content: "c" }],
				"tc-abandoned",
				"thread-2",
			);
			const [withdrawnId] = store.addChanges(
				[{ type: "create", path: "gone.md", content: "c" }],
				"tc-abandoned",
				"thread-1",
			);

			const result = store.withdrawForToolCalls("thread-1", new Set(["tc-abandoned"]));

			expect(result.withdrawn).toBe(1);
			expect(store.getEntry(keptSameThread)!.status).toBe("pending");
			expect(store.getEntry(otherThread)!.status).toBe("pending");
			expect(store.getEntry(withdrawnId)!.status).toBe("rejected");
		});

		it("keeps entries holding unreverted partially-applied content untouched", async () => {
			const original = "a\nkeep\nb\n";
			const [id] = store.addChanges(
				[{ type: "update", path: "note.md", originalContent: original, newContent: "A\nkeep\nB\n" }],
				"tc-abandoned",
				"thread-1",
			);
			vi.mocked(plugin.app.vault.getAbstractFileByPath).mockReturnValue(makeTFile("note.md"));
			vi.mocked(plugin.app.vault.read).mockResolvedValue(original);
			await store.acceptChangeGroup(id, 0);

			const result = store.withdrawForToolCalls("thread-1", new Set(["tc-abandoned"]));

			expect(result).toEqual({ withdrawn: 0, keptPartiallyApplied: 1 });
			// Still pending: the user accepted part of it, so it stays theirs to
			// resolve — withdrawing would discard the only undo record.
			expect(store.getEntry(id)!.status).toBe("pending");
			expect(store.hasUnrevertedApplication(store.getEntry(id)!)).toBe(true);
		});

		it("does not bump the revision when nothing matches", () => {
			store.addChanges([{ type: "create", path: "kept.md", content: "c" }], "tc-kept", "thread-1");
			const before = store.revision;

			const result = store.withdrawForToolCalls("thread-1", new Set(["tc-unknown"]));

			expect(result).toEqual({ withdrawn: 0, keptPartiallyApplied: 0 });
			expect(store.revision).toBe(before);
		});
	});
});
