import { type App, TFile } from "obsidian";

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Obsidian's internal drag payload, hung off `app.dragManager.draggable` while a
 * drag is in flight. Recent Obsidian versions no longer stamp `obsidian/file`
 * MIME types on the `DataTransfer`; the authoritative source is this object.
 * `type: "file"` carries a single `file`, `type: "files"` carries a `files`
 * array. Folders (`type: "folder"`) also expose `file` but as a TFolder.
 */
interface ObsidianDraggable {
	type?: string;
	file?: unknown;
	files?: unknown;
}

function draggableFromApp(app?: App | null): ObsidianDraggable | null {
	// `dragManager` is an Obsidian internal API, absent from the typings.
	if (!app || !("dragManager" in app)) return null;
	const dragManager: unknown = app.dragManager;
	if (!dragManager || typeof dragManager !== "object" || !("draggable" in dragManager)) return null;
	const draggable: unknown = dragManager.draggable;
	return draggable && typeof draggable === "object" ? draggable : null;
}

function collectDraggableFilePaths(draggable: ObsidianDraggable): string[] {
	const paths: string[] = [];
	const candidates: unknown[] = [];
	if (Array.isArray(draggable.files)) candidates.push(...draggable.files);
	if (draggable.file) candidates.push(draggable.file);

	for (const candidate of candidates) {
		// Only real files can be attached; skip folders (TFolder has no extension).
		if (candidate instanceof TFile) {
			paths.push(candidate.path);
		}
	}
	return paths;
}

/**
 * Parse the vault-relative path out of the `obsidian://open?...&file=<name>`
 * URI Obsidian writes to `text/plain` on an internal drag. This is a fallback
 * for when `app.dragManager.draggable` isn't available: the URI encodes the
 * file's basename (no extension), so we resolve it against the vault.
 */
function pathFromObsidianUri(uri: string, app?: App | null): string | null {
	try {
		if (!uri.startsWith("obsidian://")) return null;
		const query = uri.slice(uri.indexOf("?") + 1);
		const fileParam = new URLSearchParams(query).get("file");
		if (!isNonEmptyString(fileParam)) return null;
		// The URI carries a basename/path without extension; resolve to a real file.
		const resolved = app?.metadataCache.getFirstLinkpathDest(fileParam, "");
		return resolved instanceof TFile ? resolved.path : null;
	} catch {
		return null;
	}
}

/**
 * True when the current drag originates from inside Obsidian (file explorer,
 * Notebook Navigator, search results, etc.). Detected via the live
 * `app.dragManager.draggable`, falling back to the `text/uri-list` /
 * `text/plain` obsidian:// URI signature for robustness.
 */
export function hasObsidianFileDrag(dataTransfer?: Pick<DataTransfer, "types"> | null, app?: App | null): boolean {
	const draggable = draggableFromApp(app);
	if (draggable && (draggable.type === "file" || draggable.type === "files" || draggable.type === "folder")) {
		return true;
	}

	if (!dataTransfer) return false;
	const types = Array.from(dataTransfer.types ?? []);
	// Legacy MIME signatures kept for older Obsidian builds.
	return types.includes("obsidian/file") || types.includes("obsidian/files");
}

/**
 * Vault-relative paths of the files being dragged from inside Obsidian.
 * Prefers `app.dragManager.draggable` (authoritative TFile paths), then the
 * legacy `obsidian/file(s)` payloads, then the `obsidian://` URI in the drop's
 * text data. Folders are excluded (only TFiles yield paths).
 */
export function extractObsidianDraggedPaths(
	dataTransfer?: Pick<DataTransfer, "getData"> | null,
	app?: App | null,
): string[] {
	const paths: string[] = [];

	const draggable = draggableFromApp(app);
	if (draggable) {
		paths.push(...collectDraggableFilePaths(draggable));
	}

	if (dataTransfer) {
		// Legacy MIME payloads (older Obsidian): JSON array or single path.
		const multiPayload = dataTransfer.getData("obsidian/files");
		if (isNonEmptyString(multiPayload)) {
			try {
				const parsed: unknown = JSON.parse(multiPayload);
				if (Array.isArray(parsed)) {
					paths.push(...parsed.filter(isNonEmptyString));
				}
			} catch {
				/* not JSON — ignore */
			}
		}
		const singlePayload = dataTransfer.getData("obsidian/file");
		if (isNonEmptyString(singlePayload)) {
			paths.push(singlePayload);
		}

		// Fallback: resolve the obsidian:// URI Obsidian writes to text/plain.
		if (paths.length === 0) {
			const text = dataTransfer.getData("text/plain") || dataTransfer.getData("text/uri-list");
			if (isNonEmptyString(text)) {
				for (const line of text.split(/\r?\n/)) {
					const resolved = pathFromObsidianUri(line.trim(), app);
					if (resolved) paths.push(resolved);
				}
			}
		}
	}

	return [...new Set(paths)];
}
