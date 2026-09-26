<script lang="ts">
import { QueryClientProvider } from "@tanstack/svelte-query";
import Input from "../../components/chat/Input.svelte";
import MessageContainer from "../../components/chat/MessageContainer.svelte";
import { getSessionRegistry } from "../../stores/chatStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import { icon } from "../../utils/utils";
import { isMobileUI } from "../../utils/platform";
import type { ThreadPathStore } from "./threadPathStore.svelte";

interface Props {
	threadPathStore: ThreadPathStore;
}

const { threadPathStore }: Props = $props();

const threadPath = $derived(threadPathStore.current);

const plugin = getPlugin();

const registry = getSessionRegistry();

let messageContainer = $state<ReturnType<typeof MessageContainer> | undefined>();
let input = $state<ReturnType<typeof Input> | undefined>();
let lastSessionId: string | null = null;
let isDragging = $state(false);
let dragMessage = $state("Drop files here");
let dragHasIssue = $state(false);

$effect(() => {
	const session = registry?.sessionFor(threadPath) ?? null;
	const sessionId = session?.id ?? null;
	if (!sessionId || sessionId === lastSessionId) return;

	// On mobile, autofocusing pops the keyboard, which is welcome for a brand
	// new chat (about to type) but unwelcome just from opening/switching to an
	// existing one (reading, not typing yet). Desktop has no such cost, so it
	// keeps focusing unconditionally as soon as the session id changes.
	//
	// A new chat has no messages yet; history for an existing thread loads
	// asynchronously, so `isLoadingSession` is still true on the first tick
	// for it — wait for that to settle rather than treating a not-yet-loaded
	// thread as empty. Only mark this session "handled" (lastSessionId) once
	// that decision is actually made, so the effect re-runs when loading
	// finishes instead of only firing on the still-loading first tick.
	if (isMobileUI() && registry?.isLoadingSession) return;

	lastSessionId = sessionId;
	if (isMobileUI() && (session?.messages.length ?? 0) > 0) return;

	input?.focusEditor();
});

function handleRootDragEnter(event: DragEvent) {
	input?.handleDragEnter(event);
}

function handleRootDragOver(event: DragEvent) {
	input?.handleDragOver(event);
}

function handleRootDragLeave(event: DragEvent) {
	input?.handleDragLeave(event);
}

async function handleRootDrop(event: DragEvent) {
	await input?.handleDrop(event);
}

// Route Alt+↑/↓ message-navigation hotkeys to the container from anywhere in
// the chat view. A native listener keeps chat-root a plain region (a11y).
function messageNavHotkeys(node: HTMLElement) {
	const onKeydown = (event: KeyboardEvent) => messageContainer?.handleNavKeydown(event);
	node.addEventListener("keydown", onKeydown);
	return {
		destroy() {
			node.removeEventListener("keydown", onKeydown);
		},
	};
}

// Re-parent the composer out of the leaf on mobile so it can be positioned
// against a box that does not go stale when the keyboard opens. See the style
// block for why this is necessary (`.workspace-leaf` sets `contain: strict`,
// which no `position`/`inset` can escape) and what it fixes.
//
// The composer keeps its own DOM identity — only its parent changes — so Svelte
// continues to own and update it normally.
function portalComposer(node: HTMLElement) {
	if (!isMobileUI() || typeof document === "undefined") return {};
	// `.workspace-split.mod-root` rather than `.app-container`: swiping a sidebar
	// drawer open slides the workspace by transforming this element, so hosting
	// the composer inside it means the composer inherits that motion natively.
	// (Mirroring the transform from a sibling was tried and trails by up to 68px
	// mid-swipe — a sampler can only read the transform after the frame is
	// already painted.) It is `position: relative`, `contain: none` and
	// `overflow: visible`, so it is a usable containing block; its own height
	// goes stale with the keyboard exactly like `.view-content`, but that no
	// longer matters because the composer is positioned off `100vh`.
	//
	// Exception: with "Open new chat in" set to a sidebar, the chat leaf lives in
	// a `.workspace-drawer` — a SIBLING of mod-root, painted over it. (Both phones
	// and tablets use drawers; `.mod-left-split`/`.mod-right-split` are the
	// desktop-only shape.) A composer portaled to mod-root then sits behind the
	// open drawer, or lands off-viewport entirely at the drawer's x-offset. Host
	// it in the drawer instead: the drawer is `position: fixed` at the full
	// viewport height, so the same 100vh-anchored positioning holds, and being a
	// descendant inherits the drawer's own slide transform exactly like mod-root's.
	//
	// Resolved lazily, not once at mount: this action runs as soon as `.chat-root`
	// exists, which can be BEFORE Obsidian has moved the leaf into the drawer (the
	// composer itself is awaited via MutationObserver below, so `portal()` often
	// runs a good deal later). Capturing the host up front therefore pinned
	// drawer-docked chats to mod-root — the tablet symptom was a composer sitting
	// at x=1366 on a 1366px-wide viewport, i.e. just off-screen.
	const resolveHost = () =>
		node.closest<HTMLElement>(".workspace-drawer") ??
		document.querySelector<HTMLElement>(".workspace-split.mod-root");
	if (!resolveHost()) return {};

	let composer: HTMLElement | null = null;
	let home: HTMLElement | null = null;
	let nextSibling: ChildNode | null = null;
	let ro: ResizeObserver | null = null;
	let leafObserver: MutationObserver | null = null;
	let classObserver: MutationObserver | null = null;
	let treeObserver: MutationObserver | null = null;

	// Horizontal placement and height come from wherever the leaf actually is
	// (main view, sidebar split, …), so measure rather than assume full width.
	//
	// `left` is measured RELATIVE TO `host`, not to the viewport. The composer is
	// a child of `host`, so it already inherits `host`'s transform — and opening a
	// sidebar drawer on mobile slides the workspace by transforming exactly that
	// element. Publishing a viewport-absolute `left` therefore applies the drawer
	// offset twice: once via the inherited transform, once via `left`. Measured
	// on-device with the left drawer open (`translateX(-338px)`): the composer's
	// own rect landed at `left: -664` — roughly double the -338 it should have
	// been — which is why it disappeared off-screen mid-swipe, and why the offset
	// stayed baked in after the drawer closed. Subtracting the host's own rect
	// cancels the transform out, so the published value is drawer-independent
	// (verified: `leafRect.left - hostRect.left === 0` with the drawer both open
	// and closed) and needs no re-publish on drawer motion at all.
	const publishGeometry = () => {
		if (!composer) return;
		const leaf = node.getBoundingClientRect();
		// The composer's ACTUAL parent, not a freshly resolved host: these two can
		// disagree while a re-host is pending, and `left` is only transform-neutral
		// when measured against the element the composer actually inherits from.
		const hostRect = (composer.parentElement ?? node).getBoundingClientRect();
		const height = composer.getBoundingClientRect().height;
		composer.style.setProperty("--s2b-composer-left", `${Math.round(leaf.left - hostRect.left)}px`);
		composer.style.setProperty("--s2b-composer-width", `${Math.round(leaf.width)}px`);
		composer.style.setProperty("--s2b-composer-height", `${Math.round(height)}px`);
		// Also on the view itself: the composer is no longer a descendant, so the
		// scroller cannot inherit this to reserve room for it.
		node.style.setProperty("--s2b-composer-height", `${Math.round(height)}px`);
		// The view's own top edge, so the message area can be sized against the
		// viewport instead of its stale parent (see `.chat-root` in the styles).
		// Measured while the keyboard is DOWN only: once it is up this element is
		// exactly the stale box we are working around, and re-reading it then
		// would bake the stale value in.
		if (!Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--keyboard-height"))) {
			node.style.setProperty("--s2b-view-top", `${Math.round(leaf.top)}px`);
			composer.style.setProperty("--s2b-view-top", `${Math.round(leaf.top)}px`);
		}
	};

	// Obsidian hides an inactive leaf with `display: none` rather than
	// unmounting it, so this Svelte action's own `destroy()` never runs when a
	// chat tab is merely backgrounded. Without this, the portaled composer stays
	// appended to `.workspace-split.mod-root`, visible and interactive, floating
	// over whichever view the user switches to — its buttons keep real geometry
	// (`overflow: visible` lets them spill outside the now-zeroed leaf box) and
	// silently intercept taps meant for the page underneath.
	//
	// Keyed off the leaf's own rendered state, NOT its `mod-active` class:
	// `mod-active` tracks FOCUS, and swiping a sidebar drawer open moves focus
	// to the sidebar leaf while the chat leaf stays perfectly visible
	// underneath. That made the composer vanish for the whole drawer gesture
	// and pop back only once it finished closing (traced on-device: `display`
	// flipped to `none` for ~400ms mid-swipe while `opacity`/`visibility`
	// stayed untouched). `display: none` is what Obsidian actually uses to
	// background a tab, so reading it distinguishes a real tab switch from a
	// drawer stealing focus — verified on-device: with the drawer closed the
	// leaf is `display: flex` at its full 402x874 box even when another leaf
	// holds `mod-active`.
	const syncActiveState = () => {
		if (!composer) return;
		const rendered = leafEl ? getComputedStyle(leafEl).display !== "none" : true;
		composer.style.display = rendered ? "" : "none";
	};

	const leafEl = node.closest<HTMLElement>(".workspace-leaf");

	// `<Input>`'s own template drives this element's `class` attribute, and
	// if it ever toggles a class reactively again (it used to, for the removed
	// fullscreen editor), Svelte replaces the whole attribute string on each
	// such re-render — silently
	// dropping `s2b-composer-portaled`, which was added imperatively above and
	// is invisible to Svelte's reactivity. Losing it mid-render (confirmed via
	// on-device collapse-from-fullscreen: the class vanished right after
	// `chat-input-fullscreen*` were removed) leaves the still-portaled composer
	// with no positioning rule at all, so it falls back to plain in-flow layout
	// inside `.workspace-split.mod-root` — a small, mispositioned box floating
	// over the real view instead of the docked composer bar. Re-add it whenever
	// Svelte's re-render strips it.
	const ensurePortaledClass = () => {
		if (composer && !composer.classList.contains("s2b-composer-portaled")) {
			composer.classList.add("s2b-composer-portaled");
		}
	};

	// Move the composer under whichever host currently owns the leaf. Called on
	// first portal and again whenever the leaf is relocated (docking a chat into
	// a drawer, or dragging it back out) — otherwise a chat that moves after mount
	// keeps a host it no longer belongs to and the composer strands off-screen.
	const rehost = () => {
		if (!composer) return;
		const currentHost = resolveHost();
		if (!currentHost || composer.parentElement === currentHost) return;
		currentHost.appendChild(composer);
		publishGeometry();
	};

	const portal = (found: HTMLElement) => {
		composer = found;
		home = found.parentElement;
		nextSibling = found.nextSibling;
		(resolveHost() ?? node).appendChild(found);
		// After the append, so the host-relative `left` is measured against the
		// element the composer now actually inherits its transform from.
		publishGeometry();
		found.classList.add("s2b-composer-portaled");
		// The composer grows and shrinks with its content (attachments,
		// multi-line drafts), and the leaf moves when splits resize — both
		// change the geometry the CSS above is anchored to.
		ro = new ResizeObserver(publishGeometry);
		ro.observe(found);
		ro.observe(node);
		if (leafEl) {
			syncActiveState();
			leafObserver = new MutationObserver(() => {
				syncActiveState();
				// The leaf may have been moved into (or out of) a drawer, which
				// changes which element should host the composer.
				rehost();
			});
			// `style` as well as `class`: `syncActiveState` reads the leaf's
			// computed `display`, which Obsidian can change either way.
			leafObserver.observe(leafEl, { attributes: true, attributeFilter: ["class", "style"] });
		}

		// Relocating a leaf is a DOM move, not an attribute change, so the observer
		// above never sees it. Watch the workspace subtree for structural changes
		// and re-evaluate the host; `rehost` is a no-op when nothing moved.
		const workspaceEl = document.querySelector<HTMLElement>(".workspace");
		if (workspaceEl) {
			treeObserver = new MutationObserver(rehost);
			treeObserver.observe(workspaceEl, { childList: true, subtree: true });
		}
		classObserver = new MutationObserver(ensurePortaledClass);
		classObserver.observe(found, { attributes: true, attributeFilter: ["class"] });
	};

	// `<Input>` is rendered by a child component, so it may not exist yet when
	// this action runs on the root. Wait for it rather than giving up.
	const existing = node.querySelector<HTMLElement>(".chat-input-container");
	const mo = new MutationObserver(() => {
		if (composer) return;
		const found = node.querySelector<HTMLElement>(".chat-input-container");
		if (found) {
			mo.disconnect();
			portal(found);
		}
	});
	if (existing) {
		portal(existing);
	} else {
		mo.observe(node, { childList: true, subtree: true });
	}

	return {
		destroy() {
			mo.disconnect();
			ro?.disconnect();
			leafObserver?.disconnect();
			classObserver?.disconnect();
			treeObserver?.disconnect();
			if (!composer) return;
			composer.style.display = "";
			composer.classList.remove("s2b-composer-portaled");
			for (const prop of [
				"--s2b-composer-left",
				"--s2b-composer-width",
				"--s2b-composer-height",
				"--s2b-view-top",
			]) {
				composer.style.removeProperty(prop);
			}
			node.style.removeProperty("--s2b-composer-height");
			node.style.removeProperty("--s2b-view-top");
			// Put it back so Svelte's own teardown finds it where it expects.
			home?.insertBefore(composer, nextSibling);
		},
	};
}
</script>

<QueryClientProvider client={plugin.queryClient}>
  <div
    class="chat-root relative h-full flex flex-col gap-0 overflow-hidden"
    data-testid="chat-root"
    role="region"
    ondragenter={handleRootDragEnter}
    ondragover={handleRootDragOver}
    ondragleave={handleRootDragLeave}
    ondrop={handleRootDrop}
    use:messageNavHotkeys
    use:portalComposer
  >
    {#if registry}
      <MessageContainer bind:this={messageContainer} {registry} {threadPath} />
      <Input
        bind:this={input}
        {registry}
        {threadPath}
        dropTargetMode="view"
        onDragStateChange={(state) => {
          isDragging = state.isDragging;
          dragMessage = state.dragMessage;
          dragHasIssue = state.dragHasIssue;
        }}
        onMessageSent={() => messageContainer?.scrollToLatestMessage()}
      />
    {:else}
      <div
        class="flex h-full items-center justify-center p-4 text-center text-sm text-[--text-muted]"
      >
        Chat session is not available yet. Reopen this view after plugin initialization completes.
      </div>
    {/if}

    {#if isDragging}
      <!-- One dashed frame around the whole pane, because the whole pane is the
           drop target. The dashed border is the conventional "this region
           accepts drops" signal, so it belongs on the region — previously it
           was wrapped around a small floating pill, which read as "drop onto
           this chicklet" and left the actual target unmarked. The label sits
           inside the frame and no longer carries a border of its own. -->
      <div
        class="chat-drop-overlay absolute inset-0 z-30 pointer-events-none flex items-center justify-center p-2 {dragHasIssue
          ? 'chat-drop-overlay-issue'
          : 'chat-drop-overlay-active'}"
      >
        <div class="chat-drop-frame flex items-center justify-center rounded-[16px]">
          <div
            class="chat-drop-overlay-panel flex items-center gap-3 rounded-2xl px-5 py-4 text-sm font-medium"
          >
            <div
              class="h-icon-s w-icon-s"
              style="--icon-size: var(--icon-s)"
              data-testid="chat-drop-overlay-icon"
              use:icon={dragHasIssue ? "alert-triangle" : "upload"}
            ></div>
            <span data-testid="chat-drop-overlay-message">{dragMessage}</span>
          </div>
        </div>
      </div>
    {/if}
  </div>
</QueryClientProvider>

<style>
  :global(.chat-root .scroll-container) {
    padding-top: 44px;
  }

  /* With the composer portaled out of the leaf it no longer takes up flow
     space, so the conversation would scroll underneath it. Shrink the
     scroller's own box by the composer's height (published by
     `portalComposer`) so it ends just above it.

     `height`, NOT `padding-bottom`: padding is part of the border box, so a
     padded scroller still *occupies* the full height and WebKit draws its
     scrollbar track down the whole thing — the bar visibly ran past the
     composer's top edge and down beside the input (confirmed on-device:
     scroller box 114→788 with the composer at 630→788, i.e. the bottom 158px
     of track sat behind the composer). Reducing the height moves the box's
     real bottom edge up, so the track ends where the content does.

     This also removes the need for the composer to paint an opaque
     background: nothing scrolls behind it any more. */
  :global(.is-mobile .chat-root .scroll-container) {
    /* `+ 24px`: run the content 24px PAST the composer's top edge, so it
       passes under the composer's own top padding band. That band carries a
       transparent→page-colour gradient (see `.chat-input-container` in
       Input.svelte) which needs real text underneath it to dissolve — ending
       the scroller exactly at the composer's top instead leaves the last line
       hard-cut against a bare slab of page colour, with nothing to fade. */
    height: calc(100% - var(--s2b-composer-height, 0px) + 24px);
  }

  /* Also matches the portaled composer, which is no longer a `.chat-root`
     child (see `portalComposer`); the mobile rule below resets `margin-top`. */
  :global(.chat-root > .chat-input-container),
  :global(.chat-input-container.s2b-composer-portaled) {
    margin-top: -12px;
    padding-top: 12px;
    z-index: 10;
  }

  .chat-root {
    --chat-bg: var(--background-primary);
  }

  /* The composer sizes itself against the chat pane's height (see
     `--s2b-chat-pane-height` in Input.svelte). On desktop it is an in-flow
     child of `.chat-root`, so the pane is a size container and `cqh` measures
     it directly. Mobile portals the composer out of the pane (see
     `portalComposer`), where `cqh` would fall back to the full viewport and
     ignore the keyboard — the portaled rule below restates the height with the
     pane's own formula instead. */
  :global(body:not(.is-mobile)) .chat-root {
    container-type: size;
  }

  :global(body:not(.is-mobile) .chat-root > .chat-input-container) {
    --s2b-chat-pane-height: 100cqh;
  }

  :global(.mod-left-split .chat-root),
  :global(.mod-right-split .chat-root) {
    --chat-bg: var(--background-secondary);
  }

  /* Mobile keyboard handling.

     The composer is moved out of the leaf and re-parented to the workspace
     root (see `portalComposer`), then positioned with core's own formula for
     `.mobile-toolbar`:

       top: calc(100vh - var(--keyboard-height) - var(--mobile-toolbar-height))

     Why re-parent at all: `--keyboard-height` flips to the real height in one
     frame, but `.app-container` — and therefore `.view-content` — only reflows
     to `max-height: calc(100vh - var(--keyboard-height))` ~420ms later. Any
     descendant of the leaf is pinned to that stale box for the whole gap.
     Measured on-device: the composer sat frozen at bottom 802, behind the
     keyboard, while core's toolbar glided 822 → 796 → … → 487, then teleported
     to 487 when the container finally caught up. That is the "composer
     vanishes, then jumps up".

     Escaping the leaf is not optional: `.workspace-leaf` sets `contain: strict`,
     which establishes a containing block AND clips, so no amount of
     `position`/`inset` on our side gets out. Core's toolbar has no such problem
     because it is a direct child of `.app-container`, whose nearest positioned
     ancestor is `body` — a box that never goes stale. Re-parenting puts the
     composer in exactly that situation.

     Verified on-device: composer bottom goes 822 → 487 in a single frame and
     holds there for the entire keyboard animation, with the toolbar arriving
     to meet it. No transition — the value is already correct on frame one, and
     animating on top of it is what made earlier attempts drift. */
  /* The message area has the same staleness problem as the composer did: it is
     an `inset:0` child of `.view-content`, so while the keyboard opens it keeps
     the pre-keyboard height for ~420ms and its contents (the recommendations
     block in an empty chat) visibly hang low before snapping up. It cannot be
     portaled — it scrolls with the conversation and belongs to the leaf — so
     instead size it against the viewport, which is correct on frame one.
     `--s2b-view-top` is published by `portalComposer` (the leaf's own top edge,
     sampled while the keyboard is down); the bottom edge matches the composer's
     so the two stay flush. */
  :global(.is-mobile) .chat-root {
    position: absolute;
    inset: 0;
    bottom: auto;
    padding-bottom: 0;
    height: calc(
      100vh - var(--s2b-view-top, 0px) -
        max(
          calc(var(--keyboard-height, 0px) + var(--mobile-toolbar-height, 52px)),
          calc(52px + env(safe-area-inset-bottom))
        )
    );
  }

  /* The portaled composer, positioned against `body` like core's toolbar.
     `--s2b-composer-*` are published by `portalComposer` from the geometry the
     composer had while still in the leaf, so it keeps the leaf's width and
     horizontal placement (it can be in a sidebar split, not just full width).

     The bottom edge differs by keyboard state, because a different core element
     owns that band each time: with the keyboard UP it is `.mobile-toolbar`
     (`--mobile-toolbar-height`), with it DOWN it is the floating
     `.mobile-navbar` (52px + the safe-area inset, landing us 2px above the
     navbar top — the same clearance this view had before the composer was
     portaled). `max()` picks whichever edge is higher without a conditional.

     No `z-index`: core's navbar and toolbar live outside our host with
     `z-index: auto`, so leaving this unstyled lets them paint on top where they
     belong. An explicit stacking value here is what made the composer cover
     them. */
  :global(.is-mobile .chat-input-container.s2b-composer-portaled) {
    position: absolute;
    /* Inset from the leaf's own edges (published as --s2b-composer-left/width,
       the leaf's true bounds) rather than the full viewport, so the composer
       keeps a margin instead of sitting flush against the screen edge — and
       still respects a sidebar split's actual width.

       Width is additionally capped at `--file-line-width` and centred inside the
       leaf, because absolute positioning drops the `mx-auto
       max-w-[--file-line-width]` the container carries in the normal flow. On a
       phone the leaf is narrower than that cap, so `min()` resolves to the
       inset width and nothing changes; on a tablet the cap wins and the
       composer stays aligned with the message column above it instead of
       stretching the full leaf. */
    --s2b-composer-inset-width: calc(var(--s2b-composer-width, 100%) - 32px);
    --s2b-composer-render-width: min(
      var(--s2b-composer-inset-width),
      var(--file-line-width)
    );
    width: var(--s2b-composer-render-width);
    left: calc(
      var(--s2b-composer-left, 0px) + 16px +
        (var(--s2b-composer-inset-width) - var(--s2b-composer-render-width)) / 2
    );
    /* The host stretches an unsized child to its full height (measured 874px),
       which would drag the `top` calc below with it. */
    height: auto;
    top: calc(
      100vh - var(--s2b-composer-height, 0px) -
        max(
          calc(var(--keyboard-height, 0px) + var(--mobile-toolbar-height, 52px)),
          calc(52px + env(safe-area-inset-bottom))
        )
    );
    margin-top: 0;
    z-index: auto;
    /* The same height `.chat-root` gets in the mobile rule above.
       `--s2b-view-top` is published on the composer too: it is no longer a
       descendant of `.chat-root`, so it can't inherit it from there. */
    --s2b-chat-pane-height: calc(
      100vh - var(--s2b-view-top, 0px) -
        max(
          calc(var(--keyboard-height, 0px) + var(--mobile-toolbar-height, 52px)),
          calc(52px + env(safe-area-inset-bottom))
        )
    );
  }

  /* Anchor the absolute chat-root to the leaf's content area. `:has` is supported
     on the iOS WebKit / modern Electron Obsidian runs on. */
  :global(.is-mobile .view-content:has(> .chat-root)) {
    position: relative;
  }

  .chat-root::after {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 32px;
    pointer-events: none;
    z-index: 25;
    background: linear-gradient(
        to bottom,
        color-mix(in srgb, var(--chat-bg) 60%, transparent) 0%,
        transparent 100%
      );
  }

  /* The frame IS the drop affordance: dashed border marking the boundary, plus
     a uniform wash across the interior so the whole enclosed area reads as one
     active region. This replaces the radial glow that used to sit at the top of
     the view (`.chat-root::before`, no longer triggered) — a gradient anchored
     to one edge suggested the target was up there rather than everywhere.
     16px radius matches the composer and message bubbles. */
  .chat-drop-frame {
    position: absolute;
    inset: 0;
    border: 2px dashed var(--s2b-drop-border);
    background: var(--s2b-drop-wash);
    backdrop-filter: blur(2px);
  }

  .chat-drop-overlay-active {
    --s2b-drop-border: color-mix(in srgb, var(--interactive-accent) 55%, transparent);
    --s2b-drop-wash: color-mix(in srgb, var(--interactive-accent) 5%, transparent);
    --s2b-drop-label-color: var(--text-accent);
    --s2b-drop-label-bg: color-mix(in srgb, var(--interactive-accent) 14%, var(--background-primary));
  }

  /* Same geometry as the active state, error palette — so nothing shifts or
     jumps if validity changes mid-drag; only the colours cross-fade. */
  .chat-drop-overlay-issue {
    --s2b-drop-border: color-mix(in srgb, var(--text-error) 45%, transparent);
    --s2b-drop-wash: color-mix(in srgb, var(--text-error) 5%, transparent);
    --s2b-drop-label-color: var(--text-error);
    --s2b-drop-label-bg: color-mix(in srgb, var(--background-modifier-error) 70%, var(--background-primary));
  }

  /* Label: no border of its own — the frame owns that. Keeps a solid fill so
     it stays legible over whatever conversation content is behind it. */
  .chat-drop-overlay-panel {
    color: var(--s2b-drop-label-color);
    background: var(--s2b-drop-label-bg);
  }

</style>
