/** Title a chat file carries until its first successful turn renames it. */
export const DEFAULT_CHAT_TITLE = "New Chat";

/**
 * Title a still-placeholder chat moves to when a turn fails, freeing
 * {@link DEFAULT_CHAT_TITLE} so the next new chat isn't deduped to "New Chat (2)".
 */
export const FAILED_CHAT_TITLE = "New Chat (failed)";

function basenameOf(threadPath: string): string {
	return (
		threadPath
			.split("/")
			.pop()
			?.replace(/\.chat$/, "") ?? ""
	);
}

/**
 * True for the placeholder a new chat is created with: "New Chat" or an
 * auto-deduped variant like "New Chat (2)". Accepts a thread path or basename.
 */
export function isDefaultChatTitle(threadPath: string): boolean {
	return /^New Chat( \(\d+\))?$/.test(basenameOf(threadPath));
}

/**
 * True while a chat has never been titled: the placeholder, or the
 * {@link FAILED_CHAT_TITLE} (and its deduped variants) a failed turn left it on.
 */
export function needsChatTitle(threadPath: string): boolean {
	return isDefaultChatTitle(threadPath) || /^New Chat \(failed\)( \(\d+\))?$/.test(basenameOf(threadPath));
}
