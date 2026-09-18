/**
 * Shared types used across multiple domains (agent, stores, etc.)
 */

/**
 * Represents an error that occurred during thread/conversation processing
 */
export interface ThreadError {
	message: string;
	name?: string;
}

/**
 * Represents a file attachment in a chat message.
 * Stored as a vault path reference for persistence (survives restarts).
 * The actual binary data lives in the vault under the attachments directory.
 */
export interface ChatAttachment {
	/** Original file name (e.g. "photo.png") */
	name: string;
	/** MIME type (e.g. "image/png", "application/pdf") */
	mimeType: string;
	/** Vault-relative path to the stored attachment file */
	vaultPath: string;
}

/** MIME types supported for chat attachments */

/** File extensions considered images for vault file detection and LLM vision APIs.
 * Only includes formats accepted by major providers (OpenAI, Anthropic, etc.).
 * SVG and BMP are intentionally excluded — they are not supported by vision APIs. */
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
/** File extensions considered PDFs */
export const PDF_EXTENSIONS = new Set(["pdf"]);
/** File extensions considered plain-text documents */
export const TEXT_EXTENSIONS = new Set([
	"md",
	"txt",
	"csv",
	"json",
	// A standalone widget (`.widget`, see views/widget): frontmatter, then HTML — text the agent reads to revise it.
	"widget",
]);

// ============================================================================
// Pending Changes (Staged Write Operations)
// ============================================================================

/** Status of a pending change proposed by the agent */
type PendingChangeStatus = "pending" | "accepted" | "rejected";

/** A staged note creation */
interface PendingNoteCreate {
	type: "create";
	/** Vault-relative path for the new file */
	path: string;
	/** Full markdown content to write */
	content: string;
}

/** A staged note update */
interface PendingNoteUpdate {
	type: "update";
	/** Vault-relative path of the existing file */
	path: string;
	/** Content of the file before the proposed change */
	originalContent: string;
	/** Proposed new content */
	newContent: string;
	/** Snapshot of originalContent before any group-level accepts mutated it.
	 *
	 *  Presence means "applied content is in the note that the user has not signed
	 *  off on", which is what `rejectAll` / the pending-changes bar key off (see
	 *  `PendingChangesStore.hasUnrevertedApplication`). Set on the first
	 *  `acceptChangeGroup`, and cleared once the outcome settles: every group
	 *  accepted (or the whole entry accepted), or the applied text reverted.
	 *  Leaving it set past that point would make a completed acceptance look like
	 *  something to undo. */
	initialOriginalContent?: string;
}

/** A staged note deletion */
interface PendingNoteDelete {
	type: "delete";
	/** Vault-relative path of the file to delete */
	path: string;
	/** Content of the file at the time of the proposal (for diff display) */
	originalContent: string;
}

/** A staged note move */
interface PendingNoteMove {
	type: "move";
	/** Current vault-relative path of the file */
	path: string;
	/** Target vault-relative path after the move */
	newPath: string;
}

/** Discriminated union of all pending change types */
export type PendingChange = PendingNoteCreate | PendingNoteUpdate | PendingNoteDelete | PendingNoteMove;

/** A single pending change entry with metadata */
export interface PendingChangeEntry {
	/** Unique ID for this change */
	id: string;
	/** The proposed change */
	change: PendingChange;
	/** Current status */
	status: PendingChangeStatus;
	/** ID of the tool call that created this change */
	toolCallId: string;
	/** Thread ID this change belongs to */
	threadId: string;
	/** Timestamp when the change was proposed */
	createdAt: number;
	/** Whether this entry's accept/reject outcome has been surfaced to the model
	 * (in a later user turn's context block). Resolved-but-unreported entries are
	 * reported exactly once; pending ones are re-reported until resolved. */
	reportedToModel?: boolean;
	/** Short, stable handle the model names this proposal by (`manage_notes`
	 * `discard`).
	 *
	 * A proposal is an object with its own lifetime; its path is a mutable label
	 * that can move, be reused, or name two proposals at once — so paths cannot
	 * identify one. `id` already provides identity but is a 36-char UUID whose
	 * members differ only in their last characters within a batch, which is
	 * error-prone for a model to reproduce. This is the same identity in a form
	 * that survives being copied by hand.
	 *
	 * Optional only for entries persisted before this existed; one is minted on
	 * load so every entry has one in memory. */
	shortId?: string;
}

/**
 * The review outcome of one staged note change, as reported to the model in a
 * user turn's context suffix. Stored in the message's `additional_kwargs` so the
 * exact suffix can be reconstructed and stripped for display (the same pattern
 * as visible notes / selection).
 *
 * `partially` = an update whose diff groups were resolved individually with at
 * least one accepted and the rest rejected — some proposed text IS in the note.
 */
export interface ReviewOutcomeRef {
	path: string;
	outcome: "accepted" | "rejected" | "partially";
}

/** The review status of a thread's staged note changes at the moment a user
 * turn was sent: freshly resolved outcomes plus paths still awaiting review.
 * Persisted in the message's `additional_kwargs` (like visible notes) so the
 * appended context block can be exactly reconstructed and stripped for display. */
export interface ReviewStatusRef {
	outcomes: ReviewOutcomeRef[];
	/** Proposals still awaiting review, with the short id the model discards by.
	 *
	 * Re-listed on every turn, which is what makes an id durable: the tool result
	 * that first reported it eventually falls out of context, and without an id
	 * the model cannot name the proposal to withdraw it. */
	pendingProposals: { path: string; shortId: string }[];
	/** Pre-`pendingProposals` shape, still read when reconstructing the context
	 * block of a message persisted before ids existed. The block is stripped from
	 * the displayed message by exact string match, so an old message must still
	 * render byte-identically or its suffix leaks into the UI. Never written. */
	pendingPaths?: string[];
}
