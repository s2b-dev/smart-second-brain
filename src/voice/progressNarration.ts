import type { TurnProgress } from "../stores/chatStore.svelte";

/**
 * Turns a tool start into something worth saying aloud — or nothing.
 *
 * Only the agent's own lead-in sentence qualifies: it already explains why this
 * step follows the last one, in the agent's words, and since the agent writes one
 * only when it has something new to say, its pace is the right pace for spoken
 * updates. Tool inputs are deliberately not summarised — a line built from a
 * search query or a note title carries no reasoning and, spoken every few
 * seconds, reads as noise.
 */

export interface ProgressLine {
	text: string;
	/** Always true: the line is the assistant's own sentence. Kept so the caller can phrase the prompt for it. */
	isLeadIn: true;
}

export function describeProgress(progress: TurnProgress): ProgressLine | null {
	const preamble = progress.preamble?.trim();
	return preamble ? { text: preamble, isLeadIn: true } : null;
}
