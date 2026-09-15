import { Platform, type TFile, type Vault } from "obsidian";
import { getAgentPathSource } from "./agentPathSource";
import { agentRootDir } from "./agentPaths";
import { THREAD_DATA_DEDUP_VERSION, inflateThreadData, sniffThreadDataVersion } from "../agent/threadDataCodec";
import { gunzipPrefixToString, gunzipToString } from "./gzip";
import { extractTextFromPdf } from "./pdfExtractor";

/**
 * Largest file whose content gets read for indexing on mobile, in bytes.
 *
 * The mobile WebView lives under an OS memory ceiling the desktop never meets,
 * and reading a file costs a multiple of its size before any truncation could
 * apply: Capacitor's bridge round-trips binary reads through base64, pdf.js
 * keeps the parsed document alongside the bytes, and strings are UTF-16.
 * Oversized files are indexed by title/path only. For PDFs that loses little —
 * above this size they are predominantly scans, which yield no text anyway.
 */
const MOBILE_MAX_READ_BYTES = 10 * 1024 * 1024;

/**
 * Largest **legacy-format** `.chat` file whose content gets extracted on
 * mobile, in bytes.
 *
 * Tighter than {@link MOBILE_MAX_READ_BYTES} because legacy thread files
 * repeat the full message history in every checkpoint (#431): gzip compresses
 * that repetition extremely well, so the on-disk size understates the
 * decompressed cost by orders of magnitude. A 72MB thread file in a real
 * vault decompressed to a string large enough to get the WebView killed on
 * the spot — and because bulk indexing resumes at the same place each boot,
 * that single file turned every restart into another death.
 *
 * Deduplicated (v2+) files are exempt: their size tracks unique content with
 * an ordinary compression ratio, so only {@link MOBILE_MAX_READ_BYTES}
 * applies. The format is identified by streaming just the first decompressed
 * bytes (`version` is deliberately the file's first JSON key). An oversized
 * legacy file stays title-indexed until it is migrated — which happens on the
 * next load/save of the thread, after which sync delivers the small file.
 */
const MOBILE_CHAT_MAX_EXTRACT_BYTES = 2 * 1024 * 1024;

/**
 * Hard caps on the text handed to indexing, in UTF-16 code units.
 *
 * Search relevance saturates long before these bounds, but the index's memory
 * cost keeps growing linearly — and the cost is postings, not vocabulary.
 * MiniSearch keeps one object entry per (term, document) pair at roughly 60
 * bytes of overhead, so a document's cost scales with its *unique term count*.
 * Measured on a 7.2k-file vault (149K-term vocabulary): full extracted text
 * put the mobile WebView's live JS heap at ~650MB (1.4GB footprint — a hair
 * under the OS kill ceiling), and a uniform 100K-char cap only trimmed ~200MB
 * because the PDF/clipping tail still contributed millions of pairs.
 *
 * So mobile caps by provenance: authored notes keep 100K (~99% of notes fit
 * completely), while extracted/structured text (PDFs, chat logs, canvas/CSV/
 * JSON) gets 10K — about four PDF pages — enough to find a document by its
 * opening content, with title/path/tag search unaffected. Desktop has no
 * memory ceiling and indexes up to 1M everywhere.
 */
const MAX_INDEXED_TEXT_CHARS_DESKTOP = 1_000_000;
const MOBILE_MAX_INDEXED_TEXT_CHARS_NOTES = 100_000;
const MOBILE_MAX_INDEXED_TEXT_CHARS_EXTRACTED = 10_000;

function maxIndexedTextChars(file: TFile): number {
	if (!Platform.isMobile) return MAX_INDEXED_TEXT_CHARS_DESKTOP;
	return file.extension === "md" || file.extension === "txt"
		? MOBILE_MAX_INDEXED_TEXT_CHARS_NOTES
		: MOBILE_MAX_INDEXED_TEXT_CHARS_EXTRACTED;
}

function normalizePattern(pattern: string): string {
	return pattern.trim().replace(/^\/+|\/+$/g, "");
}

function matchesPathPattern(filePath: string, pattern: string): boolean {
	const normalizedPattern = normalizePattern(pattern);
	if (!normalizedPattern) return false;

	if (normalizedPattern.startsWith("*.")) {
		return filePath.toLowerCase().endsWith(normalizedPattern.slice(1).toLowerCase());
	}

	return (
		filePath === normalizedPattern ||
		filePath.startsWith(`${normalizedPattern}/`) ||
		filePath.includes(`/${normalizedPattern}`)
	);
}

function isInternallyExcludedPath(filePath: string, targetFolder: string): boolean {
	return matchesPathPattern(filePath, targetFolder);
}

export function shouldProcessVaultPath(filePath: string, targetFolder: string): boolean {
	return !isInternallyExcludedPath(filePath, targetFolder);
}

// ---------------------------------------------------------------------------
// File-type classification for indexing
// ---------------------------------------------------------------------------

/**
 * Extensions whose content can be read as UTF-8 text via `vault.cachedRead()`
 * or `vault.read()`. Canvas files are JSON internally and included here.
 */
const TEXT_INDEXABLE_EXTENSIONS = new Set(["md", "txt", "csv", "json", "yaml", "yml", "canvas", "chat"]);

/**
 * Extensions whose text is extracted from a binary container rather than read
 * directly. These are indexable, just not via `readTextFile`.
 */
const BINARY_TEXT_EXTENSIONS = new Set(["pdf"]);

/**
 * Extensions excluded from the *embedding* index.
 *
 * A file with no extractable text yields an empty body, and `chunkText` still
 * emits one chunk containing only the title — a content-free vector. Measured:
 * those score ~0.46-0.48 against *any* query, which is the noise floor, so they
 * displace real notes while carrying no information.
 *
 * This is deliberately **not** applied to lexical search: a user who types
 * "Bild" or the name of a Bases view expects to find that file, and MiniSearch
 * matches it on title/path without needing any content at all. Only the semantic
 * pipeline suffers from content-free entries, so only it filters on this set
 * (see `isEmbeddableFile` vs `isIndexableFile`).
 *
 *   - `base`: Obsidian Bases view definitions — YAML formula/config, no prose.
 *   - images: no text to extract. Embedding them would require a multimodal
 *     embedding model and a separate image pipeline; until that exists they are
 *     pure noise rather than a missing feature.
 */
const NON_EMBEDDABLE_EXTENSIONS = new Set([
	"base",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"bmp",
	"avif",
	"ico",
	"mp3",
	"wav",
	"m4a",
	"ogg",
	"flac",
	"mp4",
	"webm",
	"mov",
	"mkv",
	"zip",
]);

/**
 * Returns `true` when the file holds text content that can be read and
 * indexed for full-text / embedding search.
 */
export function isTextIndexableFile(file: TFile): boolean {
	return TEXT_INDEXABLE_EXTENSIONS.has(file.extension.toLowerCase());
}

/** Returns `true` when the file's text must be extracted from a binary container. */
export function isBinaryTextFile(file: TFile): boolean {
	return BINARY_TEXT_EXTENSIONS.has(file.extension.toLowerCase());
}

/**
 * Returns `true` when `path` lives inside the configurable agent root folder (default
 * "Agents"). That folder holds all agent context — `Memories/`, `Skills/` (skill dirs, core
 * skills included), and one `<Agent Name>/` folder per agent holding its `AGENT.md`. These are
 * plugin machinery, not user notes, so they must be kept out of indexing, search, graph, and the
 * agent's vault-facing tools. (One deliberate exemption: `list_directory` always shows the
 * `Memories/` subtree — memory notes are absent from the search index, so that listing is the
 * agent's only memory-discovery path.)
 * `agentFolder` is pure/injectable for testing; callers that don't have it use
 * `isAgentFilePath`, which reads it from plugin data.
 */
export function isAgentPath(path: string, agentFolder: string): boolean {
	if (!agentFolder) return false;
	const folder = normalizePattern(agentFolder);
	if (!folder) return false;
	const p = path.replace(/^\/+/, "");
	return p === folder || p.startsWith(`${folder}/`);
}

/**
 * `isAgentPath` with the configured agent folder resolved from plugin data. Use this from
 * runtime call sites (indexing, search, graph, tools); use `isAgentPath` directly in tests.
 * Fails open (returns `false`) if the data store isn't initialized yet — the caller then
 * treats the file as a normal note, preserving pre-relocation behavior rather than throwing.
 */
export function isAgentFilePath(path: string): boolean {
	if (!getAgentPathSource()) return false;
	return isAgentPath(path, agentRootDir());
}

/**
 * Returns `true` when the file should be visible to search at all.
 *
 * Every vault file qualifies except plugin machinery under the agent folder. In
 * particular images and `.base` files are included: they carry no text to embed, but
 * they have names, and lexical search finds them by name. Callers that specifically
 * build the *embedding* index must additionally check {@link isEmbeddableFile}.
 */
export function isIndexableFile(file: TFile): boolean {
	return !isAgentFilePath(file.path);
}

/**
 * Returns `true` when the file has text worth turning into a vector.
 *
 * Narrower than {@link isIndexableFile}: a file with no extractable text would be
 * embedded as a title-only vector, which sits at the similarity noise floor (~0.46-0.48
 * against *any* query) and displaces real notes.
 */
export function isEmbeddableFile(file: TFile): boolean {
	if (!isIndexableFile(file)) return false;
	// Fall back to the path suffix: `extension` is absent on some call sites'
	// file-like objects, and treating that as "no extension" would silently
	// re-admit every excluded type.
	const extension = (file.extension ?? file.path.split(".").pop() ?? "").toLowerCase();
	return !NON_EMBEDDABLE_EXTENSIONS.has(extension);
}

/**
 * Enumerate all vault files eligible for indexing (replaces
 * `vault.getMarkdownFiles()` in search / vectorstore callers).
 */
export function getIndexableVaultFiles(vault: Vault): TFile[] {
	return vault.getFiles().filter((file) => isIndexableFile(file));
}

/** {@link getIndexableVaultFiles} restricted to files worth embedding. */
export function getEmbeddableVaultFiles(vault: Vault): TFile[] {
	return vault.getFiles().filter((file) => isEmbeddableFile(file));
}

/**
 * Read indexable content for a file. Returns the text content for
 * text-indexable files, or an empty string when nothing can be extracted.
 * Special-case handling:
 *   - `.chat` files: extracts only human/AI message content (not LangChain metadata)
 *   - `.pdf` files: extracts the document text via pdfjs, so a PDF is chunked and
 *     embedded like any other long document rather than reduced to its filename
 *   - `.excalidraw.md` files: extracts the "back of the note" and text elements,
 *     stripping the huge embedded JSON drawing data
 *
 * The caller is responsible for filtering via `isIndexableFile`
 * before calling this helper.
 */
export async function readIndexableContent(vault: Vault, file: TFile): Promise<string> {
	const content = await readIndexableContentRaw(vault, file);
	const cap = maxIndexedTextChars(file);
	return content.length > cap ? content.slice(0, cap) : content;
}

async function readIndexableContentRaw(vault: Vault, file: TFile): Promise<string> {
	// Size gates come before any read: the cost of reading an oversized file is
	// paid before truncation could help.
	if (Platform.isMobile && file.stat.size > MOBILE_MAX_READ_BYTES) {
		return "";
	}

	// PDFs carry real prose, but it lives inside a binary container. Extracting it
	// lets the normal chunker split the document by length; returning "" would
	// index a multi-page PDF as a single title-only vector.
	if (isBinaryTextFile(file)) {
		try {
			const bytes = await readBinaryFile(vault, file);
			const { text } = await extractTextFromPdf(new Uint8Array(bytes));
			return text.trim();
		} catch {
			// Encrypted, malformed, or scanned-without-OCR: skip rather than fail
			// the whole index run.
			return "";
		}
	}

	if (!isTextIndexableFile(file)) {
		return "";
	}

	// `.chat` files are gzip-compressed binary (written via readBinary/gzipString
	// by ObsidianChatManager), NOT UTF-8 text. A text read throws on iOS ("file
	// isn't in the correct format") and yields garbage on desktop, so read + gunzip
	// the bytes and hand the decompressed JSON to the extractor.
	if (file.extension === "chat") {
		try {
			const bytes = await readBinaryFile(vault, file);
			if (Platform.isMobile && file.stat.size > MOBILE_CHAT_MAX_EXTRACT_BYTES) {
				// Only the deduplicated format is safe to materialize at this
				// size — a legacy file this large decompresses to a quadratic
				// payload (see MOBILE_CHAT_MAX_EXTRACT_BYTES). Sniff the
				// version from the first decompressed bytes before committing
				// to a full gunzip.
				const prefix = await gunzipPrefixToString(bytes, 64);
				if (sniffThreadDataVersion(prefix) < THREAD_DATA_DEDUP_VERSION) {
					return "";
				}
			}
			const raw = await gunzipToString(bytes);
			return extractChatContent(raw);
		} catch {
			// Unreadable/corrupt thread file — skip rather than fail the whole index.
			return "";
		}
	}

	const raw = await readTextFile(vault, file);

	if (file.path.toLowerCase().endsWith(".excalidraw.md")) {
		return extractExcalidrawContent(raw);
	}

	return raw;
}

/**
 * Read a text file's raw content, resilient to Obsidian mobile's `cachedRead`.
 *
 * On iOS, `vault.cachedRead()` / `vault.read()` route through a reader that can
 * reject some non-markdown extensions. The low-level `vault.adapter.read()` is a
 * plain UTF-8 read with no such gate. Try `cachedRead` first (cache-backed, fast
 * on desktop) and fall back to the adapter on failure.
 */
async function readTextFile(vault: Vault, file: TFile): Promise<string> {
	try {
		return await vault.cachedRead(file);
	} catch {
		return await vault.adapter.read(file.path);
	}
}

/**
 * Read a file's raw bytes, preferring the Vault API (serialized against concurrent
 * writes) with the same adapter fallback as {@link readTextFile}, in case the iOS
 * reader gate ever applies to binary reads of unusual extensions too.
 */
async function readBinaryFile(vault: Vault, file: TFile): Promise<ArrayBuffer> {
	try {
		return await vault.readBinary(file);
	} catch {
		return await vault.adapter.readBinary(file.path);
	}
}

// ---------------------------------------------------------------------------
// .chat file content extraction
// ---------------------------------------------------------------------------

/**
 * Serialised LangChain classes that represent something a person actually said or
 * was told. `ToolMessage` is deliberately absent: a tool result is the *input* the
 * agent worked from, not conversation. Measured on a real vault, tool results were
 * 73.5% of all indexed chat text, and 45.8% of it was `read_content` echoing notes
 * back verbatim — so notes were indexed a second time inside every thread that had
 * read them, competing with the note itself at retrieval time.
 */
const CONVERSATIONAL_MESSAGE_CLASSES = new Set(["HumanMessage", "AIMessage", "AIMessageChunk", "SystemMessage"]);

/**
 * Name of the serialised LangChain class for a message, e.g. `"ToolMessage"`.
 * Serialised messages carry it as the last element of the `id` path array
 * (`["langchain_core", "messages", "ToolMessage"]`). Returns `null` when the shape
 * is unrecognised, so the caller can decide how to treat it.
 */
function getMessageClass(msg: unknown): string | null {
	if (!msg || typeof msg !== "object") return null;
	const record = msg as Record<string, unknown>;

	if (Array.isArray(record.id) && record.id.length > 0) {
		const last = record.id[record.id.length - 1];
		if (typeof last === "string" && last.trim()) return last.trim();
	}
	// Flat (non-`lc`) message shape stores the role on `type`.
	if (typeof record.type === "string" && record.type.trim()) return record.type.trim();
	return null;
}

/**
 * Context blocks appended to a user's question before it is sent (visible notes,
 * selected text, graph selection). They are machinery, not something the user typed,
 * and they name other notes — indexing them makes a thread match queries about notes
 * that merely happened to be open. The chat UI strips the same suffix for display
 * (`stripAugmentedSuffix` in `stores/chatStore.svelte.ts`); matching on the block
 * marker keeps this independent of the exact rendering.
 */
const RE_AUGMENTED_CONTEXT = /\n*\[(?:Currently visible notes|Selected text from |Graph-selected notes)/;

/** Drop appended context blocks, keeping only what the user actually wrote. */
function stripAugmentedContext(content: string): string {
	const match = RE_AUGMENTED_CONTEXT.exec(content);
	return match ? content.slice(0, match.index).trim() : content;
}

/** Returns `true` when an assistant message is mid-turn narration rather than an answer. */
function hasToolCalls(msg: unknown): boolean {
	if (!msg || typeof msg !== "object") return false;
	const kwargs = (msg as Record<string, unknown>).kwargs;
	if (!kwargs || typeof kwargs !== "object") return false;
	const record = kwargs as Record<string, unknown>;

	if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) return true;
	const additional = record.additional_kwargs;
	if (additional && typeof additional === "object") {
		const nested = (additional as Record<string, unknown>).tool_calls;
		if (Array.isArray(nested) && nested.length > 0) return true;
	}
	return false;
}

/**
 * Pick the message list for the conversation as the user last left it.
 *
 * Checkpoints form a *tree*: every regenerate or edit forks a new branch, and each
 * branch keeps its own answer to the same question. Measured on a 526-checkpoint
 * thread, that turned 10 real questions into 105 distinct answers (one question was
 * regenerated 16 times), all of which were being indexed — the single biggest reason
 * a chat file outweighed real notes.
 *
 * This mirrors the branch resolution the chat UI uses to decide which conversation to
 * show (`resolveActiveCheckpointId` → `findDeterministicTipFrom` in
 * `stores/chatStore.svelte.ts`): walk from the root and always take the newest child,
 * tie-breaking on step then id so the choice is deterministic. The UI's extra inputs
 * (session / persisted / explicit checkpoint) don't apply here — the persisted "last
 * viewed" id lives in plugin data, not the `.chat` file — so this is the UI's own
 * fallback path, which is also what the read-only `.chat` embed preview takes.
 *
 * It is reimplemented rather than imported because those helpers live in a Svelte
 * runes store that pulls in the whole plugin graph, and they operate on normalized
 * LangChain `BaseMessage` instances; indexing reads raw serialised JSON and must stay
 * usable before `AgentManager` has initialized. Verified to agree with the UI on all
 * 49 threads in the test vault by comparing against `metadata.lastMessagePreview`.
 */
function selectActiveMessages(checkpoints: Record<string, unknown>): unknown[] {
	const nodes = new Map<string, { id: string; ts: string; step: number; entry: unknown; children: string[] }>();
	for (const [id, entry] of Object.entries(checkpoints)) {
		const record = entry as Record<string, unknown>;
		const checkpoint = record?.checkpoint as Record<string, unknown> | undefined;
		const metadata = record?.metadata as Record<string, unknown> | undefined;
		nodes.set(id, {
			id,
			ts: typeof checkpoint?.ts === "string" ? checkpoint.ts : "",
			step: typeof metadata?.step === "number" ? metadata.step : 0,
			entry,
			children: [],
		});
	}
	if (nodes.size === 0) return [];

	const parentOf = new Map<string, string | undefined>();
	for (const [id, entry] of Object.entries(checkpoints)) {
		const parentConfig = (entry as Record<string, unknown>)?.parentConfig as Record<string, unknown> | undefined;
		const configurable = parentConfig?.configurable as Record<string, unknown> | undefined;
		const parentId = configurable?.checkpoint_id;
		const parent = typeof parentId === "string" && nodes.has(parentId) ? parentId : undefined;
		parentOf.set(id, parent);
		if (parent) nodes.get(parent)?.children.push(id);
	}

	/** Newest first: ts desc, then step desc, then id — matches the UI's `compareNewest`. */
	const newestFirst = (a: string, b: string): number => {
		const nodeA = nodes.get(a);
		const nodeB = nodes.get(b);
		if (!nodeA || !nodeB) return 0;
		if (nodeA.ts !== nodeB.ts) return nodeB.ts.localeCompare(nodeA.ts);
		if (nodeA.step !== nodeB.step) return nodeB.step - nodeA.step;
		return nodeA.id.localeCompare(nodeB.id);
	};

	const roots = [...nodes.keys()].filter((id) => !parentOf.get(id));
	const startId = (roots.length > 0 ? roots : [...nodes.keys()]).sort((a, b) => {
		const nodeA = nodes.get(a);
		const nodeB = nodes.get(b);
		if (!nodeA || !nodeB) return 0;
		if (nodeA.step !== nodeB.step) return nodeA.step - nodeB.step;
		if (nodeA.ts !== nodeB.ts) return nodeA.ts.localeCompare(nodeB.ts);
		return nodeA.id.localeCompare(nodeB.id);
	})[0];

	// Walk to the tip, taking the newest child at each fork. `visited` guards against
	// a malformed file whose parent links form a cycle.
	let current = startId;
	const visited = new Set<string>();
	while (current && !visited.has(current)) {
		visited.add(current);
		const next = nodes
			.get(current)
			?.children.filter((id) => !visited.has(id))
			.sort(newestFirst)[0];
		if (!next) break;
		current = next;
	}

	return getNestedMessages(nodes.get(current)?.entry);
}

/**
 * Extract the conversation from a `.chat` file (LangGraph ThreadData JSON) as
 * question/answer pairs, skipping LangChain serialisation noise and tool traffic.
 *
 * Three things are dropped, each measured as a real source of index bloat:
 *   - **Tool results** (see `CONVERSATIONAL_MESSAGE_CLASSES`) — 73.5% of indexed chat
 *     text, nearly half of it notes echoed back verbatim by `read_content`.
 *   - **Abandoned branches** (see `selectActiveMessages`) — regenerated answers to a
 *     question the user already re-asked.
 *   - **Mid-turn narration** — assistant messages that only announce a tool call
 *     ("I'll quickly inspect the vault structure…"); they carry `tool_calls` and no
 *     answer, and matched no query meaningfully.
 *
 * A turn is emitted as `question\n\nanswer` so the two share a chunk: an answer often
 * lacks the vocabulary of the question that prompted it, and splitting them costs the
 * retrieval of both. Only the last final answer of a turn is kept — an assistant can
 * emit several text messages around its tool calls, but the closing one is the reply.
 */
function extractChatContent(raw: string): string {
	try {
		// v2+ thread files store each message once in a table and reference it
		// from checkpoints; resolve those references before walking the tree.
		const data = inflateThreadData(JSON.parse(raw));
		const parts: string[] = [];

		// Include the chat title if present
		if (typeof data.title === "string" && data.title.trim()) {
			parts.push(data.title.trim());
		}

		const checkpoints = data.checkpoints;
		if (checkpoints && typeof checkpoints === "object") {
			let question = "";
			let answer = "";
			const flush = () => {
				const turn = [question, answer].filter((text) => text.length > 0).join("\n\n");
				if (turn) parts.push(turn);
				question = "";
				answer = "";
			};

			for (const msg of selectActiveMessages(checkpoints)) {
				// An unrecognised shape has no class to check; indexing it risks
				// re-admitting tool output, so skip it.
				const messageClass = getMessageClass(msg);
				if (!messageClass || !CONVERSATIONAL_MESSAGE_CLASSES.has(messageClass)) continue;

				const content = extractMessageContent(msg);
				if (!content) continue;

				if (messageClass === "HumanMessage") {
					// A new question closes the previous turn.
					flush();
					question = stripAugmentedContext(content);
					continue;
				}
				// Assistant/system text: keep only turn-ending answers, and let a later
				// one supersede an earlier one within the same turn.
				if (hasToolCalls(msg)) continue;
				answer = content;
			}
			flush();
		}

		return parts.join("\n\n");
	} catch {
		// If parsing fails, fall back to empty (don't index raw JSON)
		return "";
	}
}

function getNestedMessages(entry: unknown): unknown[] {
	if (!entry || typeof entry !== "object") return [];
	const checkpoint = (entry as Record<string, unknown>).checkpoint;
	if (!checkpoint || typeof checkpoint !== "object") return [];
	const channelValues = (checkpoint as Record<string, unknown>).channel_values;
	if (!channelValues || typeof channelValues !== "object") return [];
	const messages = (channelValues as Record<string, unknown>).messages;
	return Array.isArray(messages) ? messages : [];
}

/**
 * Fallback marker for attachment blocks in threads written before the structured
 * `s2b_attachment` flag existed. Mirrors the wrappers built in `Agent.ts`.
 */
const RE_ATTACHMENT_BLOCK = /^--- (?:File|PDF): /;

/**
 * Returns `true` when a content part is an attached file rather than typed text.
 *
 * Attachments are the *note* the user pointed at, not what they said about it, and
 * the note is already indexed on its own. `Agent.ts` tags every attachment part with
 * `s2b_attachment: true`; the text-prefix check covers threads written before that.
 */
function isAttachmentPart(part: Record<string, unknown>): boolean {
	if (part.s2b_attachment === true) return true;
	const text = part.text;
	return typeof text === "string" && RE_ATTACHMENT_BLOCK.test(text);
}

/**
 * Collapse a multimodal content array to its typed text.
 *
 * A message with attachments serialises as an array of parts: the user's own text
 * plus one block per attached file. Treating the whole array as non-string dropped
 * the user's question entirely (measured: "what can you do" lost, while the attached
 * note's full body was the only thing that would have been kept). Keep the text
 * parts, drop the attachments and any non-text (image/file) parts.
 */
function extractTextFromContentParts(parts: unknown[]): string {
	const texts: string[] = [];
	for (const part of parts) {
		if (!part || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (record.type !== "text") continue;
		if (isAttachmentPart(record)) continue;
		const text = record.text;
		if (typeof text === "string" && text.trim()) texts.push(text.trim());
	}
	return texts.join("\n\n");
}

function extractMessageContent(msg: unknown): string {
	if (!msg || typeof msg !== "object") return "";
	const record = msg as Record<string, unknown>;

	// LangChain serialised messages store content in kwargs.content or data.content
	let content: unknown;
	if (record.kwargs && typeof record.kwargs === "object") {
		content = (record.kwargs as Record<string, unknown>).content;
	}
	if (content === undefined && record.data && typeof record.data === "object") {
		content = (record.data as Record<string, unknown>).content;
	}
	// Flat message format
	if (content === undefined) {
		content = record.content;
	}

	if (typeof content === "string" && content.trim()) {
		return content.trim();
	}
	if (Array.isArray(content)) {
		return extractTextFromContentParts(content);
	}
	return "";
}

// ---------------------------------------------------------------------------
// .excalidraw.md content extraction
// ---------------------------------------------------------------------------

/**
 * Regex matching the start of the Excalidraw data section.
 * Everything from this point onward is drawing data (JSON, compressed
 * blobs, element links, embedded file refs) and should NOT be indexed.
 */
const RE_EXCALIDRAW_DATA_START = /^#+ (?:Excalidraw Data|Text Elements|Drawing)\s*$/m;

/**
 * Extract the user-authored "back of the note" from an `.excalidraw.md` file.
 * Strips the frontmatter-tagged Excalidraw sections and the huge JSON drawing.
 */
function extractExcalidrawContent(raw: string): string {
	const match = RE_EXCALIDRAW_DATA_START.exec(raw);
	if (!match) {
		// No Excalidraw markers found — treat the whole file as content
		return raw;
	}

	// Everything before the first Excalidraw section header
	let content = raw.substring(0, match.index);

	// Strip Obsidian comment markers that Excalidraw uses as section fences
	content = content.replace(/%%\s*$/g, "").trim();

	return content;
}
