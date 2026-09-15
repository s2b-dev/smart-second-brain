import { MarkdownView, type EventRef, type WorkspaceLeaf } from "obsidian";
import { getPlugin } from "../stores/state.svelte";
import { getData } from "../stores/dataStore.svelte";
import { clearSelectionHighlight, setSelectionHighlight } from "../editor/selectionHighlightExtension";
import { getEditorView } from "../lib/editor";
import { SELECTION_BUDGET_FRACTION, contextWindowToCharBudget, truncateToBudget } from "../utils/contentBudget";

/** Serializable snapshot of user-selected text. Persisted in HumanMessage additional_kwargs. */
export interface SelectionRef {
	path: string;
	basename: string;
	viewType: string;
	text: string;
	icon: string;
}

interface CapturedSelection {
	ref: SelectionRef;
	/** CM6 ranges for edit-mode highlights (from/to offsets in the document). */
	cmRanges?: { from: number; to: number }[];
	/** Saved DOM Range objects for reading / PDF highlight persistence. */
	domRanges?: Range[];
}

const VIEW_ICONS: Record<string, string> = {
	markdown: "file-text",
	pdf: "file-type",
};

/**
 * Whether the leaf currently holds a *live but collapsed* selection — i.e. the
 * user has placed a cursor / clicked inside it with no text range. Used to
 * detect an intentional "click to dismiss" on a pinned selection. Returns false
 * when there's no live selection at all (focus is elsewhere).
 */
function hasCollapsedSelectionInLeaf(leaf: WorkspaceLeaf): boolean {
	const view = leaf.view;
	const viewType = leaf.view.getViewType();

	// Markdown edit mode: inspect the CM6 state selection.
	if (view instanceof MarkdownView && view.getMode() === "source") {
		try {
			const cm = getEditorView(view.editor);
			if (!cm?.state) return false;
			// A collapsed main range with editor focus means a cursor is placed but nothing is selected.
			return cm.hasFocus && cm.state.selection.main.empty;
		} catch {
			return false;
		}
	}

	// Reading mode / PDF: inspect the DOM selection scoped to this leaf.
	if ((view instanceof MarkdownView && view.getMode() === "preview") || viewType === "pdf") {
		try {
			const domSel = activeWindow.getSelection();
			if (!domSel || domSel.rangeCount === 0) return false;
			const range = domSel.getRangeAt(0);
			if (!leaf.view.containerEl.contains(range.commonAncestorContainer)) return false;
			return domSel.isCollapsed;
		} catch {
			return false;
		}
	}

	return false;
}

/**
 * Attempt to get the selected text in the active leaf.
 * Supports markdown edit mode (CM6), markdown reading mode, and PDF views.
 */
function getSelectionFromLeaf(leaf: WorkspaceLeaf): CapturedSelection | undefined {
	const view = leaf.view;
	const file = (view as { file?: { path: string; basename: string } }).file;
	if (!file) return undefined;

	const viewType = leaf.view.getViewType();

	// --- Markdown edit mode: use CM6 selection API ---
	if (view instanceof MarkdownView && view.getMode() === "source") {
		try {
			const cm = getEditorView(view.editor);
			if (!cm?.state) return undefined;
			const sel = cm.state.selection;
			const ranges = sel.ranges.filter((r: { from: number; to: number }) => r.from !== r.to);
			if (ranges.length === 0) return undefined;

			const text = ranges
				.map((r: { from: number; to: number }) => cm.state.doc.sliceString(r.from, r.to))
				.join("\n");
			if (!text.trim()) return undefined;

			return {
				ref: {
					path: file.path,
					basename: file.basename,
					viewType: "markdown",
					text,
					icon: VIEW_ICONS.markdown,
				},
				cmRanges: ranges.map((r: { from: number; to: number }) => ({ from: r.from, to: r.to })),
			};
		} catch {
			/* CM internals may change */
		}
		return undefined;
	}

	// --- Markdown reading mode & PDF: use DOM selection ---
	if ((view instanceof MarkdownView && view.getMode() === "preview") || viewType === "pdf") {
		try {
			const domSel = activeWindow.getSelection();
			if (!domSel || domSel.rangeCount === 0) return undefined;

			// Scope to the leaf's container so we don't capture stray selections
			const container = leaf.view.containerEl;
			const firstRange = domSel.getRangeAt(0);
			if (!container.contains(firstRange.commonAncestorContainer)) return undefined;

			const text = domSel.toString();
			if (!text.trim()) return undefined;

			const domRanges: Range[] = [];
			for (let i = 0; i < domSel.rangeCount; i++) {
				domRanges.push(domSel.getRangeAt(i).cloneRange());
			}

			const icon = viewType === "pdf" ? VIEW_ICONS.pdf : VIEW_ICONS.markdown;
			return {
				ref: { path: file.path, basename: file.basename, viewType, text, icon },
				domRanges,
			};
		} catch {
			/* safety */
		}
	}

	return undefined;
}

/** Resolve the dynamic char cap for selection text from the active chat model. */
function selectionCharBudget(): number {
	const contextWindow = getData().getSelectedAgent().chatModel?.modelConfig?.contextWindow;
	return contextWindowToCharBudget(contextWindow, SELECTION_BUDGET_FRACTION);
}

/** Formats a captured selection into a context block for the agent.
 * The selected text is capped to a budget derived from the model's context
 * window so a huge selection can't dominate (or overflow) the request. */
export function formatSelectionContext(ref: SelectionRef): string {
	const { text } = truncateToBudget(ref.text, selectionCharBudget());
	return `[Selected text from ${ref.path}]\n${text}`;
}

/**
 * Reactive tracker for user text selections in the main workspace area.
 * Polls the active leaf for non-empty selections and exposes a snapshot
 * that persists even after focus moves to the chat input.
 */
export class SelectionTracker {
	readonly #workspace = getPlugin().app.workspace;
	#selection: CapturedSelection | undefined = $state(undefined);
	#refs: EventRef[] = [];
	#refreshFrame: number | undefined;
	/** When true, selection was pinned (focus left the note) and should be kept. */
	#pinned = false;
	readonly #handleSelectionChange = () => this.#scheduleRefresh();

	/** The current captured selection ref (serializable). */
	get selection(): SelectionRef | undefined {
		return this.#selection?.ref;
	}

	/** Whether the current selection will be truncated when sent (exceeds the
	 * model-derived char budget). Drives the ⚠ warning cue on the chip. */
	get isLong(): boolean {
		return (this.#selection?.ref.text.length ?? 0) > selectionCharBudget();
	}

	constructor() {
		this.#refresh();
		this.#refs = [
			this.#workspace.on("active-leaf-change", () => {
				// When focus leaves a note (e.g. to the chat sidebar),
				// pin whatever we captured so the chip stays.
				if (this.#selection && !this.#pinned) {
					this.#pin();
				}
				this.#scheduleRefresh();
			}),
		];
		document.addEventListener("selectionchange", this.#handleSelectionChange);
	}

	#scheduleRefresh() {
		if (this.#refreshFrame !== undefined) return;
		this.#refreshFrame = window.requestAnimationFrame(() => {
			this.#refreshFrame = undefined;
			this.#refresh();
		});
	}

	#refresh() {
		// `activeLeaf` is deprecated; the most recently focused leaf is the one the
		// active-leaf-change event just fired for, and it is not always a markdown
		// view (PDFs count), so `getActiveViewOfType` alone is not enough.
		const activeLeaf = this.#workspace.getMostRecentLeaf();
		if (!activeLeaf) return;

		// Check if we're in a note/PDF leaf (not the chat sidebar)
		const vt = activeLeaf.view.getViewType();
		const isNoteLeaf = vt === "markdown" || vt === "pdf";

		// If pinned but user is back in a note leaf, check for a new selection
		if (this.#pinned && isNoteLeaf) {
			const captured = getSelectionFromLeaf(activeLeaf);
			if (captured && !this.#selectionEqual(this.#selection, captured)) {
				// User made a new selection — unpin and adopt it
				this.#clearHighlights();
				this.#pinned = false;
				this.#selection = captured;
				return;
			}
			// User clicked (placed a cursor) with no range in the note that owns the
			// pinned selection → treat as an intentional dismissal, not a stray blur.
			if (!captured && hasCollapsedSelectionInLeaf(activeLeaf)) {
				this.clear();
			}
			return;
		}

		// Don't overwrite a pinned selection
		if (this.#pinned) return;

		const captured = isNoteLeaf ? getSelectionFromLeaf(activeLeaf) : undefined;
		if (captured) {
			// New non-empty selection detected → update
			if (!this.#selectionEqual(this.#selection, captured)) {
				this.#selection = captured;
			}
		}
		// If selection is now empty and we haven't pinned, clear
		else if (this.#selection && !this.#pinned) {
			this.#selection = undefined;
		}
	}

	/** Pin the current selection and apply dim highlights so the user can see what was captured. */
	#pin() {
		if (!this.#selection) return;
		this.#pinned = true;

		const captured = this.#selection;

		// CM6 edit mode: dispatch decoration marks
		if (captured.cmRanges?.length) {
			try {
				const activeView = this.#workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					const cm = getEditorView(activeView.editor);
					if (cm) setSelectionHighlight(cm, captured.cmRanges);
				}
			} catch {
				/* CM internals */
			}
		}

		// Reading / PDF: use CSS Custom Highlight API
		if (captured.domRanges?.length) {
			try {
				if (CSS.highlights) {
					const highlight = new Highlight(...captured.domRanges);
					CSS.highlights.set("s2b-selection", highlight);
				}
			} catch {
				/* API may not be available */
			}
		}
	}

	/** Clear the captured selection and remove all highlights. */
	clear() {
		const cleared = this.#selection;
		this.#selection = undefined;
		this.#pinned = false;
		this.#clearHighlights();
		this.#clearNativeSelection(cleared);
	}

	/**
	 * Collapse the live selection in the note that held the dismissed selection so
	 * a dismissed chip isn't immediately re-captured on the next refresh. Without
	 * this the underlying range lingers and `getSelectionFromLeaf` re-adopts it,
	 * resurrecting the chip.
	 *
	 * The selection is usually *pinned* by the time it's dismissed, meaning focus
	 * has already moved to the chat — so we target the note leaf by the captured
	 * path, NOT the active leaf (which is the chat). Handles CM6 edit mode
	 * (state selection) and DOM (reading/PDF).
	 */
	#clearNativeSelection(cleared: CapturedSelection | undefined) {
		// Only collapse the native range that belongs to the dismissed selection.
		// With no captured selection there's nothing of ours to clear — bailing
		// here avoids stomping unrelated live selections in other editors/notes.
		const path = cleared?.ref.path;
		if (!path) return;

		// CM6 edit mode reads cm.state.selection, not the DOM — collapse it in the
		// specific editor that owned the selection.
		try {
			for (const leaf of this.#workspace.getLeavesOfType("markdown")) {
				const view = leaf.view;
				if (!(view instanceof MarkdownView) || view.getMode() !== "source") continue;
				if (view.file?.path !== path) continue;
				const cm = getEditorView(view.editor);
				if (cm?.state && !cm.state.selection.main.empty) {
					cm.dispatch({ selection: { anchor: cm.state.selection.main.head } });
				}
			}
		} catch {
			/* CM internals may change */
		}

		// Reading / PDF: collapse the DOM selection only when it lives inside the
		// note that owned the dismissed selection, so we don't wipe an unrelated
		// selection the user has active elsewhere.
		try {
			const domSel = activeWindow.getSelection();
			if (!domSel || domSel.rangeCount === 0) return;
			const container = this.#leafContainerForPath(path);
			if (container?.contains(domSel.getRangeAt(0).commonAncestorContainer)) {
				domSel.removeAllRanges();
			}
		} catch {
			/* safety */
		}
	}

	/** Container element of the visible note leaf owning `path`, if any. */
	#leafContainerForPath(path: string): HTMLElement | undefined {
		for (const type of ["markdown", "pdf"]) {
			for (const leaf of this.#workspace.getLeavesOfType(type)) {
				if ((leaf.view as { file?: { path: string } }).file?.path === path) {
					return leaf.view.containerEl;
				}
			}
		}
		return undefined;
	}

	/** Remove all visual highlights (CM6 decorations and CSS Highlight API). */
	#clearHighlights() {
		// Remove CM6 highlights from all editors
		try {
			for (const leaf of this.#workspace.getLeavesOfType("markdown")) {
				if (leaf.view instanceof MarkdownView) {
					const cm = getEditorView(leaf.view.editor);
					if (cm) clearSelectionHighlight(cm);
				}
			}
		} catch {
			/* safety */
		}

		// Remove CSS Highlight API highlights
		try {
			CSS.highlights?.delete("s2b-selection");
		} catch {
			/* safety */
		}
	}

	#selectionEqual(a: CapturedSelection | undefined, b: CapturedSelection | undefined): boolean {
		if (!a && !b) return true;
		if (!a || !b) return false;
		return a.ref.path === b.ref.path && a.ref.text === b.ref.text;
	}

	destroy() {
		// Reset our own state + highlights, but leave the user's live selection
		// intact (don't collapse it just because the chat view unmounted).
		this.#selection = undefined;
		this.#pinned = false;
		this.#clearHighlights();
		for (const ref of this.#refs) {
			this.#workspace.offref(ref);
		}
		this.#refs = [];
		document.removeEventListener("selectionchange", this.#handleSelectionChange);
		if (this.#refreshFrame !== undefined) {
			cancelAnimationFrame(this.#refreshFrame);
			this.#refreshFrame = undefined;
		}
	}
}
