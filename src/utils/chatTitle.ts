/** Title a chat file carries until its first successful turn renames it. */
export const DEFAULT_CHAT_TITLE = "New Chat";

/**
 * True while a thread still carries the placeholder name: "New Chat" or an
 * auto-deduped variant like "New Chat (2)". Accepts a thread path or basename.
 */
export function isDefaultChatTitle(threadPath: string): boolean {
	const basename =
		threadPath
			.split("/")
			.pop()
			?.replace(/\.chat$/, "") ?? "";
	return /^New Chat( \(\d+\))?$/.test(basename);
}
