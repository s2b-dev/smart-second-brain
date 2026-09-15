import { diffLines } from "diff";
import { MarkdownView, Notice, TFile } from "obsidian";
import { computeOriginalAffectedLines, countOriginalLines, insertionAnchorLine } from "../editor/diffLineMath";
import { getEditorView } from "./editor";
import type SecondBrainPlugin from "../main";
import { getPendingChangesStore } from "../stores/pendingChangesStore.svelte";
import type { PendingChange, PendingChangeEntry } from "../types/shared";
import { ChatView } from "../views/chat/Chat";

/**
 * Per-thread navigation cursor for stepping through a chat's pending changes.
 *
 * Keyed by threadId, valued by the STOP KEY of the last-visited change group
 * (`entryId#groupIndex`, see {@link stopKey}) — not an index: accept/reject can
 * reorder or drop stops mid-navigation, and a key survives that (a stale key
 * simply isn't found and we restart at the head/tail). The groupIndex is part
 * of the key because a single entry (one file edit) can contain several
 * non-adjacent change groups, and navigation steps through each of them.
 * Kept out of `pendingChangesStore` on purpose: the cursor is UI navigation
 * state, so folding it into the store would pollute its reactive `revision`
 * signal and couple the store to the workspace.
 */
const cursors = new Map<string, string>();

/**
 * A single navigation stop: one contiguous change group within an entry, plus
 * the 0-based original-content line it starts at. Multiple stops can share an
 * entry when a file edit touches several separate spots.
 */
export interface NavStop {
	entry: PendingChangeEntry;
	groupIndex: number;
	line: number;
}

/** Stable cursor key for a stop. `create`/`delete`/`move` have a single group 0. */
function stopKey(entryId: string, groupIndex: number): string {
	return `${entryId}#${groupIndex}`;
}

/**
 * Count lines in a diff part value (trailing newline ignored). Mirrors the
 * helper in readingViewDiffProcessor so group line numbers line up with the
 * decorations shown in the note.
 */
function countPartLines(value: string): number {
	if (value === "") return 0;
	return value.replace(/\n$/, "").split("\n").length;
}

/**
 * The first original-content line of each contiguous change group in an update,
 * indexed the same way the store/decorations index groups (0,1,2… in document
 * order — a group is a run of added/removed parts ended by an unchanged part).
 * Returns `[{ groupIndex, line }]`. For pure insertions the line is the original
 * line just before the insertion point (matching computeOriginalAffectedLines).
 */
function groupFirstLines(originalContent: string, newContent: string): Array<{ groupIndex: number; line: number }> {
	const parts = diffLines(originalContent, newContent);
	const totalOriginalLines = countOriginalLines(parts);
	const out: Array<{ groupIndex: number; line: number }> = [];
	let oldLine = 0; // 0-based line in originalContent
	let groupIndex = -1;
	let inGroup = false;
	let groupLine = 0;

	for (const part of parts) {
		if (part.value === "") continue;
		const lines = countPartLines(part.value);

		if (part.removed) {
			if (!inGroup) {
				inGroup = true;
				groupIndex++;
				groupLine = oldLine;
			}
			oldLine += lines;
		} else if (part.added) {
			if (!inGroup) {
				inGroup = true;
				groupIndex++;
				// Pure insertion: anchor to the same single line the decorations use
				// (following line, or line before at EOF) so nav scrolls to the
				// section that actually renders the card.
				groupLine = insertionAnchorLine(oldLine, totalOriginalLines);
			}
		} else {
			if (inGroup) {
				out.push({ groupIndex, line: groupLine });
				inGroup = false;
			}
			oldLine += lines;
		}
	}
	if (inGroup) out.push({ groupIndex, line: groupLine });

	return out;
}

/** The navigation stops contributed by one entry, in document order. */
function stopsForEntry(entry: PendingChangeEntry): NavStop[] {
	if (entry.change.type === "update") {
		const groups = groupFirstLines(entry.change.originalContent, entry.change.newContent);
		if (groups.length > 0) return groups.map((g) => ({ entry, groupIndex: g.groupIndex, line: g.line }));
	}
	// create/delete/move (or a degenerate update): a single stop at the top.
	return [{ entry, groupIndex: 0, line: 0 }];
}

/**
 * The thread's pending changes in a stable, deterministic order: by path
 * (so a file's changes are adjacent), then createdAt, then id as a final
 * tiebreak. `getPendingForThread` returns pending-only but in insertion order,
 * which isn't stable enough for group-by-file — hence the sort here.
 */
function orderedPendingForThread(threadId: string): PendingChangeEntry[] {
	const store = getPendingChangesStore();
	return [...store.getPendingForThread(threadId)].sort(
		(a, b) => a.change.path.localeCompare(b.change.path) || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
	);
}

/**
 * Every navigation stop for the thread, ordered so next/prev steps through each
 * changed spot: by file path, then by line within the file, then groupIndex as
 * a final tiebreak. Entries are pre-sorted by {@link orderedPendingForThread};
 * expanding each into its groups and re-sorting by line keeps multi-spot files
 * visited top-to-bottom.
 */
function orderedStopsForThread(threadId: string): NavStop[] {
	const entries = orderedPendingForThread(threadId);
	const stops = entries.flatMap(stopsForEntry);
	return stops.sort(
		(a, b) =>
			a.entry.change.path.localeCompare(b.entry.change.path) ||
			a.line - b.line ||
			a.groupIndex - b.groupIndex ||
			a.entry.id.localeCompare(b.entry.id),
	);
}

/**
 * Whether stepping through the thread's pending changes would actually go
 * anywhere — i.e. there is more than one stop.
 *
 * Navigation WRAPS (see `navigateToPendingChange`), so with two or more stops
 * both directions always have a target and both chevrons are useful. With
 * exactly one, next and prev both land back on the change you're already
 * looking at, so the in-note bars hide their chevrons entirely rather than
 * offering two controls that visibly do nothing.
 */
export function threadHasMultipleStops(threadId: string): boolean {
	try {
		return orderedStopsForThread(threadId).length > 1;
	} catch {
		// Store not initialized — err toward the quieter bar.
		return false;
	}
}

/** 0-based line to scroll to: the first changed line of an update, else the top of the file. */
export function firstChangedLine(change: PendingChange): number {
	if (change.type === "update") {
		const lines = computeOriginalAffectedLines(change.originalContent, change.newContent);
		if (lines.size === 0) return 0;
		return Math.min(...lines);
	}
	return 0;
}

/**
 * Fraction of the viewport height from the top at which the jumped-to change is
 * positioned. 1/5 sits the change clearly in the upper portion (not centered),
 * while still leaving a little context above it rather than pinning to the top.
 */
const SCROLL_ANCHOR_FRACTION = 1 / 5;

/**
 * Scroll a MarkdownView so the target change sits in the TOP THIRD of the
 * viewport (rather than pinned to the very top, which `applyScroll` alone does).
 *
 * Both modes compute `scrollTop` manually — the built-in `scrollIntoView`
 * keyword anchors (`start`/`center`) can't express an arbitrary fraction, and in
 * reading mode `applyScroll(line)`'s line→pixel estimate is off by thousands of
 * px from a rendered section's real offset, so it can't be nudged reliably.
 *
 * Edit mode: `cm.lineBlockAt(pos).top` is the line's document-space Y; scroll so
 * it sits `clientHeight * FRACTION` below the viewport top.
 *
 * Reading mode: `applyScroll(line)` DOES accurately top-pin the target line on a
 * normally-structured note (verified: `applyScroll(58)` put that line at
 * viewport-top ~1px), so use it to reach the correct line — then nudge the
 * scroller up by `clientHeight * FRACTION` to drop the line to the anchor. Do
 * NOT anchor to `querySelector(".s2b-diff-section")`: reading view VIRTUALIZES,
 * so only sections near the viewport exist in the DOM, and the first one is
 * usually NOT the target group — navigating to a later change would scroll to
 * the wrong (earlier) change's section. Driving off `line` avoids that entirely.
 *
 * Reading-mode layout isn't final the instant a leaf is revealed/re-rendered, so
 * a single synchronous call scrolls a not-yet-laid-out container and lands wrong.
 * We re-apply on the next frame and once more shortly after so the scroll sticks
 * whether the view is ready now or momentarily later.
 */
function scrollToLine(view: MarkdownView, line: number): void {
	const apply = () => {
		// Edit mode: anchor the line's document-space top to the top third.
		const cm = getEditorView(view.editor);
		if (cm?.state && cm.scrollDOM && view.getMode() === "source") {
			try {
				const lineCount = cm.state.doc.lines;
				const clamped = Math.min(Math.max(line + 1, 1), lineCount); // CM lines are 1-based
				const pos = cm.state.doc.line(clamped).from;
				const block = cm.lineBlockAt(pos);
				const anchor = cm.scrollDOM.clientHeight * SCROLL_ANCHOR_FRACTION;
				cm.scrollDOM.scrollTop = Math.max(0, block.top - anchor);
				return;
			} catch {
				/* fall through to applyScroll below */
			}
		}

		// Reading mode: top-pin the TARGET line via applyScroll (accurate on
		// structured notes, and it targets the right line even when the section
		// isn't rendered yet), then nudge it down to the fractional anchor.
		view.currentMode.applyScroll(line);
		const scroller = view.contentEl.querySelector<HTMLElement>(".markdown-preview-view");
		if (scroller && scroller.clientHeight > 0) {
			const anchor = scroller.clientHeight * SCROLL_ANCHOR_FRACTION;
			scroller.scrollTop = Math.max(0, scroller.scrollTop - anchor);
		}
	};
	apply();
	window.requestAnimationFrame(apply);
	window.setTimeout(apply, 50);
	// One later retry: reading-mode layout can settle a frame or two late, so a
	// final pass ensures the scroll lands where intended.
	window.setTimeout(apply, 200);
}

/**
 * Reveal the note at `path` and scroll it to `line`, preserving the mode of an
 * already-open leaf. Returns false when the path has no on-disk file (e.g. a
 * `create` change not yet accepted) so the caller can surface a Notice.
 */
export async function revealAndScroll(plugin: SecondBrainPlugin, path: string, line: number): Promise<boolean> {
	const ws = plugin.app.workspace;
	const file = plugin.app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return false;

	// Reuse a leaf already showing this note — keeps its current reading/edit mode.
	const existing = ws
		.getLeavesOfType("markdown")
		.find((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path);
	if (existing && existing.view instanceof MarkdownView) {
		ws.setActiveLeaf(existing, { focus: true });
		void ws.revealLeaf(existing);
		scrollToLine(existing.view, line);
		return true;
	}

	// Otherwise open the note. Reuse the current leaf UNLESS it hosts a chat —
	// opening a note into the ChatView leaf would replace the chat the user is
	// reviewing from (the arrows/commands are triggered while the chat is active).
	// In that case open a new tab so the chat survives.
	const current = ws.getLeaf(false);
	const leaf = current.view instanceof ChatView ? ws.getLeaf("tab") : current;
	// Open WITHOUT eState.line: passing it makes Obsidian flash the target line
	// yellow (.is-flashing), which is redundant here — the change's own red/green
	// tint already marks the spot. scrollToLine handles the scroll in both modes.
	await leaf.openFile(file);
	void ws.revealLeaf(leaf);
	if (leaf.view instanceof MarkdownView) scrollToLine(leaf.view, line);
	return true;
}

/**
 * Advance the thread's navigation cursor in `direction` (wrapping around) and
 * reveal+scroll to that change group. Shared by the in-note diff bars (edit +
 * reading view) and the command-palette commands so all stay in sync. Steps
 * through each changed spot (group) within a file before moving to the next
 * file.
 *
 * `origin`, when given, is the stop the step is taken RELATIVE TO — the in-note
 * action bars pass their own `(entryId, groupIndex)` so their chevrons move
 * relative to the change they're attached to, not the thread's shared cursor.
 * Without it (palette commands) the shared per-thread cursor is used. Either
 * way the resulting stop becomes the new shared cursor, keeping all entry
 * points in sync. If the origin isn't found among the current stops (e.g.
 * it was just accepted/rejected) we fall back to the shared cursor.
 *
 * Returns the stop navigated to, or null when the thread has no pending changes
 * (the caller Notices). A `create` target that isn't on disk yet still advances
 * the cursor but shows a Notice instead of opening nothing.
 */
export async function navigateToPendingChange(
	plugin: SecondBrainPlugin,
	threadId: string,
	direction: "next" | "prev",
	origin?: { entryId: string; groupIndex: number },
): Promise<NavStop | null> {
	const stops = orderedStopsForThread(threadId);
	const n = stops.length;
	if (n === 0) {
		cursors.delete(threadId);
		return null;
	}

	// Prefer the clicked bar's own stop as the step origin; fall back to the
	// thread's shared cursor when no origin is given or it's no longer present.
	const originKey = origin ? stopKey(origin.entryId, origin.groupIndex) : undefined;
	let currentIdx = originKey ? stops.findIndex((s) => stopKey(s.entry.id, s.groupIndex) === originKey) : -1;
	if (currentIdx === -1) {
		const currentKey = cursors.get(threadId);
		currentIdx = currentKey ? stops.findIndex((s) => stopKey(s.entry.id, s.groupIndex) === currentKey) : -1;
	}
	let idx: number;
	if (currentIdx === -1) {
		// No cursor yet, or it pointed at an accepted/rejected group: start at the
		// head for "next" and the tail for "prev".
		idx = direction === "next" ? 0 : n - 1;
	} else {
		idx = direction === "next" ? (currentIdx + 1) % n : (currentIdx - 1 + n) % n;
	}

	const target = stops[idx];
	cursors.set(threadId, stopKey(target.entry.id, target.groupIndex));

	const opened = await revealAndScroll(plugin, target.entry.change.path, target.line);
	if (!opened) {
		new Notice("This change creates a new file — nothing to open yet.");
	}
	return target;
}

/** Drop a thread's cursor (e.g. when the thread is removed). */
