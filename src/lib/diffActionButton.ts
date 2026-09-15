import { setIcon } from "obsidian";
import { threadHasMultipleStops } from "./pendingChangeNavigation";
import { getPendingChangesStore } from "../stores/pendingChangesStore.svelte";

/**
 * Whether an entry's action bar should offer prev/next chevrons: true only when
 * its thread has more than one pending-change stop to step between.
 *
 * The bars know their `entryId` but not their `threadId`, so resolve the entry
 * the same way the click handlers do. Guarded because the bar can be built
 * before the store exists.
 */
export function canNavigate(entryId: string): boolean {
	try {
		const entry = getPendingChangesStore().getEntry(entryId);
		if (!entry) return false;
		return threadHasMultipleStops(entry.threadId);
	} catch {
		return false;
	}
}

/**
 * Build an Accept / Reject button for a pending-change action bar.
 *
 * Shared by the two parallel bar builders — `createEditActionBar` in
 * `editor/inlineDiffExtension.ts` (CodeMirror widget) and the reading-view
 * builder in `editor/readingViewDiffProcessor.ts` — so the two surfaces can't
 * drift apart the way they did before.
 *
 * The glyph and the word are separate spans on purpose: the bar collapses to
 * icon-only below its container-query breakpoint (see `.s2b-diff-btn-label` in
 * styles.css) so it stays on one row in a narrow note pane. `aria-label` is set
 * unconditionally because the visible word is exactly what disappears there.
 */
export function createResolveButton(
	className: string,
	iconName: string,
	label: string,
	ariaLabel: string,
): HTMLButtonElement {
	const btn = createEl("button");
	btn.className = className;
	btn.setAttribute("aria-label", ariaLabel);

	const iconEl = createSpan();
	iconEl.className = "s2b-diff-btn-icon";
	setIcon(iconEl, iconName);
	btn.appendChild(iconEl);

	const labelEl = createSpan();
	labelEl.className = "s2b-diff-btn-label";
	labelEl.textContent = label;
	btn.appendChild(labelEl);

	return btn;
}
