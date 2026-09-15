import type { Change } from "diff";
import {
	type Component,
	MarkdownRenderChild,
	type MarkdownPostProcessorContext,
	MarkdownRenderer,
	type Plugin,
	setIcon,
} from "obsidian";
import { diffLines, diffWords } from "diff";
import { canNavigate, createResolveButton } from "../lib/diffActionButton";
import { navigateToPendingChange } from "../lib/pendingChangeNavigation";
import { getPendingChangesStore } from "../stores/pendingChangesStore.svelte";
import { getData } from "../stores/dataStore.svelte";
import { getPlugin } from "../stores/state.svelte";
import { computeOriginalAffectedLines, countOriginalLines, countPartLines, insertionAnchorLine } from "./diffLineMath";
import type { DiffViewMode } from "../types/plugin";
import type { PendingChangeEntry } from "../types/shared";

function buildLineMapper(originalContent: string, currentContent: string): (currentLine: number) => number | null {
	if (originalContent === currentContent) return (line) => line;

	const parts = diffLines(originalContent, currentContent);
	const segments: Array<{
		currentStart: number;
		count: number;
		originalStart: number;
		type: "equal" | "added";
	}> = [];

	let origLine = 0;
	let currLine = 0;

	for (const part of parts) {
		if (part.value === "") continue;
		const lines = countPartLines(part.value);

		if (part.removed) {
			origLine += lines;
		} else if (part.added) {
			segments.push({ currentStart: currLine, count: lines, originalStart: origLine, type: "added" });
			currLine += lines;
		} else {
			segments.push({ currentStart: currLine, count: lines, originalStart: origLine, type: "equal" });
			origLine += lines;
			currLine += lines;
		}
	}

	return (currentLine: number): number | null => {
		// Binary search for the segment containing currentLine
		let lo = 0;
		let hi = segments.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const seg = segments[mid];
			if (currentLine < seg.currentStart) {
				hi = mid - 1;
			} else if (currentLine >= seg.currentStart + seg.count) {
				lo = mid + 1;
			} else {
				if (seg.type === "added") return null;
				return seg.originalStart + (currentLine - seg.currentStart);
			}
		}
		return null;
	};
}

/** Result of extracting section-relevant text from a diff. */
interface SectionExtraction {
	/** Unchanged lines in the section before the first change. */
	prefixText: string;
	/** Original text of the changed lines only. */
	sectionOld: string;
	/** New text of the changed lines only. */
	sectionNew: string;
	/** Unchanged lines in the section after the last change. */
	suffixText: string;
}

/** Render word-level diff spans into a container element. */
function renderWordDiff(el: HTMLElement, oldText: string, newText: string): void {
	el.empty();
	const wordChanges = diffWords(oldText.trimEnd(), newText.trimEnd());

	for (const part of wordChanges) {
		const span = createSpan();
		span.textContent = part.value;
		if (part.removed) {
			span.className = "s2b-reading-diff-word-removed";
		} else if (part.added) {
			span.className = "s2b-reading-diff-word-added";
		}
		el.appendChild(span);
	}
}

/** Accumulator for building a SectionExtraction. */
interface ExtractionState {
	prefixText: string;
	sectionOld: string;
	sectionNew: string;
	suffixText: string;
	oldLine: number;
	seenChange: boolean;
	/** First original line of the immediately-preceding removed part, or null
	 * when the previous part wasn't a removal. An added part that follows a
	 * removed one is a REPLACEMENT and belongs to the section owning this line
	 * (see extractSectionTexts). */
	lastRemovedStart: number | null;
}

/** Process a removed diff part, collecting lines within the section range. */
function processRemovedPart(lines: string[], lineStart: number, lineEnd: number, state: ExtractionState): void {
	state.lastRemovedStart = state.oldLine;
	for (const line of lines) {
		if (state.oldLine >= lineStart && state.oldLine <= lineEnd) {
			state.seenChange = true;
			state.sectionOld += `${line}\n`;
		}
		state.oldLine++;
	}
}

/** Process an unchanged diff part, routing lines to prefix or suffix. */
function processUnchangedPart(lines: string[], lineStart: number, lineEnd: number, state: ExtractionState): void {
	for (const line of lines) {
		if (state.oldLine >= lineStart && state.oldLine <= lineEnd) {
			if (state.seenChange) {
				state.suffixText += `${line}\n`;
			} else {
				state.prefixText += `${line}\n`;
			}
		}
		state.oldLine++;
	}
}

/**
 * Extract the old and new section text from the line-level diff,
 * separating unchanged prefix/suffix lines from the actual changed content.
 */
function extractSectionTexts(changes: Change[], lineStart: number, lineEnd: number): SectionExtraction {
	const state: ExtractionState = {
		prefixText: "",
		sectionOld: "",
		sectionNew: "",
		suffixText: "",
		oldLine: 0,
		seenChange: false,
		lastRemovedStart: null,
	};
	const totalOriginalLines = countOriginalLines(changes);

	for (const part of changes) {
		if (part.value === "") continue;
		const partLines = part.value.replace(/\n$/, "").split("\n");

		if (part.removed) {
			processRemovedPart(partLines, lineStart, lineEnd, state);
		} else if (part.added) {
			// A REPLACEMENT (added part right after a removed one) belongs with the
			// removed run — attributed to the section owning the run's FIRST line,
			// so exactly one section claims it even when the run spans sections.
			// The anchor heuristic is for PURE insertions only: by the time we get
			// here oldLine has advanced past any removed lines, so anchoring a
			// replacement would land on the line AFTER the run — outside the section
			// whenever the run ends it (every single-line heading edit), silently
			// dropping the new text from the card and handing it to the next
			// section. Mirrors computeOriginalAffectedLines / checkPartForSection so
			// all three agree on which section owns which change.
			if (state.lastRemovedStart !== null) {
				if (state.lastRemovedStart >= lineStart && state.lastRemovedStart <= lineEnd) {
					state.seenChange = true;
					state.sectionNew += part.value;
				}
			} else {
				const anchor = insertionAnchorLine(state.oldLine, totalOriginalLines);
				if (anchor >= lineStart && anchor <= lineEnd) {
					state.seenChange = true;
					state.sectionNew += part.value;
				}
			}
			state.lastRemovedStart = null;
		} else {
			processUnchangedPart(partLines, lineStart, lineEnd, state);
			state.lastRemovedStart = null;
		}
	}

	return {
		prefixText: state.prefixText,
		sectionOld: state.sectionOld,
		sectionNew: state.sectionNew,
		suffixText: state.suffixText,
	};
}

/**
 * Render a word-level diff of the changed section into a detail container.
 * Additive — the caller owns `container`; Obsidian's rendered markdown is
 * never touched.
 */
function applyInlineWordDiff(container: HTMLElement, changes: Change[], lineStart: number, lineEnd: number): void {
	const { sectionOld, sectionNew } = extractSectionTexts(changes, lineStart, lineEnd);
	if (sectionOld === sectionNew) return;

	const diffContent = createDiv();
	diffContent.className = "s2b-diff-content";
	renderWordDiff(diffContent, sectionOld, sectionNew);
	container.appendChild(diffContent);
}

/**
 * Render the "new content" preview into a detail container: the proposed section
 * text rendered as full markdown into a pane we own (green tint). The original
 * text is deliberately NOT shown — Obsidian's rendered markdown of the current
 * (original) note is already visible directly beneath this decoration, so a
 * removed pane would just duplicate it. Additive — Obsidian's rendered markdown
 * is never touched.
 */
async function applyTwoPaneDiff(
	container: HTMLElement,
	changes: Change[],
	lineStart: number,
	lineEnd: number,
	sourcePath: string,
	plugin: Plugin,
	component: Component,
	isCurrent: () => boolean,
): Promise<void> {
	const { sectionOld, sectionNew } = extractSectionTexts(changes, lineStart, lineEnd);
	if (sectionOld === sectionNew) return;

	const diffContent = createDiv();
	diffContent.className = "s2b-diff-content";

	const paneWrap = createDiv();
	paneWrap.className = "s2b-diff-two-pane";

	const newPane = createDiv();
	newPane.className = "s2b-diff-pane-added";
	await MarkdownRenderer.render(plugin.app, sectionNew.trimEnd(), newPane, sourcePath, component);
	// A newer render may have superseded this one while we awaited — bail so we
	// don't append a stale pane into a container the newer render already owns.
	if (!isCurrent()) return;
	paneWrap.appendChild(newPane);

	diffContent.appendChild(paneWrap);
	container.appendChild(diffContent);
}

/** Context needed to re-render a diff section in a different mode. */
interface DiffRenderContext {
	changes: Change[];
	origLineStart: number;
	origLineEnd: number;
	filePath: string;
	plugin: Plugin;
	/**
	 * Owner of anything `MarkdownRenderer.render` registers for the two-pane
	 * preview. Tied to the section via `ctx.addChild`, so it unloads with the
	 * section instead of living as long as the plugin.
	 */
	component: Component;
}

/**
 * Monotonic render token per detail container. `applyTwoPaneDiff` awaits
 * `MarkdownRenderer.render`, so a fast mode flip (two-pane → word-diff, or two
 * rapid two-pane renders) can let an EARLIER async render append its pane AFTER a
 * newer `renderDetailInto` already cleared and re-filled the container — the card
 * then shows content from both modes. Each `renderDetailInto` bumps this token;
 * the async path only appends when its captured token is still current.
 */
const renderTokens = new WeakMap<HTMLElement, number>();

/** Render the diff detail (word-diff or two-pane) into a detail container. */
function renderDetailInto(container: HTMLElement, ctx: DiffRenderContext, mode: DiffViewMode): void {
	const token = (renderTokens.get(container) ?? 0) + 1;
	renderTokens.set(container, token);
	container.empty();
	if (mode === "word-diff") {
		applyInlineWordDiff(container, ctx.changes, ctx.origLineStart, ctx.origLineEnd);
	} else {
		applyTwoPaneDiff(
			container,
			ctx.changes,
			ctx.origLineStart,
			ctx.origLineEnd,
			ctx.filePath,
			ctx.plugin,
			ctx.component,
			() => renderTokens.get(container) === token,
		).catch(() => {
			// Only fall back if this render is still the current one — a superseded
			// render must not repaint the container the newer render owns.
			if (renderTokens.get(container) !== token) return;
			applyInlineWordDiff(container, ctx.changes, ctx.origLineStart, ctx.origLineEnd);
		});
	}
}

/**
 * Build the action bar + always-shown detail body for a reading-view change
 * group. Additive: returns a fragment the caller prepends to the section; it
 * never touches Obsidian's rendered markdown. The diff detail is always rendered
 * (no collapse); the toggle switches word-diff ↔ two-pane in place.
 */
function createReadingDiffActionBar(
	entryId: string,
	groupIndex: number,
	groupTotal: number,
	renderCtx: DiffRenderContext,
): HTMLElement {
	const wrap = createDiv();
	wrap.className = "s2b-diff-reading-group";

	const bar = createDiv();
	bar.className = "s2b-diff-actions-bar";
	wrap.appendChild(bar);

	const detail = createDiv();
	detail.className = "s2b-diff-detail";
	wrap.appendChild(detail);

	const renderDetail = () => {
		let mode: DiffViewMode = "word-diff";
		try {
			mode = getData().diffViewMode;
		} catch {
			/* data store not ready */
		}
		renderDetailInto(detail, renderCtx, mode);
	};

	const label = createSpan();
	label.className = "s2b-diff-actions-label";
	label.textContent = "Pending change";
	bar.appendChild(label);

	// Position among this note's pending change groups (e.g. "2/3"). Only shown
	// when there's more than one — mirrors createEditActionBar so both views match.
	if (groupTotal > 1) {
		const position = createSpan();
		position.className = "s2b-diff-position-indicator";
		position.textContent = `${groupIndex + 1}/${groupTotal}`;
		bar.appendChild(position);
		// The indicator takes over the label's auto-margin (see styles.css).
		label.classList.add("s2b-diff-actions-label-with-indicator");
	}

	// Prev/next chevrons: step through this chat thread's pending changes across
	// files, reusing the SAME shared cursor as the edit-mode bar and the palette
	// commands. Mirrors createEditActionBar in inlineDiffExtension.ts (reading +
	// edit views have parallel action bars).
	const makeNavBtn = (iconName: string, ariaLabel: string, direction: "next" | "prev"): HTMLButtonElement => {
		const btn = createEl("button");
		btn.className = "s2b-diff-nav-btn";
		btn.setAttribute("aria-label", ariaLabel);
		setIcon(btn, iconName);
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			try {
				const entry = getPendingChangesStore().getEntry(entryId);
				if (!entry) return;
				void navigateToPendingChange(getPlugin(), entry.threadId, direction, { entryId, groupIndex });
			} catch {
				/* store/plugin not initialized */
			}
		});
		return btn;
	};
	// Only when the thread has another stop to reach — navigation wraps, so a
	// lone pending change would give two chevrons that lead back here.
	if (canNavigate(entryId)) {
		bar.appendChild(makeNavBtn("chevron-up", "Previous pending change", "prev"));
		bar.appendChild(makeNavBtn("chevron-down", "Next pending change", "next"));
	}

	// Toggle view mode icon (visible on hover via CSS)
	const toggleBtn = createEl("button");
	toggleBtn.className = "s2b-diff-toggle-btn";
	toggleBtn.setAttribute("aria-label", "Toggle diff view");
	let currentMode: DiffViewMode;
	try {
		currentMode = getData().diffViewMode;
	} catch {
		currentMode = "word-diff";
	}
	setIcon(toggleBtn, currentMode === "word-diff" ? "columns-2" : "file-diff");
	toggleBtn.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		try {
			const data = getData();
			data.diffViewMode = data.diffViewMode === "word-diff" ? "two-pane" : "word-diff";
		} catch {
			/* data store not initialized */
		}
		// A view-mode flip is NOT a pending-changes mutation — dispatch the
		// dedicated mode event so only the in-place re-render paths react. Firing
		// s2b-pending-changes-updated here would trigger main.ts's destructive
		// previewMode.rerender(true), which races (and loses to) the async
		// two-pane render and tears down the review card.
		document.dispatchEvent(new CustomEvent("s2b-diff-mode-changed"));
	});
	bar.appendChild(toggleBtn);

	const acceptBtn = createResolveButton("s2b-diff-accept-btn", "check", "Accept", "Accept change");
	acceptBtn.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		try {
			const store = getPendingChangesStore();
			void store.acceptChangeGroup(entryId, groupIndex);
		} catch {
			/* store not initialized */
		}
	});
	bar.appendChild(acceptBtn);

	// Stale parity with the chat bar and the edit-mode bar: accepting a group
	// whose note changed after staging always fails the store's conflict check.
	// Async (disk read) — the reading view isn't an editing surface, so disk is
	// the right source here; the bar is recreated on every section re-render
	// (file modify, store change), which keeps the answer current.
	try {
		void getPendingChangesStore()
			.hasConflict(entryId)
			.then((conflict) => {
				if (!conflict) return;
				acceptBtn.disabled = true;
				acceptBtn.setAttribute(
					"title",
					"Cannot accept — the note changed after this was proposed. Reject it and ask the agent to re-stage.",
				);
			})
			.catch(() => {
				/* vault read failed — leave the button as-is */
			});
	} catch {
		/* store not initialized */
	}

	const rejectBtn = createResolveButton("s2b-diff-reject-btn", "x", "Reject", "Reject change");
	rejectBtn.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		try {
			const store = getPendingChangesStore();
			store.rejectChangeGroup(entryId, groupIndex);
		} catch {
			/* store not initialized */
		}
	});
	bar.appendChild(rejectBtn);

	// The diff detail is always shown (no collapse) — render it now. It survives
	// store-triggered section re-renders via the same call path.
	renderDetail();

	return wrap;
}

/**
 * Check if any line in a range overlaps [sectionStart, sectionEnd].
 */
function rangeOverlapsSection(startLine: number, lineCount: number, sectionStart: number, sectionEnd: number): boolean {
	const endLine = startLine + lineCount - 1;
	return endLine >= sectionStart && startLine <= sectionEnd;
}

/**
 * Process a single diff part for group index detection.
 * Returns the group index if this part overlaps the section, or -1 otherwise.
 */
function checkPartForSection(
	part: Change,
	groupIndex: number,
	oldLine: number,
	lineCount: number,
	sectionStart: number,
	sectionEnd: number,
	totalOriginalLines: number,
	lastRemovedStart: number | null,
): number {
	if (part.removed) {
		if (rangeOverlapsSection(oldLine, lineCount, sectionStart, sectionEnd)) {
			return groupIndex;
		}
	} else if (part.added) {
		// Mirror computeOriginalAffectedLines / extractSectionTexts: a REPLACEMENT
		// (added right after removed) is owned by the section holding the removed
		// run's first line; only a PURE insertion uses the single anchor line
		// (following line, or line before at EOF), so exactly one section claims
		// each change either way.
		if (lastRemovedStart !== null) {
			if (lastRemovedStart >= sectionStart && lastRemovedStart <= sectionEnd) {
				return groupIndex;
			}
		} else {
			const anchor = insertionAnchorLine(oldLine, totalOriginalLines);
			if (anchor >= sectionStart && anchor <= sectionEnd) {
				return groupIndex;
			}
		}
	}
	return -1;
}

/**
 * Compute which diff group index a section belongs to, based on its line range.
 * Groups are contiguous sequences of removed/added parts in the line diff.
 */
function computeGroupIndexForSection(changes: Change[], sectionLineStart: number, sectionLineEnd: number): number {
	let oldLine = 0;
	let groupIndex = -1;
	let inGroup = false;
	let lastRemovedStart: number | null = null;
	const totalOriginalLines = countOriginalLines(changes);

	for (const part of changes) {
		if (part.value === "") continue;
		const partLineCount = countPartLines(part.value);

		if (part.removed || part.added) {
			if (!inGroup) {
				groupIndex++;
				inGroup = true;
			}
			const result = checkPartForSection(
				part,
				groupIndex,
				oldLine,
				partLineCount,
				sectionLineStart,
				sectionLineEnd,
				totalOriginalLines,
				lastRemovedStart,
			);
			if (result >= 0) return result;
			if (part.removed) {
				lastRemovedStart = oldLine;
				oldLine += partLineCount;
			} else {
				lastRemovedStart = null;
			}
		} else {
			inGroup = false;
			lastRemovedStart = null;
			oldLine += partLineCount;
		}
	}

	return -1;
}

/**
 * Total number of change groups in a line diff — a group is a contiguous run of
 * removed/added parts ended by an unchanged part. Mirrors the group-walking in
 * {@link computeGroupIndexForSection} (minus the per-section check) so the
 * "N/total" indicator's denominator matches the indices that function returns.
 */
function countGroups(changes: Change[]): number {
	let total = 0;
	let inGroup = false;
	for (const part of changes) {
		if (part.value === "") continue;
		if (part.removed || part.added) {
			if (!inGroup) {
				total++;
				inGroup = true;
			}
		} else {
			inGroup = false;
		}
	}
	return total;
}

/** Check if a section overlaps affected lines and return true if it does. */
function sectionHasAffectedLine(affectedLines: Set<number>, origLineStart: number, origLineEnd: number): boolean {
	for (let line = origLineStart; line <= origLineEnd; line++) {
		if (affectedLines.has(line)) return true;
	}
	return false;
}

/** Whether the changed section has any removed lines (vs. a pure insertion). */
function sectionHasRemoval(changes: Change[], lineStart: number, lineEnd: number): boolean {
	const { sectionOld } = extractSectionTexts(changes, lineStart, lineEnd);
	return sectionOld.trim().length > 0;
}

/**
 * Strip any diff decoration this processor previously applied to a section
 * element. Needed because the processor is additive and Obsidian reuses section
 * DOM nodes across `rerender(true)` — without this a tint/review bar would
 * linger after the pending change is accepted/rejected or the section stops
 * overlapping a change.
 */
function clearSectionDecoration(el: HTMLElement): void {
	el.classList.remove(
		"s2b-diff-section",
		"s2b-diff-section-removed",
		"s2b-diff-section-added",
		"s2b-diff-hide-original",
	);
	el.querySelector(":scope > .s2b-diff-reading-group")?.remove();
}

/**
 * In word-diff mode the detail already shows the old (red) and new (green) text
 * inline, so the section's own rendered original is a duplicate — hide it (and
 * suppress the section tint, which would otherwise be an empty red band). In
 * two-pane mode the original stays visible beneath the new-content pane.
 *
 * Only applies when the change REMOVED original lines. For a PURE INSERTION the
 * section's rendered content is unchanged (not a duplicate of anything in the
 * card), so hiding it would wrongly blank out a legitimate paragraph.
 */
function applyWordDiffOriginalVisibility(el: HTMLElement, mode: DiffViewMode, hasRemoval: boolean): void {
	el.classList.toggle("s2b-diff-hide-original", hasRemoval && mode === "word-diff");
}

/**
 * Core logic for decorating a rendered section that overlaps a pending change.
 * Purely ADDITIVE — it tints the section and prepends a collapsible review bar,
 * but never calls `el.empty()` or replaces Obsidian's rendered markdown, so it
 * does not clash with other plugins' post-processors.
 */
function processSection(
	el: HTMLElement,
	entry: PendingChangeEntry,
	plugin: Plugin,
	component: Component,
	filePath: string,
	sectionInfo: { text: string; lineStart: number; lineEnd: number },
): void {
	const change = entry.change;
	if (change.type !== "update") return;

	const changes = diffLines(change.originalContent, change.newContent);
	const affectedLines = computeOriginalAffectedLines(change.originalContent, change.newContent);
	if (affectedLines.size === 0) return;

	const mapLine = buildLineMapper(change.originalContent, sectionInfo.text);
	const origLineStart = mapLine(sectionInfo.lineStart);
	const origLineEnd = mapLine(sectionInfo.lineEnd);

	if (origLineStart === null || origLineEnd === null) return;
	if (!sectionHasAffectedLine(affectedLines, origLineStart, origLineEnd)) {
		// This section no longer overlaps the change (e.g. content shifted after
		// an accept on a reused DOM node) — clear any stale decoration.
		clearSectionDecoration(el);
		return;
	}

	// Idempotency: skip only if OUR review card is still present. Checking the
	// tint CLASS here would be wrong — Obsidian reuses the section DOM node across
	// scroll-triggered re-renders and regenerates its inner content, which wipes
	// the `.s2b-diff-reading-group` bar while our added class survives. Guarding on
	// the class then early-returns and never re-inserts the bar, leaving a tinted
	// section with no Accept/Reject/nav controls (the "reading-mode review is
	// broken after scrolling" bug). Guard on the bar's presence instead so a
	// stripped section gets its bar rebuilt.
	if (el.querySelector(":scope > .s2b-diff-reading-group")) {
		return;
	}

	// Additive tint on the rendered section. Only tint when the change REMOVES
	// original lines — those rendered lines are the "before" the card refers to.
	// A PURE INSERTION changes no original line (the new text lives in the review
	// card), so tinting the section green would falsely paint an unchanged
	// paragraph as "added" — and on a long wrapped paragraph the green bleeds
	// across the whole block. Mark it only as a diff section (for lifecycle
	// clearing) without an add/remove color.
	el.classList.add("s2b-diff-section");
	const hasRemoval = sectionHasRemoval(changes, origLineStart, origLineEnd);
	if (hasRemoval) {
		el.classList.add("s2b-diff-section-removed");
	}

	const groupIndex = computeGroupIndexForSection(changes, origLineStart, origLineEnd);
	if (groupIndex === -1) return;
	const renderCtx: DiffRenderContext = { changes, origLineStart, origLineEnd, filePath, plugin, component };
	const groupEl = createReadingDiffActionBar(entry.id, groupIndex, countGroups(changes), renderCtx);
	el.insertBefore(groupEl, el.firstChild);

	// Hide the (duplicated) original when the initial mode is word-diff.
	let initialMode: DiffViewMode = "word-diff";
	try {
		initialMode = getData().diffViewMode;
	} catch {
		/* data store not ready */
	}
	applyWordDiffOriginalVisibility(el, initialMode, hasRemoval);

	// Sync the toggle icon + expanded detail with global mode changes (e.g.
	// toggled from this or another section, or the editor). Only re-renders our
	// detail subtree in place — never the section. Listens to the dedicated
	// mode event (fired by the toggle) as well as the pending-changes event (so
	// the icon stays correct after external mutations).
	const syncHandler = () => {
		if (!el.isConnected) {
			document.removeEventListener("s2b-pending-changes-updated", syncHandler);
			document.removeEventListener("s2b-diff-mode-changed", syncHandler);
			return;
		}
		let mode: DiffViewMode = "word-diff";
		try {
			mode = getData().diffViewMode;
		} catch {
			/* */
		}
		const toggleBtn = groupEl.querySelector<HTMLElement>(".s2b-diff-toggle-btn");
		if (toggleBtn) setIcon(toggleBtn, mode === "word-diff" ? "columns-2" : "file-diff");
		applyWordDiffOriginalVisibility(el, mode, hasRemoval);
		const detail = groupEl.querySelector<HTMLElement>(":scope > .s2b-diff-detail");
		if (detail) {
			renderDetailInto(detail, renderCtx, mode);
		}
	};
	document.addEventListener("s2b-pending-changes-updated", syncHandler);
	document.addEventListener("s2b-diff-mode-changed", syncHandler);
}

/**
 * Create a factory for the reading-view diff post-processor.
 * The plugin instance is captured so MarkdownRenderer can be used for two-pane diffs.
 */
export function createReadingViewDiffPostProcessor(plugin: Plugin) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		const filePath = ctx.sourcePath;
		if (!filePath) return;

		let store: ReturnType<typeof getPendingChangesStore>;
		try {
			store = getPendingChangesStore();
		} catch {
			return;
		}

		const pendingUpdates = store.getPendingUpdatesForPath(filePath);
		if (pendingUpdates.length === 0) {
			// No pending change for this file — strip any decoration left on a
			// reused section node from a previous render.
			clearSectionDecoration(el);
			return;
		}

		const entry = pendingUpdates.at(-1);
		if (!entry) return;

		const sectionInfo = ctx.getSectionInfo(el);
		if (!sectionInfo) return;

		// Anything the section renders (the two-pane markdown preview) is owned by
		// a child of the section's own render context, so it unloads with the
		// section rather than with the plugin.
		const component = new MarkdownRenderChild(el);
		ctx.addChild(component);
		try {
			processSection(el, entry, plugin, component, filePath, sectionInfo);
		} catch {
			// Silently recover — don't break Obsidian's rendering pipeline
		}
	};
}
