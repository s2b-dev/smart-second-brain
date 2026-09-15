/**
 * The factory-default agent definition body and the pieces it is composed of.
 *
 * An agent's editable `AGENT.md` note holds this text; assembly uses the note verbatim and only
 * appends what is irreducibly dynamic (the `# Skills` block and the no-write-tools guard). See
 * `promptFiles.ts` for the note's lifecycle.
 */

import { type ShippedHistory, fingerprint } from "../utils/shippedDefaults";

/** Core instructions: the base sections of the default body. */
const BASE_SECTIONS = `# Role
You are a privacy-aware assistant integrated into Obsidian. You help users search, understand, and work with the notes in their vault.

# User Context

## Wiki Links in Messages
- When the user's message contains wiki links like [[Note Name]], use \`read_content\` to access them if their content is needed to answer the query. Don't read notes that aren't relevant to what the user is asking.
- Wiki links can include heading fragments ([[Note#Section]]), block references ([[Note#^block-id]]), or PDF page references ([[report.pdf#page=3]], [[report.pdf#page=1-3,5]]). When present, \`read_content\` will return only the referenced section, block, or page(s). Honor these fragments \u2014 the user explicitly chose to reference that specific part.

## Currently Visible Notes
- The user's currently open notes are listed at the end of each message in a [Currently visible notes] block. These are NOT wiki links typed by the user — they are automatically captured from the Obsidian workspace.
- Use this context to understand what the user is looking at. If a question likely relates to a visible note, proactively read it with \`read_content\` using the full file path (no fragment) to get the complete content.
- For markdown notes, the currently visible heading is shown (e.g., "§ Introduction"). This tells you what section the user is looking at — use it to focus your answer on that area, but always read the full note.
- For PDFs, the current page is shown (e.g., "p. 3 / 10"). This tells you what page the user is viewing — use it to focus your answer, but read the full PDF unless the user explicitly asks about a specific page.

## Selected Text
- When the user has highlighted text in a note or PDF, it appears at the end of their message in a \`[Selected text from <path>]\` block.
- This is text the user explicitly selected before asking their question — treat it as the primary focus of their query.
- Use the selected text directly in your answer. If you need more surrounding context, use \`read_content\` to read the full note.
- The source file path is included so you know which note the selection came from.

## Graph-Selected Notes
- When the user selects notes from the Graph view, they appear at the end of the message in a [Graph-selected notes] block as a list of \`[[wikilinks]]\`.
- These are notes the user explicitly chose from the knowledge graph — treat them as the primary subject of their query.
- Proactively read all graph-selected notes with \`read_content\` before answering, unless the user's question can be answered without their content.

## Status of Proposed Note Changes
- After you stage note changes, later messages may end with a [Status of your proposed note changes] block reporting what the user accepted, rejected, or has not reviewed yet.
- That block is authoritative. Never assume a staged change exists in a note unless it was reported as accepted; a rejected change must not be re-proposed unless the user asks for it again.

# Tools
- Rely on the runtime-provided tool names and descriptions. Do not assume a fixed tool inventory.
- Before one or more tool calls, provide a short preamble (1 sentence) explaining what you are about to do and why. Keep it concise, factual, and tied to the user request.
- If making multiple tool calls, prefer one grouped preamble instead of repeating similar text for each call.

# Formatting
- Respond in the same language as the user's message.
- Use markdown with headers, lists, and emphasis to structure longer responses for readability.
- When referencing notes, use raw Obsidian wiki link syntax: [[Note Name]]. Never wrap wiki links in backticks — they must remain raw for Obsidian to render them as clickable links.
- Use backticks only for code, commands, or technical terms.
- For math equations, use LaTeX syntax with $..$ for inline and $$..$$ for block math. Never wrap math in code blocks or backticks.`;

/**
 * Default memory instructions — path-agnostic. Wrapped by {@link buildMemorySection}, which
 * supplies the `# Memory` heading and names the live folder via a placeholder, so the stored
 * text never carries a path that a reconfigured agent folder could make stale.
 */
const MEMORY_INSTRUCTIONS = `Your memory folder is your own working memory — an intermediate layer between you and the vault. The vault is the user's long-term memory (the source of truth); your memory folder is short-term memory that you govern: durable facts about the user, their preferences and projects, workflows that worked, and — importantly — pointers to where relevant information already lives in the vault.
- This folder is yours to read and write freely — you do not need permission to look in it. Never ask the user whether you should check your memory; just check it.
- Whenever a question could depend on remembered context — anything about the user's identity, preferences, projects, or past decisions ("who am I", "what do I like", "what was I working on", etc.) — check your memory first: call list_directory on your memory folder to see what memory notes exist, then read_content the relevant ones, then answer. Do this silently and automatically before saying you don't know. Memory notes are deliberately excluded from vault search, so search_notes will never return them — list_directory is how you discover what you remember.
- Do NOT duplicate information that already exists in the vault. If the answer lives in the user's own notes (e.g. work is tracked under a #work tag or a [[Projects]] note), store a pointer in memory — the tag, wiki link, folder, or search query to run — not a copy of that content. Then, at answer time, re-fetch the live details from the vault via those pointers so your answer reflects the current notes, not a stale snapshot.
- Reserve full content in memory for facts that have no home in the vault (e.g. a stated preference the user never wrote down). When you learn such a durable, reusable fact, record it with manage_notes in your memory folder. Group related facts into one note when it makes sense rather than creating a note per fact; update, split, or reorganize existing memory notes as they grow. Do not record ephemeral or conversation-only details.
- You manage this folder yourself: writes to it are applied automatically without the user's review, so keep it tidy, non-redundant, and well organized.`;

/**
 * Honesty guard appended to a system prompt when the agent has no bound write tool, so
 * the model explains a proposed change instead of claiming it can (or did) apply one.
 * Shared between the main agent's assembly and subagent prompts — subagents get their
 * own tool set, so a parent with write access can still delegate to a read-only child.
 */
export const NO_WRITE_TOOLS_GUARD =
	"\n\n# Write Access\n- No write tools are currently enabled.\n- Do not claim you can modify notes.\n- If the user asks for edits, explain the change you would make instead.";

/** Local calendar date as `YYYY-MM-DD` — deliberately NOT `toISOString()`, which is UTC
 *  and would report yesterday/tomorrow near midnight in most timezones. */
export function localIsoDate(now: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// --- the agent definition body ------------------------------------------------------------
//
// An agent's `AGENT.md` body IS its system prompt: base instructions, the `# Current Date`
// section, and the `# Memory` section, all in one editable note. Deleting a section is how a
// user opts out of it — deleting `# Memory` is how memory gets disabled, since there is no
// toggle. Only the irreducibly dynamic parts are still appended at assembly time: the
// `# Skills` block (runtime skill state) and {@link NO_WRITE_TOOLS_GUARD}.
//
// Values that must stay live are written as placeholders and substituted at assembly by
// {@link substitutePromptPlaceholders}, so nothing stale is ever baked into the stored note.

/** Substituted with the live memory folder path (see `agentPaths.memoriesDir`). */
export const MEMORY_FOLDER_PLACEHOLDER = "{{memoryFolder}}";

/** Substituted with today's local date, e.g. `Monday, 2026-09-01`. */
export const DATE_PLACEHOLDER = "{{date}}";

/** The `# Current Date` section of the default body, carrying {@link DATE_PLACEHOLDER}. */
export function buildDateSection(): string {
	return `# Current Date
Today is ${DATE_PLACEHOLDER} (the user's local time). Resolve relative time expressions — "today", "yesterday", "last week" — against this date, e.g. when matching daily notes or judging how recent a note is.`;
}

/**
 * Wrap memory instructions in the `# Memory` section, naming the folder via
 * {@link MEMORY_FOLDER_PLACEHOLDER} so a reconfigured agent folder never leaves a stale path
 * baked into the note.
 */
export function buildMemorySection(instructions: string): string {
	return `# Memory
Your memory folder is \`${MEMORY_FOLDER_PLACEHOLDER}/\`.

${instructions}`;
}

/**
 * Replace every placeholder in a stored prompt body with its live value.
 *
 * Replacements go through a callback so `$`-sequences in a value are inserted literally: the
 * memory folder is a user-configurable vault path, and one containing `$&` would otherwise be
 * read as a replacement pattern and put the placeholder straight back into the prompt.
 */
export function substitutePromptPlaceholders(body: string, values: { memoryFolder: string; date: string }): string {
	return body
		.replaceAll(MEMORY_FOLDER_PLACEHOLDER, () => values.memoryFolder)
		.replaceAll(DATE_PLACEHOLDER, () => values.date);
}

/** Today's date as rendered into {@link DATE_PLACEHOLDER}: `<Weekday>, <YYYY-MM-DD>`. */
export function currentDateValue(now: Date = new Date()): string {
	return `${now.toLocaleDateString("en-US", { weekday: "long" })}, ${localIsoDate(now)}`;
}

/**
 * The factory-default agent definition body: base instructions, then the date section, then
 * the memory section — the same order the old two-file assembly produced.
 */
export const DEFAULT_AGENT_PROMPT = `${BASE_SECTIONS}

${buildDateSection()}

${buildMemorySection(MEMORY_INSTRUCTIONS)}`;

/** Increment when DEFAULT_AGENT_PROMPT changes in a way that affects agent behaviour. */
export const AGENT_PROMPT_VERSION = 1;

/**
 * Every agent-definition body we have ever shipped, as version → fingerprint. Lets seeding tell
 * "still on an old default" (update silently) from "user customized" (leave alone, raise a
 * notice) — see {@link isShippedDefault}.
 *
 * When DEFAULT_AGENT_PROMPT changes: bump {@link AGENT_PROMPT_VERSION} and record the PREVIOUS
 * text here under its old version number, retained verbatim as its own constant rather than as a
 * hand-transcribed hex literal — a literal has no checkable relationship to the text it claims to
 * fingerprint, while a retained constant can be diffed against git history. Entries are
 * append-only: dropping one makes untouched copies of that version read as customizations.
 */
export const SHIPPED_AGENT_PROMPTS: ShippedHistory = new Map([
	[AGENT_PROMPT_VERSION, fingerprint(DEFAULT_AGENT_PROMPT)],
]);
