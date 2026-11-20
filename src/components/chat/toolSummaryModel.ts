import type { ToolCallStatus } from "../../stores/chatTimeline";
import { parseAskQuestions } from "../../utils/askQuestion";
import type { ToolOutputRenderModel } from "./toolOutputRenderModel";
import { parseTodos } from "../../utils/todoList";
import { type MessageKey, t } from "../../i18n";

/**
 * A compact, one-line description of a tool call: a plain-language `label` and an
 * `summary` outcome clause that the UI folds into one sentence
 * (e.g. label `Read main.md` + summary `512 lines` → `Read main.md, 512 lines`).
 *
 * `label` is written as a short sentence an average user can read at a glance (not
 * `verb(target)` function syntax) and tense-matched to the tool's status:
 * **present continuous while running** (`Reading main.ts`), **past tense once
 * finished** (`Read main.ts`). `summary` is the outcome, phrased to read as a
 * natural continuation of the label (`found 3 notes`, `found no matches`,
 * `512 lines`). Either can be empty when there is nothing meaningful to show yet
 * (e.g. a tool still running with no input).
 */
export interface ToolSummary {
	label: string;
	summary: string;
}

/**
 * A verb whose tense is chosen from the tool's status: the present-continuous
 * form while the call is running, the past-tense form once it has finished (or
 * failed). Kept as a pair so summarizers stay declarative and the tense rule
 * lives in one place ({@link renderLabel}).
 */
interface Verb {
	/** Present continuous, shown while running — e.g. "Reading {target}", "Searching notes for {target}". */
	running: MessageKey;
	/** Past tense, shown when done/failed — e.g. "Read {target}", "Searched notes for {target}". */
	done: MessageKey;
	/** Extra placeholders the messages use besides `{target}` (the generic tool's `{name}`). */
	vars?: Record<string, string>;
}

/** A tense-aware label: a status-driven {@link Verb} plus optional trailing text. */
interface Label {
	verb: Verb;
	/** The verb message's `{target}` (e.g. a quoted query or a note name). */
	rest?: string;
}

function verb(running: MessageKey, done: MessageKey, vars?: Record<string, string>): Verb {
	return { running, done, vars };
}

/**
 * Resolves a {@link Label} to a display string, choosing the verb tense by status.
 * `pending` (arguments still streaming) is in-flight just like `running`, so it
 * takes the present-continuous form — a call that hasn't started must never read
 * as though it already finished.
 */
function renderLabel(label: Label, status: ToolCallStatus): string {
	const inFlight = status === "running" || status === "pending";
	const key = inFlight ? label.verb.running : label.verb.done;
	return t(key, { ...label.verb.vars, target: label.rest ?? "" });
}

/**
 * Maps a (possibly user-renamed) tool name to the canonical built-in kind so
 * summary logic keys off tool *identity*, not the display name. The output
 * render model already special-cases the default names; we mirror that set and
 * additionally recognise the tools that fall through to generic rendering
 * (grep_notes, get_all_tags, …) so they still get a tailored label. Unknown /
 * renamed tools return `undefined` and fall back to a generic summary.
 */
type BuiltInTool =
	| "search_notes"
	| "grep_notes"
	| "list_directory"
	| "read_content"
	| "manage_notes"
	| "execute_javascript"
	| "get_all_tags"
	| "get_properties"
	| "fetch_url"
	| "web_search"
	| "load_skill"
	| "write_todos"
	| "task"
	| "ask_question";

const BUILT_IN_TOOLS: ReadonlySet<string> = new Set<BuiltInTool>([
	"search_notes",
	"grep_notes",
	"list_directory",
	"read_content",
	"manage_notes",
	"execute_javascript",
	"get_all_tags",
	"get_properties",
	"fetch_url",
	"web_search",
	"load_skill",
	"write_todos",
	"task",
	"ask_question",
]);

function asBuiltIn(toolName: string): BuiltInTool | undefined {
	return BUILT_IN_TOOLS.has(toolName) ? (toolName as BuiltInTool) : undefined;
}

/* ── Small formatting helpers ── */

/** A counted noun ("3 notes"), one plural message per noun. */
type CountNoun =
	| "note"
	| "match"
	| "file"
	| "folder"
	| "line"
	| "tag"
	| "result"
	| "question"
	| "operation"
	| "item"
	| "row"
	| "field";

function pluralize(count: number, noun: CountNoun): string {
	switch (noun) {
		case "note":
			return t("chat.tool_summary.count.note", { count });
		case "match":
			return t("chat.tool_summary.count.match", { count });
		case "file":
			return t("chat.tool_summary.count.file", { count });
		case "folder":
			return t("chat.tool_summary.count.folder", { count });
		case "line":
			return t("chat.tool_summary.count.line", { count });
		case "tag":
			return t("chat.tool_summary.count.tag", { count });
		case "result":
			return t("chat.tool_summary.count.result", { count });
		case "question":
			return t("chat.tool_summary.count.question", { count });
		case "operation":
			return t("chat.tool_summary.count.operation", { count });
		case "item":
			return t("chat.tool_summary.count.item", { count });
		case "row":
			return t("chat.tool_summary.count.row", { count });
		case "field":
			return t("chat.tool_summary.count.field", { count });
	}
}

/** "found 3 notes" — the common outcome clause. */
function found(counted: string): string {
	return t("chat.tool_summary.found", { items: counted });
}

/** Truncate a target string so the phrase stays a single tidy line. */
function truncateTarget(value: string, max = 48): string {
	const trimmed = value.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max - 1)}…`;
}

/** The basename of a vault path (last non-empty segment), for compact labels. */
function basename(path: string): string {
	const segments = path.split("/").filter(Boolean);
	return segments.at(-1) ?? path;
}

function stringInput(input: Record<string, unknown> | null | undefined, key: string): string | undefined {
	const value = input?.[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Title-case a raw tool name as a fallback label (`get_all_tags` → `Get All Tags`). */
function titleCaseToolName(name: string): string {
	if (!name) return t("chat.tool_summary.tool_fallback");
	return name
		.replace(/_/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function countLines(text: string): number {
	if (!text) return 0;
	// A trailing newline shouldn't count as an extra empty line.
	const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
	return normalized.split(/\r?\n/).length;
}

/* ── Per-tool summaries ── */

/** Internal per-tool result: a tense-aware {@link Label} plus the muted summary. */
interface RawSummary {
	label: Label;
	summary: string;
}

function summarizeSearchNotes(
	input: Record<string, unknown> | null | undefined,
	model: ToolOutputRenderModel | undefined,
): RawSummary {
	const query = stringInput(input, "query");
	const recentOnly = input?.recentOnly === true;
	const label: Label = query
		? {
				verb: verb(
					"chat.tool_summary.verb.search_notes_for.running",
					"chat.tool_summary.verb.search_notes_for.done",
				),
				rest: `“${truncateTarget(query)}”`,
			}
		: recentOnly
			? { verb: verb("chat.tool_summary.verb.recent_notes.running", "chat.tool_summary.verb.recent_notes.done") }
			: { verb: verb("chat.tool_summary.verb.search_notes.running", "chat.tool_summary.verb.search_notes.done") };

	if (model?.kind !== "search_notes") return { label, summary: "" };
	const total = model.payload.totalResults ?? model.payload.results?.length ?? 0;
	return { label, summary: total === 0 ? t("chat.tool_summary.found_no_matches") : found(pluralize(total, "note")) };
}

function summarizeGrepNotes(
	input: Record<string, unknown> | null | undefined,
	model: ToolOutputRenderModel | undefined,
): RawSummary {
	const pattern = stringInput(input, "pattern");
	const label: Label = pattern
		? {
				verb: verb("chat.tool_summary.verb.grep_for.running", "chat.tool_summary.verb.grep_for.done"),
				rest: `“${truncateTarget(pattern)}”`,
			}
		: { verb: verb("chat.tool_summary.verb.grep.running", "chat.tool_summary.verb.grep.done") };

	// grep_notes returns generic JSON — pull totals straight off the raw payload.
	const payload = parseRawJson(model?.rawText);
	if (payload && typeof payload === "object") {
		const total = numberProp(payload, "total_matches");
		const files = numberProp(payload, "files_searched");
		if (total !== undefined) {
			if (total === 0) return { label, summary: t("chat.tool_summary.found_no_matches") };
			const matches = pluralize(total, "match");
			return {
				label,
				summary:
					files !== undefined
						? t("chat.tool_summary.found_in", { items: matches, files: pluralize(files, "file") })
						: found(matches),
			};
		}
	}
	return { label, summary: "" };
}

function summarizeListDirectory(
	input: Record<string, unknown> | null | undefined,
	model: ToolOutputRenderModel | undefined,
): RawSummary {
	const path = stringInput(input, "path") ?? stringInput(input, "root");
	const label: Label =
		path && path !== "/"
			? {
					verb: verb("chat.tool_summary.verb.list_folder.running", "chat.tool_summary.verb.list_folder.done"),
					rest: truncateTarget(basename(path)),
				}
			: { verb: verb("chat.tool_summary.verb.list_vault.running", "chat.tool_summary.verb.list_vault.done") };

	if (model?.kind !== "list_directory") return { label, summary: "" };
	const folders = model.payload.totalFolders ?? 0;
	const files = model.payload.totalFiles ?? 0;
	const filesPart = pluralize(files, "file");
	return {
		label,
		summary:
			folders > 0
				? t("chat.tool_summary.found_folders_and_files", {
						folders: pluralize(folders, "folder"),
						files: filesPart,
					})
				: found(filesPart),
	};
}

function summarizeReadContent(
	input: Record<string, unknown> | null | undefined,
	model: ToolOutputRenderModel | undefined,
): RawSummary {
	const target = stringInput(input, "target") ?? stringInput(input, "path");
	const label: Label = target
		? {
				verb: verb("chat.tool_summary.verb.read_target.running", "chat.tool_summary.verb.read_target.done"),
				rest: truncateTarget(basename(target)),
			}
		: { verb: verb("chat.tool_summary.verb.read_note.running", "chat.tool_summary.verb.read_note.done") };

	if (model?.kind !== "read_content") return { label, summary: "" };
	const lines = countLines(model.payload.content);
	const summary = model.payload.truncated
		? t("chat.tool_summary.truncated", { lines: pluralize(lines, "line") })
		: pluralize(lines, "line");
	return { label, summary };
}

function summarizeManageNotes(model: ToolOutputRenderModel | undefined): RawSummary {
	// The operation set can be large; a plain "Edited notes" reads cleaner than a list.
	if (model?.kind !== "manage_notes")
		return {
			label: {
				verb: verb("chat.tool_summary.verb.edit_notes.running", "chat.tool_summary.verb.edit_notes.done"),
			},
			summary: "",
		};
	const { operations, paths } = model.summary;
	const label: Label =
		paths === 1
			? { verb: verb("chat.tool_summary.verb.edit_note.running", "chat.tool_summary.verb.edit_note.done") }
			: { verb: verb("chat.tool_summary.verb.edit_notes.running", "chat.tool_summary.verb.edit_notes.done") };
	return {
		label,
		summary: t("chat.tool_summary.operations_across", {
			operations: pluralize(operations, "operation"),
			notes: pluralize(paths, "note"),
		}),
	};
}

function summarizeExecuteJavaScript(model: ToolOutputRenderModel | undefined): RawSummary {
	const label: Label = {
		verb: verb("chat.tool_summary.verb.run_javascript.running", "chat.tool_summary.verb.run_javascript.done"),
	};
	if (model?.kind !== "execute_javascript") return { label, summary: "" };
	if (model.payload.state === "error") return { label, summary: t("chat.tool_summary.errored") };
	const logs = model.payload.logs.length;
	const parts: string[] = [];
	if (logs > 0) parts.push(t("chat.tool_summary.logged", { lines: pluralize(logs, "line") }));
	if (model.payload.resultText) parts.push(t("chat.tool_summary.returned_value"));
	if (model.payload.durationMs !== undefined)
		parts.push(t("chat.tool_summary.duration_ms", { ms: model.payload.durationMs }));
	return { label, summary: parts.join(" ") };
}

function summarizeGetAllTags(model: ToolOutputRenderModel | undefined): RawSummary {
	const label: Label = {
		verb: verb("chat.tool_summary.verb.list_tags.running", "chat.tool_summary.verb.list_tags.done"),
	};
	const count = listLength(model);
	return { label, summary: count !== undefined ? found(pluralize(count, "tag")) : "" };
}

function summarizeGetProperties(input: Record<string, unknown> | null | undefined): RawSummary {
	const target = stringInput(input, "path") ?? stringInput(input, "target");
	const label: Label = target
		? {
				verb: verb(
					"chat.tool_summary.verb.read_properties_of.running",
					"chat.tool_summary.verb.read_properties_of.done",
				),
				rest: truncateTarget(basename(target)),
			}
		: {
				verb: verb(
					"chat.tool_summary.verb.read_properties.running",
					"chat.tool_summary.verb.read_properties.done",
				),
			};
	return { label, summary: "" };
}

function summarizeFetchUrl(input: Record<string, unknown> | null | undefined): RawSummary {
	const url = stringInput(input, "url");
	const label: Label = url
		? {
				verb: verb("chat.tool_summary.verb.fetch_target.running", "chat.tool_summary.verb.fetch_target.done"),
				rest: truncateTarget(hostOf(url)),
			}
		: { verb: verb("chat.tool_summary.verb.fetch_page.running", "chat.tool_summary.verb.fetch_page.done") };
	return { label, summary: "" };
}

function summarizeWebSearch(
	input: Record<string, unknown> | null | undefined,
	model: ToolOutputRenderModel | undefined,
): RawSummary {
	const query = stringInput(input, "query");
	const label: Label = query
		? {
				verb: verb(
					"chat.tool_summary.verb.web_search_for.running",
					"chat.tool_summary.verb.web_search_for.done",
				),
				rest: `“${truncateTarget(query)}”`,
			}
		: { verb: verb("chat.tool_summary.verb.web_search.running", "chat.tool_summary.verb.web_search.done") };
	const count = listLength(model);
	return { label, summary: count !== undefined ? found(pluralize(count, "result")) : "" };
}

function summarizeLoadSkill(input: Record<string, unknown> | null | undefined): RawSummary {
	const name = stringInput(input, "skillName");
	const label: Label = name
		? {
				verb: verb(
					"chat.tool_summary.verb.load_skill_target.running",
					"chat.tool_summary.verb.load_skill_target.done",
				),
				rest: truncateTarget(name),
			}
		: { verb: verb("chat.tool_summary.verb.load_skill.running", "chat.tool_summary.verb.load_skill.done") };
	return { label, summary: "" };
}

function summarizeWriteTodos(input: Record<string, unknown> | null | undefined): RawSummary {
	const label: Label = {
		verb: verb("chat.tool_summary.verb.update_todos.running", "chat.tool_summary.verb.update_todos.done"),
	};
	const todos = parseTodos(input);
	if (!todos) return { label, summary: "" };
	if (todos.length === 0)
		return {
			label: {
				verb: verb("chat.tool_summary.verb.clear_todos.running", "chat.tool_summary.verb.clear_todos.done"),
			},
			summary: "",
		};
	const done = todos.filter((todo) => todo.status === "completed").length;
	return { label, summary: t("chat.tool_summary.todos_done", { done, total: todos.length }) };
}

function summarizeAskQuestion(
	input: Record<string, unknown> | null | undefined,
	model: ToolOutputRenderModel | undefined,
): RawSummary {
	const questions = parseAskQuestions(input);
	const label: Label =
		questions.length === 1
			? {
					verb: verb("chat.tool_summary.verb.ask_target.running", "chat.tool_summary.verb.ask_target.done"),
					rest: `“${truncateTarget(questions[0].question)}”`,
				}
			: {
					verb: verb("chat.tool_summary.verb.ask_target.running", "chat.tool_summary.verb.ask_target.done"),
					rest: pluralize(questions.length, "question"),
				};
	if (model?.kind !== "ask_question") return { label, summary: "" };
	const result = model.result;
	if (result.status === "dismissed") return { label, summary: t("chat.tool_summary.dismissed") };
	if (result.status === "replied") return { label, summary: t("chat.tool_summary.answered_in_chat") };
	const only = result.answers.length === 1 ? result.answers[0].answer.join(", ") : "";
	return { label, summary: only ? truncateTarget(only) : t("chat.tool_summary.answered") };
}

/* ── Generic fallback (unknown / renamed tools) ── */

function summarizeGeneric(
	toolName: string,
	input: Record<string, unknown> | null | undefined,
	model: ToolOutputRenderModel | undefined,
): RawSummary {
	const name = titleCaseToolName(toolName);
	// A renamed/unknown tool has no known verb, so it can't be tensed — show a
	// neutral "Using <name>" / "Used <name>" frame that still reads as a sentence.
	const primary = firstStringInput(input);
	const rest = primary ? truncateTarget(primary) : name;
	const label: Label = primary
		? {
				verb: verb(
					"chat.tool_summary.verb.generic_target.running",
					"chat.tool_summary.verb.generic_target.done",
					{
						name,
					},
				),
				rest,
			}
		: { verb: verb("chat.tool_summary.verb.generic.running", "chat.tool_summary.verb.generic.done", { name }) };

	// Pull a light outcome hint from the shape the render model already computed.
	let summary = "";
	if (model) {
		switch (model.kind) {
			case "list":
				summary = found(pluralize(model.items.length, "item"));
				break;
			case "table":
				summary = found(pluralize(model.rows.length, "row"));
				break;
			case "keyValue":
				summary = found(pluralize(model.entries.length, "field"));
				break;
			default:
				summary = "";
		}
	}
	return { label, summary };
}

/* ── Shared payload helpers ── */

function parseRawJson(rawText: string | undefined): unknown {
	if (!rawText) return undefined;
	const trimmed = rawText.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function numberProp(obj: unknown, key: string): number | undefined {
	if (!obj || typeof obj !== "object") return undefined;
	const value = (obj as Record<string, unknown>)[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Count items for tools that render as a scalar/list of results, if determinable. */
function listLength(model: ToolOutputRenderModel | undefined): number | undefined {
	if (!model) return undefined;
	if (model.kind === "list") return model.items.length;
	if (model.kind === "table") return model.rows.length;
	const parsed = parseRawJson(model.rawText);
	if (Array.isArray(parsed)) return parsed.length;
	return undefined;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

function firstStringInput(input: Record<string, unknown> | null | undefined): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	for (const value of Object.values(input)) {
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

/**
 * Builds the compact plain-language label and one-line result summary for a tool
 * call, dispatching on the canonical built-in tool identity. `model` is the
 * already-normalised output render model (undefined while the tool is still
 * running or produced no output); `status` lets callers keep the summary empty
 * until an outcome exists if they prefer.
 */
export function buildToolSummary(
	toolName: string,
	input: Record<string, unknown> | null | undefined,
	model: ToolOutputRenderModel | undefined,
	status: ToolCallStatus,
): ToolSummary {
	const builtIn = asBuiltIn(toolName);

	const raw = ((): RawSummary => {
		switch (builtIn) {
			case "search_notes":
				return summarizeSearchNotes(input, model);
			case "grep_notes":
				return summarizeGrepNotes(input, model);
			case "list_directory":
				return summarizeListDirectory(input, model);
			case "read_content":
				return summarizeReadContent(input, model);
			case "manage_notes":
				return summarizeManageNotes(model);
			case "execute_javascript":
				return summarizeExecuteJavaScript(model);
			case "get_all_tags":
				return summarizeGetAllTags(model);
			case "get_properties":
				return summarizeGetProperties(input);
			case "fetch_url":
				return summarizeFetchUrl(input);
			case "web_search":
				return summarizeWebSearch(input, model);
			case "load_skill":
				return summarizeLoadSkill(input);
			case "write_todos":
				return summarizeWriteTodos(input);
			case "ask_question":
				return summarizeAskQuestion(input, model);
			default:
				return summarizeGeneric(toolName, input, model);
		}
	})();

	const label = renderLabel(raw.label, status);

	// While running with nothing decoded yet, a failed tool should still read as
	// failed rather than showing a stale summary from a prior render.
	if (status === "failed" && !model) {
		return { label, summary: t("chat.tool_summary.failed") };
	}
	return { label, summary: raw.summary };
}

/* ── Merged multi-call summaries ── */

/** One call in a merged group: its input plus already-normalised output model. */
export interface MergedCall {
	input: Record<string, unknown> | null | undefined;
	model: ToolOutputRenderModel | undefined;
}

/**
 * Per-tool recipe for merging several consecutive same-tool calls into one
 * sentence: the shared {@link Verb}, how to pull each call's target for the list,
 * whether targets read as quoted queries, and how to aggregate the result counts.
 */
interface MergeSpec {
	verb: Verb;
	/** The target shown in the list for one call (query, path basename, host…). */
	target: (input: Record<string, unknown> | null | undefined) => string | undefined;
	/** Whether list targets are wrapped in typographic quotes (queries vs paths). */
	quoted: boolean;
	/** Aggregated result summary across all calls (e.g. total matches/notes). */
	aggregate?: (calls: MergedCall[]) => string;
}

/** How many targets to name inline before collapsing the tail into "+N more". */
const MAX_LISTED_TARGETS = 4;

function sumBy(calls: MergedCall[], pick: (c: MergedCall) => number | undefined): number | undefined {
	let total = 0;
	let seen = false;
	for (const c of calls) {
		const n = pick(c);
		if (n !== undefined) {
			total += n;
			seen = true;
		}
	}
	return seen ? total : undefined;
}

const MERGE_SPECS: Partial<Record<BuiltInTool, MergeSpec>> = {
	search_notes: {
		verb: verb("chat.tool_summary.verb.search_notes_for.running", "chat.tool_summary.verb.search_notes_for.done"),
		target: (input) => stringInput(input, "query"),
		quoted: true,
		aggregate: (calls) => {
			const total = sumBy(calls, (c) =>
				c.model?.kind === "search_notes"
					? (c.model.payload.totalResults ?? c.model.payload.results?.length ?? 0)
					: undefined,
			);
			return total === undefined
				? ""
				: total === 0
					? t("chat.tool_summary.found_no_matches")
					: found(pluralize(total, "note"));
		},
	},
	grep_notes: {
		verb: verb("chat.tool_summary.verb.grep_for.running", "chat.tool_summary.verb.grep_for.done"),
		target: (input) => stringInput(input, "pattern"),
		quoted: true,
		aggregate: (calls) => {
			const total = sumBy(calls, (c) => {
				const payload = parseRawJson(c.model?.rawText);
				return payload && typeof payload === "object" ? numberProp(payload, "total_matches") : undefined;
			});
			return total === undefined
				? ""
				: total === 0
					? t("chat.tool_summary.found_no_matches")
					: found(pluralize(total, "match"));
		},
	},
	read_content: {
		verb: verb("chat.tool_summary.verb.read_target.running", "chat.tool_summary.verb.read_target.done"),
		target: (input) => {
			const target = stringInput(input, "target") ?? stringInput(input, "path");
			return target ? basename(target) : undefined;
		},
		quoted: false,
		aggregate: (calls) => {
			const total = sumBy(calls, (c) =>
				c.model?.kind === "read_content" ? countLines(c.model.payload.content) : undefined,
			);
			return total === undefined ? "" : t("chat.tool_summary.lines_total", { lines: pluralize(total, "line") });
		},
	},
	get_properties: {
		verb: verb(
			"chat.tool_summary.verb.read_properties_of.running",
			"chat.tool_summary.verb.read_properties_of.done",
		),
		target: (input) => {
			const target = stringInput(input, "path") ?? stringInput(input, "target");
			return target ? basename(target) : undefined;
		},
		quoted: false,
	},
	fetch_url: {
		verb: verb("chat.tool_summary.verb.fetch_target.running", "chat.tool_summary.verb.fetch_target.done"),
		target: (input) => {
			const url = stringInput(input, "url");
			return url ? hostOf(url) : undefined;
		},
		quoted: false,
	},
	web_search: {
		verb: verb("chat.tool_summary.verb.web_search_for.running", "chat.tool_summary.verb.web_search_for.done"),
		target: (input) => stringInput(input, "query"),
		quoted: true,
	},
	load_skill: {
		verb: verb("chat.tool_summary.verb.load_skill_target.running", "chat.tool_summary.verb.load_skill_target.done"),
		target: (input) => stringInput(input, "skillName"),
		quoted: false,
	},
};

/** Joins listed targets into "a, b and c", capping the tail as "a, b and N more". */
function joinTargets(targets: string[], quoted: boolean): string {
	const wrap = (target: string) => (quoted ? `“${truncateTarget(target, 32)}”` : truncateTarget(target, 32));
	const separator = t("chat.tool_summary.list_separator");
	if (targets.length <= MAX_LISTED_TARGETS) {
		const wrapped = targets.map(wrap);
		if (wrapped.length === 1) return wrapped[0];
		return t("chat.tool_summary.list_and", {
			list: wrapped.slice(0, -1).join(separator),
			last: wrapped.at(-1) ?? "",
		});
	}
	const head = targets.slice(0, MAX_LISTED_TARGETS).map(wrap);
	const remaining = targets.length - MAX_LISTED_TARGETS;
	return t("chat.tool_summary.list_and_more", { list: head.join(separator), count: remaining });
}

/**
 * Builds one combined, tense-aware summary for a run of consecutive calls to the
 * same tool. When the tool has a clear per-call target (a query or path), the
 * label lists them (e.g. `Searched for text "a", "b" and "c"`); otherwise it
 * falls back to a count phrase (e.g. `Read 3 notes`). The result summary is the
 * tool's aggregate across all calls where one is defined. `status` is the merged
 * status of the group (running if any call is still running).
 */
export function buildMergedToolSummary(toolName: string, calls: MergedCall[], status: ToolCallStatus): ToolSummary {
	// Degenerate group: defer to the single-call summary.
	if (calls.length === 1) {
		return buildToolSummary(toolName, calls[0].input, calls[0].model, status);
	}

	const builtIn = asBuiltIn(toolName);
	const spec = builtIn ? MERGE_SPECS[builtIn] : undefined;

	// No merge recipe (or a tool whose calls don't share a target): fall back to a
	// count phrase using the single-call verb, so the row still reads as a sentence.
	if (!spec) {
		// Re-summarize with empty input so the label is just the tense-aware verb
		// (e.g. "Listed all tags"), never the *first* call's target clause — that
		// clause describes one call and would misrepresent the whole group.
		const base = buildToolSummary(toolName, {}, undefined, status);
		const label = `${base.label} ×${calls.length}`;
		// Sum the count-based outcomes each call already computed so a merged
		// generic tool still reports its result (e.g. two get_all_tags → "found N tags").
		const summary = status === "failed" ? t("chat.tool_summary.failed") : mergedGenericSummary(calls);
		return { label, summary };
	}

	const targets = calls.map((c) => spec.target(c.input)).filter((target): target is string => !!target);
	const noun: CountNoun = builtIn === "read_content" || builtIn === "get_properties" ? "note" : "item";

	let rest: string;
	if (targets.length === calls.length && targets.length > 0) {
		rest = joinTargets(targets, spec.quoted);
	} else {
		// Some calls had no extractable target — summarise by count instead of a
		// partial, misleading list.
		rest = pluralize(calls.length, noun);
	}

	const label = renderLabel({ verb: spec.verb, rest }, status);
	// A failed group must not display a positive aggregate ("found 3 notes") in red —
	// mirror the single-call failed guard. Aggregates are also empty while running.
	if (status === "failed") return { label, summary: t("chat.tool_summary.failed") };
	const summary = status === "running" || status === "pending" ? "" : (spec.aggregate?.(calls) ?? "");
	return { label, summary };
}

/**
 * Sums the count-based outcomes (list/table/keyValue) across a merged run of a
 * generic tool with no dedicated merge recipe, so the row still reports a result.
 * Returns an empty string when no call produced a countable shape.
 */
function mergedGenericSummary(calls: MergedCall[]): string {
	let total = 0;
	let noun: CountNoun | undefined;
	for (const c of calls) {
		switch (c.model?.kind) {
			case "list":
				total += c.model.items.length;
				noun ??= "item";
				break;
			case "table":
				total += c.model.rows.length;
				noun ??= "row";
				break;
			case "keyValue":
				total += c.model.entries.length;
				noun ??= "field";
				break;
		}
	}
	return noun ? found(pluralize(total, noun)) : "";
}
