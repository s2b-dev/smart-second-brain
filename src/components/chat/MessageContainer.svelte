<script lang="ts">
import { Menu, Notice } from "obsidian";
import { tick } from "svelte";
import { type SessionRegistry } from "../../stores/chatStore.svelte";
import {
	type AssistantMessage,
	AssistantState,
	type MessagePair,
	getMessagePairTimestamp,
} from "../../stores/chatTimeline";
import type { UUIDv7 } from "../../utils/uuid7Validator";
import { Logger } from "../../utils/logging";
import { isMobileUI } from "../../utils/platform";
import { longPress } from "../../utils/longPress";
import { getPlugin } from "../../stores/state.svelte";
import { thinkingProcessPref } from "../../stores/thinkingProcessPref.svelte";
import { getData } from "../../stores/dataStore.svelte";
import { DEFAULT_AGENT_ICON } from "../../types/plugin";
import { VIEW_TYPE_CHAT } from "../../views/chat/Chat";
import Button from "../ui/Button.svelte";
import Icon from "../ui/Icon.svelte";
import MarkdownRenderer from "../ui/MarkdownRenderer.svelte";
import BranchNavigator from "./BranchNavigator.svelte";
import CollapsibleUserBubble from "./CollapsibleUserBubble.svelte";
import UserAttachmentFiles from "./UserAttachmentFiles.svelte";
import UserAttachmentImages from "./UserAttachmentImages.svelte";
import ToolCallsSection from "./ToolCallsSection.svelte";
import ChatRecommendations from "./ChatRecommendations.svelte";
import { icon } from "../../utils/utils";

interface Props {
	registry: SessionRegistry;
	threadPath: string | null;
}

function linkPathForReference(path: string, viewType?: string, context?: string): string {
	if (viewType !== "pdf" || !context) return path;
	const match = context.match(/^p\.\s+([^/]+)\s*\/\s*/);
	if (!match) return path;
	const pageLabel = match[1]?.trim();
	if (!pageLabel || !/^\d+$/.test(pageLabel)) return path;
	return `${path}#page=${pageLabel}`;
}

const { registry, threadPath }: Props = $props();
const sourcePath = $derived(getPlugin().app.workspace.getActiveFile()?.path ?? "");

// This view's own session, pinned to its thread path. All actions target it
// directly — never a global active pointer.
const session = $derived(registry.sessionFor(threadPath));

const messages = $derived.by(() => {
	return session?.messages;
});

// Whether this session's chat model runs on this machine. Ollama and oMLX are the
// local templates (the same pair dataStore trusts with private data by default),
// and only they can spend the pre-first-token window loading weights into memory —
// which is what the streaming status says during it. Remote providers get the
// network wording instead.
const isLocalModel = $derived.by(() => {
	const data = getData();
	const providerId = data.getAgent(session?.selectedAgentId ?? "")?.chatModel?.provider;
	if (!providerId) return false;
	const templateId = data.getProviderTemplateId(providerId);
	return templateId === "ollama" || templateId === "omlx";
});

const onMobile = isMobileUI();

// Edit mode lives on the session (see ChatSession.beginEdit/cancelEdit), not
// here, so the composer and the message list both react to the same state
// without prop-drilling through Chat.svelte.
const editingMessageId = $derived(session?.editingPairId ?? null);

function startEdit(messagePair: MessagePair) {
	if (session?.isRunning) {
		new Notice("Wait for the current response to finish before editing");
		return;
	}
	session?.beginEdit(messagePair.id);
}

// Tapping the highlighted bubble again while editing it cancels, mirroring
// the composer's own cancel affordance — the message the user is already
// looking at doubles as the "never mind" target. Ignore link clicks so a
// wikilink/URL inside the message still navigates instead of just closing
// the editor (same guard CollapsibleUserBubble uses for its own expand/
// collapse tap).
function handleEditedBubbleClick(event: MouseEvent, messagePair: MessagePair) {
	if (editingMessageId !== messagePair.id) return;
	const target = event.target as HTMLElement;
	if (target.closest("a")) return;
	session?.cancelEdit();
}

async function regenerateResponse(messageId: UUIDv7) {
	try {
		await session?.regenerateResponse(messageId);
	} catch (error) {
		Logger.error("[MessageContainer] Regenerate failed:", error);
		new Notice(`Regenerate failed: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}

async function retryLastError(messageId: UUIDv7) {
	try {
		await session?.retryLastError(messageId);
	} catch (error) {
		Logger.error("[MessageContainer] Retry failed:", error);
		new Notice(`Retry failed: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}

async function handleBranchNavigate(checkpointId: string) {
	if (!threadPath) return;
	try {
		await registry.switchToBranch(threadPath, checkpointId);
	} catch (error) {
		Logger.error("[MessageContainer] Branch switch failed:", error);
		new Notice(`Branch switch failed: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}

function previewReferencedNote(evt: Event, path: string): void {
	const target = evt.currentTarget;
	if (!(target instanceof HTMLElement)) return;

	getPlugin().app.workspace.trigger("hover-link", {
		event: evt,
		source: VIEW_TYPE_CHAT,
		hoverParent: getPlugin(),
		targetEl: target,
		linktext: path,
		sourcePath,
	});
}

let scrollContainer: HTMLDivElement | undefined = $state();
const messageRefs = new Map<string, HTMLDivElement>();

// Leave breathing room above the anchored message so its top isn't hidden
// behind the container's top padding (Chat.svelte adds 44px) and fade mask.
const NAV_TOP_OFFSET = 48;

// Fast custom smooth-scroll — the native `behavior: "smooth"` easing is too
// slow for message navigation. Duration is short and capped regardless of
// distance so long jumps still feel snappy.
let scrollRafId: number | null = null;

function animateScrollTo(top: number) {
	if (!scrollContainer) return;
	const el = scrollContainer;

	// Cancel any in-flight animation so a new target fully supersedes the old
	// one — otherwise overlapping RAF loops fight over scrollTop and jitter.
	if (scrollRafId !== null) {
		cancelAnimationFrame(scrollRafId);
		scrollRafId = null;
	}

	const start = el.scrollTop;
	const max = el.scrollHeight - el.clientHeight;
	const target = Math.max(0, Math.min(top, max));
	const delta = target - start;
	if (Math.abs(delta) < 1) return;

	const duration = Math.min(260, 120 + Math.abs(delta) * 0.15);
	let startTime: number | null = null;

	const step = (now: number) => {
		if (startTime === null) startTime = now;
		const t = Math.min(1, (now - startTime) / duration);
		// easeOutCubic
		const eased = 1 - (1 - t) ** 3;
		el.scrollTop = start + delta * eased;
		if (t < 1) {
			scrollRafId = window.requestAnimationFrame(step);
		} else {
			scrollRafId = null;
		}
	};
	scrollRafId = window.requestAnimationFrame(step);
}

// Scroll a specific user message to the top of the container.
function scrollUserMessageToTop(id: UUIDv7) {
	const messageElement = messageRefs.get(`${id}-user`);
	if (!messageElement || !scrollContainer) return;

	const containerTop = scrollContainer.getBoundingClientRect().top;
	const messageTop = messageElement.getBoundingClientRect().top;
	const currentScroll = scrollContainer.scrollTop;

	// Place the message near the top of the container, minus a small offset so
	// it isn't clipped by the fade mask.
	const targetScroll = currentScroll + (messageTop - containerTop) - NAV_TOP_OFFSET;

	animateScrollTo(targetScroll);
}

export async function scrollToLatestMessage() {
	await tick();
	if (messages && messages.length > 0) {
		scrollUserMessageToTop(messages[messages.length - 1].id);
	}
}

// Anchor the message near the top of the view as soon as it enters edit
// mode, so the user can see what they're changing without hunting for it in
// the thread. Reuses `scrollUserMessageToTop` (the same function message
// navigation uses) rather than scrolling relative to the composer: on mobile
// the composer is portaled and repositioned live off the on-screen keyboard
// (see Chat.svelte), which has no "finished opening" event to wait for and
// made a composer-relative target impossible to land reliably. The
// scroller's top edge has no such dependency — it's anchored to the view's
// own top on both platforms — so this works the same way in both places.
let lastAnchoredEditId: UUIDv7 | null = null;
$effect(() => {
	if (editingMessageId === null) {
		lastAnchoredEditId = null;
		return;
	}
	if (editingMessageId === lastAnchoredEditId) return;
	lastAnchoredEditId = editingMessageId;
	const id = editingMessageId;
	void tick().then(() => scrollUserMessageToTop(id));
});

// --- Message navigation (jump between user messages) ---

// Ids of navigable user messages, in document order (skips summary markers).
const userMessageIds = $derived.by<UUIDv7[]>(() => {
	if (!messages) return [];
	return messages.filter((m) => m.transcriptEvent?.type !== "summarization_marker").map((m) => m.id);
});

// Index of the user message currently anchored near the top of the viewport.
// Recomputed on scroll so prev/next move relative to what the user is reading.
let activeUserIndex = $state(0);

// Whether the up/down controls should be shown. Driven by scroll position so
// they reflect not just the turn index but where we are within a long reply.
let prevAvailable = $state(false);
let nextAvailable = $state(false);

// The nav arrows appear while scrolling (and on hover, via CSS). After scrolling
// stops they linger briefly, then fade out.
let isScrolling = $state(false);
let scrollIdleTimer: number | undefined;

function handleScroll() {
	recomputeActiveUserIndex();
	isScrolling = true;
	if (scrollIdleTimer) window.clearTimeout(scrollIdleTimer);
	scrollIdleTimer = window.setTimeout(() => {
		isScrolling = false;
	}, 900);
}

function recomputeActiveUserIndex() {
	if (!scrollContainer || userMessageIds.length === 0) return;
	const containerTop = scrollContainer.getBoundingClientRect().top;
	// Anchor at the same offset navigation scrolls to, so the message that lands
	// at the top counts as active rather than the one just above it.
	const anchor = containerTop + NAV_TOP_OFFSET + 4;

	let candidate = 0;
	for (let i = 0; i < userMessageIds.length; i++) {
		const el = messageRefs.get(`${userMessageIds[i]}-user`);
		if (!el) continue;
		if (el.getBoundingClientRect().top <= anchor) {
			candidate = i;
		} else {
			break;
		}
	}
	activeUserIndex = candidate;

	// "Up" is available if there's an earlier turn, OR we've scrolled down inside
	// the current turn's reply (first "up" snaps back to its user message).
	prevAvailable = candidate > 0 || !isUserMessageAtTop(candidate);
	nextAvailable = candidate < userMessageIds.length - 1;
}

const canNavigatePrev = $derived(prevAvailable);
const canNavigateNext = $derived(nextAvailable);

function navigateToUserMessage(index: number) {
	if (index < 0 || index >= userMessageIds.length) return;
	activeUserIndex = index;
	scrollUserMessageToTop(userMessageIds[index]);
}

// True when the given user message is already anchored near the top of the
// viewport (i.e. we're at the very start of its turn, not deep inside its reply).
function isUserMessageAtTop(index: number): boolean {
	const el = messageRefs.get(`${userMessageIds[index]}-user`);
	if (!el || !scrollContainer) return false;
	const containerTop = scrollContainer.getBoundingClientRect().top;
	const offset = el.getBoundingClientRect().top - containerTop;
	// Within a small band around the resting position counts as "at top".
	return Math.abs(offset - NAV_TOP_OFFSET) <= 24;
}

function navigatePrevMessage() {
	// If we've scrolled down into the current turn's (long) reply, the first
	// "up" press should bring us back to that turn's own user message rather
	// than skipping to the previous turn.
	if (!isUserMessageAtTop(activeUserIndex)) {
		scrollUserMessageToTop(userMessageIds[activeUserIndex]);
		return;
	}
	navigateToUserMessage(activeUserIndex - 1);
}

function navigateNextMessage() {
	navigateToUserMessage(activeUserIndex + 1);
}

// Touch devices have no Alt key, so the keyboard hint in these tooltips
// describes a shortcut the user can't press. Drop it on mobile.
const prevMessageTooltip = onMobile ? "Previous message" : "Previous message (Alt+↑)";
const nextMessageTooltip = onMobile ? "Next message" : "Next message (Alt+↓)";

function scrollToTop() {
	// "Jump to top" targets the first user message, symmetric with jump-to-bottom.
	if (userMessageIds.length === 0) {
		animateScrollTo(0);
		return;
	}
	navigateToUserMessage(0);
}

function scrollToBottom() {
	// "Jump to bottom" targets the last user message (consistent with the rest
	// of the navigation), not the raw end of the last assistant reply.
	if (userMessageIds.length === 0) return;
	navigateToUserMessage(userMessageIds.length - 1);
}

export function handleNavKeydown(event: KeyboardEvent) {
	// Alt+Up / Alt+Down jump between user messages. Ignore when a modifier
	// combo we don't own is pressed, or while typing in an editable field.
	if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
	const target = event.target as HTMLElement | null;
	if (target?.isContentEditable || target?.closest("input, textarea, .cm-editor")) return;

	if (event.key === "ArrowUp") {
		event.preventDefault();
		navigatePrevMessage();
	} else if (event.key === "ArrowDown") {
		event.preventDefault();
		navigateNextMessage();
	}
}

// Svelte action to register message refs
function registerMessageRef(node: HTMLDivElement, id: string) {
	messageRefs.set(id, node);
	return {
		destroy() {
			messageRefs.delete(id);
		},
	};
}

function renderAssitantAnswer(assistantAnswer: AssistantMessage) {
	if (assistantAnswer.state === AssistantState.cancelled) {
		return "> [!Warning] stopped by user";
	}
	if (assistantAnswer.state === AssistantState.error) {
		const detail = assistantAnswer.errorCode?.trim();
		if (detail) {
			// Indent continuation lines so multi-line messages stay inside the callout.
			const body = detail.replace(/\n/g, "\n> ");
			return `> [!Error] Something went wrong\n> ${body}`;
		}
		return "> [!Error] Something went wrong\n> The model request failed.";
	}
	return assistantAnswer.content;
}

function getOpenDataviewFenceStart(content: string): number | null {
	const fenceRegex = /```(\w+)?/g;
	let inFence = false;
	let fenceLang = "";
	let fenceStart = -1;
	let match = fenceRegex.exec(content);

	while (match !== null) {
		if (!inFence) {
			inFence = true;
			fenceLang = (match[1] ?? "").toLowerCase();
			fenceStart = match.index;
		} else {
			inFence = false;
			fenceLang = "";
			fenceStart = -1;
		}
		match = fenceRegex.exec(content);
	}

	if (inFence && (fenceLang === "dataview" || fenceLang === "dataviewjs")) {
		return fenceStart;
	}
	return null;
}

function getRenderableAssistantContent(assistantAnswer: AssistantMessage) {
	const content = renderAssitantAnswer(assistantAnswer) ?? "";
	const isStreaming = assistantAnswer.state === AssistantState.streaming;
	if (!isStreaming || !assistantAnswer.content) {
		return { content, showLoading: false, renderContent: true };
	}

	const openFenceStart = getOpenDataviewFenceStart(content);
	if (openFenceStart === null) {
		return { content, showLoading: false, renderContent: true };
	}

	const visibleContent = content.slice(0, openFenceStart);
	const hasRenderableContent = visibleContent.trim().length > 0;

	return {
		content: visibleContent,
		showLoading: true,
		renderContent: hasRenderableContent,
	};
}

async function copyToClipboard(content: string) {
	await navigator.clipboard.writeText(content);
	new Notice("Copied to Clipboard");
}

/**
 * Long-press menu for a user message (touch only).
 *
 * On mobile the per-message Edit/Copy buttons and the timestamp are hidden —
 * four turns' worth of always-on chrome crowds a phone screen, and forcing the
 * hover-reveal buttons to be permanently visible on touch (the `@media (hover:
 * none)` rule) traded reachability for clutter. A long press surfaces the same
 * actions on demand, matching the gesture already used for graph nodes.
 *
 * The timestamp rides along as a disabled first item so hiding it from the
 * bubble doesn't lose the information.
 */
function openUserMessageMenu(pair: MessagePair, x: number, y: number) {
	const menu = new Menu();
	const timestamp = formatMessageTimestamp(pair);

	if (timestamp) {
		menu.addItem((item) => item.setTitle(timestamp).setIcon("clock").setDisabled(true));
		menu.addSeparator();
	}

	menu.addItem((item) =>
		item
			.setTitle("Edit message")
			.setIcon("edit")
			.onClick(() => startEdit(pair)),
	);

	menu.addItem((item) =>
		item
			.setTitle("Copy message")
			.setIcon("copy")
			.onClick(() => copyToClipboard(pair.userMessage.content)),
	);

	menu.showAtPosition({ x, y });
}

function formatMessageTimestamp(pair: MessagePair): string | null {
	const date = getMessagePairTimestamp(pair);
	if (!date) return null;
	return date.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function getGenerationLabel(
	messagePair: MessagePair,
): { agent: string | null; agentIcon: string | null; model: string | null } | null {
	const generation = messagePair.generation;
	if (!generation) return null;

	const agent = generation.agentName ?? generation.agentId ?? null;
	const model =
		generation.provider && generation.model
			? `${generation.provider}/${generation.model}`
			: (generation.model ?? generation.provider ?? null);

	if (!agent && !model) return null;

	// Resolve the agent's own icon from its config (falling back to the default
	// agent icon), so the footer matches how agents render in the picker.
	const agentIcon = agent
		? (generation.agentId ? getData().getAgent(generation.agentId)?.icon?.trim() : "") || DEFAULT_AGENT_ICON
		: null;

	return { agent, agentIcon, model };
}

/** Identity of the agent+model that produced a turn, for change detection. */
function generationSignature(pair: MessagePair): string | null {
	const label = getGenerationLabel(pair);
	if (!label) return null;
	return `${label.agent ?? ""}|${label.model ?? ""}`;
}

/**
 * Whether to render the agent/model label under a response on mobile.
 *
 * The label is identical on every turn of a normal thread, so repeating it is
 * pure noise on a phone. Show it only when it actually carries information:
 * the first response in the thread (establishes which agent/model is answering)
 * and any turn where the agent or model differs from the previous response —
 * which is exactly the "wait, that answer came from a different model" case.
 * Desktop keeps the label on every turn; there's room for it there.
 */
function shouldShowGenerationLabel(index: number): boolean {
	if (!onMobile) return true;

	const list = messages;
	const pair = list?.[index];
	if (!pair) return false;

	const current = generationSignature(pair);
	if (!current) return false;

	for (let i = index - 1; i >= 0; i--) {
		const earlier = list[i];
		if (!earlier) continue;
		const previous = generationSignature(earlier);
		// Skip turns that carry no generation of their own (e.g. summarization
		// markers) rather than treating them as a change.
		if (previous === null) continue;
		return previous !== current;
	}

	// No earlier response to compare against — this is the thread's first.
	return true;
}

// ── Timeline collapse state ──────────────────────────────────────────────
// NOTHING collapses or expands automatically — the user drives the collapse state and
// whatever it is while a turn streams simply carries through unchanged after it settles.
// Two controls feed it:
//
//  1. GLOBAL session preference (`thinkingProcessPref.streamingExpanded`, session-scoped,
//     default expanded). This is the default a turn shows when the user hasn't toggled it
//     individually. Toggling the chevron on a turn that is still STREAMING (its per-turn
//     key isn't stable yet) flips this global pref, so every other untouched turn follows.
//  2. TRANSIENT per-turn override (`perTurnOverride`, keyed by the turn's stable
//     `regenerateFromCheckpointId`, only settable once the turn has settled). Toggling a
//     settled turn opens/closes just that turn. Not persisted; never touches the pref.
//
// The effective collapsed value is a pure function of these two — no $effect, no phase-
// dependent default, no auto-collapse. A run left expanded settles expanded; a run
// collapsed mid-stream settles collapsed. Both fall back to the same global pref, so the
// value the user sees while streaming is exactly the value after settle: no seam.
const perTurnOverride: Record<string, boolean> = $state({});

// Stable key for a settled turn's transient override. `regenerateFromCheckpointId` is the
// checkpoint where this human message is last — turn-unique and stable across the settle
// rebuild and future runs (unlike `id`, which is a fresh UUID every rebuild). Error/
// cancelled turns that never checkpointed have no id here; they also have no thinking
// process worth persisting, so `id` is a fine fallback key for them.
function overrideKey(pair: MessagePair): string {
	return pair.regenerateFromCheckpointId ?? pair.id;
}

// Whether this pair has a STABLE per-turn key yet. `regenerateFromCheckpointId` is only
// stable once the turn has settled onto a real checkpoint; before that it's either absent
// (fresh send) or a temporary `optimistic-…` id (regenerate/edit) that the settle rebuild
// replaces. A per-turn override written under a temporary key orphans at settle → the turn
// falls back to the pref and appears to "auto-expand". So the override branch is only taken
// when the key is stable; otherwise the click flips the global pref instead.
function hasStableKey(pair: MessagePair): boolean {
	const id = pair.regenerateFromCheckpointId;
	return !!id && !id.startsWith("optimistic-");
}

// The effective collapsed state a turn's process renders with. A per-turn override wins,
// but ONLY when read under a stable key (a temporary streaming key can't have a meaningful
// override — those clicks go to the pref); otherwise the turn follows the global pref.
function isCollapsed(pair: MessagePair): boolean {
	if (hasStableKey(pair)) {
		const override = perTurnOverride[overrideKey(pair)];
		if (override !== undefined) return override;
	}
	return !thinkingProcessPref.streamingExpanded;
}

// Chevron toggle. A per-turn override is only meaningful once the turn has a STABLE key
// (settled onto a real checkpoint). Until then — while streaming, or in the brief window
// where state has flipped to success but the checkpoint id hasn't been assigned — flip the
// global pref instead, so the choice can't be stranded under a temporary key and lost at
// the settle rebuild (the intermittent "collapsed turn auto-expands" bug).
function toggleCollapsed(pair: MessagePair): void {
	if (!hasStableKey(pair)) {
		thinkingProcessPref.toggleStreamingExpanded();
		return;
	}
	perTurnOverride[overrideKey(pair)] = !isCollapsed(pair);
}

// Recompute the active message + nav availability from the DOM after the thread
// or message list changes (switching chats, new replies). This is a legitimate
// DOM-measurement side effect, not state synchronization: `recomputeActiveUserIndex`
// derives everything from live element positions, so a stale `activeUserIndex`
// self-heals here and on the next scroll rather than needing an imperative clamp.
$effect(() => {
	void threadPath;
	void userMessageIds.length;
	tick().then(() => recomputeActiveUserIndex());
});

$effect(() => {
	return () => {
		if (scrollIdleTimer) window.clearTimeout(scrollIdleTimer);
		if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
	};
});
</script>

<div class="message-area relative flex-1 min-h-0 z-20">
  <!-- Scrollable messages area -->
  <div
    bind:this={scrollContainer}
    class="scroll-container h-full overflow-y-auto overflow-x-clip px-2 pt-4 pb-8"
    tabindex="-1"
    onscroll={handleScroll}
  >
    <!-- `min-h-full` when there are messages, NOT `h-full`: a long conversation
         must be allowed to grow past the scroller's content-box height, or the
         mobile `padding-bottom` (which reserves the portaled composer's height)
         gets laid out relative to a collapsed box and the last message scrolls
         under the composer. But with zero messages there's nothing to scroll
         under anything, and `min-h-full`'s effective height doesn't reliably
         resolve to 100% through this ancestor chain (percentage heights need a
         parent with a *definite* height, and `min-height: 100%` doesn't count as
         one) — so the empty-state's own centering `h-full` collapses to its
         content height instead of the pane's, and "Start a new conversation"
         renders near the top instead of vertically centred. `h-full` here (only
         for the empty/loading branches) is a definite height and doesn't have
         that gap. -->
    <div
      class="w-full max-w-[--file-line-width] mx-auto"
      class:min-h-full={messages && messages.length > 0}
      class:h-full={!messages || messages.length === 0}
    >
      {#if registry.isLoadingSession}
        <!-- Loading skeleton -->
        <div
          class="flex flex-col gap-4 pt-2 px-1 animate-pulse"
          data-testid="chat-loading-skeleton"
        >
          <div class="flex justify-end">
            <div class="h-9 w-48 rounded-2xl bg-[--background-modifier-border]"></div>
          </div>
          <div class="flex flex-col gap-2">
            <div class="h-3 w-full rounded bg-[--background-modifier-border]"></div>
            <div class="h-3 w-4/5 rounded bg-[--background-modifier-border]"></div>
            <div class="h-3 w-2/3 rounded bg-[--background-modifier-border]"></div>
          </div>
          <div class="flex justify-end">
            <div class="h-9 w-64 rounded-2xl bg-[--background-modifier-border]"></div>
          </div>
          <div class="flex flex-col gap-2">
            <div class="h-3 w-full rounded bg-[--background-modifier-border]"></div>
            <div class="h-3 w-3/4 rounded bg-[--background-modifier-border]"></div>
          </div>
        </div>
      {:else if !messages || messages.length === 0}
        <!-- Empty state. `items-stretch`, not `items-center`: ChatRecommendations
             is a single left-aligned column that centres itself via its own
             max-width + auto margins, so centring here would collapse it to its
             content width and re-ragged the left edge. -->
        <div class="flex flex-col items-stretch justify-center h-full">
          <ChatRecommendations {registry} {threadPath} />
        </div>
      {:else}
        {#each messages as messagePair, index (messagePair.stableKey ?? messagePair.id)}
          {#if messagePair.transcriptEvent?.type === "summarization_marker"}
            <div
              class="summary-marker-row flex justify-center my-4"
              class:mb-12={index === messages.length - 1}
            >
              <div
                class="summary-marker inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs"
                title={messagePair.transcriptEvent.source === "manual_summarization"
                  ? "Manual conversation compaction"
                  : "Automatic conversation compaction"}
              >
                <span class="summary-marker-icon" use:icon={"archive"} style="--icon-size: 12px"
                ></span>
                <span>{messagePair.transcriptEvent.label}</span>
              </div>
            </div>
          {:else}
            {@const isBeingEdited = editingMessageId === messagePair.id}
            <!-- User Message -->
            <div
              use:registerMessageRef={messagePair.id + "-user"}
              class="group mr-2 flex flex-col items-end gap-2 mb-2"
            >
              {#if messagePair.userMessage.attachments?.some( (a) => a.mimeType.startsWith("image/"), )}
                  <UserAttachmentImages
                    attachments={messagePair.userMessage.attachments.filter((a) =>
                      a.mimeType.startsWith("image/"),
                    )}
                  />
                {/if}
                {#if messagePair.userMessage.attachments?.some((a) => !a.mimeType.startsWith("image/"))}
                  <UserAttachmentFiles
                    attachments={messagePair.userMessage.attachments.filter(
                      (a) => !a.mimeType.startsWith("image/"),
                    )}
                  />
                {/if}
                {#if messagePair.userMessage.visibleNotes?.length || messagePair.userMessage.selection || messagePair.userMessage.graphNotes?.length}
                  <div class="visible-notes-history flex flex-row flex-wrap gap-1.5 justify-end">
                    {#if messagePair.userMessage.visibleNotes?.length}
                      {#each messagePair.userMessage.visibleNotes as note (note.path)}
                        {@const noteLinkPath = linkPathForReference(
                          note.path,
                          note.viewType,
                          note.context,
                        )}
                        <button
                          type="button"
                          class="history-note-chip s2b-pill s2b-pill--history"
                          title={noteLinkPath}
                          onmouseover={(evt) => previewReferencedNote(evt, noteLinkPath)}
                          onfocus={(evt) => previewReferencedNote(evt, noteLinkPath)}
                        >
                          <span class="chip-icon" use:icon={note.icon} style="--icon-size: 12px"
                          ></span>
                          <span
                            >{note.basename}{#if note.context}<span class="chip-context">
                                · {note.context}</span
                              >{/if}</span
                          >
                        </button>
                      {/each}
                    {/if}
                    {#if messagePair.userMessage.selection}
                      {@const selection = messagePair.userMessage.selection}
                      <button
                        type="button"
                        class="history-note-chip history-selection-chip s2b-pill s2b-pill--history"
                        title="{selection.path}\n\n{selection.text.slice(0, 200)}"
                        onmouseover={(evt) => previewReferencedNote(evt, selection.path)}
                        onfocus={(evt) => previewReferencedNote(evt, selection.path)}
                      >
                        <span class="chip-icon" use:icon={selection.icon} style="--icon-size: 12px"
                        ></span>
                        <span
                          >{selection.basename}<span class="chip-context">
                            · "{selection.text.replace(/\n/g, " ").slice(0, 40)}{selection.text
                              .length > 40
                              ? "…"
                              : ""}"</span
                          ></span
                        >
                      </button>
                    {/if}
                    {#if messagePair.userMessage.graphNotes?.length}
                      {#each messagePair.userMessage.graphNotes as gNote (gNote.path)}
                        <button
                          type="button"
                          class="history-note-chip history-graph-chip s2b-pill s2b-pill--history"
                          title={gNote.path}
                          onmouseover={(evt) => previewReferencedNote(evt, gNote.path)}
                          onfocus={(evt) => previewReferencedNote(evt, gNote.path)}
                        >
                          <span class="chip-icon" use:icon={"git-fork"} style="--icon-size: 12px"
                          ></span>
                          <span>{gNote.basename}</span>
                        </button>
                      {/each}
                    {/if}
                  </div>
                {/if}
                <!-- The wrapper (not the bubble component) carries the gesture so
                     CollapsibleUserBubble keeps its own tap-to-expand contract;
                     the action swallows the synthesised click after a press.
                     While editing, a click here (after the bubble's own
                     expand/collapse handler runs first, since it's the inner
                     element) cancels the edit — see handleEditedBubbleClick. -->
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="flex flex-col items-end w-full s2b-user-press-target"
                  use:longPress={{
                    enabled: onMobile && !isBeingEdited,
                    onLongPress: (x, y) => openUserMessageMenu(messagePair, x, y),
                  }}
                  onclick={(e) => handleEditedBubbleClick(e, messagePair)}
                >
                  <CollapsibleUserBubble
                    content={messagePair.userMessage.content}
                    attachments={messagePair.userMessage.attachments}
                    class="max-w-[80%] rounded-[16px] px-4 py-2 {isBeingEdited
                      ? 's2b-user-bubble-editing'
                      : 'bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)]'}"
                  />
                </div>

              <!-- User message actions and branch navigator.
                   On mobile these live in the long-press menu instead (see
                   `openUserMessageMenu`), so the row is dropped entirely —
                   except the branch navigator, which is stateful (‹1/2›) rather
                   than an action and has no other affordance. On desktop the
                   row stays mounted even while editing (only the Edit/Copy
                   buttons and timestamp are suppressed) — removing the whole
                   row collapses its height and shifts the assistant reply
                   below it. -->
              <div class="flex flex-row items-center gap-2">
                {#if !(onMobile && !messagePair.userBranchInfo)}
                  <div
                    class="message-footer flex flex-row items-center gap-3 opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 pointer-events-none group-hover:pointer-events-auto transition-all duration-200 ease-out"
                  >
                    {#if !onMobile && !isBeingEdited && formatMessageTimestamp(messagePair)}
                      <span class="message-timestamp">{formatMessageTimestamp(messagePair)}</span>
                    {/if}
                    <div class="footer-actions flex flex-row items-center gap-1.5">
                      {#if messagePair.userBranchInfo}
                        <BranchNavigator
                          branchInfo={messagePair.userBranchInfo}
                          onNavigate={handleBranchNavigate}
                        />
                      {/if}
                      {#if !onMobile && !isBeingEdited}
                        <Button
                          iconId="edit"
                          ariaLabel="Edit message"
                          tooltip="Edit message"
                          onClick={() => startEdit(messagePair)}
                        />
                        <Button
                          iconId="copy"
                          ariaLabel="Copy message"
                          tooltip="Copy message"
                          onClick={() => copyToClipboard(messagePair.userMessage.content)}
                        />
                      {/if}
                    </div>
                  </div>
                {/if}
              </div>
            </div>

            <!-- Assistant Message -->
            <div
              class:min-h-[95%]={index === messages.length - 1}
              class:pb-12={index === messages.length - 1}
            >
              <div class="group flex flex-col px-2 gap-3 mb-2 w-full">
                {#if messagePair.assistantMessage.toolCalls?.length || (messagePair.assistantMessage.assistantTimeline?.length ?? 0) > 0 || messagePair.assistantMessage.state === AssistantState.idle || messagePair.assistantMessage.state === AssistantState.streaming}
                  <!-- Tools + Answer integrated in timeline (or processing dot).
                     Keep ToolCallsSection mounted during all streaming/idle states so that
                     the component never unmounts mid-stream, preventing the jarring flash
                     where preamble content appears as plain text before the timeline builds. -->
                  {@const renderInfo = getRenderableAssistantContent(messagePair.assistantMessage)}
                  <ToolCallsSection
                    assistantTimeline={messagePair.assistantMessage.assistantTimeline}
                    collapsed={isCollapsed(messagePair)}
                    answerContent={renderInfo.renderContent && renderInfo.content
                      ? renderInfo.content
                      : undefined}
                    contentAiMessageId={messagePair.assistantMessage.contentAiMessageId}
                    isStreaming={messagePair.assistantMessage.state === AssistantState.streaming}
                    thinkingDurationMs={messagePair.assistantMessage.thinkingDurationMs}
                    runStartedAtMs={messagePair.assistantMessage.runStartedAtMs}
                    summarizingHistory={index === messages.length - 1 &&
                      !!session?.summarizingHistory}
                    {isLocalModel}
                    ontoggle={() => toggleCollapsed(messagePair)}
                  />
                {:else}
                  <!-- Content Section: only reached for completed messages with no tool calls / timeline -->
                  {#if messagePair.assistantMessage.content || messagePair.assistantMessage.state === AssistantState.cancelled || messagePair.assistantMessage.state === AssistantState.error}
                    {@const renderInfo = getRenderableAssistantContent(
                      messagePair.assistantMessage,
                    )}
                    {#if renderInfo.renderContent}
                      <MarkdownRenderer
                        content={renderInfo.content}
                        class="message-text markdown-preview-view leading-[1.5] !p-0 !w-full !max-w-full !m-0 [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_code]:bg-code-background [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:font-[--font-monospace] [&_code]:text-[0.9em] [&_pre]:bg-code-background [&_pre]:p-3 [&_pre]:rounded [&_pre]:overflow-x-auto [&_pre]:my-2 [&_pre]:text-[0.85em] [&_pre]:relative [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[1em] [&_pre_.clickable-icon]:absolute [&_pre_.clickable-icon]:top-1.5 [&_pre_.clickable-icon]:right-1.5 [&_pre_.clickable-icon]:opacity-0 [&_pre:hover_.clickable-icon]:opacity-100"
                      />
                    {/if}
                  {/if}
                {/if}

                {#if messagePair.assistantMessage.state === AssistantState.error}
                  <div class="flex flex-row items-center">
                    <Button
                      iconId="refresh-cw"
                      buttonText="Retry"
                      ariaLabel="Retry this request"
                      tooltip="Re-run the failed request"
                      onClick={() => retryLastError(messagePair.id)}
                    />
                  </div>
                {/if}

                <!-- Assistant message actions and branch navigator.
                     Skipped for error pairs: the dedicated Retry button above is
                     the only relevant action, and Copy/Regenerate would act on an
                     empty, non-existent response. -->
                {#if !(messagePair.assistantMessage.state === AssistantState.streaming) && messagePair.assistantMessage.state !== AssistantState.error}
                {@const genLabel = shouldShowGenerationLabel(index) ? getGenerationLabel(messagePair) : null}
                {@const timestamp = onMobile ? null : formatMessageTimestamp(messagePair)}
                <div
                  class="message-footer message-footer-assistant flex flex-row items-center gap-3 flex-nowrap opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 pointer-events-none group-hover:pointer-events-auto transition-all duration-200 ease-out"
                >
                  <div class="footer-actions flex flex-row items-center gap-1.5">
                    {#if messagePair.assistantBranchInfo}
                      <BranchNavigator
                        branchInfo={messagePair.assistantBranchInfo}
                        onNavigate={handleBranchNavigate}
                      />
                    {/if}
                    <Button
                      iconId="refresh-cw"
                      ariaLabel="Regenerate response"
                      tooltip="Regenerate response"
                      onClick={() => regenerateResponse(messagePair.id)}
                    />
                    <Button
                      iconId="copy"
                      ariaLabel="Copy response"
                      tooltip="Copy response"
                      onClick={() => copyToClipboard(messagePair.assistantMessage.content)}
                    />
                  </div>

                  {#if genLabel || timestamp}
                    <div class="footer-meta flex flex-row items-center gap-2 min-w-0">
                      {#if genLabel}
                        <span
                          class="generation-label inline-flex items-center gap-1 min-w-0"
                          title={[genLabel.agent, genLabel.model].filter(Boolean).join(" · ")}
                        >
                          {#if genLabel.agent}
                            {#if genLabel.agentIcon}
                              <span class="generation-agent-icon" aria-hidden="true">
                                <Icon name={genLabel.agentIcon} size="xs" />
                              </span>
                            {/if}
                            <span class="generation-agent truncate">{genLabel.agent}</span>
                          {/if}
                          {#if genLabel.agent && genLabel.model}
                            <span class="generation-sep" aria-hidden="true">·</span>
                          {/if}
                          {#if genLabel.model}
                            <span class="generation-model truncate">{genLabel.model}</span>
                          {/if}
                        </span>
                      {/if}
                      {#if genLabel && timestamp}
                        <span class="footer-dot" aria-hidden="true"></span>
                      {/if}
                      {#if timestamp}
                        <span class="message-timestamp">{timestamp}</span>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/if}
              </div>

            </div>
          {/if}
        {/each}
      {/if}
    </div>
  </div>

  {#if userMessageIds.length > 1 && !onMobile}
    <!-- Message navigation controls. The overlay mirrors the content column's
         max-width so the cluster hugs the right edge of the messages when a wide
         gutter opens up, while staying near the scrollbar at narrower widths.
         Desktop only: this is a one-message-at-a-time jump/scroll shortcut
         cluster mirroring Alt+↑/↓, which has no mobile equivalent to shortcut
         and is redundant with plain touch scrolling — one less floating
         overlay competing for space on a small screen. -->
    <div class="message-nav-overlay">
      <div class="message-nav" class:message-nav-active={isScrolling} data-testid="message-nav">
        <div class="message-nav-slot" class:message-nav-hidden={!canNavigatePrev}>
          <Button
            iconId="chevrons-up"
            iconSize="s"
            tooltip="Jump to top"
            dataTestId="message-nav-top"
            onClick={scrollToTop}
          />
        </div>
        <div class="message-nav-slot" class:message-nav-hidden={!canNavigatePrev}>
          <Button
            iconId="chevron-up"
            iconSize="s"
            tooltip={prevMessageTooltip}
            dataTestId="message-nav-prev"
            onClick={navigatePrevMessage}
          />
        </div>
        <div class="message-nav-slot" class:message-nav-hidden={!canNavigateNext}>
          <Button
            iconId="chevron-down"
            iconSize="s"
            tooltip={nextMessageTooltip}
            dataTestId="message-nav-next"
            onClick={navigateNextMessage}
          />
        </div>
        <div class="message-nav-slot" class:message-nav-hidden={!canNavigateNext}>
          <Button
            iconId="chevrons-down"
            iconSize="s"
            tooltip="Jump to bottom"
            dataTestId="message-nav-bottom"
            onClick={scrollToBottom}
          />
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  /* Highlights the bubble anchored above the composer while it's being
     edited. `:global` because CollapsibleUserBubble renders its own root
     element from the `class` prop, outside this component's style scope.
     `cursor: pointer` signals the tap-to-cancel affordance even when the
     message is short (CollapsibleUserBubble's own cursor only turns on for
     truncated/expandable messages, which is a different concern). */
  :global(.s2b-user-bubble-editing) {
    background: color-mix(in srgb, var(--color-accent) 32%, transparent);
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
    cursor: pointer;
  }

  .history-note-chip {
    --s2b-pill-bg: color-mix(in srgb, var(--interactive-accent) 5%, var(--background-secondary));
    --s2b-pill-border: color-mix(
      in srgb,
      var(--interactive-accent) 18%,
      var(--background-modifier-border)
    );
    --s2b-pill-color: var(--text-muted);
  }

  .history-note-chip .chip-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .history-note-chip .chip-context {
    opacity: 0.7;
  }

  .history-selection-chip {
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .history-graph-chip {
    --s2b-pill-border: color-mix(
      in srgb,
      var(--color-accent) 24%,
      var(--background-modifier-border)
    );
  }

  .scroll-container {
    /* Enable native elastic/rubber-band scrolling on macOS/iOS */
    -webkit-overflow-scrolling: touch;
    /* Allow the container to have its own scroll bounce */
    overscroll-behavior: contain;
    mask-image: linear-gradient(to bottom, transparent 0%, black 24px, black calc(100% - 24px), transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 24px, black calc(100% - 24px), transparent 100%);
  }

  .summary-marker {
    color: var(--text-muted);
    background: color-mix(in srgb, var(--background-secondary) 80%, transparent);
    border: 1px solid color-mix(in srgb, var(--background-modifier-border) 85%, transparent);
  }

  .summary-marker-icon {
    display: inline-flex;
    align-items: center;
  }

  /* Assistant footer: a quiet row of controls + generation metadata. Actions
     sit left in muted color and warm to normal on hover; metadata reads as a
     single subdued, consistently-sized group so it never competes with the
     message content above it. */
  .message-footer {
    min-height: 22px;
    font-size: 11px;
    color: var(--text-faint);
  }

  /* Everything below is scoped to `.message-footer-assistant`. The user
     message reuses `.message-footer` but lays out in the OPPOSITE order
     (timestamp then actions, right-aligned) and carries no metadata group,
     so the sizing rules here actively break it: pinning its actions with
     nothing else able to yield pushes the buttons off the right edge. */
  .message-footer-assistant {
    /* Query container for the metadata's progressive collapse (see the
       `@container` rules below). As in the composer, the constraint is the
       width of the CHAT PANE, not the viewport: a sidebar can be dragged
       wide and a narrow window's main view is just as cramped as a sidebar,
       so only querying an element in the actual column tracks it. */
    container-type: inline-size;
    container-name: chat-message-footer;
  }

  /* The assistant footer is `nowrap`: it must stay a single line at every
     width. It previously wrapped, which dropped the agent/model group onto
     its own row and made the footer grow taller than the message it
     annotates. With nowrap the overflow has to go somewhere, so pin the
     controls and let ONLY the metadata shrink — otherwise the browser is
     free to squeeze the icon buttons and deform the touch targets. */
  .message-footer-assistant .footer-actions {
    flex-shrink: 0;
  }

  .footer-meta {
    color: var(--text-faint);
    overflow: hidden;
    flex-shrink: 1;
    min-width: 0;
  }

  /* Progressive collapse of the footer metadata as the chat pane narrows.
     Without this, everything stays on one line and merely truncates, which
     produced unreadable stubs ("S2B Ag…", "openai/gemma-4-26b-a4b-i…") that
     identify neither the agent nor the model. Shed whole items instead, in
     priority order (least identifying first):

       1. <400px — drop the timestamp. It's the only item that says nothing
          about WHO answered, and it's already hidden on mobile for this
          reason. Dropping it hands its width to the labels.
       2. <300px — drop the model. The agent name + its user-chosen icon
          still identify the responder; a truncated provider/model string
          does not.
       3. <220px — drop the metadata entirely, leaving the action buttons.
          Below this the labels can't survive at any useful length, and the
          controls are the part you actually click.

     Every shed item remains in the group's `title` tooltip, so the full
     agent · model text stays reachable on hover at any width. */
  @container chat-message-footer (max-width: 400px) {
    .message-footer-assistant .message-timestamp,
    .message-footer-assistant .footer-dot {
      display: none;
    }
  }

  @container chat-message-footer (max-width: 300px) {
    .message-footer-assistant .generation-model,
    .message-footer-assistant .generation-sep {
      display: none;
    }
  }

  @container chat-message-footer (max-width: 220px) {
    .message-footer-assistant .footer-meta {
      display: none;
    }
  }

  .generation-label {
    color: var(--text-muted);
    line-height: 1.15;
  }

  /* The agent is the more identifying of the two labels and is far shorter,
     so let the model absorb the truncation first: the agent only shrinks
     once the model has already collapsed to nothing. Otherwise flexbox
     splits the deficit between them and clips BOTH into stubs, which is
     exactly the "S2B Ag… · openai/gemma-4-26b-a4b-i…" case. */
  .generation-agent {
    font-weight: 500;
    flex-shrink: 0;
    max-width: 100%;
  }

  .generation-agent-icon {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--text-muted);
  }

  .generation-sep {
    color: var(--text-faint);
    flex-shrink: 0;
  }

  .generation-model {
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 1;
    min-width: 0;
  }

  /* Small dot separating the model label from the timestamp. */
  .footer-dot {
    width: 2px;
    height: 2px;
    border-radius: 999px;
    background: var(--text-faint);
    flex-shrink: 0;
    opacity: 0.6;
  }

  .message-timestamp {
    color: var(--text-faint);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .message-nav-overlay {
    position: absolute;
    inset: 0;
    /* Full-area so the gutter math below resolves against the whole width. */
    pointer-events: none;
    z-index: 30;
  }

  .message-nav {
    position: absolute;
    bottom: 12px;
    /* Sit a fixed distance out from the content column's right edge, into the
       gutter — a constant offset regardless of pane width, so on very wide panes
       the arrows stay near the content instead of drifting to the middle of a
       huge gutter. `--gutter` is the space to the right of the column; `--out` is
       how far past the content edge to sit. Clamped so at narrow widths (small
       gutter) the arrows rest flush at the content edge, aligned with the input. */
    --gutter: max(0px, (100% - var(--file-line-width)) / 2);
    --out: 16px;
    --cluster: 20px;
    right: clamp(2px, calc(var(--gutter) - var(--out)), var(--gutter));
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 0;
    width: var(--cluster);
    opacity: 0;
    transition: opacity 160ms ease;
    /* Container stays hoverable even when the arrows are faded out, so moving
       into the corner reveals them. Individual buttons gate interaction via
       their own visibility. */
    pointer-events: auto;
  }

  /* Show while scrolling, when hovering the cluster, or when a nav button has
     focus. Standalone arrows — no container chrome. */
  .message-nav-active,
  .message-nav:hover,
  .message-nav:focus-within {
    opacity: 1;
  }

  /* Fixed slots keep the cluster's height stable so a button never shifts into
     a neighbour's position when the opposite direction is unavailable. */
  .message-nav-slot {
    display: flex;
    align-items: center;
    justify-content: center;
    transition: opacity 120ms ease;
  }

  .message-nav-hidden {
    visibility: hidden;
    pointer-events: none;
  }

  /* While faded out the cluster is still hoverable (to reveal it), but its
     buttons shouldn't register clicks. */
  .message-nav:not(.message-nav-active):not(:hover):not(:focus-within) :global(button) {
    pointer-events: none;
  }

  .message-nav :global(button) {
    color: var(--text-muted);
    /* Override Obsidian's .clickable-icon defaults (padding, min-width, hover
       box-shadow/background) so the arrows are a tight, chrome-free icon box.
       The scoped `.message-nav` ancestor plus the element (0,2,1) already
       out-specifies core's `.clickable-icon` / `.is-mobile .clickable-icon`
       (0,2,0), and leaves the mobile touch-target rule in styles.css
       (`body.is-mobile .message-nav button`) able to win on specificity. */
    background: transparent;
    box-shadow: none;
    width: var(--icon-s);
    height: var(--icon-s);
    min-width: 0;
    padding: 2px;
    box-sizing: content-box;
    border-radius: 4px;
  }

  .message-nav :global(button:hover) {
    color: var(--text-normal);
    background: transparent;
    box-shadow: none;
  }
</style>
