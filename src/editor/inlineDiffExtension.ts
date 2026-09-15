import { type DecorationSet, Decoration, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { diffLines, diffWords } from "diff";
import { type App, Component, MarkdownRenderer, editorInfoField, setIcon } from "obsidian";
import { canNavigate, createResolveButton } from "../lib/diffActionButton";
import { type ChangeGroup, identifyGroups } from "../lib/diffGroups";
import { navigateToPendingChange } from "../lib/pendingChangeNavigation";
import { getData } from "../stores/dataStore.svelte";
import { getPendingChangesStore } from "../stores/pendingChangesStore.svelte";
import { getPlugin } from "../stores/state.svelte";
import type { PendingChangeEntry } from "../types/shared";
import type { DiffViewMode } from "../types/plugin";

/** Dispatched to signal the plugin should rebuild decorations from the store. */
const refreshPendingChanges = StateEffect.define();

/**
 * Create the compact action bar shown at the head of a pending change group:
 * the "Pending change" label, a view-mode toggle, and Accept / Reject buttons.
 * The diff detail below is always shown (no collapse).
 */
function createEditActionBar(entryId: string, groupIndex: number, groupTotal: number, stale: boolean): HTMLElement {
	const bar = createDiv();
	bar.className = "s2b-diff-action-bar-widget";

	const label = createSpan();
	label.className = "s2b-diff-actions-label";
	label.textContent = "Pending change";
	bar.appendChild(label);

	// Position among this note's pending change groups (e.g. "2/3"). Only shown
	// when there's more than one — a lone change needs no counter. The note's
	// inline diff renders a single entry's groups, so groupIndex/groupTotal is a
	// per-file position (see buildDecorations).
	if (groupTotal > 1) {
		const position = createSpan();
		position.className = "s2b-diff-position-indicator";
		position.textContent = `${groupIndex + 1}/${groupTotal}`;
		bar.appendChild(position);
		// The indicator takes over the label's auto-margin (see styles.css).
		label.classList.add("s2b-diff-actions-label-with-indicator");
	}

	// Prev/next chevrons: step through this chat thread's pending changes across
	// files, reusing the SAME shared cursor as the palette commands and the
	// reading-view bars so all entry points stay in sync. The entry's threadId
	// is resolved lazily on click (the bar only knows the entryId).
	//
	// Only rendered when the thread has somewhere to go. Navigation wraps, so a
	// lone pending change makes both chevrons no-ops that land right back on
	// this bar — omit them rather than show two dead controls.
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
				// Pass this bar's own stop as the origin so the chevron steps
				// relative to the change it's attached to — not the thread's shared
				// cursor, which every bar shares (all bars would otherwise move in
				// lockstep from the same global position).
				void navigateToPendingChange(getPlugin(), entry.threadId, direction, { entryId, groupIndex });
			} catch {
				/* store/plugin not initialized */
			}
		});
		return btn;
	};
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
		// A view-mode flip is not a pending-changes mutation — use the dedicated
		// mode event so it doesn't trigger the reading views' destructive
		// rerender (see readingViewDiffProcessor). The editor field rebuilds its
		// decorations synchronously in response either way.
		document.dispatchEvent(new CustomEvent("s2b-diff-mode-changed"));
	});
	bar.appendChild(toggleBtn);

	const acceptBtn = createResolveButton("s2b-diff-accept-btn", "check", "Accept", "Accept change");
	// Stale parity with the chat bar: once the document no longer matches the
	// staged original, the store's conflict check makes every group accept fail
	// unconditionally, so offer the explanation instead of the error.
	if (stale) {
		acceptBtn.disabled = true;
		acceptBtn.setAttribute(
			"title",
			"Cannot accept — the note changed after this was proposed. Reject it and ask the agent to re-stage.",
		);
	}
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

	return bar;
}

function appendWordDiffContent(container: HTMLElement, removedText: string, addedText: string): void {
	const parts = diffWords(removedText, addedText);

	for (const part of parts) {
		const span = createSpan();
		span.textContent = part.value;
		if (part.removed) {
			span.className = "s2b-diff-word-removed";
		} else if (part.added) {
			span.className = "s2b-diff-word-added";
		}
		container.appendChild(span);
	}
}

/**
 * Render the diff detail body (word-diff or two-pane) for a change group. In
 * two-pane mode only the NEW content is shown, rendered as full markdown (the
 * original is already visible + red-tinted in the document). `app`/`sourcePath`
 * are needed for markdown rendering; a transient {@link Component} owns the
 * render lifecycle and is unloaded when the widget's DOM is torn down.
 */
function buildDetailBody(
	mode: DiffViewMode,
	removedText: string,
	addedText: string,
	app: App | null,
	sourcePath: string,
	onCleanup: (fn: () => void) => void,
): HTMLElement {
	const body = createDiv();
	body.className = "s2b-diff-detail";

	if (mode === "two-pane") {
		const panes = createDiv();
		panes.className = "s2b-diff-two-pane";

		// Only the new content is shown. The original lines are already visible
		// (and tinted red) in the document above/around this widget, so a removed
		// pane would just duplicate them.
		if (addedText) {
			const added = createDiv();
			added.className = "s2b-diff-pane-added";
			if (app) {
				// Render markdown so the pane matches the reading-view two-pane
				// (headings/bold/lists formatted, not raw source).
				const component = new Component();
				component.load();
				onCleanup(() => component.unload());
				void MarkdownRenderer.render(app, addedText.trimEnd(), added, sourcePath, component);
			} else {
				const pre = createEl("pre");
				pre.textContent = addedText;
				added.appendChild(pre);
			}
			panes.appendChild(added);
		}

		body.appendChild(panes);
	} else {
		const preview = createDiv();
		preview.className = "s2b-diff-edit-word-preview";
		appendWordDiffContent(preview, removedText, addedText);
		body.appendChild(preview);
	}

	return body;
}

/**
 * `WidgetType` comes from `@codemirror/view`, which is **externalized** (provided
 * by the Obsidian host, not bundled — see vite.config.ts). On Obsidian mobile
 * (iOS) the host does not expose that export in the shape the bundle expects, so
 * a top-level `class ... extends WidgetType {}` sees `WidgetType === undefined`
 * and throws `TypeError: The superclass is not a constructor` at module load,
 * crashing the whole plugin before any of our code runs. Desktop exposes it, so
 * it never surfaced there. Same failure family as `AbstractInputSuggest` — see
 * `src/components/modal/folderSuggest.ts`.
 *
 * Defer the `class extends WidgetType` declarations into a memoized factory so
 * the superclass is only dereferenced the first time a diff decoration is
 * actually built (well past plugin load). If `WidgetType` is somehow missing,
 * the inline-diff widgets degrade instead of taking down the plugin.
 */
interface WidgetClasses {
	PendingGroupWidget: new (
		entryId: string,
		groupIndex: number,
		groupTotal: number,
		removedText: string,
		addedText: string,
		mode: DiffViewMode,
		app: App | null,
		sourcePath: string,
		stale: boolean,
	) => WidgetType;
	CrossThreadBannerWidget: new (otherCount: number) => WidgetType;
}

let widgetClasses: WidgetClasses | null = null;

function getWidgetClasses(): WidgetClasses {
	if (widgetClasses) return widgetClasses;

	/**
	 * Lightweight block widget for a single change group: a compact action bar
	 * (accept / reject / view-mode toggle) plus the always-shown word-diff /
	 * two-pane detail. The removed/added lines are also conveyed by the line tints
	 * in the document. This replaces the old always-on full-preview block widgets,
	 * which reflowed the editor for every group.
	 */
	class PendingGroupWidgetImpl extends WidgetType {
		/** Markdown-render cleanups for the currently-shown detail body, so a
		 * re-render or widget teardown unloads its Components. */
		private detailCleanups: Array<() => void> = [];

		constructor(
			readonly entryId: string,
			readonly groupIndex: number,
			readonly groupTotal: number,
			readonly removedText: string,
			readonly addedText: string,
			readonly mode: DiffViewMode,
			readonly app: App | null,
			readonly sourcePath: string,
			readonly stale: boolean,
		) {
			super();
		}

		private runDetailCleanups() {
			for (const fn of this.detailCleanups) fn();
			this.detailCleanups = [];
		}

		private buildDetail(): HTMLElement {
			this.runDetailCleanups();
			return buildDetailBody(this.mode, this.removedText, this.addedText, this.app, this.sourcePath, (fn) =>
				this.detailCleanups.push(fn),
			);
		}

		toDOM(): HTMLElement {
			const container = createDiv();
			container.className = "s2b-diff-edit-group";

			container.appendChild(createEditActionBar(this.entryId, this.groupIndex, this.groupTotal, this.stale));
			container.appendChild(this.buildDetail());

			return container;
		}

		destroy(): void {
			this.runDetailCleanups();
		}

		eq(other: PendingGroupWidgetImpl): boolean {
			return (
				this.entryId === other.entryId &&
				this.groupIndex === other.groupIndex &&
				this.groupTotal === other.groupTotal &&
				this.removedText === other.removedText &&
				this.addedText === other.addedText &&
				this.mode === other.mode &&
				this.sourcePath === other.sourcePath &&
				// Part of identity so a staleness flip re-renders the bar (CM6 reuses
				// the DOM of eq widgets, so toDOM would otherwise never re-run).
				this.stale === other.stale
			);
		}

		ignoreEvent(): boolean {
			return false;
		}
	}

	/** Block widget shown at the top of the document when OTHER chats also have a
	 * pending update to this file. The inline diff only renders the newest pending
	 * update ({@link getLatestPendingUpdateForPath} → `.at(-1)`), so without this
	 * banner the existence of competing edits from other threads would be invisible
	 * here. Purely informational — the entries are reviewed from each chat's own
	 * PendingChangesBar. */
	class CrossThreadBannerWidgetImpl extends WidgetType {
		constructor(readonly otherCount: number) {
			super();
		}

		toDOM(): HTMLElement {
			const banner = createDiv();
			banner.className = "s2b-diff-cross-thread-banner";
			const chat = this.otherCount === 1 ? "chat has" : "chats have";
			banner.textContent = `${this.otherCount} other ${chat} a pending edit to this file. Only the latest is shown here; whichever is accepted first wins and the others may then fail to apply.`;
			return banner;
		}

		eq(other: CrossThreadBannerWidgetImpl): boolean {
			return this.otherCount === other.otherCount;
		}

		ignoreEvent(): boolean {
			return false;
		}
	}

	widgetClasses = {
		PendingGroupWidget: PendingGroupWidgetImpl,
		CrossThreadBannerWidget: CrossThreadBannerWidgetImpl,
	};
	return widgetClasses;
}

function createGroupDecoration(
	group: ChangeGroup,
	entryId: string,
	groupIndex: number,
	groupTotal: number,
	mode: DiffViewMode,
	app: App | null,
	sourcePath: string,
	stale: boolean,
): Decoration {
	const widget = new (getWidgetClasses().PendingGroupWidget)(
		entryId,
		groupIndex,
		groupTotal,
		group.removedText,
		group.addedText,
		mode,
		app,
		sourcePath,
		stale,
	);
	return Decoration.widget({ widget, side: -1, block: true });
}

/** Line-background tint for removed lines within a group. (Pure insertions are
 * NOT tinted — the inserted text lives in the widget card, not the document, so
 * there is no document line to mark as added.) */
const removedLineDecoration = Decoration.line({ class: "s2b-diff-line-removed" });
/** Neutral tint for removed lines in word-diff mode — marks the source lines
 * the card's diff refers to without the "deleted" connotation of red. */
const mutedLineDecoration = Decoration.line({ class: "s2b-diff-line-muted" });

/**
 * Build a function that maps positions from originalContent-space to docText-space,
 * accounting for user edits. Returns null for positions that fall in regions
 * the user has modified (deleted/changed).
 */
function buildPositionMapper(originalContent: string, docText: string): (origPos: number) => number | null {
	if (originalContent === docText) return (pos) => pos;

	const parts = diffLines(originalContent, docText);
	const segments: Array<{
		fromStart: number;
		fromEnd: number;
		shift: number;
		type: "equal" | "removed";
	}> = [];
	let fromPos = 0;
	let toPos = 0;

	for (const part of parts) {
		if (part.removed) {
			segments.push({
				fromStart: fromPos,
				fromEnd: fromPos + part.value.length,
				shift: toPos - fromPos,
				type: "removed",
			});
			fromPos += part.value.length;
		} else if (part.added) {
			toPos += part.value.length;
		} else {
			segments.push({
				fromStart: fromPos,
				fromEnd: fromPos + part.value.length,
				shift: toPos - fromPos,
				type: "equal",
			});
			fromPos += part.value.length;
			toPos += part.value.length;
		}
	}

	return (origPos: number): number | null => {
		for (const seg of segments) {
			if (origPos >= seg.fromStart && origPos < seg.fromEnd) {
				if (seg.type === "removed") return null;
				return origPos + seg.shift;
			}
		}
		// Position at or beyond the end — use last segment's shift
		const last = segments.at(-1);
		if (last?.fromEnd === origPos) {
			return origPos + last.shift;
		}
		return origPos;
	};
}

/** Build decorations for a single change group at the given mapped offset. */
function getEditorFilePath(state: EditorState): string | null {
	try {
		return state.field(editorInfoField, false)?.file?.path ?? null;
	} catch {
		return null;
	}
}

function getEditorApp(state: EditorState): App | null {
	try {
		return state.field(editorInfoField, false)?.app ?? null;
	} catch {
		return null;
	}
}

function getLatestPendingUpdateForPath(filePath: string): PendingChangeEntry | null {
	try {
		return getPendingChangesStore().getPendingUpdatesForPath(filePath).at(-1) ?? null;
	} catch {
		return null;
	}
}

function buildDecorations(state: EditorState, entryOverride?: PendingChangeEntry | null): DecorationSet {
	try {
		const filePath = getEditorFilePath(state);
		if (!filePath) return Decoration.none;

		const entry = entryOverride ?? getLatestPendingUpdateForPath(filePath);
		if (!entry) return Decoration.none;
		const change = entry.change;
		if (change.type !== "update") return Decoration.none;

		let mode: DiffViewMode;
		try {
			mode = getData().diffViewMode;
		} catch {
			mode = "word-diff";
		}

		const docText = state.doc.toString();
		const app = getEditorApp(state);
		const groups = identifyGroups(change.originalContent, change.newContent);
		if (groups.length === 0) return Decoration.none;

		// The document no longer matches the staged original (user edits, or an
		// external change loaded into the editor). Every group accept would fail
		// the store's disk conflict check, so the action bars disable Accept.
		// Doc-based rather than a disk read: it's synchronous, and the editor's
		// content is what the user is looking at while reviewing here.
		const stale = docText !== change.originalContent;

		const mapPos = buildPositionMapper(change.originalContent, docText);
		const decorations = [];

		// Prepend a banner if OTHER chats also have a pending update to this file
		// (the inline diff only renders this entry — the newest). Anchored at the
		// document start with side: -1 so it sorts before any group decoration.
		let otherThreads = 0;
		try {
			otherThreads = getPendingChangesStore().countOtherThreadsPendingUpdate(filePath, entry.threadId);
		} catch {
			otherThreads = 0;
		}
		if (otherThreads > 0) {
			decorations.push(
				Decoration.widget({
					widget: new (getWidgetClasses().CrossThreadBannerWidget)(otherThreads),
					side: -1,
					block: true,
				}).range(0),
			);
		}

		for (let gi = 0; gi < groups.length; gi++) {
			const group = groups[gi];
			const mappedOffset = mapPos(group.docOffset);
			if (mappedOffset === null) continue;

			if (
				group.removedText &&
				docText.substring(mappedOffset, mappedOffset + group.docLength) !== group.removedText
			) {
				continue;
			}

			const clampedOffset = Math.min(mappedOffset, state.doc.length);
			const lineStart = state.doc.lineAt(clampedOffset).from;

			// Compact collapsible action bar for the group, anchored above its
			// first line (side: -1 so it sorts before the line decoration).
			decorations.push(
				createGroupDecoration(group, entry.id, gi, groups.length, mode, app, filePath, stale).range(lineStart),
			);

			// Line-background tints — additive, no document reflow. Only lines that
			// exist in the DOCUMENT get tinted; the inserted (new) text lives solely
			// in the widget card, not in the document, so a PURE INSERTION tints
			// NOTHING. Tinting its anchor line (the existing, unchanged paragraph
			// before the insertion point) as "added" falsely paints an unchanged
			// line green — and on a long wrapped paragraph that green bleeds across
			// the whole block. For groups WITH removed text: in word-diff mode the
			// card already shows the exact old->new inline, so removed lines get a
			// MUTED tint (a full red band there reads like "this line was deleted",
			// misleading for an in-place edit; no tint makes the still-visible
			// original look like a duplicate). Two-pane keeps the red (the document
			// is the reference the new pane is compared against).
			if (!group.removedText) {
				// Pure insertion: no document line changed — skip the tint entirely.
				continue;
			}
			const tint: Decoration = mode === "word-diff" ? mutedLineDecoration : removedLineDecoration;
			// group.docLength counts the removed lines' trailing newline, so
			// clampedOffset + docLength lands on the START of the line AFTER the
			// change — often a blank separator. Step back one char so the span ends
			// on the last removed line's own newline and the loop doesn't tint that
			// trailing blank line (edit mode used to show a stray tinted gap under
			// the original; reading mode never did — this keeps them consistent).
			const spanEnd = Math.min(clampedOffset + group.docLength - 1, state.doc.length);
			let pos = lineStart;
			while (pos <= spanEnd) {
				const line = state.doc.lineAt(pos);
				decorations.push(tint.range(line.from));
				if (line.to >= state.doc.length) break;
				pos = line.to + 1;
			}
		}

		// Decoration.set(..., true) sorts the mixed line/widget/block ranges,
		// satisfying CM6's sorted-range invariant regardless of push order.
		return Decoration.set(decorations, true);
	} catch {
		return Decoration.none;
	}
}

/**
 * The pending-diff decorations live in a StateField (NOT a ViewPlugin): CM6
 * forbids block decorations — the collapsible group widget and cross-thread
 * banner are `block: true` — from being provided by a ViewPlugin ("Block
 * decorations may not be specified via plugins"). The field rebuilds when it
 * sees a {@link refreshPendingChanges} effect (fired by the companion plugin on
 * init, store changes, file switches, and viewport/geometry changes) or when
 * the document itself changes; otherwise it maps the existing set through the
 * transaction's changes to keep positions valid.
 */
const pendingDiffField = StateField.define<DecorationSet>({
	create() {
		// editorInfoField may not be ready during field init — defer the first
		// build to the companion plugin's scheduled refresh.
		return Decoration.none;
	},
	update(deco, tr) {
		const refreshRequested = tr.effects.some((e) => e.is(refreshPendingChanges));
		if (refreshRequested) {
			return buildDecorations(tr.state);
		}
		// Doc changes only MAP the existing set (O(changes), keeps positions
		// valid) — rebuilding here ran two full-document diffLines passes on
		// every keystroke while a pending change was open. The companion plugin
		// debounces a refresh effect after typing pauses, which also flips the
		// bars' stale state (the mapped set still carries pre-edit staleness).
		return deco.map(tr.changes);
	},
	provide: (f) => EditorView.decorations.from(f),
});

/**
 * Companion side-effect plugin: it holds no decorations itself. It (1) defers
 * the first decoration build until `editorInfoField` is ready (rAF loop, as the
 * field/plugin can be constructed before Obsidian attaches the file), (2)
 * rebuilds on the `s2b-pending-changes-updated` DOM event, and (3) re-fires the
 * refresh effect on file switches and viewport/geometry changes the field can't
 * observe on its own.
 */
const inlineDiffSideEffects = ViewPlugin.fromClass(
	class {
		private readonly refreshHandler: () => void;
		private readonly view: EditorView;
		private initialized = false;
		private refreshAttempts = 0;
		private lastFilePath: string | null = null;
		private docRefreshTimer: number | null = null;

		constructor(view: EditorView) {
			this.view = view;
			this.refreshHandler = () => {
				try {
					this.view.dispatch({ effects: refreshPendingChanges.of(null) });
				} catch {
					/* view may already be destroyed */
				}
			};
			document.addEventListener("s2b-pending-changes-updated", this.refreshHandler);
			document.addEventListener("s2b-diff-mode-changed", this.refreshHandler);
			this.scheduleInitialRefresh();
		}

		private scheduleInitialRefresh() {
			window.requestAnimationFrame(() => {
				if (this.initialized) return;

				const hasFilePath = getEditorFilePath(this.view.state) !== null;
				if (hasFilePath || this.refreshAttempts >= 4) {
					this.initialized = true;
					this.lastFilePath = getEditorFilePath(this.view.state);
					this.refreshHandler();
					return;
				}

				this.refreshAttempts++;
				this.scheduleInitialRefresh();
			});
		}

		update(update: ViewUpdate) {
			if (!this.initialized) return;

			// Viewport and geometry changes deliberately do NOT refresh: the
			// decoration set is document-anchored, so scrolling can't change it —
			// refreshing there ran two full diffLines passes per scroll frame.
			const filePath = getEditorFilePath(this.view.state);
			if (filePath !== this.lastFilePath) {
				this.lastFilePath = filePath;
				this.refreshHandler();
				return;
			}

			// The field only MAPS the set through doc changes; schedule the real
			// rebuild for after typing pauses so the diffs run once per pause, not
			// once per keystroke. The mapped set stays visually correct meanwhile;
			// the rebuild re-verifies group text and updates the bars' stale state.
			if (update.docChanged) {
				if (this.docRefreshTimer) window.clearTimeout(this.docRefreshTimer);
				this.docRefreshTimer = window.setTimeout(() => {
					this.docRefreshTimer = null;
					this.refreshHandler();
				}, 250);
			}
		}

		destroy() {
			if (this.docRefreshTimer) window.clearTimeout(this.docRefreshTimer);
			document.removeEventListener("s2b-pending-changes-updated", this.refreshHandler);
			document.removeEventListener("s2b-diff-mode-changed", this.refreshHandler);
		}
	},
);

/** Inline pending-diff decorations: the decoration StateField plus its
 * companion side-effect plugin. Registered as one editor extension. */
export const inlineDiffPlugin: Extension = [pendingDiffField, inlineDiffSideEffects];
