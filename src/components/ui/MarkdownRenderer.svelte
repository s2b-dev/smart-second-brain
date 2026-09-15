<script lang="ts">
import { Keymap, MarkdownRenderer, loadMathJax } from "obsidian";
import { onDestroy } from "svelte";
import { getPlugin } from "../../stores/state.svelte";
import { findSealableEnd } from "../../utils/streamingMarkdown";
import { openTagSearch } from "../../utils/tagSearch";
import { VIEW_TYPE_CHAT } from "../../views/chat/Chat";

interface Props {
	content: string;
	class?: string;
	enableMath?: boolean;
	/** Content is still being streamed: render incrementally (see below). */
	streaming?: boolean;
}

const { content, class: className = "", enableMath = true, streaming = false }: Props = $props();

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
	for (const copyBtn of containerEl.querySelectorAll(".copy-code-button")) {
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

// ---- Rendering ----------------------------------------------------------------
//
// Renders are coalesced to one per animation frame: during streaming `content`
// changes once per token (often 100-300/s), and rendering each change would force
// a style/layout pass per token. Renders are also serialised — a token arriving
// while a render is in flight marks it dirty and the newest content is rendered
// right after — so the DOM never interleaves two renders.
//
// While `streaming` is set the message is rendered in two parts (see
// `utils/streamingMarkdown.ts`): a sealed prefix whose nodes stay in the DOM
// untouched, and a live tail — the block still being written — that is the only
// part re-parsed each frame. Without this the whole accumulated reply was torn
// down and re-parsed every frame, O(length) per frame, which pinned the main
// thread for the duration of a long reply (#482). Outside streaming, and when the
// reply settles, the content is rendered as one document, so link-reference and
// footnote definitions resolve exactly as before.

let latest = { content: "", sourcePath: "", enableMath: true, streaming: false };
let frame: number | null = null;
let rendering = false;
let dirty = false;
let destroyed = false;
/** Prefix of `latest.content` whose DOM is final (streaming only). */
let sealedText = "";
/** Nodes belonging to the live tail; replaced on every render while streaming. */
let tailNodes: ChildNode[] = [];

$effect(() => {
	// Read every reactive dep here so the effect re-runs when any of them change;
	// the render itself runs later, off the tracked scope.
	latest = { content: content ?? "", sourcePath, enableMath, streaming };
	if (container) schedule();
});

onDestroy(() => {
	destroyed = true;
	if (frame !== null) cancelAnimationFrame(frame);
});

function schedule() {
	if (frame !== null) return;
	frame = requestAnimationFrame(() => {
		frame = null;
		void flush();
	});
}

async function flush() {
	if (rendering) {
		dirty = true;
		return;
	}
	rendering = true;
	try {
		do {
			dirty = false;
			await renderLatest();
		} while (dirty && !destroyed);
	} finally {
		rendering = false;
	}
}

async function renderLatest() {
	const { content: text, sourcePath: path, enableMath: math, streaming: live } = latest;
	if (!container) return;
	if (math) await loadMathJax();
	// `container` may have been unbound (component unmounted) while awaiting.
	if (destroyed || !container) return;

	if (!live) {
		resetDom();
		await appendSegment(text, path);
		return;
	}

	// Streaming: content normally extends what is already sealed. Anything else
	// (a reset at a tool-call boundary, an edit) starts over.
	if (!text.startsWith(sealedText)) resetDom();
	const remainder = text.slice(sealedText.length);
	const sealEnd = findSealableEnd(remainder);
	removeTail();
	if (sealEnd > 0) {
		const segment = remainder.slice(0, sealEnd);
		await appendSegment(segment, path);
		if (destroyed || !container) return;
		sealedText += segment;
	}
	tailNodes = await appendSegment(text.slice(sealedText.length), path);
}

function resetDom() {
	container?.empty();
	sealedText = "";
	tailNodes = [];
}

function removeTail() {
	for (const node of tailNodes) node.remove();
	tailNodes = [];
}

/**
 * Render `markdown` at the end of the container and return the nodes it produced.
 * The render happens inside a boxless staging element that is attached for its
 * duration — post-processors may measure layout — and is unwrapped afterwards so
 * the container stays flat: no wrapper element, so `:first-child`/`:last-child`
 * styling on the container keeps working across segment seams.
 */
async function appendSegment(markdown: string, path: string): Promise<ChildNode[]> {
	if (!markdown || !container) return [];
	const staging = container.createDiv({ attr: { style: "display: contents" } });
	await MarkdownRenderer.render(plugin.app, markdown, staging, path, plugin);
	if (destroyed || !container) {
		staging.remove();
		return [];
	}
	normalizeLinks(staging);
	// The renderer may tag the target element (e.g. `markdown-rendered`); carry that over.
	for (const cls of staging.classList) container.classList.add(cls);
	const nodes = [...staging.childNodes];
	staging.replaceWith(...nodes);
	return nodes;
}
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
