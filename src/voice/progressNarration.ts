import type { TurnProgress } from "../stores/chatStore.svelte";

/**
 * Turns a tool start into something worth saying aloud — or nothing.
 *
 * The model's own lead-in sentence is best when it wrote one. Otherwise the
 * tool's input usually carries the one concrete detail a listener cares about
 * (what is being searched for, which note is being read); a bare "running a
 * tool" carries none and, spoken every few seconds, only reads as repetition, so
 * those return `null` and stay silent.
 */

const MAX_DETAIL = 60;

function str(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.length > MAX_DETAIL ? `${trimmed.slice(0, MAX_DETAIL - 1)}…` : trimmed;
}

function field(input: unknown, key: string): unknown {
	return typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;
}

/** "Notes/Weekly review 2026-09-12.md" → "Weekly review 2026-09-12". */
function noteTitle(path: string): string {
	const base = path.split("/").pop() ?? path;
	return base.replace(/\.md$/i, "");
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

export interface ProgressLine {
	text: string;
	/** The assistant's own sentence rather than a summary of the tool input. */
	isLeadIn: boolean;
}

export function describeProgress(progress: TurnProgress): ProgressLine | null {
	if (progress.preamble?.trim()) return { text: progress.preamble.trim(), isLeadIn: true };
	const text = summariseToolInput(progress);
	return text ? { text, isLeadIn: false } : null;
}

function summariseToolInput(progress: TurnProgress): string | null {
	const { toolName, input } = progress;
	switch (toolName) {
		case "search_notes": {
			const query = str(field(input, "query"));
			return query ? `Searching the notes for "${query}"` : null;
		}
		case "grep_notes": {
			const pattern = str(field(input, "pattern"));
			return pattern ? `Looking through note text for "${pattern}"` : null;
		}
		case "read_content": {
			const path = str(field(input, "path"));
			return path ? `Reading "${noteTitle(path)}"` : null;
		}
		case "list_directory": {
			const path = str(field(input, "path"));
			return path ? `Looking through the folder "${noteTitle(path)}"` : null;
		}
		case "get_properties": {
			const note = str(field(input, "note_name"));
			return note ? `Checking the properties of "${noteTitle(note)}"` : null;
		}
		case "web_search": {
			const query = str(field(input, "query"));
			return query ? `Searching the web for "${query}"` : null;
		}
		case "fetch_url": {
			const url = str(field(input, "url"));
			return url ? `Reading a page from ${hostOf(url)}` : null;
		}
		case "manage_notes":
			return "Drafting the note changes for review";
		case "load_skill": {
			const name = str(field(input, "skillName"));
			return name ? `Loading the "${name}" skill` : null;
		}
		default:
			return null;
	}
}
