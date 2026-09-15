import { BUILT_IN_TOOL_IDS, type BuiltInToolId, type ToolConfig, type ToolsConfig } from "../../types/plugin";

/**
 * The one table describing every built-in tool: what the settings UI calls it, the
 * one-line summary the UI shows under it, and the stored default `ToolConfig` (the
 * model-facing name/description plus enabled state and settings).
 *
 * `DEFAULT_TOOLS_CONFIG` (what a new agent's `toolsConfig` is seeded from) and the UI
 * lookups below are all derived from it, so a tool is added or reworded in exactly
 * one place. `BUILT_IN_TOOL_IDS` in types/plugin.ts stays the type-level source of
 * ids; the table is keyed by it, so a missing entry is a compile error.
 */
export interface BuiltInToolDefault {
	/** Title-cased label for the settings UI. */
	displayName: string;
	/** One-line summary shown under the tool in the Tools modal. Shorter than the model-facing description. */
	summary: string;
	/** Stored default configuration: model-facing name/description, enabled state, settings. */
	config: ToolConfig;
}

// --- read_content: the description depends on which processors are attached ---------------

const READ_CONTENT_DESC_SHARED = "Read content of vault files by path or wiki link.";

/** No processors: images can't be read */
const READ_CONTENT_DESC_NONE = `${READ_CONTENT_DESC_SHARED} Supports text, PDFs, and Excalidraw. Images must be attached directly in chat.`;

/** Image processor only */
const READ_CONTENT_DESC_IMAGE = `${READ_CONTENT_DESC_SHARED} Supports text, PDFs, images, and Excalidraw.`;

/** PDF processor only */
const READ_CONTENT_DESC_PDF = `${READ_CONTENT_DESC_SHARED} Supports text, PDFs (analyzed via vision model), and Excalidraw. Images must be attached directly in chat.`;

/** Both processors */
const READ_CONTENT_DESC_BOTH = `${READ_CONTENT_DESC_SHARED} Supports text, PDFs (analyzed via vision model), images, and Excalidraw.`;

/**
 * Returns the appropriate read_content description based on processor configuration.
 */
export function getReadContentDescription(hasImageProcessor: boolean, hasPdfProcessor: boolean): string {
	if (hasImageProcessor && hasPdfProcessor) return READ_CONTENT_DESC_BOTH;
	if (hasImageProcessor) return READ_CONTENT_DESC_IMAGE;
	if (hasPdfProcessor) return READ_CONTENT_DESC_PDF;
	return READ_CONTENT_DESC_NONE;
}

// --- search_notes: the description depends on whether an embedding index exists ------------

const SEARCH_NOTES_DESC_SHARED =
	"Search through your Obsidian notes, or return recently opened notes. Returns structured JSON with matching file names, paths, tags, match reasons, short match snippets or headings, and metadata (properties/frontmatter), plus a count of results hidden by privacy rules. Use this to identify relevant notes before using other tools.";

/** An embedding index exists, so all three retrieval strategies are usable. */
const SEARCH_NOTES_DESC_EMBEDDINGS = `${SEARCH_NOTES_DESC_SHARED} Pick the retrieval strategy with \`algorithm\`: \`lexical\` (default, fast, exact keyword matching) is usually the right first attempt — escalate to \`semantic\` or \`hybrid\` when wording rather than content is the obstacle.`;

/** No embedding index — semantic and hybrid will fall back to lexical. */
const SEARCH_NOTES_DESC_LEXICAL_ONLY = `${SEARCH_NOTES_DESC_SHARED} This vault has no embedding index configured, so only \`algorithm: "lexical"\` is available; \`semantic\` and \`hybrid\` fall back to it and say so. Vary your search *terms* rather than the algorithm.`;

/** Returns the search_notes description matching the vault's embedding-index state. */
export function getSearchNotesDescription(hasEmbeddingIndex: boolean): string {
	return hasEmbeddingIndex ? SEARCH_NOTES_DESC_EMBEDDINGS : SEARCH_NOTES_DESC_LEXICAL_ONLY;
}

// --- the table -----------------------------------------------------------------------------

export const BUILT_IN_TOOL_DEFAULTS: Record<BuiltInToolId, BuiltInToolDefault> = {
	search_notes: {
		displayName: "Search Notes",
		summary: "Search through your Obsidian notes by keyword. Returns matching file names and metadata.",
		config: {
			enabled: true,
			name: "search_notes",
			// Seeded with the embeddings variant; `createSearchNotesTool` derives the live text
			// (embeddings vs lexical-only) at build time, so this is only a placeholder for the
			// stored config, never what the model actually sees.
			description: SEARCH_NOTES_DESC_EMBEDDINGS,
			// No settings: retrieval algorithm and result count are per-call tool parameters
			// the model picks, and the result-detail flags are hardcoded on for the agent.
			settings: {},
		},
	},
	list_directory: {
		displayName: "List Directory",
		summary:
			"List directories and files in the vault to understand folder structure before searching or editing notes.",
		config: {
			enabled: true,
			name: "list_directory",
			description:
				"List directories and files in the vault. Use this to understand folder structure before searching or editing notes. The 'path' parameter must be an actual vault folder path (e.g. 'Projects/research').",
		},
	},
	read_content: {
		displayName: "Read Content",
		summary:
			"Read notes and vault files by path or wiki link. Supports markdown/text files and PDF text extraction. Images must be attached in chat.",
		config: {
			enabled: true,
			name: "read_content",
			description: READ_CONTENT_DESC_NONE,
		},
	},
	grep_notes: {
		displayName: "Grep Notes",
		summary:
			"Find an exact substring or regex pattern across notes, returning matching lines with line numbers and context. Unlike Search Notes, it matches literal strings. Scope to one note with a path, or page large result sets.",
		config: {
			enabled: true,
			name: "grep_notes",
			description:
				"Find an exact text substring or regex pattern across your notes, returning matching lines with line numbers and surrounding context. Unlike search_notes (which ranks notes by relevance and cannot match literal strings), this does exact/regex line-level matching. Provide 'path' to scope the search to a single note. Use it to find literal strings (e.g. 'TODO(fix)', '#deprecated', a wiki link), or to locate exact positions before editing.",
		},
	},
	get_all_tags: {
		displayName: "Get All Tags",
		summary: "Retrieve a list of all tags used in the vault.",
		config: {
			enabled: true,
			name: "get_all_tags",
			description:
				"Retrieve a list of all tags used in the Obsidian vault. Returns a sorted list of unique tags.",
		},
	},
	get_properties: {
		displayName: "Get Properties",
		summary: "Retrieve frontmatter properties from notes or list all property keys in the vault.",
		config: {
			enabled: true,
			name: "get_properties",
			description:
				"Retrieve properties (frontmatter) from Obsidian. Omit 'note_name' to list all available property keys in the vault.",
		},
	},
	execute_javascript: {
		displayName: "Execute JavaScript",
		summary:
			"Run isolated JavaScript for calculations and data transformation. Use return for the final value and console.log for intermediate output.",
		config: {
			enabled: true,
			name: "execute_javascript",
			description:
				"Execute isolated JavaScript for calculations and data transformation. Pass structured data via the input field, use return for the final value, and use console.log for intermediate output.",
		},
	},
	manage_notes: {
		displayName: "Manage Notes",
		summary:
			"Create, update, or delete markdown notes in one staged batch. Related note operations can be proposed together for user approval.",
		config: {
			enabled: true,
			name: "manage_notes",
			description:
				"Create, update, delete, move, or find-and-replace across markdown notes in one staged batch. For a single note, use 'update' with targeted search-and-replace edits (add is_regex/replace_all to match by regex or replace every occurrence). For vault-wide or folder-scoped find-and-replace, use the 'replace' operation (find/replace, optional is_regex/case_sensitive/path_prefix) — preview its blast radius first with grep_notes. Batch related note operations together. Staged changes can still be revised: editing a note you already have a pending proposal for ADDS to that proposal, so set replace_pending on the update to replace it instead, or use the 'discard' operation with the proposal's id (reported when it was staged) to withdraw it entirely.",
		},
	},
	fetch_url: {
		displayName: "Fetch URL",
		summary:
			"Fetch a public web page or text resource over HTTP(S) and return its main content as cleaned markdown. Use only with URLs the user provided or clearly public references.",
		config: {
			// Enabled by default, matching web_search: the web core skill ships enabled and
			// its instructions direct the model to follow up promising search results with
			// fetch_url — a default-off tool there means the model calls a tool that doesn't
			// exist. Users who want an offline agent disable the web skill, which unbinds both.
			enabled: true,
			name: "fetch_url",
			description:
				"Fetch a public web page or text resource over HTTP(S) and return its main content. HTML is converted to markdown with scripts, styles, and navigation chrome removed while headings, lists, tables, code blocks, and links are preserved. JSON, plain text, and other text-based responses are returned as-is. Use this when the user asks about a specific URL or when external information is needed that the vault does not contain.",
		},
	},
	web_search: {
		displayName: "Web Search",
		summary:
			"Search the web and return results (title, URL, snippet). Configure the provider and API key in the tool's Configure panel. Prefer vault search first.",
		config: {
			enabled: true,
			name: "web_search",
			description:
				"Search the web and return a list of relevant results (title, URL, snippet). Use this when the user asks about current events, external topics, or anything that cannot be in the vault. Always prefer searching the vault first with search_notes.",
			settings: {
				maxResults: 10,
			},
		},
	},
	manage_skills: {
		displayName: "Manage Skills",
		summary:
			"Create new skills, revise the agent's own attached skills, or delete skills it created. Changes apply immediately. A skill's name and plugin link are locked once created.",
		config: {
			enabled: false,
			name: "manage_skills",
			description:
				"Create new skills, revise your own attached skills, or delete skills you created. Changes apply immediately. A skill's name and plugin link are locked once created; only the body and description can change.",
		},
	},
	ask_question: {
		displayName: "Ask Question",
		summary:
			"Ask the user one or more multiple-choice questions to clarify requirements, solicit preferences, or choose between options. Execution pauses until the user responds in chat.",
		config: {
			enabled: true,
			name: "ask_question",
			description:
				"Ask the user one or more multiple-choice questions to clarify requirements, solicit preferences, or choose between options. Execution pauses until the user responds in chat.",
		},
	},
};

/**
 * Default configuration for all built-in tools — what a new agent's `toolsConfig` is
 * seeded from. Derived from {@link BUILT_IN_TOOL_DEFAULTS}; callers `structuredClone` it
 * before storing.
 */
export const DEFAULT_TOOLS_CONFIG: ToolsConfig = Object.fromEntries(
	BUILT_IN_TOOL_IDS.map((id) => [id, BUILT_IN_TOOL_DEFAULTS[id].config]),
) as ToolsConfig;

/**
 * Human-facing display name for a tool. Prefers the agent's configured tool name,
 * falls back to the default, and title-cases snake_case names for readability.
 */
export function getToolDisplayName(toolId: BuiltInToolId, configuredName?: string): string {
	const name = configuredName ?? BUILT_IN_TOOL_DEFAULTS[toolId]?.displayName ?? toolId;
	return name.includes("_")
		? name
				.split("_")
				.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
				.join(" ")
		: name;
}

/** Description shown for a tool in the UI — configured description first, then the summary. */
export function getToolDescription(toolId: BuiltInToolId, configuredDescription?: string): string {
	return configuredDescription ?? BUILT_IN_TOOL_DEFAULTS[toolId]?.summary ?? "";
}

/**
 * Tools with at least one tool-specific setting in `ToolConfigForm` (beyond the
 * non-editable name/description carried in `toolsConfig`). Kept in sync with that
 * component's per-tool branches; `ToolsModal` uses this to hide the gear for tools
 * that would otherwise open an empty config modal.
 */
const TOOLS_WITH_SETTINGS = new Set<BuiltInToolId>([
	// `search_notes` is deliberately absent: its retrieval algorithm and result count
	// are per-call tool parameters the model picks (it holds the query context; the user
	// does not), and the result-detail flags are hardcoded on for the agent — those
	// remain user-facing for the search *modal*, under Settings → Search → Display.
	// `manage_notes` is likewise absent: its per-operation allow-toggles were removed (the
	// staged-review flow in pendingChangesStore is the user's control point, so a tool-level
	// permission matrix only duplicated it), and the diff-view-mode preference moved onto the
	// pending-changes review bars where diffs are actually seen. `grep_notes` has no
	// settings either since its context-lines count was dropped.
	"read_content",
	"web_search",
]);

export function toolHasConfigurableSettings(toolId: BuiltInToolId): boolean {
	return TOOLS_WITH_SETTINGS.has(toolId);
}
