<script lang="ts">
import { Keymap, MarkdownRenderer, loadMathJax } from "obsidian";
import { getPlugin } from "../../stores/state.svelte";
import { openTagSearch } from "../../utils/tagSearch";
import { VIEW_TYPE_CHAT } from "../../views/chat/Chat";

interface Props {
	content: string;
	class?: string;
	enableMath?: boolean;
}

const { content, class: className = "", enableMath = true }: Props = $props();

const plugin = getPlugin();

// Module-level state shared across all instances to ensure only one hover preview at a time
let lastHoverLink: HTMLElement | null = $state(null);

// Container element reference
let container: HTMLElement | undefined = $state();

// Get the source path for link resolution
const sourcePath = $derived(plugin.app.workspace.getActiveFile()?.path ?? "");

// Helper to get link text from an anchor element
function getLinkText(link: HTMLAnchorElement): string | null {
	return link.getAttribute("data-href") ?? link.getAttribute("href");
}

// Helper to get tag text from a tag element
function getTagText(tagEl: HTMLElement): string | null {
	// Tags in Obsidian are rendered as <a class="tag" href="#tagname">#tagname</a>
	const href = tagEl.getAttribute("href");
	if (href?.startsWith("#")) {
		return href.slice(1); // Remove the leading #
	}
	// Fallback to text content
	const text = tagEl.textContent?.trim();
	if (text?.startsWith("#")) {
		return text.slice(1);
	}
	return text ?? null;
}

// Handle internal link clicks
function handleClick(evt: MouseEvent) {
	const target = evt.target as HTMLElement;

	// Check for tag clicks first
	const tagEl = target.closest("a.tag") as HTMLElement | null;
	if (tagEl) {
		evt.preventDefault();
		evt.stopPropagation();

		const tag = getTagText(tagEl);
		if (tag) {
			void openTagSearch(plugin.app, tag);
		}
		return;
	}

	// Handle internal link clicks
	const link = target.closest("a.internal-link") as HTMLAnchorElement | null;
	if (!link) return;

	evt.preventDefault();
	evt.stopPropagation();

	const linktext = getLinkText(link);
	if (linktext) {
		plugin.app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(evt));
	}
}

// Handle hover for page preview
function handleMouseOver(evt: MouseEvent) {
	const target = evt.target as HTMLElement | null;
	if (!target) return;

	const linkEl = target.closest("a.internal-link") as HTMLAnchorElement | null;
	if (!linkEl) return;

	// Prevent re-trigger spam while moving over children inside the same <a>
	// This ensures only one preview is active at a time
	if (lastHoverLink === linkEl) return;
	lastHoverLink = linkEl;

	const linktext = getLinkText(linkEl);
	if (!linktext) return;

	plugin.app.workspace.trigger("hover-link", {
		event: evt, // Page Preview inspects modifier keys here
		source: VIEW_TYPE_CHAT, // Must match registered hover source
		hoverParent: plugin, // The Component (Plugin) that owns this
		targetEl: linkEl, // The actual link element being hovered
		linktext,
		sourcePath,
	});
}

// Handle mouseout to reset hover state
function handleMouseOut(evt: MouseEvent) {
	const target = evt.target as HTMLElement | null;
	const related = evt.relatedTarget as HTMLElement | null;
	if (!target) return;

	const fromLink = target.closest("a.internal-link");
	const toLink = related?.closest?.("a.internal-link") ?? null;

	// Reset when actually leaving the link (not just moving to a child)
	if (fromLink && fromLink !== toLink) {
		lastHoverLink = null;
	}
}

// Post-process rendered content to normalize links
function normalizeLinks(containerEl: HTMLElement) {
	// Copy button styling
	const copyBtn = containerEl.querySelector(".copy-code-button") as HTMLElement | null;
	if (copyBtn) {
		copyBtn.className = "clickable-icon";
		copyBtn.setAttribute("aria-label", "Copy code");
	}

	// Normalize internal links
	for (const a of containerEl.querySelectorAll("a.internal-link")) {
		const link = a as HTMLAnchorElement;
		link.removeAttribute("target");
		link.removeAttribute("rel");
		link.style.cursor = "pointer";
	}

	// External links: open in new tab safely
	for (const a of containerEl.querySelectorAll("a:not(.internal-link)")) {
		const link = a as HTMLAnchorElement;
		link.target = "_blank";
		link.rel = "noopener";
	}
}

// Render markdown when content changes.
// Coalesced to one paint per animation frame. During streaming, `content` updates
// once per token (often 100-300/s); a naive re-render tears down and re-parses the
// entire accumulated message each time, forcing a full style/layout recalc per token
// that stalls the whole app for the length of the reply. Scheduling the render on
// requestAnimationFrame collapses a burst of token updates into a single re-parse per
// frame (~60Hz). The effect re-runs on every `content` change and the cleanup cancels
// the previous pending frame, so only the newest content is ever rendered — the final
// token is never dropped, and static (non-streaming) content just paints one frame later.
$effect(() => {
	if (!container) return;

	// Read every reactive dep synchronously here so the effect re-runs when any of
	// them change — including `enableMath`, which is only used later inside the
	// rAF-deferred render() and would otherwise not be tracked.
	const currentContent = content;
	const currentSourcePath = sourcePath;
	const currentEnableMath = enableMath;

	let frame: number | null = null;
	let disposed = false;

	// Async render function
	async function render() {
		if (disposed || !container) return;

		if (currentEnableMath) {
			await loadMathJax();
		}

		// `container` may have been unbound (component unmounted), or this render
		// superseded by a newer frame, while awaiting above. Re-check before touching
		// it — otherwise clearing `container` throws "Cannot read properties of null"
		// during rapid mount/unmount (e.g. subagent tool cards folding in/out).
		if (disposed || !container) return;

		container.empty();
		await MarkdownRenderer.render(plugin.app, currentContent ?? "", container, currentSourcePath, plugin);

		if (disposed || !container) return;
		normalizeLinks(container);
	}

	frame = requestAnimationFrame(() => {
		frame = null;
		render();
	});

	// Runs before the effect re-runs (content changed) and on unmount: drop the
	// pending frame and abort any in-flight render so we never render stale content
	// or touch an unbound container.
	return () => {
		disposed = true;
		if (frame !== null) cancelAnimationFrame(frame);
	};
});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_mouse_events_have_key_events -->
<div
  bind:this={container}
  class={className}
  onclick={handleClick}
  onmouseover={handleMouseOver}
  onmouseout={handleMouseOut}
></div>
