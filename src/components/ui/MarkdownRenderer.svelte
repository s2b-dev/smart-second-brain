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

// Render markdown when content changes
$effect(() => {
	if (!container) return;

	const currentContent = content;
	const currentSourcePath = sourcePath;

	// Async render function
	async function render() {
		if (!container) return;

		if (enableMath) {
			await loadMathJax();
		}

		// `container` may have been unbound (component unmounted) while awaiting
		// above. Re-check before touching it — otherwise clearing `container`
		// throws "Cannot read properties of null" during rapid mount/unmount
		// (e.g. subagent tool cards folding in/out during streaming).
		if (!container) return;

		container.empty();
		await MarkdownRenderer.render(plugin.app, currentContent ?? "", container, currentSourcePath, plugin);

		if (!container) return;
		normalizeLinks(container);
	}

	render();
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
