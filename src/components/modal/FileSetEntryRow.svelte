<script lang="ts">
import { Keymap, type App } from "obsidian";
import type { Snippet } from "svelte";
import { getPlugin } from "../../stores/state.svelte";
import { getSearchResultNoteIcon } from "../../utils/noteIcons";
import { icon as iconDirective } from "../../utils/utils";

interface FileSetEntryRowEntry {
	path: string;
	displayName?: string;
	contextLabel?: string | null;
}

interface Props {
	app: App;
	entry: FileSetEntryRowEntry;
	sourcePath?: string;
	hoverSource: string;
	compact?: boolean;
	/**
	 * Keep the action buttons hidden until the row is hovered or focused within.
	 * Lists where every row carries the same one-click action (the privacy tabs)
	 * otherwise render a wall of identical buttons that drowns out the filenames.
	 * Off by default: short, mixed-action lists read better with them always shown.
	 */
	revealActionsOnHover?: boolean;
	actions?: Snippet<[]>;
}

const FILE_ICON_MAP: Record<string, string> = {
	chat: "message-square",
	excalidraw: "pencil",
	canvas: "layout-dashboard",
	base: "database",
	pdf: "file-text",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	svg: "image",
	webp: "image",
	mp3: "audio-lines",
	wav: "audio-lines",
	mp4: "film",
	mov: "film",
	mkv: "film",
	json: "braces",
	csv: "table",
	txt: "file-text",
};

let {
	app,
	entry,
	sourcePath = "",
	hoverSource,
	compact = false,
	revealActionsOnHover = false,
	actions,
}: Props = $props();

function getFileDisplayName(path: string): string {
	return path.split("/").pop() ?? path;
}

function getFileIconName(path: string): string {
	const lower = path.toLowerCase();
	const extension = lower.endsWith(".excalidraw.md") ? "excalidraw" : (lower.split(".").pop() ?? "");
	return FILE_ICON_MAP[extension] ?? "file-text";
}

interface LazyFileIconOptions {
	app: App;
	path: string;
}

function lazyFileIcon(node: HTMLElement, options: LazyFileIconOptions) {
	let currentOptions = options;
	let observer: IntersectionObserver | null = null;
	let idleCallbackHandle: number | null = null;
	let timeoutHandle: number | null = null;
	let hasRendered = false;

	const clearPending = () => {
		if (observer) {
			observer.disconnect();
			observer = null;
		}
		if (idleCallbackHandle !== null && typeof window.cancelIdleCallback === "function") {
			window.cancelIdleCallback(idleCallbackHandle);
			idleCallbackHandle = null;
		}
		if (timeoutHandle !== null) {
			window.clearTimeout(timeoutHandle);
			timeoutHandle = null;
		}
	};

	const renderIcon = () => {
		if (hasRendered) return;
		const icon = getSearchResultNoteIcon(currentOptions.app, currentOptions.path);
		if (!icon) return;
		try {
			icon.render(node);
			hasRendered = true;
		} catch {
			// Keep the fallback icon if richer rendering fails.
		}
	};

	const scheduleRender = () => {
		if (hasRendered || idleCallbackHandle !== null || timeoutHandle !== null) return;
		// typeof, not `in`: `requestIdleCallback` is non-optional on the `Window` type,
		// so an `in` check narrows the else branch to `never` and stops compiling. The
		// runtime guard is still wanted — older iOS WebViews don't implement it.
		if (typeof window.requestIdleCallback === "function") {
			idleCallbackHandle = window.requestIdleCallback(
				() => {
					idleCallbackHandle = null;
					renderIcon();
				},
				{ timeout: 250 },
			);
		} else {
			timeoutHandle = window.setTimeout(() => {
				timeoutHandle = null;
				renderIcon();
			}, 0);
		}
	};

	const observe = () => {
		clearPending();
		if (typeof IntersectionObserver === "undefined") {
			scheduleRender();
			return;
		}

		const root = node.closest(".file-set-editor-list");
		observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((observerEntry) => observerEntry.isIntersecting)) {
					observer?.disconnect();
					observer = null;
					scheduleRender();
				}
			},
			{
				root: root instanceof Element ? root : null,
				rootMargin: "120px 0px",
				threshold: 0,
			},
		);
		observer.observe(node);
	};

	observe();

	return {
		update(nextOptions: LazyFileIconOptions) {
			currentOptions = nextOptions;
			hasRendered = false;
			observe();
		},
		destroy() {
			clearPending();
		},
	};
}

function handleFileLinkClick(event: MouseEvent): void {
	event.preventDefault();
	event.stopPropagation();
	app.workspace.openLinkText(entry.path, sourcePath, Keymap.isModEvent(event));
}

/**
 * Sweeping the cursor down the list used to fire `hover-link` once per row it
 * crossed, and each preview popup has its own open/close delay — so several
 * would be on screen at once, reading as a smear trailing the cursor. Wait for
 * the pointer to settle before asking for a preview, and drop the pending
 * request as soon as it leaves, so only the row actually rested on previews.
 */
const HOVER_PREVIEW_DELAY_MS = 220;
let hoverPreviewHandle: number | null = null;

function cancelPendingPreview(): void {
	if (hoverPreviewHandle === null) return;
	window.clearTimeout(hoverPreviewHandle);
	hoverPreviewHandle = null;
}

function triggerPreview(event: Event, target: HTMLElement): void {
	app.workspace.trigger("hover-link", {
		event,
		source: hoverSource,
		hoverParent: getPlugin(),
		targetEl: target,
		linktext: entry.path,
		sourcePath,
	});
}

function previewFileLink(event: Event): void {
	const target = event.currentTarget;
	if (!(target instanceof HTMLElement)) return;

	cancelPendingPreview();
	hoverPreviewHandle = window.setTimeout(() => {
		hoverPreviewHandle = null;
		// The row can be torn down (list re-filtered, modal closed) during the
		// delay; a detached element has nothing to anchor a popup to.
		if (!target.isConnected) return;
		triggerPreview(event, target);
	}, HOVER_PREVIEW_DELAY_MS);
}

/** Focus has no "settling" ambiguity — preview immediately, as before. */
function previewFileLinkImmediate(event: Event): void {
	const target = event.currentTarget;
	if (!(target instanceof HTMLElement)) return;

	cancelPendingPreview();
	triggerPreview(event, target);
}

$effect(() => cancelPendingPreview);
</script>

<div class="space-file-row" class:space-file-row--compact={compact} title={entry.path}>
  <div class="space-file-link-row">
    <span
      class="space-file-link-icon s2b-search-result-note-icon"
      aria-hidden="true"
      use:iconDirective={getFileIconName(entry.path)}
      use:lazyFileIcon={{ app, path: entry.path }}
    ></span>
    <a
      class="internal-link space-file-link truncate"
      href={entry.path}
      data-href={entry.path}
      onclick={handleFileLinkClick}
      onmouseover={previewFileLink}
      onmouseout={cancelPendingPreview}
      onfocus={previewFileLinkImmediate}
      onblur={cancelPendingPreview}
    >
      {entry.displayName ?? getFileDisplayName(entry.path)}
    </a>
    {#if entry.contextLabel}
      <span class="space-file-context truncate">{entry.contextLabel}</span>
    {/if}
  </div>

  {#if actions}
    <div class="space-file-actions" class:space-file-actions--hover-reveal={revealActionsOnHover}>
      {@render actions()}
    </div>
  {/if}
</div>

<style>
  /*
   * Flat rows with a hover highlight, matching Obsidian's own list surfaces
   * (file explorer, search results) rather than boxing each entry in a card.
   * Keeps long lists scannable and the row height uniform whether or not the
   * entry has a context label.
   */
  .space-file-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 6px;
    border-radius: var(--radius-s);
    min-height: 28px;
  }

  .space-file-row:hover {
    background: var(--background-modifier-hover);
  }

  .space-file-row--compact {
    opacity: 0.85;
  }

  .space-file-link-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    flex: 1;
  }

  .space-file-link-icon {
    flex-shrink: 0;
    color: var(--text-faint);
    align-self: center;
    display: flex;
    align-items: center;
  }

  .space-file-link {
    min-width: 0;
    color: var(--text-normal);
    text-decoration: none;
  }

  .space-file-link:hover {
    color: var(--text-accent);
    text-decoration: underline;
  }

  /* Trails the filename inline; shrinks first so the name keeps priority. */
  .space-file-context {
    font-size: var(--font-smallest);
    color: var(--text-faint);
    flex-shrink: 1;
    min-width: 0;
  }

  .space-file-actions {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    flex-shrink: 0;
  }

  /*
   * Hover-reveal, opt-in per row. `visibility` rather than `opacity: 0` on
   * purpose: a transparent button still takes pointer events, which is how an
   * invisible control ends up swallowing the first click on a row. The element
   * keeps its box either way, so revealing it never reflows the row.
   *
   * Keyboard focus reveals the buttons too, but it must be `:has(:focus-visible)`
   * and NOT `:focus-within`: a mouse press leaves focus inside the row, so with
   * `:focus-within` every row the cursor passed over stayed revealed after the
   * hover moved on — several sets of buttons on screen at once, trailing the
   * cursor. `:focus-visible` only matches keyboard-derived focus, so mouse use
   * is governed purely by `:hover` and clears the instant the cursor leaves.
   *
   * Touch has no hover, so mobile opts back into always-visible rather than
   * stranding the action. That check keys off Obsidian's `.is-mobile` body
   * class, NOT `@media (hover: none)`: desktop Electron reports `hover: none`
   * and `pointer: coarse` on touch-capable hardware, so the media query matched
   * on desktop and pinned every row's buttons visible — the reveal never
   * engaged at all.
   */
  .space-file-actions--hover-reveal {
    visibility: hidden;
  }

  /*
   * Themes (Baseline, Cupertino, and others) ship a bare
   * `button, .clickable-icon, select, .dropdown { transition: <duration> ... }`
   * with no property list, which resolves to `transition-property: all` and so
   * transitions `visibility` too. Discrete properties flip at the END of the
   * interval when transitioned, so hiding was deferred by the theme's ~320ms
   * moderate duration while showing stayed instant — a fast sweep left three or
   * four rows' buttons on screen at once. Reveal is a state change, not an
   * animation, so opt these buttons out of transitioning visibility entirely.
   * The longhand leaves any theme background/colour transition intact.
   */
  .space-file-actions--hover-reveal,
  .space-file-actions--hover-reveal :global(button) {
    transition-property: background-color, color, border-color, box-shadow;
  }

  .space-file-row:hover .space-file-actions--hover-reveal,
  .space-file-row:has(:focus-visible) .space-file-actions--hover-reveal {
    visibility: visible;
  }

  :global(.is-mobile) .space-file-actions--hover-reveal {
    visibility: visible;
  }

  /*
   * Shrink the action buttons to match the tighter row. Scoped to this row's
   * buttons so the modal's other controls keep their normal sizing.
   */
  .space-file-actions :global(button) {
    height: auto;
    padding: 3px 8px;
    font-size: var(--font-smaller);
    box-shadow: none;
  }
</style>
