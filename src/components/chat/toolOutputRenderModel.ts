interface SearchNotesResult {
	rank?: number;
	name?: string;
	path?: string;
	score?: number;
	tags?: string[];
	matchExplanation?: string;
	matchBadges?: string[];
}

interface SearchNotesPayload {
	query?: string;
	recentOnly?: boolean;
	algorithm?: string;
	maxResults?: number;
	totalResults?: number;
	returnedResults?: number;
	skippedPrivateFiles?: number;
	message?: string;
	results?: SearchNotesResult[];
}

interface DirectoryFileEntry {
	name?: string;
	extension?: string;
	size?: number;
}

interface DirectoryTreeNode {
	folders?: Record<string, DirectoryTreeNode>;
	files?: DirectoryFileEntry[];
}

interface ListDirectoryPayload {
	root?: string;
	recursive?: boolean;
	maxDepth?: number;
	tree?: DirectoryTreeNode;
	totalFolders?: number;
	totalFiles?: number;
	skippedPrivateFiles?: number;
}

interface ManageNotesSummary {
	operations: number;
	paths: number;
	breakdown: string[];
	message: string;
}

interface ReadContentPayload {
	target: string;
	sourceType: "file" | "pdf" | "excalidraw";
	content: string;
	label?: string;
	analysisLabel?: string;
	truncated?: boolean;
}

interface ExecuteJavaScriptPayload {
	state: "success" | "error";
	durationMs?: number;
	logs: string[];
	resultText?: string;
	errorMessage?: string;
	code?: string;
	inputJson?: string;
}

export interface QuestionAnswerItem {
	questionId?: string;
	question: string;
	selected: string[];
	customText?: string;
}

export interface AskQuestionPayload {
	status?: string;
	answers: QuestionAnswerItem[];
}

interface StructuredSection {
	key: string;
	label: string;
	json: string;
	summary: string;
}

type ScalarValue = string | number | boolean | null;

export type ToolOutputRenderModel =
	| {
			kind: "empty";
			rawText: string;
	  }
	| {
			kind: "markdown";
			markdown: string;
			rawText: string;
	  }
	| {
			kind: "scalar";
			value: string;
			rawText: string;
	  }
	| {
			kind: "keyValue";
			entries: { key: string; value: string }[];
			rawText: string;
	  }
	| {
			kind: "list";
			items: string[];
			rawText: string;
	  }
	| {
			kind: "table";
			columns: string[];
			rows: Record<string, string>[];
			rawText: string;
	  }
	| {
			kind: "structured";
			summaryEntries: { key: string; value: string }[];
			sections: StructuredSection[];
			json: string;
			rawText: string;
	  }
	| {
			kind: "search_notes";
			payload: SearchNotesPayload;
			rawText: string;
	  }
	| {
			kind: "list_directory";
			payload: ListDirectoryPayload;
			rawText: string;
	  }
	| {
			kind: "manage_notes";
			summary: ManageNotesSummary;
			rawText: string;
	  }
	| {
			kind: "read_content";
			payload: ReadContentPayload;
			rawText: string;
	  }
	| {
			kind: "execute_javascript";
			payload: ExecuteJavaScriptPayload;
			rawText: string;
	  }
	| {
			kind: "ask_question";
			payload: AskQuestionPayload;
			rawText: string;
	  };

const JSON_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
const MARKDOWN_PATTERNS = [
	/^#{1,6}\s/m,
	/^[-*+]\s/m,
	/^>\s/m,
	/^```/m,
	/^\d+\.\s/m,
	/\|.+\|/,
	/\[.+\]\(.+\)/,
	/\[\[[^\]]+\]\]/,
];

export function buildToolOutputRenderModel(
	toolName: string,
	output: unknown,
	input?: Record<string, unknown> | null,
): ToolOutputRenderModel {
	if (output === null || output === undefined) {
		return { kind: "empty", rawText: "" };
	}

	const extracted = extractStructuredOutput(output);
	if (extracted !== undefined) {
		return buildNormalizedOutputRenderModel(toolName, extracted, input);
	}

	return buildNormalizedOutputRenderModel(toolName, output, input);
}

function buildNormalizedOutputRenderModel(
	toolName: string,
	output: unknown,
	input?: Record<string, unknown> | null,
): ToolOutputRenderModel {
	if (typeof output === "string") {
		return buildStringOutputRenderModel(toolName, output, input);
	}

	if (typeof output === "number" || typeof output === "boolean") {
		return {
			kind: "scalar",
			value: String(output),
			rawText: String(output),
		};
	}

	return classifyStructuredValue(toolName, output, stringifyCompactValue(output), input);
}

function buildStringOutputRenderModel(
	toolName: string,
	output: string,
	input?: Record<string, unknown> | null,
): ToolOutputRenderModel {
	const trimmed = output.trim();
	if (!trimmed) return { kind: "empty", rawText: output };

	const parsed = parseJsonString(trimmed);
	if (parsed !== undefined) {
		return classifyStructuredValue(toolName, parsed, trimmed, input);
	}

	const specialized = buildSpecializedStringModel(toolName, trimmed, input);
	if (specialized) return specialized;

	if (looksLikeMarkdown(trimmed)) {
		return { kind: "markdown", markdown: trimmed, rawText: trimmed };
	}

	return { kind: "markdown", markdown: trimmed, rawText: trimmed };
}

function buildSpecializedStringModel(
	toolName: string,
	trimmed: string,
	input?: Record<string, unknown> | null,
): ToolOutputRenderModel | undefined {
	if (toolName === "manage_notes") {
		const manageNotesSummary = parseManageNotesSummary(trimmed);
		if (manageNotesSummary) {
			return {
				kind: "manage_notes",
				summary: manageNotesSummary,
				rawText: trimmed,
			};
		}
	}

	if (toolName === "read_content") {
		const readContentPayload = parseReadContentPayload(trimmed);
		if (readContentPayload) {
			return {
				kind: "read_content",
				payload: readContentPayload,
				rawText: trimmed,
			};
		}
	}

	if (toolName === "execute_javascript") {
		return {
			kind: "execute_javascript",
			payload: buildExecuteJavaScriptPayload(trimmed, input),
			rawText: trimmed,
		};
	}

	if (toolName === "ask_question") {
		const payload = parseAskQuestionPayload(trimmed);
		if (payload) {
			return {
				kind: "ask_question",
				payload,
				rawText: trimmed,
			};
		}
	}

	return undefined;
}

function classifyStructuredValue(
	toolName: string,
	value: unknown,
	rawText: string,
	input?: Record<string, unknown> | null,
): ToolOutputRenderModel {
	const toolSpecificModel = buildStructuredToolSpecificModel(toolName, value, rawText, input);
	if (toolSpecificModel) return toolSpecificModel;

	if (Array.isArray(value)) return buildArrayRenderModel(value, rawText);
	if (isPlainObject(value)) return buildObjectRenderModel(value, rawText);

	return {
		kind: "scalar",
		value: describeUnknownValue(value),
		rawText,
	};
}

function buildStructuredToolSpecificModel(
	toolName: string,
	value: unknown,
	rawText: string,
	input?: Record<string, unknown> | null,
): ToolOutputRenderModel | undefined {
	if (toolName === "search_notes" && isSearchNotesPayload(value)) {
		return { kind: "search_notes", payload: value, rawText };
	}

	if (toolName === "list_directory" && isListDirectoryPayload(value)) {
		return { kind: "list_directory", payload: value, rawText };
	}

	if (toolName === "execute_javascript" && typeof value === "string") {
		return {
			kind: "execute_javascript",
			payload: buildExecuteJavaScriptPayload(value, input),
			rawText,
		};
	}

	if (toolName === "ask_question" && isAskQuestionPayload(value)) {
		return { kind: "ask_question", payload: value, rawText };
	}

	return undefined;
}

function buildArrayRenderModel(value: unknown[], rawText: string): ToolOutputRenderModel {
	if (value.every(isScalar)) {
		return {
			kind: "list",
			items: value.map((item) => formatScalar(item)),
			rawText,
		};
	}

	const tableModel = buildTableModel(value);
	if (tableModel) {
		return {
			kind: "table",
			columns: tableModel.columns,
			rows: tableModel.rows,
			rawText,
		};
	}

	return {
		kind: "structured",
		summaryEntries: [{ key: "items", value: String(value.length) }],
		sections: [],
		json: stringifyPrettyValue(value),
		rawText,
	};
}

function buildObjectRenderModel(value: Record<string, unknown>, rawText: string): ToolOutputRenderModel {
	const scalarEntries = Object.entries(value).reduce<{ key: string; value: string }[]>(
		(entries, [key, entryValue]) => {
			if (isScalar(entryValue)) {
				entries.push({ key, value: formatScalar(entryValue) });
			}
			return entries;
		},
		[],
	);

	const sections = Object.entries(value)
		.filter(([, entryValue]) => !isScalar(entryValue))
		.map(([key, entryValue]) => ({
			key,
			label: formatLabel(key),
			json: stringifyPrettyValue(entryValue),
			summary: summarizeValue(entryValue),
		}));

	if (sections.length === 0) {
		return {
			kind: "keyValue",
			entries: scalarEntries,
			rawText,
		};
	}

	return {
		kind: "structured",
		summaryEntries: scalarEntries,
		sections,
		json: stringifyPrettyValue(value),
		rawText,
	};
}

function looksLikeMarkdown(value: string): boolean {
	return MARKDOWN_PATTERNS.some((pattern) => pattern.test(value));
}

function extractStructuredOutput(output: unknown): unknown {
	if (Array.isArray(output)) {
		const contentBlocks = output.map((item) => extractContentBlockValue(item)).filter((item) => item !== undefined);

		if (contentBlocks.length > 0) {
			if (contentBlocks.length === 1) return contentBlocks[0];
			return contentBlocks;
		}
	}

	if (isPlainObject(output)) {
		if (output.type === "text" && typeof output.text === "string") {
			return output.text;
		}

		if (output.type === "json" && "data" in output) {
			return output.data;
		}

		if ("content" in output) {
			const extractedContent = extractStructuredOutput(output.content);
			return extractedContent ?? output.content;
		}
	}

	return undefined;
}

function extractContentBlockValue(item: unknown): unknown {
	if (!isPlainObject(item)) return undefined;
	if (item.type === "text" && typeof item.text === "string") return item.text;
	if (item.type === "json" && "data" in item) return item.data;
	return undefined;
}

function parseJsonString(value: string): Record<string, unknown> | unknown[] | undefined {
	const fencedMatch = JSON_FENCE.exec(value);
	const candidate = fencedMatch?.[1]?.trim() ?? value;
	if (!(candidate.startsWith("{") || candidate.startsWith("["))) return undefined;

	try {
		return JSON.parse(candidate);
	} catch {
		return undefined;
	}
}

function parseManageNotesSummary(value: string): ManageNotesSummary | undefined {
	const match = /^Proposed\s+(\d+)\s+note operation\(s\)\s+across\s+(\d+)\s+path\(s\)\s+\((.+)\)(?:\s+-.*)?$/.exec(
		value,
	);
	if (!match) return undefined;

	return {
		operations: Number(match[1]),
		paths: Number(match[2]),
		breakdown: match[3].split(/,\s*/).filter(Boolean),
		message: value,
	};
}

function parseReadContentPayload(value: string): ReadContentPayload | undefined {
	let remaining = value;
	let analysisLabel: string | undefined;
	const analysisMatch = /^\[(.+?)\]\s+/.exec(remaining);
	if (analysisMatch) {
		analysisLabel = analysisMatch[1];
		remaining = remaining.slice(analysisMatch[0].length);
	}

	const pdfMatch = /^Content of PDF "([^"]+)"(?: \((.+)\))?:\n\n([\s\S]+)$/.exec(remaining);
	if (pdfMatch) {
		return {
			target: pdfMatch[1],
			sourceType: "pdf",
			label: pdfMatch[2],
			content: pdfMatch[3],
			analysisLabel,
			truncated: pdfMatch[3].includes("[Content truncated at"),
		};
	}

	const excalidrawMatch = /^Content of Excalidraw drawing "([^"]+)"(?: \((.+)\))?:\n\n([\s\S]+)$/.exec(remaining);
	if (excalidrawMatch) {
		return {
			target: excalidrawMatch[1],
			sourceType: "excalidraw",
			label: excalidrawMatch[2],
			content: excalidrawMatch[3],
			analysisLabel,
			truncated: excalidrawMatch[3].includes("[Content truncated at"),
		};
	}

	const fileMatch = /^Content of "([^"]+)"(?: \((.+)\))?:\n\n([\s\S]+)$/.exec(remaining);
	if (fileMatch) {
		return {
			target: fileMatch[1],
			sourceType: "file",
			label: fileMatch[2],
			content: fileMatch[3],
			analysisLabel,
			truncated: fileMatch[3].includes("[Content truncated at"),
		};
	}

	return undefined;
}

function buildExecuteJavaScriptPayload(
	output: string,
	input?: Record<string, unknown> | null,
): ExecuteJavaScriptPayload {
	const code = typeof input?.code === "string" ? input.code : undefined;
	const inputJson = input && "input" in input ? stringifyCompactValue(input.input) : undefined;
	const trimmed = output.trim();

	if (trimmed.startsWith("JavaScript execution failed:")) {
		return {
			state: "error",
			logs: [],
			errorMessage: trimmed.replace(/^JavaScript execution failed:\s*/, ""),
			code,
			inputJson,
		};
	}

	const durationMatch = /^Execution completed in (\d+)ms\./.exec(trimmed);
	const durationMs = durationMatch ? Number(durationMatch[1]) : undefined;
	const logsMatch = /(?:^|\n\n)Console output:\n([\s\S]*?)(?=\n\nReturn value:|$)/.exec(trimmed);
	const logs = logsMatch?.[1]
		? logsMatch[1]
				.split("\n")
				.map((line) => line.replace(/^[-*]\s*/, "").trim())
				.filter(Boolean)
		: [];
	const returnMatch = /(?:^|\n\n)Return value:\n([\s\S]+)$/.exec(trimmed);
	let resultText: string | undefined;
	if (returnMatch) {
		resultText = returnMatch[1].trim();
	} else if (/Return value: undefined\./.test(trimmed)) {
		resultText = "undefined";
	}

	return {
		state: "success",
		durationMs,
		logs,
		resultText,
		code,
		inputJson,
	};
}

function buildTableModel(value: unknown[]): { columns: string[]; rows: Record<string, string>[] } | undefined {
	if (!value.every(isPlainObject)) return undefined;

	const keySet = new Set<string>();
	for (const row of value) {
		for (const key of Object.keys(row)) keySet.add(key);
	}

	const columns = Array.from(keySet);
	if (columns.length === 0 || columns.length > 6) return undefined;

	const rows = value.map((row) => {
		const formattedRow: Record<string, string> = {};
		for (const column of columns) {
			formattedRow[column] = formatCellValue(row[column]);
		}
		return formattedRow;
	});

	return { columns, rows };
}

function formatCellValue(value: unknown): string {
	if (isScalar(value)) return formatScalar(value);
	if (Array.isArray(value) && value.every(isScalar)) {
		return value.map((item) => formatScalar(item)).join(", ");
	}
	return summarizeValue(value);
}

function summarizeValue(value: unknown): string {
	if (Array.isArray(value)) {
		return `${value.length} item${value.length === 1 ? "" : "s"}`;
	}

	if (isPlainObject(value)) {
		const keyCount = Object.keys(value).length;
		return `${keyCount} key${keyCount === 1 ? "" : "s"}`;
	}

	if (isScalar(value)) return formatScalar(value);
	return describeUnknownValue(value);
}

function formatScalar(value: ScalarValue): string {
	if (value === null) return "null";
	return String(value);
}

function formatLabel(key: string): string {
	return key.replaceAll("_", " ").replaceAll(/\b\w/g, (char) => char.toUpperCase());
}

function stringifyCompactValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		const serialized = JSON.stringify(value);
		return serialized ?? describeUnknownValue(value);
	} catch {
		return describeUnknownValue(value);
	}
}

function stringifyPrettyValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		const serialized = JSON.stringify(value, null, 2);
		return serialized ?? describeUnknownValue(value);
	} catch {
		return describeUnknownValue(value);
	}
}

function isDirectoryFileEntry(value: unknown): value is DirectoryFileEntry {
	if (!isPlainObject(value)) return false;
	if ("name" in value && value.name !== undefined && typeof value.name !== "string") return false;
	if ("extension" in value && value.extension !== undefined && typeof value.extension !== "string") return false;
	if ("size" in value && value.size !== undefined && typeof value.size !== "number") return false;
	return true;
}

function isDirectoryTreeNode(value: unknown): value is DirectoryTreeNode {
	if (!isPlainObject(value)) return false;

	if ("files" in value) {
		if (!Array.isArray(value.files) || !value.files.every(isDirectoryFileEntry)) return false;
	}

	if ("folders" in value) {
		if (!isPlainObject(value.folders)) return false;
		if (!Object.values(value.folders).every(isDirectoryTreeNode)) return false;
	}

	return true;
}

function describeUnknownValue(value: unknown): string {
	if (typeof value === "symbol") return value.toString();
	if (typeof value === "function") return "[function]";
	return Object.prototype.toString.call(value);
}

function isScalar(value: unknown): value is ScalarValue {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSearchNotesPayload(value: unknown): value is SearchNotesPayload {
	if (!isPlainObject(value)) return false;
	if (!("results" in value) || !Array.isArray(value.results)) return false;
	return value.results.every((item) => isPlainObject(item));
}

function isListDirectoryPayload(value: unknown): value is ListDirectoryPayload {
	if (!isPlainObject(value)) return false;
	if ("root" in value && value.root !== undefined && typeof value.root !== "string") return false;
	if ("recursive" in value && value.recursive !== undefined && typeof value.recursive !== "boolean") return false;
	if ("maxDepth" in value && value.maxDepth !== undefined && typeof value.maxDepth !== "number") return false;
	if ("totalFolders" in value && value.totalFolders !== undefined && typeof value.totalFolders !== "number")
		return false;
	if ("totalFiles" in value && value.totalFiles !== undefined && typeof value.totalFiles !== "number") return false;
	if (
		"skippedPrivateFiles" in value &&
		value.skippedPrivateFiles !== undefined &&
		typeof value.skippedPrivateFiles !== "number"
	)
		return false;
	if (!("tree" in value) || !isDirectoryTreeNode(value.tree)) return false;
	return true;
}

function parseAskQuestionPayload(raw: string): AskQuestionPayload | undefined {
	const parsed = parseJsonString(raw);
	if (isAskQuestionPayload(parsed)) return parsed;
	return undefined;
}

function isAskQuestionPayload(value: unknown): value is AskQuestionPayload {
	if (!isPlainObject(value)) return false;
	if (!("answers" in value) || !Array.isArray(value.answers)) return false;
	return value.answers.every((item) => isPlainObject(item) && typeof item.question === "string");
}
