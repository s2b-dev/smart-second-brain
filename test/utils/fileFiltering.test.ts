import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

import { installAgentPathSource } from "../../src/utils/agentPathSource";

// isIndexableFile/isAgentFilePath resolve the agent folder through the installed
// AgentPathSource (the data store at runtime). isAgentPath itself is pure (folder passed
// explicitly).
installAgentPathSource({ agentFolder: () => "Agents", agentName: () => undefined });

import {
	extractExcalidrawContent,
	hasNoEmbeddableText,
	isAgentFilePath,
	isAgentPath,
	isEmbeddableFile,
	isExcalidrawPath,
	isIndexableFile,
	readIndexableContent,
} from "../../src/utils/fileFiltering";
import { deflateThreadData } from "../../src/agent/threadDataCodec";
import { gzipString, toArrayBuffer } from "../../src/utils/gzip";

describe("isAgentPath (pure)", () => {
	it("matches the folder itself and files inside it", () => {
		expect(isAgentPath("Agents", "Agents")).toBe(true);
		expect(isAgentPath("Agents/Skills/dataview/SKILL.md", "Agents")).toBe(true);
		expect(isAgentPath("Agents/Memories/notes.md", "Agents")).toBe(true);
		expect(isAgentPath("Agents/Base Prompts/default-agent.md", "Agents")).toBe(true);
	});

	it("does not match sibling folders or lookalike prefixes", () => {
		expect(isAgentPath("Notes/x.md", "Agents")).toBe(false);
		expect(isAgentPath("AgentsExtra/x.md", "Agents")).toBe(false);
		expect(isAgentPath("MyAgents/x.md", "Agents")).toBe(false);
	});

	it("respects a custom / nested agent folder and tolerates leading slashes", () => {
		expect(isAgentPath("Meta/Agents/Skills/x/SKILL.md", "Meta/Agents")).toBe(true);
		expect(isAgentPath("/Agents/Skills/x/SKILL.md", "Agents")).toBe(true);
		expect(isAgentPath("Agents/x.md", "Meta/Agents")).toBe(false);
	});

	it("never matches when the folder is empty", () => {
		expect(isAgentPath("anything.md", "")).toBe(false);
	});
});

describe("isAgentFilePath / isIndexableFile (folder from plugin data)", () => {
	it("isAgentFilePath reads the configured agent folder", () => {
		installAgentPathSource({ agentFolder: () => "Agents", agentName: () => undefined });
		expect(isAgentFilePath("Agents/Skills/foo/SKILL.md")).toBe(true);
		expect(isAgentFilePath("Agents/Memories/x.md")).toBe(true);
		expect(isAgentFilePath("Projects/foo.md")).toBe(false);
	});

	it("isIndexableFile excludes agent-folder files and includes normal notes", () => {
		installAgentPathSource({ agentFolder: () => "Agents", agentName: () => undefined });
		expect(isIndexableFile({ path: "Agents/Skills/foo/SKILL.md" } as never)).toBe(false);
		expect(isIndexableFile({ path: "Agents/Base Prompts/default-agent.md" } as never)).toBe(false);
		expect(isIndexableFile({ path: "Projects/note.md" } as never)).toBe(true);
	});

	it("tracks a custom folder", () => {
		installAgentPathSource({ agentFolder: () => "Meta/Agents", agentName: () => undefined });
		expect(isAgentFilePath("Meta/Agents/Skills/foo/SKILL.md")).toBe(true);
		expect(isAgentFilePath("Agents/Skills/foo/SKILL.md")).toBe(false);
	});

	it("fails open when the data store is uninitialized", () => {
		installAgentPathSource(null);
		expect(isAgentFilePath("Agents/Skills/foo/SKILL.md")).toBe(false);
		installAgentPathSource({ agentFolder: () => "Agents", agentName: () => undefined });
	});
});

// ---------------------------------------------------------------------------
// .chat extraction
// ---------------------------------------------------------------------------

/** Build a LangChain-serialised message as stored inside a checkpoint. */
function message(id: string | null, content: unknown, messageClass = "HumanMessage"): Record<string, unknown> {
	const kwargs: Record<string, unknown> = { content };
	if (id !== null) kwargs.id = id;
	return { lc: 1, type: "constructor", id: ["langchain_core", "messages", messageClass], kwargs };
}

/** Assistant reply that ends a turn. */
function reply(id: string, content: unknown) {
	return message(id, content, "AIMessage");
}

/** Assistant message that only announces a tool call (mid-turn narration). */
function narration(id: string, content: string) {
	const msg = message(id, content, "AIMessage");
	(msg.kwargs as Record<string, unknown>).tool_calls = [{ name: "search_notes", args: {} }];
	return msg;
}

/** A tool result, which must never reach the index. */
function toolResult(id: string, content: string) {
	return message(id, content, "ToolMessage");
}

/**
 * Build thread JSON whose checkpoints form a growing prefix chain — the shape
 * LangGraph actually persists, where checkpoint N re-contains messages 1..N and
 * links to N-1 via `parentConfig`.
 */
function thread(title: string, messages: Array<Record<string, unknown>>, tsBase = 1): string {
	const checkpoints: Record<string, unknown> = {};
	for (let i = 1; i <= messages.length; i++) {
		checkpoints[`cp-${i}`] = {
			checkpoint: {
				id: `cp-${i}`,
				ts: `2026-01-01T00:00:${String(tsBase + i).padStart(2, "0")}.000Z`,
				channel_values: { messages: messages.slice(0, i) },
			},
			metadata: { step: i },
			...(i > 1 ? { parentConfig: { configurable: { checkpoint_id: `cp-${i - 1}` } } } : {}),
		};
	}
	return JSON.stringify({ title, checkpoints });
}

/**
 * Build a thread that forks: `common` messages, then two competing continuations
 * from the same parent. `newer` carries the later timestamp, so it is the branch
 * the chat UI would show.
 */
function forkedThread(
	title: string,
	common: Array<Record<string, unknown>>,
	older: Array<Record<string, unknown>>,
	newer: Array<Record<string, unknown>>,
): string {
	const parsed = JSON.parse(thread(title, common));
	const forkPoint = `cp-${common.length}`;
	parsed.checkpoints["cp-old"] = {
		checkpoint: {
			id: "cp-old",
			ts: "2026-01-01T00:01:00.000Z",
			channel_values: { messages: [...common, ...older] },
		},
		metadata: { step: common.length + 1 },
		parentConfig: { configurable: { checkpoint_id: forkPoint } },
	};
	parsed.checkpoints["cp-new"] = {
		checkpoint: {
			id: "cp-new",
			ts: "2026-01-01T00:02:00.000Z",
			channel_values: { messages: [...common, ...newer] },
		},
		metadata: { step: common.length + 1 },
		parentConfig: { configurable: { checkpoint_id: forkPoint } },
	};
	return JSON.stringify(parsed);
}

/** Minimal vault stub exposing the `adapter.readBinary` path used for .chat files. */
function vaultReturning(raw: string | Uint8Array) {
	return {
		adapter: {
			readBinary: vi.fn().mockImplementation(async () => {
				const bytes = typeof raw === "string" ? await gzipString(raw) : raw;
				return toArrayBuffer(bytes);
			}),
		},
	} as never;
}

const chatFile = { path: "Chats/Thread.chat", extension: "chat", basename: "Thread" } as never;

describe("readIndexableContent (.chat extraction)", () => {
	it("emits each message once despite the checkpoint tree repeating it", async () => {
		const raw = thread("Greeting", [
			message("m1", "hello there"),
			reply("m2", "general kenobi"),
			message("m3", "you are a bold one"),
			reply("m4", "back away"),
		]);

		const out = await readIndexableContent(vaultReturning(raw), chatFile);

		// Naive per-checkpoint concatenation would emit m1 four times and m2 three times.
		expect(out.match(/hello there/g)).toHaveLength(1);
		expect(out.match(/general kenobi/g)).toHaveLength(1);
		expect(out.match(/you are a bold one/g)).toHaveLength(1);
	});

	it("extracts an oversized v2 chat file on mobile, but keeps legacy files title-only", async () => {
		const { Platform } = await import("obsidian");
		const legacyRaw = thread("Big", [message("m1", "needle in the legacy file"), reply("m2", "found it")]);
		const v2Raw = JSON.stringify(deflateThreadData(JSON.parse(legacyRaw)));
		// Over the 2MB legacy gate (stat.size is the compressed on-disk size).
		const bigChatFile = {
			path: "Chats/Big.chat",
			extension: "chat",
			basename: "Big",
			stat: { size: 3 * 1024 * 1024 },
		} as never;

		(Platform as { isMobile: boolean }).isMobile = true;
		try {
			expect(await readIndexableContent(vaultReturning(legacyRaw), bigChatFile)).toBe("");
			const out = await readIndexableContent(vaultReturning(v2Raw), bigChatFile);
			expect(out).toContain("needle in the legacy file");
			expect(out).toContain("found it");
		} finally {
			(Platform as { isMobile: boolean }).isMobile = false;
		}
	});

	it("extracts content from a v2 deduplicated thread file", async () => {
		const parsed = JSON.parse(thread("Dedup", [message("m1", "hello there"), reply("m2", "general kenobi")]));
		const raw = JSON.stringify(deflateThreadData(parsed));
		// Sanity: the checkpoints really reference messages via the table.
		expect(raw).toContain('"$msg"');

		const out = await readIndexableContent(vaultReturning(raw), chatFile);

		expect(out).toContain("hello there");
		expect(out).toContain("general kenobi");
	});

	it("pairs each question with its answer in transcript order", async () => {
		const raw = thread("Greeting", [
			message("m1", "first question"),
			reply("m2", "first answer"),
			message("m3", "second question"),
			reply("m4", "second answer"),
		]);

		const out = await readIndexableContent(vaultReturning(raw), chatFile);

		expect(out).toBe("Greeting\n\nfirst question\n\nfirst answer\n\nsecond question\n\nsecond answer");
	});

	it("keeps only the active branch when an answer was regenerated", async () => {
		const raw = forkedThread(
			"Regenerated",
			[message("m1", "what is it")],
			[reply("old", "discarded answer")],
			[reply("new", "kept answer")],
		);

		const out = await readIndexableContent(vaultReturning(raw), chatFile);

		expect(out).toContain("kept answer");
		expect(out).not.toContain("discarded answer");
		expect(out).toContain("what is it");
	});

	it("drops mid-turn narration that only announces a tool call", async () => {
		const raw = thread("Narrated", [
			message("m1", "find the note"),
			narration("m2", "I'll search the vault for that."),
			toolResult("m3", "hit: Some Note.md"),
			reply("m4", "Found it in Some Note."),
		]);

		const out = await readIndexableContent(vaultReturning(raw), chatFile);

		expect(out).toBe("Narrated\n\nfind the note\n\nFound it in Some Note.");
	});

	it("keeps the last answer when a turn ends with several assistant messages", async () => {
		const raw = thread("Multi", [message("m1", "q"), reply("m2", "partial"), reply("m3", "final answer")]);

		const out = await readIndexableContent(vaultReturning(raw), chatFile);

		expect(out).toContain("final answer");
		expect(out).not.toContain("partial");
	});

	it("strips appended context blocks from the user's question", async () => {
		const raw = thread("Context", [
			message("m1", "what can you see\n\n[Currently visible notes]\n- Large Notes/Distributed Systems.md"),
			reply("m2", "I can see one note."),
		]);

		const out = await readIndexableContent(vaultReturning(raw), chatFile);

		expect(out).toContain("what can you see");
		expect(out).not.toContain("Distributed Systems");
		expect(out).not.toContain("Currently visible notes");
	});

	it("returns an empty string for corrupt thread JSON", async () => {
		const out = await readIndexableContent(vaultReturning("not json at all"), chatFile);

		expect(out).toBe("");
	});

	it("returns an empty string when the file cannot be read", async () => {
		const vault = {
			adapter: { readBinary: vi.fn().mockRejectedValue(new Error("unreadable")) },
		} as never;

		expect(await readIndexableContent(vault, chatFile)).toBe("");
	});

	it("skips tool results so notes are not indexed a second time inside a thread", async () => {
		const raw = thread("Research", [
			message("m1", "what does the note say?"),
			message(
				"m2",
				'Content of "Machine Learning Basics.md":\n\nGradient descent minimises loss.',
				"ToolMessage",
			),
			message("m3", "It covers gradient descent.", "AIMessage"),
		]);

		const out = await readIndexableContent(vaultReturning(raw), chatFile);

		expect(out).not.toContain("Gradient descent minimises loss");
		expect(out).toContain("what does the note say?");
		expect(out).toContain("It covers gradient descent.");
	});

	it("indexes assistant turns streamed as AIMessageChunk", async () => {
		const raw = thread("Streamed", [message("m1", "streamed reply", "AIMessageChunk")]);

		expect(await readIndexableContent(vaultReturning(raw), chatFile)).toContain("streamed reply");
	});

	it("skips messages whose class cannot be determined", async () => {
		const raw = JSON.stringify({
			title: "Odd",
			checkpoints: {
				"cp-1": { checkpoint: { channel_values: { messages: [{ kwargs: { content: "mystery" } }] } } },
			},
		});

		expect(await readIndexableContent(vaultReturning(raw), chatFile)).toBe("Odd");
	});

	it("keeps the typed question but drops the attached file from a multimodal turn", async () => {
		const raw = thread("Attachment", [
			message("m1", [
				{ type: "text", text: "what can you do" },
				{
					type: "text",
					text: "--- File: Start Here.md ---\nTaskNotes tour body\n--- End File ---",
					s2b_attachment: true,
				},
			]),
		]);

		const out = await readIndexableContent(vaultReturning(raw), chatFile);

		expect(out).toContain("what can you do");
		expect(out).not.toContain("TaskNotes tour body");
	});

	it("drops legacy attachment blocks that predate the s2b_attachment flag", async () => {
		const raw = thread("Legacy attachment", [
			message("m1", [
				{ type: "text", text: "summarise this" },
				{ type: "text", text: "--- PDF: paper.pdf (3 pages) ---\nabstract body\n--- End PDF ---" },
			]),
		]);

		const out = await readIndexableContent(vaultReturning(raw), chatFile);

		expect(out).toContain("summarise this");
		expect(out).not.toContain("abstract body");
	});

	it("ignores non-text parts such as images", async () => {
		const raw = thread("Image", [
			message("m1", [
				{ type: "text", text: "describe it" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
			]),
		]);

		expect(await readIndexableContent(vaultReturning(raw), chatFile)).toBe("Image\n\ndescribe it");
	});
});

describe("isEmbeddableFile (content-free extensions)", () => {
	const f = (path: string, extension: string) => ({ path, extension }) as never;

	it("excludes files with no extractable text from the embedding index", () => {
		// These were embedded as title-only vectors, which sit at the similarity noise
		// floor (~0.46-0.48 against any query) and displace real notes.
		installAgentPathSource({ agentFolder: () => "Agents", agentName: () => undefined });
		expect(isEmbeddableFile(f("TaskNotes/Views/tasks.base", "base"))).toBe(false);
		expect(isEmbeddableFile(f("Assets/diagram.png", "png"))).toBe(false);
		expect(isEmbeddableFile(f("Assets/photo.JPG", "JPG"))).toBe(false);
		expect(isEmbeddableFile(f("Assets/clip.mp4", "mp4"))).toBe(false);
	});

	it("keeps notes and PDFs, whose text can be extracted", () => {
		installAgentPathSource({ agentFolder: () => "Agents", agentName: () => undefined });
		expect(isEmbeddableFile(f("Notes/note.md", "md"))).toBe(true);
		expect(isEmbeddableFile(f("Papers/paper.pdf", "pdf"))).toBe(true);
		expect(isEmbeddableFile(f("Chats/thread.chat", "chat"))).toBe(true);
	});

	it("still excludes agent-folder files regardless of extension", () => {
		installAgentPathSource({ agentFolder: () => "Agents", agentName: () => undefined });
		expect(isEmbeddableFile(f("Agents/Skills/foo/SKILL.md", "md"))).toBe(false);
	});
});

describe("isIndexableFile keeps content-free files searchable by name", () => {
	const f = (path: string, extension: string) => ({ path, extension }) as never;

	it("includes images and Bases views so lexical search can match their titles", () => {
		// A user typing "Bild" or the name of a Bases view expects to find that file.
		// MiniSearch matches on title/path and needs no content, so only the semantic
		// pipeline filters these out.
		installAgentPathSource({ agentFolder: () => "Agents", agentName: () => undefined });
		expect(isIndexableFile(f("TaskNotes/Views/tasks.base", "base"))).toBe(true);
		expect(isIndexableFile(f("Assets/Bild.png", "png"))).toBe(true);
		expect(isIndexableFile(f("Assets/clip.mp4", "mp4"))).toBe(true);
	});
});

describe("readIndexableContent (PDF)", () => {
	const pdfFile = { path: "Papers/paper.pdf", extension: "pdf", basename: "paper" } as never;

	it("returns an empty string when the PDF cannot be parsed", async () => {
		// Encrypted, malformed, or scanned-without-OCR must skip the file rather than
		// fail the whole index run.
		const vault = {
			adapter: { readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(8)) },
		} as never;

		expect(await readIndexableContent(vault, pdfFile)).toBe("");
	});

	it("returns an empty string when the file cannot be read at all", async () => {
		const vault = {
			adapter: { readBinary: vi.fn().mockRejectedValue(new Error("missing")) },
		} as never;

		expect(await readIndexableContent(vault, pdfFile)).toBe("");
	});
});

describe("rename into a non-embeddable extension", () => {
	// Review finding: both index listeners gated the rename event on the *post-rename*
	// file. Renaming `note.md` to `note.base` therefore skipped the handler entirely,
	// so `removeDocument(oldPath)` never ran and the pre-rename document stayed
	// searchable. The guard now lives inside the handler, after the removal.
	it("classifies the destination as non-embeddable, so the old vector must be dropped", () => {
		installAgentPathSource({ agentFolder: () => "Agents", agentName: () => undefined });
		const before = { path: "Notes/note.md", extension: "md" } as never;
		const after = { path: "Notes/note.base", extension: "base" } as never;

		expect(isEmbeddableFile(before)).toBe(true);
		// The destination has no text to embed — which is exactly why the event must
		// not be filtered on it before the stale path's vectors are removed.
		expect(isEmbeddableFile(after)).toBe(false);
		// It stays lexically searchable by name, so the rename must not evict it from
		// the MiniSearch index — only re-key it.
		expect(isIndexableFile(after)).toBe(true);
	});
});

/** An `.excalidraw.md` file as the Excalidraw plugin writes it, with `back` as the back of the note. */
function drawing(back = ""): string {
	return [
		"---",
		"",
		"excalidraw-plugin: parsed",
		"tags: [excalidraw]",
		"",
		"---",
		"==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'",
		"",
		back,
		"",
		"# Excalidraw Data",
		"",
		"## Text Elements",
		"Label on a box ^aBcD1234",
		"",
		"%%",
		"## Drawing",
		"```compressed-json",
		"N4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA7hADTgQBuCpAzoQPYB2KqATLZMzYBXUtiRoIACyhQ4zZAHoFAc0JRJQgEYA6bGwC2",
		"```",
		"%%",
	].join("\n");
}

describe("Excalidraw drawings (#541)", () => {
	const f = (path: string, extension: string) => ({ path, extension }) as never;

	it("recognises both drawing forms by path", () => {
		expect(isExcalidrawPath("Drawings/Sketch.excalidraw.md")).toBe(true);
		expect(isExcalidrawPath("Drawings/Sketch.Excalidraw.MD")).toBe(true);
		expect(isExcalidrawPath("Drawings/Sketch.excalidraw")).toBe(true);
		expect(isExcalidrawPath("Notes/excalidraw.md")).toBe(false);
		expect(isExcalidrawPath("Notes/On Excalidraw.md")).toBe(false);
	});

	it("never embeds a bare .excalidraw scene, but keeps it findable by name", () => {
		installAgentPathSource({ agentFolder: () => "Agents", agentName: () => undefined });
		expect(isEmbeddableFile(f("Drawings/Sketch.excalidraw", "excalidraw"))).toBe(false);
		expect(isIndexableFile(f("Drawings/Sketch.excalidraw", "excalidraw"))).toBe(true);
	});

	const sketch = { path: "Drawings/Sketch.excalidraw.md", extension: "md", stat: { size: 10 } } as never;

	it("drops the banner, text elements and scene, keeping frontmatter and the back of the note", () => {
		const out = extractExcalidrawContent(drawing("Architecture sketch for the [[Sync engine]] rewrite."));
		expect(out).not.toContain("Switch to EXCALIDRAW VIEW");
		expect(out).not.toContain("Label on a box");
		expect(out).not.toContain("N4KAk");
		// Lexical search reads `aliases` from the frontmatter.
		expect(out).toContain("excalidraw-plugin: parsed");
		expect(out.endsWith("Architecture sketch for the [[Sync engine]] rewrite.")).toBe(true);
	});

	it("reads a blank drawing as having no text to embed — its frontmatter is bookkeeping", async () => {
		// The frontmatter and banner used to count as text, so a blank drawing was
		// embedded as boilerplate plus its title on every autosave.
		const vault = { cachedRead: vi.fn(async () => drawing()) } as never;
		expect(hasNoEmbeddableText(sketch, await readIndexableContent(vault, sketch))).toBe(true);
		expect(hasNoEmbeddableText(sketch, extractExcalidrawContent(drawing("A note")))).toBe(false);
	});

	it("handles the older format whose data section starts at # Text Elements, behind a %% fence", () => {
		const raw =
			"---\nexcalidraw-plugin: parsed\n---\nMy notes\n%%\n# Text Elements\nfoo ^x\n# Drawing\n```json\n{}\n```\n%%";
		expect(extractExcalidrawContent(raw)).toBe("---\nexcalidraw-plugin: parsed\n---\nMy notes");
	});
});

describe("hasNoEmbeddableText", () => {
	const f = (path: string, extension: string) => ({ path, extension, stat: { size: 10 } }) as never;

	it("is true for a blank note", () => {
		expect(hasNoEmbeddableText(f("Notes/Untitled.md", "md"), "  \n")).toBe(true);
		expect(hasNoEmbeddableText(f("Notes/Idea.md", "md"), "an idea")).toBe(false);
	});

	it("counts a plain note's frontmatter as text: a task note keeps everything there", () => {
		expect(hasNoEmbeddableText(f("Tasks/Pay rent.md", "md"), "---\nstatus: open\ndue: 2026-11-01\n---\n")).toBe(
			false,
		);
	});

	it("never takes an empty extraction from a container as a verdict: it may be a failed read", () => {
		expect(hasNoEmbeddableText(f("Papers/scan.pdf", "pdf"), "")).toBe(false);
		expect(hasNoEmbeddableText(f("Chats/Thread.chat", "chat"), "")).toBe(false);
	});
});
