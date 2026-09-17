/**
 * The `s2b-widget` fence: an agent-generated widget.
 *
 * The fence body is an HTML document fragment (markup, `<style>`, `<script>`) that is
 * rendered inside a sandboxed iframe (see `viewFrame.ts`). An optional leading
 * frontmatter block declares what the host should do for it:
 *
 * ```s2b-widget
 * ---
 * title: Notes per tag
 * height: 320
 * queries:
 *   tags: TABLE length(rows) AS n FROM "" FLATTEN file.tags AS tag GROUP BY tag
 * ---
 * <div id="app"></div>
 * <script>s2b.onData(({ tags }) => { ... });</script>
 * ```
 *
 * `queries` are Dataview DQL strings the host runs and re-runs on vault changes; the
 * results are posted into the frame (see `viewQueries.ts`). `libs` names vendored
 * browser libraries to inline into the frame (see `viewLibs.ts`). The parser here is a
 * small purpose-built one rather than a YAML library: the block has four known keys, a
 * query is either a one-line scalar or a `|`/`>` block, and a list is a scalar, a flow
 * list, or a `- item` block — which is all a model needs.
 */

export const WIDGET_BLOCK_LANGUAGE = "s2b-widget";

export interface WidgetSpec {
	/** Shown in the chat toolbar and used as the file name when saved. */
	title?: string;
	/** One line on what the widget shows. With the title, the only text of a `.widget` file that is indexed. */
	description?: string;
	/** Lucide icon name for the tab and toolbar; see `widgetIcon.ts` for the default and validation. */
	icon?: string;
	/** Fixed frame height in px. When absent the frame follows its content height. */
	height?: number;
	/** Named Dataview queries, run by the host and kept live. */
	queries: Record<string, string>;
	/** Ids of vendored libraries to inline into the frame (`viewLibs.ts`), in order. */
	libs: string[];
	/** The HTML rendered inside the frame. */
	body: string;
}

const FRONTMATTER_DELIMITER = "---";
const TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*):\s*(.*)$/;
const NESTED_KEY = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/;
const BLOCK_SCALAR_INDICATORS = new Set(["|", "|-", "|+", ">", ">-", ">+"]);

/** Parse a fence body into its spec. Never throws: malformed frontmatter is treated as body. */
export function parseWidgetSpec(source: string): WidgetSpec {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	let start = 0;
	while (start < lines.length && lines[start].trim() === "") start++;
	if (lines[start]?.trim() !== FRONTMATTER_DELIMITER) {
		return { queries: {}, libs: [], body: source.trim() };
	}
	let end = -1;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i].trim() === FRONTMATTER_DELIMITER) {
			end = i;
			break;
		}
	}
	if (end === -1) return { queries: {}, libs: [], body: source.trim() };

	const spec = parseFrontmatter(lines.slice(start + 1, end));
	spec.body = lines
		.slice(end + 1)
		.join("\n")
		.trim();
	return spec;
}

function parseFrontmatter(lines: string[]): WidgetSpec {
	const spec: WidgetSpec = { queries: {}, libs: [], body: "" };
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) {
			i++;
			continue;
		}
		const match = TOP_LEVEL_KEY.exec(line);
		if (!match) {
			i++;
			continue;
		}
		const [, key, rawValue] = match;
		if (key === "queries") {
			i = parseQueries(lines, i + 1, spec.queries);
			continue;
		}
		if (key === "libs") {
			i = parseList(lines, i + 1, rawValue, spec.libs);
			continue;
		}
		const value = unquote(rawValue);
		if (key === "title" && value) {
			spec.title = value;
		} else if (key === "description" && value) {
			spec.description = value;
		} else if (key === "icon" && value) {
			spec.icon = value;
		} else if (key === "height") {
			const height = Number.parseInt(value, 10);
			if (Number.isFinite(height) && height > 0) spec.height = height;
		}
		i++;
	}
	return spec;
}

/** Parse the indented entries under `queries:`; returns the index of the first line after them. */
function parseQueries(lines: string[], from: number, out: Record<string, string>): number {
	let i = from;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") {
			i++;
			continue;
		}
		const indent = indentOf(line);
		if (indent === 0) return i;
		const match = NESTED_KEY.exec(line);
		if (!match) {
			i++;
			continue;
		}
		const [, name, rawValue] = match;
		i++;
		if (BLOCK_SCALAR_INDICATORS.has(rawValue.trim())) {
			const block: string[] = [];
			while (i < lines.length) {
				const next = lines[i];
				if (next.trim() === "") {
					block.push("");
					i++;
					continue;
				}
				if (indentOf(next) <= indent) break;
				block.push(next.trim());
				i++;
			}
			out[name] = block.join("\n").trim();
		} else {
			out[name] = unquote(rawValue);
		}
	}
	return i;
}

/**
 * Parse a list value: a scalar (`a`, `a b`, `a, b`), a flow list (`[a, b]`), or — when
 * the value is empty — the `- item` lines that follow. Returns the index after the list.
 */
function parseList(lines: string[], from: number, rawValue: string, out: string[]): number {
	const inline = rawValue.trim();
	if (inline) {
		for (const item of inline.replace(/^\[|\]$/g, "").split(/[\s,]+/)) {
			const value = unquote(item);
			if (value) out.push(value);
		}
		return from;
	}
	let i = from;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") {
			i++;
			continue;
		}
		const match = /^\s*-\s*(.+)$/.exec(line);
		if (!match || indentOf(line) === 0) return i;
		const value = unquote(match[1]);
		if (value) out.push(value);
		i++;
	}
	return i;
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

/**
 * Wrap a fence body back into a markdown fence. The fence is made longer than any
 * backtick run inside the body so a ``` in a `<script>` can't close it early.
 */
export function wrapWidgetFence(source: string): string {
	const longest = Math.max(2, ...[...source.matchAll(/`+/g)].map((m) => m[0].length));
	const fence = "`".repeat(longest + 1);
	return `${fence}${WIDGET_BLOCK_LANGUAGE}\n${source.trim()}\n${fence}\n`;
}

/**
 * The text a `.widget` file contributes to the search indexes: its title and description,
 * never its body. Enough to find a widget by what it is about; no markup or script becomes
 * a chunk. Empty when it has neither (the indexer then falls back to the file name).
 */
export function widgetIndexText(source: string): string {
	const { title, description } = parseWidgetSpec(source);
	return [title, description].filter((part): part is string => Boolean(part)).join("\n");
}

/** A vault-safe note basename for a widget, from its title. */
export function widgetFileBasename(title: string | undefined): string {
	const cleaned = (title ?? "")
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned || "Widget";
}
