<script lang="ts">
import { Notice, Platform, TFile, normalizePath } from "obsidian";
import { selectChatModelAction, showActionNotice } from "../../utils/actionNotice";
import { onDestroy, onMount, untrack } from "svelte";
import { useAvailableModels } from "../../hooks/useAvailableModels.svelte";
import { EmbeddableMarkdownEditor } from "../../lib/editor";
import { type SessionRegistry } from "../../stores/chatStore.svelte";
import { MessageState } from "../../stores/chatTimeline";
import { getPlugin } from "../../stores/state.svelte";
import { icon } from "../../utils/utils";
import { buildUsageEstimate, estimateContextUsageBreakdown } from "../../utils/tokenEstimator";
import type { ChatAttachment } from "../../types/shared";
import type { VisibleNote, VisibleNoteRef } from "../../hooks/useVisibleNotes.svelte";
import type { SelectionRef } from "../../hooks/useSelection.svelte";
import type { GraphNoteRef } from "../../stores/chatTimeline";
import { mimeFromExtension } from "../../utils/attachments";
import { extractObsidianDraggedPaths, hasObsidianFileDrag } from "../../utils/obsidianDrag";
import { getData } from "../../stores/dataStore.svelte";
import AgentPopover from "./AgentPopover.svelte";
import ModelSelectButton from "./ModelSelectButton.svelte";
import PendingChangesBar from "./PendingChangesBar.svelte";
import EditingMessageBar from "./EditingMessageBar.svelte";
import ContextTray from "./ContextTray.svelte";
import ContextUsageCircle from "./ContextUsageCircle.svelte";
import AttachPopover from "./AttachPopover.svelte";
import { SearchModal } from "../modal/SearchModal";
import { isMobileUI } from "../../utils/platform";
import Button from "../ui/Button.svelte";
interface Props {
	registry: SessionRegistry;
	threadPath: string | null;
	onFocusChange?: (focused: boolean) => void;
	onMessageSent?: () => void;
	onDragStateChange?: (state: DragOverlayState) => void;
	dropTargetMode?: "input" | "view";
}

type DragOverlayState = {
	isDragging: boolean;
	dragMessage: string;
	dragHasIssue: boolean;
};

const acceptedFileTypes =
	".txt, .md, .csv, .json, .png, .jpg, .jpeg, .gif, .webp, .pdf, image/png, image/jpeg, image/gif, image/webp, application/pdf, text/plain, text/markdown, text/csv";

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB per file
const MAX_TOTAL_ATTACHMENTS_BYTES = 25 * 1024 * 1024; // 25 MB per message
const FULLSCREEN_TRANSITION_MS = 220;

const {
	registry,
	threadPath,
	onFocusChange,
	onMessageSent,
	onDragStateChange,
	dropTargetMode = "input",
}: Props = $props();

// Pinned to this tab's own thread — never follows a global pointer.
const session = $derived(registry.sessionFor(threadPath));
const editingPairId = $derived(session?.editingPairId ?? null);
const isEditing = $derived(editingPairId !== null);

let editorContainer: HTMLDivElement | undefined = $state();
let attachmentInputEl: HTMLInputElement | undefined = $state();
/** Send shortcut hint for the send button tooltip (platform-aware). */
const sendShortcut = Platform.isMacOS ? "⌘↵" : "Ctrl+↵";
let markdownEditor: EmbeddableMarkdownEditor | undefined = $state();
let inputValue = $state("");

let attachments: ChatAttachment[] = $state([]);
let attachmentSizes: Map<string, number> = $state(new Map());
/** Tracks attachment files created as temp copies (safe to delete if unsent/removed). */
let managedAttachmentPaths: Set<string> = $state(new Set());
/** Object URLs for image previews (cleaned up on destroy) */
let previewUrls: Map<string, string> = $state(new Map());
/** Tracks files currently being saved to vault */
let savingFiles = $state(false);
/** Drag-and-drop state */
let isDragging = $state(false);
let dragCounter = 0;
let dragMessage = $state("Drop files here");
let dragHasIssue = $state(false);
let isFullscreen = $state(false);
// On mobile there's no keyboard shortcut at all — Enter is always a newline
// there (see the `onEnter` handler below) and the send button is the only
// way to submit, so there's nothing to hint. Desktop: Enter sends when
// collapsed; when expanded, Enter is a newline and Mod+Enter sends.
const sendShortcutHint = $derived(isMobileUI() ? "" : isFullscreen ? sendShortcut : "↵");
let isFullscreenVisible = $state(false);
let fullscreenNoTransition = $state(false);
let fullscreenTransitioning = false;
let fullscreenPlaceholderHeight = $state(0);
let containerEl: HTMLDivElement | undefined = $state();
let contextTrayRef = $state<ReturnType<typeof ContextTray> | undefined>(undefined);
// Read the tray's context outputs reactively through the instance. They're
// getter functions over `$derived` state in ContextTray, so reading them inside
// these `$derived`s tracks their dependencies across the component boundary.
const activeVisibleNotes = $derived(contextTrayRef?.getActiveVisibleNotes() ?? []);
const activeSelection = $derived(contextTrayRef?.getActiveSelection());
const activeGraphNotes = $derived(contextTrayRef?.getActiveGraphNotes() ?? []);
let assembledSystemPrompt = $state("");
let assembledPromptRequestVersion = 0;

const sendButtonStyle = $derived.by(() => {
	const baseColor = "var(--text-accent)";
	const hoverColor = "color-mix(in srgb, var(--text-accent) 84%, black 16%)";
	const disabledColor = "color-mix(in srgb, var(--text-accent) 68%, var(--background-primary) 32%)";

	// Only custom properties go inline. Sizing and colour live in the
	// `.chat-input-container button.send-message-button` rules below — an inline
	// `width`/`background` would beat every stylesheet rule, including the mobile
	// touch-target sizes, which is what used to force `!important` everywhere.
	return [
		"--s2b-button-icon-size: var(--icon-xs)",
		`--send-button-bg: ${baseColor}`,
		`--send-button-bg-hover: ${hoverColor}`,
		`--send-button-bg-disabled: ${disabledColor}`,
	].join("; ");
});

const DEFAULT_DRAG_MESSAGE = "Drop files here";

const ACCEPTED_EXTENSIONS = new Set(["txt", "md", "csv", "json", "png", "jpg", "jpeg", "gif", "webp", "pdf"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

const MIME_EXTENSION_MAP: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"application/pdf": "pdf",
	"text/plain": "txt",
	"text/markdown": "md",
	"text/csv": "csv",
	"application/json": "json",
};

const SUPPORTED_DRAG_MIME_PREFIXES = ["image/"];
const SUPPORTED_DRAG_MIMES = new Set([
	"application/pdf",
	"text/plain",
	"text/markdown",
	"text/csv",
	"application/json",
]);

const models = useAvailableModels();

// The agent THIS tab runs, resolved session-first exactly as ModelSelectButton and
// ChatRecommendations do. The global fallback keeps this always-defined for the
// display/estimate reads below.
const selectedAgent = $derived(
	(session?.selectedAgentId ? getData().getAgent(session.selectedAgentId) : undefined) ??
		getData().getSelectedAgent(),
);

// Write target for the "Switch model" notice, which must NOT inherit the fallback
// above. A session pinned to a since-deleted agent (deleteAgent doesn't repoint live
// sessions) would otherwise resolve to the global agent and save the model there,
// leaving this tab on the dead agent. Passing the session's id through even when it
// no longer resolves is deliberate: selectChatModelAction reports "that agent no
// longer exists" for an unresolvable id, whereas omitting it would re-enable the
// global fallback — the very thing being avoided.
const selectedAgentWriteTarget = $derived(session?.selectedAgentId ?? selectedAgent.id);

const selectedChatModel = $derived.by(() => {
	return selectedAgent.chatModel;
});

const selectedAgentPromptSignature = $derived.by(() => {
	return JSON.stringify({
		agentId: selectedAgent.id,
		toolsConfig: selectedAgent.toolsConfig,
		skills: selectedAgent.skills,
	});
});

const selectedModelSupportsVision = $derived.by(() => {
	const supportsVision = selectedChatModel?.modelConfig?.supportsVision;
	return supportsVision;
});

const contextBreakdown = $derived.by(() => {
	return estimateContextUsageBreakdown(session?.getActiveCheckpointMessages() ?? [], inputValue, {
		systemPrompt: assembledSystemPrompt,
		pendingAttachmentsCount: attachments.length,
		pendingVisibleNotesCount: activeVisibleNotes.length,
		hasPendingSelection: Boolean(activeSelection),
		pendingGraphNotesCount: activeGraphNotes.length,
	});
});

const contextUsage = $derived.by(() => {
	return buildUsageEstimate(contextBreakdown.totalTokens, selectedChatModel?.modelConfig?.contextWindow);
});

// No model on the agent means no provider either — `chatModel` carries both, and
// it's the same value ModelSelectButton renders as "Select model". Sending in that
// state fails inside the agent with a generic error, so gate the composer instead.
const hasChatModel = $derived(Boolean(selectedChatModel));
const hasContentToSend = $derived(inputValue.trim().length > 0 || attachments.length > 0);
const canSendMessage = $derived(hasContentToSend && hasChatModel);
const canSummarizeNow = $derived.by(() => {
	return Boolean(session && session.messageState === MessageState.idle && session.messages.length > 0);
});
// Only the composer's OWN drag state tints the composer. In `view` mode the
// whole pane is the drop target and Chat.svelte draws one dashed frame around
// it — the composer sits inside that frame, so tinting it too painted a second,
// competing target for a drop that behaves identically either way. (It also put
// a solid accent slab where the composer is deliberately a flat, bordered
// surface.) The frame communicates the target; the composer stays itself.
const showDragActive = $derived(dropTargetMode === "input" && isDragging);

$effect(() => {
	onDragStateChange?.({
		isDragging,
		dragMessage,
		dragHasIssue,
	});
});

export function focusEditor() {
	window.requestAnimationFrame(() => {
		markdownEditor?.focus();
	});
}

onMount(() => {
	// Initialize the markdown editor once the container is ready
	if (editorContainer) {
		initializeEditor();
	}
	if (isMobileUI() && editorContainer) {
		editorContainer.addEventListener("touchend", handleMobileTapFocus);
	}
});

// Consume any pending input queued from elsewhere (e.g. graph "Send to Chat")
$effect(() => {
	if (registry.pendingSubmitThreadPath && registry.pendingSubmitThreadPath !== threadPath) return;
	if (registry.pendingInput && markdownEditor) {
		const text = registry.pendingInput;
		registry.pendingInput = null;
		// Mirror the value into inputValue synchronously so canSendMessage/auto-submit
		// reflect it (setValue does not fire the editor onChange). Defer the editor
		// write to the next frame so CodeMirror's DOM is laid out before the
		// transaction dispatches — otherwise decoration plugins can throw on a
		// stale position ("No tile at position N").
		inputValue = text;
		window.requestAnimationFrame(() => {
			// If auto-submit already sent and cleared the input this tick, don't
			// resurrect the text into the cleared editor — that makes a sent
			// message look like it's still sitting unsent in the input.
			if (inputValue !== text) return;
			markdownEditor?.setValue(text);
			markdownEditor?.focus();
		});
	}
});

// The composer draft in progress when an edit started, restored verbatim if
// the edit is cancelled. Lives here (not on the session) because this
// component is the only thing that holds `inputValue`/the CodeMirror instance.
let stashedDraft: string | null = null;

/** Attachment paths the edit seeded into the tray (the edited message's own
 * attachments, minus any the user already had attached). Tracked so a cancel
 * can remove exactly these and leave the user's own attachments alone. */
let seededEditPaths = new Set<string>();

/** Invalidates an in-flight `seedEditAttachments` pass. Seeding awaits vault
 * reads (image previews), so the edit can end — save, cancel, or a new edit —
 * while the loop is suspended; without this the resumed loop would inject the
 * abandoned edit's remaining attachments into a tray that was already cleared,
 * and they'd ride along into a later, unrelated message. Bumped wherever the
 * seeded state is reset, checked after every await. Same last-started-wins
 * idiom as `assembledPromptRequestVersion` above. */
let seedEditToken = 0;

/** Seed the edited message's attachments into the composer tray so they are
 * visible and removable during the edit — previously they rode along
 * invisibly, and anything the user attached during the edit was silently
 * dropped from the save. Seeded chips are not "managed" (removing one never
 * deletes the underlying vault file). Image previews load best-effort. */
async function seedEditAttachments(restored: ChatAttachment[]) {
	const token = ++seedEditToken;
	const plugin = getPlugin();
	for (const att of restored) {
		if (token !== seedEditToken) return; // the edit ended mid-seed — stop
		if (attachments.some((a) => a.vaultPath === att.vaultPath)) continue;
		const file = plugin.app.vault.getAbstractFileByPath(att.vaultPath);
		if (!(file instanceof TFile)) {
			new Notice(
				`Attachment "${att.name}" no longer exists in the vault — it won't be part of the edited message.`,
			);
			continue;
		}
		attachments.push({ name: att.name, mimeType: att.mimeType, vaultPath: att.vaultPath });
		attachmentSizes.set(att.vaultPath, file.stat.size);
		attachmentSizes = new Map(attachmentSizes);
		seededEditPaths.add(att.vaultPath);
		if (att.mimeType.startsWith("image/")) {
			try {
				const buffer = await plugin.app.vault.readBinary(file);
				// Re-check before publishing: the URL would leak (nothing left to
				// revoke it) and the map write would resurrect a removed chip's
				// preview if the edit ended during the read.
				if (token !== seedEditToken) return;
				previewUrls.set(att.vaultPath, URL.createObjectURL(new Blob([buffer], { type: att.mimeType })));
				previewUrls = new Map(previewUrls);
			} catch {
				// preview only — the chip still renders without it
			}
		}
	}
}

// Seed the composer with the target message's content when an edit starts.
// Mirrors the `pendingInput` pattern above: write `inputValue` synchronously
// so `canSendMessage` reflects it immediately, defer the CodeMirror write to
// the next frame so its DOM is laid out before the transaction dispatches.
//
// The `editingPairId → null` transition is ALSO handled here (not only in
// cancelActiveEdit): an edit can end from outside the composer — tapping the
// highlighted bubble calls `session.cancelEdit()` directly, and a branch
// switch can drop the edited pair. Restoring in the effect means every
// cancel path puts the stashed draft back and clears the seeded attachment
// chips; a successful saveEdit clears the stash first, so this no-ops there.
let lastSeededEditId: string | null = null;

/** Unwind one edit's seeding: stop any in-flight attachment seeding, put the
 * pre-edit draft back, and remove the chips the edit seeded (the user's own
 * attachments stay). Shared by the `editingPairId → null` cleanup and the
 * direct A→B edit switch below — the two paths must stay identical, or
 * whichever one drifts leaks the previous edit's text/attachments into
 * whatever the composer does next. */
function restorePreEditComposerState() {
	seedEditToken++;
	if (stashedDraft !== null) {
		const draft = stashedDraft;
		stashedDraft = null;
		inputValue = draft;
		markdownEditor?.setValue(draft);
	}
	for (const path of seededEditPaths) {
		removeAttachmentByPath(path);
	}
	seededEditPaths = new Set();
}

$effect(() => {
	if (editingPairId === null) {
		if (lastSeededEditId !== null) {
			lastSeededEditId = null;
			// Untracked: the restore reads/writes composer state that must not
			// become a dependency of this effect (it only reacts to the edit target).
			untrack(() => restorePreEditComposerState());
		}
		return;
	}
	if (editingPairId === lastSeededEditId) return;
	const pair = session?.getEditingPair();
	if (!pair) {
		session?.cancelEdit();
		return;
	}
	// Switching straight from editing one message to another never passes
	// through null, so unwind the previous edit here first — otherwise its
	// seeded attachments stay in the tray and get saved onto the new target,
	// and its message text (stashed below as the "draft") would later be
	// restored as if the user had typed it.
	if (lastSeededEditId !== null) {
		untrack(() => restorePreEditComposerState());
	}
	lastSeededEditId = editingPairId;
	stashedDraft = inputValue;
	const text = pair.userMessage.content;
	inputValue = text;
	// Untracked: seeding reads/writes the attachment state, which must not
	// become a dependency of this effect (it only reacts to the edit target).
	untrack(() => void seedEditAttachments(session?.getEditAttachments(pair.id) ?? []));
	window.requestAnimationFrame(() => {
		markdownEditor?.setValue(text);
		markdownEditor?.focus();
	});
});

$effect(() => {
	if (registry.pendingSubmitThreadPath && registry.pendingSubmitThreadPath !== threadPath) return;
	if (!registry.pendingAttachmentPaths || registry.pendingAttachmentPaths.length === 0) {
		return;
	}

	const paths = [...registry.pendingAttachmentPaths];
	registry.pendingAttachmentPaths = null;
	// Note-only ask (no auto-submit): the target is satisfied once the notes are
	// attached, so release it here. With an auto-submit pending, that effect
	// clears the target instead.
	if (!registry.pendingAutoSubmit && registry.pendingSubmitThreadPath === threadPath) {
		registry.pendingSubmitThreadPath = null;
	}

	void attachVaultFilesByPath(paths);
});

// Auto-submit queued input (e.g. "Ask agent" from the search modal).
// Waits until the chat session is ready and attachments finish loading and
// there is something to send, so it works whether or not notes were queued
// alongside the text — and doesn't drop the send if the session is still
// loading (the effect re-runs when session becomes available).
$effect(() => {
	if (!registry.pendingAutoSubmit) return;
	if (registry.pendingSubmitThreadPath && registry.pendingSubmitThreadPath !== threadPath) return;
	if (!session) return;
	if (savingFiles) return;
	if (!hasContentToSend) return;

	registry.pendingAutoSubmit = false;
	registry.pendingSubmitThreadPath = null;
	// Consume the queued submit either way. Waiting for `hasChatModel` instead
	// would leave the request armed indefinitely and fire it much later, once the
	// user eventually picks a model — long after they've forgotten they asked.
	// The text stays in the composer, so nothing is lost by explaining and stopping.
	if (!hasChatModel) {
		showActionNotice(
			"Select a chat model to send this.",
			selectChatModelAction("Select model", selectedAgentWriteTarget),
		);
		return;
	}
	sendMessage();
});

// Keep a cached assembled system prompt so estimate matches what is actually sent.
$effect(() => {
	const _signature = selectedAgentPromptSignature;
	const requestVersion = ++assembledPromptRequestVersion;

	void (async () => {
		try {
			const assembled = await getPlugin().agentManager.assembleSystemPrompt();
			if (requestVersion === assembledPromptRequestVersion) {
				assembledSystemPrompt = assembled;
			}
		} catch {
			// Keep base prompt fallback if assembling fails.
		}
	})();
});

// The live graph selection is ambient (registry.graphSelection) and shown in
// every chat's tray. `pendingGraphNotes` is a one-shot focus signal from the
// graph's "send to chat" button — consume it to grab focus for this chat.
$effect(() => {
	if (registry.pendingGraphNotes !== null) {
		const hadNotes = registry.pendingGraphNotes.length > 0;
		registry.pendingGraphNotes = null;
		if (hadNotes) {
			window.requestAnimationFrame(() => markdownEditor?.focus());
		}
	}
});

onDestroy(() => {
	// Stop any in-flight edit-attachment seeding; its writes would land on a
	// dead component's state (and mint object URLs nothing revokes).
	seedEditToken++;
	editorContainer?.removeEventListener("touchend", handleMobileTapFocus);
	markdownEditor?.destroy();
	// Clean up object URLs
	for (const url of previewUrls.values()) {
		URL.revokeObjectURL(url);
	}
	// Remove any unsent attachment files from the vault
	if (attachments.length > 0) {
		const adapter = getPlugin().app.vault.adapter;
		for (const att of attachments) {
			if (managedAttachmentPaths.has(att.vaultPath)) {
				adapter.remove(att.vaultPath).catch(() => {});
			}
		}
	}
});

// Obsidian's iOS touch handling sometimes swallows the first tap on the
// composer as a hover/selection-only gesture (a widely reported iOS-core
// pattern — menus, tabs, and toolbar buttons show the same "first tap does
// nothing, second tap activates" symptom), leaving the CM editor unfocused
// and the keyboard down until a second tap. Force focus synchronously on
// `touchend` — tied to the real gesture — as a plugin-side workaround, unless
// the tap is the end of a text-selection drag (moved) or the editor already
// has focus (would otherwise fight normal caret placement).
function handleMobileTapFocus(event: TouchEvent) {
	if (!markdownEditor || event.changedTouches.length !== 1) return;
	const contentDom = editorContainer?.querySelector<HTMLElement>(".cm-content");
	if (!contentDom || contentDom.contains(document.activeElement)) return;
	markdownEditor.focus();
}

/** A click on the composer card's empty padding focuses the editor, so the
 * whole card acts as the text target — the editor box hugs its content
 * (`min-h-[24px]`) instead of padding the card out with clickable dead space.
 * Controls and the editor itself are excluded: buttons/chips keep their own
 * behavior, and clicks inside CM must keep placing the caret. */
function handleWrapperClick(event: MouseEvent) {
	const target = event.target as HTMLElement;
	if (target.closest("button, a, .s2b-chip, .markdown-editor-container")) return;
	markdownEditor?.focus();
}

function initializeEditor() {
	if (!editorContainer) return;

	const plugin = getPlugin();

	markdownEditor = new EmbeddableMarkdownEditor(plugin.app, editorContainer, {
		value: inputValue,
		// Orients first-time users toward the product's actual job — chatting
		// with the vault — instead of the generic "Type a message...".
		placeholder: "Ask about your notes...",
		cls: "chat-markdown-editor",
		enterVimInsertMode: true,
		onPaste: (event) => {
			void onEditorPaste(event);
		},
		onChange: (value) => {
			inputValue = value;
		},
		onEnter: (_editor, _mod, shift) => {
			// When expanded (fullscreen), Enter always inserts a newline so long,
			// multi-line drafts flow naturally — sending is Mod+Enter only there.
			// On mobile, Enter is the on-screen keyboard's only return key — there
			// is no Shift to hold for a newline and no discoverable "hold to send"
			// convention, so every mainstream mobile chat app (WhatsApp, iMessage,
			// Telegram) treats it as a newline and reserves the send button as the
			// only way to submit. Match that instead of sending on it. Otherwise
			// (desktop, collapsed) plain Enter sends; Shift+Enter always inserts a
			// newline. Return false to use the editor's default newline behavior.
			if (isFullscreen || shift || isMobileUI()) {
				return false;
			}
			attemptSend();
			return true;
		},
		onSubmit: () => {
			// Mod+Enter: send message (works in both collapsed and expanded modes)
			attemptSend();
		},
		onEscape: () => {
			// Fullscreen has its own Esc handling (collapse first); don't also
			// cancel an edit on the same keypress.
			if (isFullscreen) return;
			cancelActiveEdit();
		},
		onFocus: () => {
			onFocusChange?.(true);
		},
		onBlur: () => {
			onFocusChange?.(false);
		},
	});

	// Focus the editor after next paint
	window.requestAnimationFrame(() => {
		markdownEditor?.focus();
	});
}

function expandFullscreen() {
	if (isMobileUI() || fullscreenTransitioning || isFullscreen) return;
	fullscreenTransitioning = true;
	setFullscreenStartInset();
	fullscreenNoTransition = true;
	isFullscreen = true;
	isFullscreenVisible = false;
	// Double rAF ensures the start geometry is fully painted before transition begins.
	window.requestAnimationFrame(() => {
		window.requestAnimationFrame(() => {
			fullscreenNoTransition = false;
			window.requestAnimationFrame(() => {
				isFullscreenVisible = true;
			});
			window.setTimeout(() => {
				fullscreenTransitioning = false;
			}, FULLSCREEN_TRANSITION_MS);
			markdownEditor?.focus();
		});
	});
}

function collapseFullscreen() {
	if (fullscreenTransitioning || !isFullscreen) return;
	fullscreenTransitioning = true;
	isFullscreenVisible = false;
	window.setTimeout(() => {
		isFullscreen = false;
		fullscreenNoTransition = false;
		fullscreenPlaceholderHeight = 0;
		fullscreenTransitioning = false;
		window.requestAnimationFrame(() => markdownEditor?.focus());
	}, FULLSCREEN_TRANSITION_MS);
}

function setFullscreenStartInset() {
	if (!containerEl) return;
	// Use offset geometry from layout engine to avoid subpixel drift during first frame.
	const top = Math.max(0, containerEl.offsetTop);
	const left = Math.max(0, containerEl.offsetLeft);
	const width = Math.max(0, containerEl.offsetWidth);
	const height = Math.max(0, containerEl.offsetHeight);
	fullscreenPlaceholderHeight = height;

	containerEl.style.setProperty("--fs-top", `${top}px`);
	containerEl.style.setProperty("--fs-left", `${left}px`);
	containerEl.style.setProperty("--fs-width", `${width}px`);
	containerEl.style.setProperty("--fs-height", `${height}px`);
}

function toggleFullscreen() {
	if (isFullscreen) {
		collapseFullscreen();
		return;
	}
	expandFullscreen();
}

function attemptSend() {
	if (savingFiles) {
		new Notice("Please wait for attachments to finish saving");
	} else if (!hasChatModel) {
		// Reachable from the keyboard even though the button is disabled.
		// The picker is the only way forward, so offer it rather than just saying no.
		showActionNotice(
			"Select a chat model before sending.",
			selectChatModelAction("Select model", selectedAgentWriteTarget),
		);
	} else if (canSendMessage) {
		if (isEditing) {
			saveEdit();
		} else {
			sendMessage();
		}
	} else {
		new Notice("Add text or attach a file before sending");
	}
}

/** Cancel the active edit. The seeding effect above reacts to the
 * `editingPairId → null` transition and restores the stashed draft and
 * pre-edit attachments — shared with the out-of-composer cancel paths.
 * No-op when not editing. */
function cancelActiveEdit() {
	if (!isEditing) return;
	session?.cancelEdit();
}

function saveEdit() {
	if (!session || editingPairId === null) return;
	if (savingFiles) {
		new Notice("Please wait for attachments to finish saving");
		return;
	}
	if (!hasContentToSend) {
		new Notice("Add text or attach a file before saving");
		return;
	}
	if (!hasChatModel) {
		new Notice("Select a chat model before saving.");
		return;
	}

	const pairId = editingPairId;
	// Same attachment-only fallback as sendMessage — the tray IS the edited
	// message's attachment list, so text is optional exactly as it is on send.
	const contentToSave = inputValue.trim().length > 0 ? inputValue : "Please analyze the attached files.";
	session.editMessage(pairId, contentToSave, [...attachments]).catch((error) => {
		new Notice(error instanceof Error ? error.message : "Failed to save edit");
	});
	// Not session.cancelEdit() — that's for an abandoned edit; this one succeeded.
	// The draft that was stashed before the edit began is simply gone: the user
	// asked to save the edit, not to restore what they'd been typing before it.
	// Clearing the stash BEFORE editingPairId also keeps the seeding effect's
	// cancel-restore from firing on this transition.
	session.editingPairId = null;
	stashedDraft = null;
	seedEditToken++;
	seededEditPaths = new Set();
	// The tray's attachments were consumed into the edited message — clear them
	// exactly as sendMessage does (files stay in the vault; they're now sent).
	attachments = [];
	attachmentSizes = new Map();
	managedAttachmentPaths = new Set();
	for (const url of previewUrls.values()) {
		URL.revokeObjectURL(url);
	}
	previewUrls = new Map();
	inputValue = "";
	markdownEditor?.clear();
	onMessageSent?.();
}

function sendMessage() {
	if (savingFiles) {
		new Notice("Please wait for attachments to finish saving");
		return;
	}
	if (!hasContentToSend) {
		new Notice("Add text or attach a file before sending");
		return;
	}
	if (!hasChatModel) {
		new Notice("Select a chat model before sending.");
		return;
	}
	if (!session) {
		new Notice("Chat is not ready yet");
		return;
	}

	const contentToSend = inputValue.trim().length > 0 ? inputValue : "Please analyze the attached files.";
	void session
		.sendMessage(
			contentToSend,
			attachments.length > 0 ? [...attachments] : undefined,
			activeVisibleNotes.length > 0 ? [...activeVisibleNotes] : undefined,
			activeSelection ? { ...activeSelection } : undefined,
			activeGraphNotes.length > 0 ? [...activeGraphNotes] : undefined,
		)
		.catch((error) => {
			new Notice(error instanceof Error ? error.message : "Failed to send message");
		});
	attachments = [];
	attachmentSizes = new Map();
	managedAttachmentPaths = new Set();
	for (const url of previewUrls.values()) {
		URL.revokeObjectURL(url);
	}
	previewUrls = new Map();
	contextTrayRef?.clear();
	inputValue = "";
	markdownEditor?.clear();
	if (isFullscreen) {
		collapseFullscreen();
	}
	onMessageSent?.();
}

async function summarizeNow() {
	if (!session) return;
	try {
		await session.summarizeHistoryNow();
	} catch (error) {
		new Notice(error instanceof Error ? error.message : "Failed to summarize history");
	}
}

function sanitizeAttachmentFileName(fileName: string): string {
	const sanitized = fileName.replace(/[<>:"/\\|?*]/g, "-").trim();
	return sanitized.length > 0 ? sanitized : "attachment";
}

function extensionFromFile(file: File): string {
	const namedExt = file.name.split(".").pop()?.toLowerCase();
	if (namedExt && namedExt.length > 0 && namedExt !== file.name.toLowerCase()) {
		return namedExt;
	}

	const mime = file.type.toLowerCase();
	return MIME_EXTENSION_MAP[mime] ?? "bin";
}

function withFallbackAttachmentName(file: File, index: number): File {
	if (file.name.trim().length > 0 && file.name.includes(".")) {
		return file;
	}

	const extension = extensionFromFile(file);
	if (!ACCEPTED_EXTENSIONS.has(extension)) {
		return file;
	}

	const fallbackName = `pasted-file-${Date.now()}-${index + 1}.${extension}`;
	return new File([file], fallbackName, {
		type: file.type,
		lastModified: file.lastModified,
	});
}

async function getUniqueAttachmentPath(
	attachDir: string,
	fileName: string,
): Promise<{ vaultPath: string; storedName: string }> {
	const adapter = getPlugin().app.vault.adapter;
	const safeName = sanitizeAttachmentFileName(fileName);

	const dotIndex = safeName.lastIndexOf(".");
	const hasExtension = dotIndex > 0 && dotIndex < safeName.length - 1;
	const baseName = hasExtension ? safeName.slice(0, dotIndex) : safeName;
	const extension = hasExtension ? safeName.slice(dotIndex) : "";

	let attempt = 1;
	while (attempt < 10_000) {
		const storedName = attempt === 1 ? safeName : `${baseName} (${attempt})${extension}`;
		const vaultPath = normalizePath(`${attachDir}/${storedName}`);

		if (!(await adapter.exists(vaultPath))) {
			return { vaultPath, storedName };
		}

		attempt++;
	}

	throw new Error("Unable to allocate a unique attachment filename.");
}

/** Shared logic: save File objects to vault and add as attachments */
async function processFiles(files: File[]) {
	if (files.length === 0) return;

	savingFiles = true;
	const plugin = getPlugin();
	const data = getData();
	const attachDir = data.resolvedAttachmentFolder;

	try {
		// Ensure attachment directory exists
		if (!(await plugin.app.vault.adapter.exists(attachDir))) {
			await plugin.app.vault.adapter.mkdir(attachDir);
		}

		let count = 0;
		let warnedUnknownVision = false;
		let totalBytes = [...attachmentSizes.values()].reduce((sum, size) => sum + size, 0);

		for (const [index, sourceFile] of files.entries()) {
			const file = withFallbackAttachmentName(sourceFile, index);
			const ext = extensionFromFile(file);
			if (!ACCEPTED_EXTENSIONS.has(ext)) {
				new Notice(`Unsupported file type: .${ext}`);
				continue;
			}

			const isImage = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext);
			if (isImage && selectedModelSupportsVision === false) {
				const modelName = selectedChatModel?.model ?? "the selected model";
				new Notice(
					`Image attachments require a vision-capable model. Switch models to attach images (current: ${modelName}).`,
				);
				continue;
			}

			if (isImage && selectedModelSupportsVision === undefined && !warnedUnknownVision) {
				warnedUnknownVision = true;
				new Notice("Model vision support is unknown; image analysis may fail for this model.");
			}

			if (file.size > MAX_FILE_SIZE_BYTES) {
				new Notice(`File too large: ${file.name} exceeds 15 MB per-file limit.`);
				continue;
			}

			if (totalBytes + file.size > MAX_TOTAL_ATTACHMENTS_BYTES) {
				new Notice("Total attachment size exceeds 25 MB limit for one message.");
				continue;
			}

			const { vaultPath } = await getUniqueAttachmentPath(attachDir, file.name);

			// Read file as ArrayBuffer and save to vault
			const buffer = await file.arrayBuffer();
			await plugin.app.vault.adapter.writeBinary(vaultPath, buffer);
			totalBytes += file.size;

			const mime = mimeFromExtension(ext);
			const attachment: ChatAttachment = {
				name: file.name,
				mimeType: mime,
				vaultPath,
			};
			attachments.push(attachment);
			attachmentSizes.set(vaultPath, file.size);
			attachmentSizes = new Map(attachmentSizes);
			managedAttachmentPaths.add(vaultPath);
			managedAttachmentPaths = new Set(managedAttachmentPaths);
			count++;

			// Create preview URL for images
			if (mime.startsWith("image/")) {
				const blob = new Blob([buffer], { type: mime });
				previewUrls.set(vaultPath, URL.createObjectURL(blob));
				previewUrls = new Map(previewUrls);
			}
		}
	} catch (error) {
		new Notice(`Failed to attach file: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		savingFiles = false;
	}
}

async function attachVaultFile(file: TFile): Promise<boolean> {
	const ext = file.extension.toLowerCase();

	if (!ACCEPTED_EXTENSIONS.has(ext)) {
		new Notice(`Unsupported file type: .${ext}`);
		return false;
	}

	const isImage = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext);
	if (isImage && selectedModelSupportsVision === false) {
		const modelName = selectedChatModel?.model ?? "the selected model";
		showActionNotice(
			`Image attachments require a vision-capable model (current: ${modelName}).`,
			selectChatModelAction("Switch model", selectedAgentWriteTarget),
		);
		return false;
	}

	if (isImage && selectedModelSupportsVision === undefined) {
		new Notice("Model vision support is unknown; image analysis may fail for this model.");
	}

	try {
		const size = file.stat.size;

		if (size > MAX_FILE_SIZE_BYTES) {
			new Notice(`File too large: ${file.name} exceeds 15 MB per-file limit.`);
			return false;
		}

		const totalBytes = [...attachmentSizes.values()].reduce((sum, s) => sum + s, 0);
		if (totalBytes + size > MAX_TOTAL_ATTACHMENTS_BYTES) {
			new Notice("Total attachment size exceeds 25 MB limit for one message.");
			return false;
		}

		if (attachments.some((att) => att.vaultPath === file.path)) {
			new Notice(`${file.name} is already attached.`);
			return false;
		}

		const mime = mimeFromExtension(ext);
		const attachment: ChatAttachment = { name: file.name, mimeType: mime, vaultPath: file.path };
		attachments = [...attachments, attachment];
		attachmentSizes.set(file.path, size);
		attachmentSizes = new Map(attachmentSizes);

		if (mime.startsWith("image/")) {
			const buffer = await getPlugin().app.vault.readBinary(file);
			const blob = new Blob([buffer], { type: mime });
			previewUrls.set(file.path, URL.createObjectURL(blob));
			previewUrls = new Map(previewUrls);
		}

		return true;
	} catch (error) {
		new Notice(`Failed to attach file: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

async function attachVaultFilesByPath(paths: string[]) {
	if (paths.length === 0) return;

	if (savingFiles) {
		new Notice("Please wait for the current attachments to finish saving.");
		return;
	}

	savingFiles = true;
	const app = getPlugin().app;
	let attachedCount = 0;

	try {
		for (const path of paths) {
			const abstract = app.vault.getAbstractFileByPath(path);
			if (!abstract) {
				new Notice(`File not found: ${path}`);
				continue;
			}

			if (!(abstract instanceof TFile)) {
				new Notice(`Only files can be attached: ${path}`);
				continue;
			}

			if (await attachVaultFile(abstract)) {
				attachedCount++;
			}
		}
	} finally {
		savingFiles = false;
	}

	if (attachedCount > 0) {
		window.requestAnimationFrame(() => markdownEditor?.focus());
	}
}

async function onEditorPaste(event: ClipboardEvent) {
	const data = event.clipboardData;
	if (!data) return;

	const fileItems = Array.from(data.items ?? []).filter((item) => item.kind === "file");
	if (fileItems.length === 0) return;

	const pastedFiles: File[] = [];
	for (const item of fileItems) {
		const file = item.getAsFile();
		if (file) {
			pastedFiles.push(file);
		}
	}

	if (pastedFiles.length === 0) return;

	event.preventDefault();
	if (savingFiles) {
		new Notice("Please wait for the current attachments to finish saving.");
		return;
	}

	await processFiles(pastedFiles);
}

async function onFileAttachment(event: Event) {
	const input = event.target as HTMLInputElement;
	if (savingFiles) {
		new Notice("Please wait for the current attachments to finish saving.");
		input.value = "";
		return;
	}

	const fileList = input.files;
	if (!fileList || fileList.length === 0) return;
	await processFiles([...fileList]);
	// Reset the input so the same file can be re-selected
	input.value = "";
}

/** Open the search modal in picker mode to attach vault files as content. */
function openVaultPicker() {
	new SearchModal(getPlugin().app, {
		picker: {
			pickerText: {
				searchPlaceholder: "Search vault files to attach...",
				confirmVerb: "Attach",
				selectionLabel: "to attach",
			},
			pickerExistingPaths: attachments.map((att) => att.vaultPath),
			onAddPaths: (paths) => attachVaultFilesByPath(paths),
		},
	}).open();
}

function getDragFeedback(dataTransfer?: DataTransfer | null): {
	message: string;
	hasIssue: boolean;
	shouldBlockDrop: boolean;
} {
	if (!dataTransfer) {
		return { message: DEFAULT_DRAG_MESSAGE, hasIssue: false, shouldBlockDrop: false };
	}

	let hasImage = false;
	let hasClearlyUnsupported = false;

	const draggedVaultFiles = extractObsidianDraggedPaths(dataTransfer, getPlugin().app)
		.map((path) => getPlugin().app.vault.getAbstractFileByPath(path))
		.filter((file): file is TFile => file instanceof TFile);

	if (draggedVaultFiles.length > 0) {
		for (const file of draggedVaultFiles) {
			const extension = file.extension.toLowerCase();
			if (IMAGE_EXTENSIONS.has(extension)) {
				hasImage = true;
				continue;
			}

			if (!ACCEPTED_EXTENSIONS.has(extension)) {
				hasClearlyUnsupported = true;
			}
		}
	} else {
		const fileItems = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === "file");
		if (fileItems.length === 0) {
			return { message: DEFAULT_DRAG_MESSAGE, hasIssue: false, shouldBlockDrop: false };
		}

		for (const item of fileItems) {
			const mime = item.type.toLowerCase();
			if (!mime) continue;

			if (mime.startsWith("image/")) {
				hasImage = true;
				continue;
			}

			const hasSupportedPrefix = SUPPORTED_DRAG_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
			if (!SUPPORTED_DRAG_MIMES.has(mime) && !hasSupportedPrefix) {
				hasClearlyUnsupported = true;
			}
		}
	}

	if (hasImage && selectedModelSupportsVision === false) {
		const modelName = selectedChatModel?.model ?? "current model";
		return {
			message: `Images are not supported by ${modelName}. Switch to a vision-capable model.`,
			hasIssue: true,
			shouldBlockDrop: true,
		};
	}

	if (hasClearlyUnsupported) {
		return {
			message: "Some files may be unsupported (accepted: txt, md, csv, json, images, pdf).",
			hasIssue: true,
			shouldBlockDrop: false,
		};
	}

	return { message: DEFAULT_DRAG_MESSAGE, hasIssue: false, shouldBlockDrop: false };
}

function resetDragState() {
	isDragging = false;
	dragCounter = 0;
	dragMessage = DEFAULT_DRAG_MESSAGE;
	dragHasIssue = false;
}

export function handleDragEnter(event: DragEvent) {
	event.preventDefault();
	dragCounter++;
	if (event.dataTransfer?.types.includes("Files") || hasObsidianFileDrag(event.dataTransfer, getPlugin().app)) {
		isDragging = true;
		const feedback = getDragFeedback(event.dataTransfer);
		dragMessage = feedback.message;
		dragHasIssue = feedback.hasIssue;
	}
}

export function handleDragOver(event: DragEvent) {
	event.preventDefault();
	if (event.dataTransfer) {
		const feedback = getDragFeedback(event.dataTransfer);
		dragMessage = feedback.message;
		dragHasIssue = feedback.hasIssue;
		event.dataTransfer.dropEffect = feedback.shouldBlockDrop ? "none" : "copy";
	}
}

export function handleDragLeave(event: DragEvent) {
	event.preventDefault();
	dragCounter--;
	if (dragCounter <= 0) {
		resetDragState();
	}
}

export async function handleDrop(event: DragEvent) {
	event.preventDefault();
	resetDragState();

	if (savingFiles) {
		new Notice("Please wait for the current attachments to finish saving.");
		return;
	}

	const draggedVaultPaths = extractObsidianDraggedPaths(event.dataTransfer, getPlugin().app);
	if (draggedVaultPaths.length > 0) {
		// Dragging any vault file (incl. markdown) attaches it as content.
		// References are created only by typing [[wikilinks]] in the editor.
		await attachVaultFilesByPath(draggedVaultPaths);
		return;
	}

	const files = event.dataTransfer?.files;
	if (!files || files.length === 0) return;
	await processFiles([...files]);
}

function removeAttachment(attachment: ChatAttachment) {
	removeAttachmentByPath(attachment.vaultPath);
}

function removeAttachmentByPath(vaultPath: string) {
	const attachment = attachments.find((att) => att.vaultPath === vaultPath);
	if (!attachment) return;

	attachments = attachments.filter((att) => att.vaultPath !== vaultPath);
	attachmentSizes.delete(vaultPath);
	attachmentSizes = new Map(attachmentSizes);
	// Clean up preview URL
	const url = previewUrls.get(vaultPath);
	if (url) {
		URL.revokeObjectURL(url);
		previewUrls.delete(vaultPath);
		previewUrls = new Map(previewUrls);
	}
	// Optionally remove the file from vault (it's an unused pre-send attachment)
	if (managedAttachmentPaths.has(vaultPath)) {
		const plugin = getPlugin();
		plugin.app.vault.adapter.remove(vaultPath).catch(() => {});
		managedAttachmentPaths.delete(vaultPath);
		managedAttachmentPaths = new Set(managedAttachmentPaths);
	}
}

function canPromoteVisibleNoteToAttachment(note: VisibleNote): boolean {
	return ACCEPTED_EXTENSIONS.has(note.file.extension.toLowerCase());
}

/** Promote the active visible note to a content attachment (inline its bytes/content). */
async function promoteVisibleNoteToAttachment(note: VisibleNote) {
	if (!canPromoteVisibleNoteToAttachment(note)) {
		new Notice(`Unsupported file type: .${note.file.extension.toLowerCase()}`);
		return;
	}

	if (savingFiles) {
		new Notice("Please wait for the current attachments to finish saving.");
		return;
	}

	savingFiles = true;
	try {
		await attachVaultFile(note.file);
	} finally {
		savingFiles = false;
	}
}
</script>

{#if isFullscreen}
  <div
    class="chat-input-placeholder w-full"
    style="height: {fullscreenPlaceholderHeight}px;"
    aria-hidden="true"
  ></div>
{/if}
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={containerEl}
  class="chat-input-container w-full flex flex-col relative isolate gap-1 {isFullscreen
    ? `chat-input-fullscreen justify-end ${fullscreenNoTransition ? 'chat-input-fullscreen-no-transition' : ''} ${isFullscreenVisible ? 'chat-input-fullscreen-visible' : ''}`
    : 'mx-auto max-w-[--file-line-width]'}"
  role="region"
  onkeydown={(e) => {
    if (isFullscreen && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      collapseFullscreen();
    }
  }}
>
  {#if selectedChatModel && models.unavailableProviders.includes(selectedChatModel.provider)}
    <button
      class="provider-unreachable-banner flex flex-row items-center gap-1.5 text-xs cursor-pointer"
      onclick={models.refetchProviders}
      title="Click to retry connection"
    >
      <div class="h-icon-xs shrink-0" use:icon={"alert-triangle"} style="--icon-size: var(--icon-xs)"></div>
      <span>Cannot connect to {selectedChatModel.provider} — click to retry</span>
    </button>
  {/if}
  <PendingChangesBar {threadPath} />
  <EditingMessageBar {registry} {threadPath} onCancel={cancelActiveEdit} />
  <!-- Input wrapper with glow effect.
       Transition is scoped to the two properties that actually change state
       (border-color on focus/drag, background on drag-active) rather than
       `transition-all`, which also animated layout geometry — including the
       reflow when the mobile keyboard opens. The fullscreen expand/collapse
       animation is unaffected: it lives on `.chat-input-container`, which has
       its own explicit transition list. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -- the click is a
       pointer-only convenience (focus the editor from the card's padding);
       keyboard users reach the editor by Tab, so no key handler is needed. -->
  <div
    class="chat-input-wrapper flex flex-col gap-3 border border-solid pb-2 px-3 transition-[background-color,border-color] duration-200 ease-in-out relative isolate {isFullscreen
      ? 'flex-1 min-h-0'
      : ''} {showDragActive
      ? 'border-[--interactive-accent] chat-input-wrapper-drag-active'
      : ''}"
    ondragenter={dropTargetMode === "input" ? handleDragEnter : undefined}
    ondragover={dropTargetMode === "input" ? handleDragOver : undefined}
    ondragleave={dropTargetMode === "input" ? handleDragLeave : undefined}
    ondrop={dropTargetMode === "input" ? handleDrop : undefined}
    onclick={handleWrapperClick}
    role="region"
  >
    {#if !isMobileUI()}
      <!-- Fullscreen toggle - top right corner. Desktop only: on mobile the
           composer already grows with content up to `max-h-[200px]` (see the
           editor container below), and the fullscreen panel only bought a bit
           more room at real cost (an extra button, its own transition/keyboard
           timing to get right) — not worth it on a screen this small. -->
      <Button
        styles="chat-input-icon-button fullscreen-toggle-button absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity duration-150"
        iconId={isFullscreen ? "minimize-2" : "maximize-2"}
        iconSize="xs"
        style="pointer-events: auto;"
        onClick={toggleFullscreen}
        tooltip={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen editor"}
      />
    {/if}
    <!-- `pt-0.5` (2px) on top of the wrapper's 4px `padding-top` puts the tray
         6px below the border, matching the fullscreen toggle's `top-1.5` so
         the two top-anchored elements sit on one line. The old `pt-2` put it
         at 12px — a visibly large gap that also read as misaligned against
         the button. -->
    <div class="composer-tray-row flex flex-row flex-wrap items-start gap-1.5 pt-0.5 min-w-0">
      <ContextTray
        bind:this={contextTrayRef}
        graphPaths={registry.graphSelection}
        topicLabel={registry.graphSelectionTopicLabel}
        graphSelectionIsMaintenance={registry.graphSelectionIsMaintenance}
        {attachments}
        onRemoveAttachment={removeAttachment}
        onPromoteToAttachment={promoteVisibleNoteToAttachment}
        canPromoteToAttachment={canPromoteVisibleNoteToAttachment}
      />
      {#if savingFiles}
        <div class="text-xs text-text-muted flex items-center">Saving...</div>
      {/if}
    </div>

    <!-- Markdown Editor Container -->
    <div
      bind:this={editorContainer}
      class="markdown-editor-container w-full overflow-y-auto py-1 {isFullscreen
        ? 'flex-1'
        : 'min-h-[24px] max-h-[200px]'}"
      id="chat-view-user-input-element"
      data-testid="message-input"
    ></div>

    <!-- Actions row: attachment, agent+model, send -->
    <div class="chat-actions-row flex items-center gap-2">
      <input
        bind:this={attachmentInputEl}
        type="file"
        multiple={true}
        id="attachment"
        accept={acceptedFileTypes}
        style="display:none;"
        oninput={(event) => onFileAttachment(event)}
      />
      <AttachPopover
        onFromComputer={() => attachmentInputEl?.click()}
        onFromVault={openVaultPicker}
      />
      <AgentPopover {threadPath} />
      <ModelSelectButton {threadPath} />
      <div class="ml-auto flex items-center gap-2">
        <!-- Always on for desktop: the ring is the only place the running
             context estimate (and the Summarize action in its popover) lives,
             so it stays in view at every usage level. It used to appear only
             from 50% because an empty grey track next to the send button read
             as a loading spinner; ContextUsageCircle now draws a minimum arc,
             a faint track and the live percentage, so low usage reads as a
             gauge at rest. Hidden on mobile: it is the only thing in the row
             that isn't a control, and the phone action row has no width to
             spare for it (the same reason the narrowest container query below
             sheds it first on desktop). -->
        {#if !isMobileUI()}
          <ContextUsageCircle
            usagePercent={contextUsage.usagePercent}
            used={contextUsage.estimatedUsedTokens}
            limit={contextUsage.contextWindow}
            breakdown={contextBreakdown}
            {canSummarizeNow}
            onSummarizeNow={summarizeNow}
          />
        {/if}
        {#if !session || session.messageState === MessageState.idle}
          {#if isEditing && isMobileUI()}
            <Button
              ariaLabel="Cancel edit"
              tooltip="Cancel edit"
              onClick={cancelActiveEdit}
              styles="chat-input-icon-button clickable-icon mr-2"
              iconId="x"
            />
          {/if}
          <Button
            disabled={!canSendMessage || savingFiles}
            ariaLabel={isEditing ? "save edit" : "send message"}
            tooltip={!hasChatModel
              ? "Select a chat model first"
              : isEditing
                ? sendShortcutHint
                  ? `Save edit (${sendShortcutHint})`
                  : "Save edit"
                : sendShortcutHint
                  ? `Send message (${sendShortcutHint})`
                  : "Send message"}
            onClick={attemptSend}
            dataTestId="send-message-button"
            styles="send-message-button p-0 border-none cursor-pointer flex items-center justify-center shrink-0 transition-all duration-200 disabled:cursor-not-allowed"
            style={sendButtonStyle}
            iconId={isEditing ? "check" : "arrow-up"}
          />
        {:else if session.messageState === MessageState.answering}
          <Button
            ariaLabel="stop streaming"
            tooltip="Stop streaming"
            onClick={() => session?.stopStreaming()}
            styles="send-message-button p-0 border-none cursor-pointer flex items-center justify-center shrink-0 transition-all duration-200"
            style={sendButtonStyle}
            iconId="square"
          />
        {/if}
      </div>
    </div>

    {#if dropTargetMode === "input" && isDragging}
      <div
        class="absolute inset-0 z-20 rounded-[22px] pointer-events-none flex items-center justify-center gap-2 text-sm font-medium {dragHasIssue
          ? 'text-[--text-error]'
          : 'text-[--text-accent]'}"
      >
        <div
          class="w-[--icon-s] h-[--icon-s]"
          style="--icon-size: var(--icon-s)"
          use:icon={dragHasIssue ? "alert-triangle" : "upload"}
        ></div>
        <span>{dragMessage}</span>
      </div>
    {/if}
  </div>

  <!-- Spacer to keep the input glow from being clipped at the bottom edge -->
  <div class="h-4" aria-hidden="true"></div>
</div>

<style>
  .chat-input-container {
    background: transparent !important;
    /* Same fill as the page, everywhere. The composer is defined by its
       border, not by a contrasting slab — see `.chat-input-wrapper`. */
    --input-bg: var(--background-primary);
  }

  /* Same card language as the other pre-composer bars (PendingChangesBar,
     EditingMessageBar): page fill, real border, the composer stack's 22px
     pill. An error state shouldn't be the one surface in the stack rendered
     as bare floating text — it deserves more structure than routine bars,
     not less. Red is kept to the text/icon and a tinted border rather than a
     filled red slab: this is a retryable connectivity hiccup, not data loss. */
  .provider-unreachable-banner {
    padding: 6px 12px;
    border: 1px solid color-mix(in srgb, var(--text-error) 35%, var(--background-modifier-border));
    border-radius: 22px;
    background: var(--input-bg);
    color: var(--text-error);
  }

  .provider-unreachable-banner:hover {
    background: color-mix(in srgb, var(--text-error) 6%, var(--input-bg));
  }

  /* The scroller runs 24px past this container's top edge (see
     `.scroll-container`'s height calc in Chat.svelte), so message text passes
     underneath this band on its way behind the input. Fade it out across
     exactly that distance, so the last visible line dissolves into the page
     instead of being hard-cut at the input's border.

     Fades to `--background-primary` (the PAGE colour), not `--input-bg` (the
     wrapper's own surface): matching the wrapper removes the seam at the
     input border but paints a slab of wrapper-grey across the full width,
     which against a dark theme's near-black page reads as a distinctly
     lighter band with visible edges down both sides of the inset input.
     Verified on-device in dark mode: page `#000` vs wrapper `rgb(30,30,30)`. */
  :global(.is-mobile .chat-input-container) {
    background: linear-gradient(to bottom, transparent 0%, var(--background-primary) 24px) !important;
  }

  /* The wrapper's shape and internal rhythm live here, not in utility classes
     on the element (the markup carries only layout/transition utilities, so
     this block and the markup can't disagree about the design). All
     platform-neutral: keeping desktop squarer or looser than mobile would
     just be an inconsistency.

     The fill matches the page (`--input-bg` is `--background-primary`), so
     the border is the only thing separating the composer from the background
     and always has to be drawn — in the main view as well as in a sidebar.

     Plain selector, NOT `:not(:focus-within)` — that has the same specificity
     as the `:focus-within` rule further down and, coming earlier in the file,
     would silently win on source order and kill the focus ring entirely.
     Leaving this unqualified lets `:focus-within` override it as intended. */
  .chat-input-wrapper {
    background: var(--input-bg);
    border-radius: 22px;
    border-color: var(--background-modifier-border);
    gap: 8px;
    /* Query container for the action row's progressive collapse (see the
       `@container` rules below). The real constraint on that row is how wide
       the COMPOSER is, which is not the viewport and not `.mod-*-split`: a
       sidebar can be dragged wide, and a narrow window's main view is just as
       cramped as a sidebar. Querying the wrapper itself is the only measure
       that tracks the actual available space in every one of those cases. */
    container-type: inline-size;
    container-name: chat-composer;
    /* The `pb-2 px-3` utilities on the element leave `padding-top` at 0, which
       started the text inside the 22px corner's curve — it read as if the
       first line was crowding the border. Clear the curve. */
    padding-top: 4px;
  }

  /* The row is `nowrap`: wrapping dropped the send button onto a second line
     and grew the composer taller, which is worse than any amount of label
     truncation. With nowrap, overflow has to be absorbed by something, so
     pin every fixed-size control and let ONLY the model name shrink (it sets
     `flex-shrink: 1` + `min-width: 0` in ModelSelectButton). Without these
     `flex-shrink: 0` guards the browser is free to squeeze the icon buttons
     and the agent pill instead, which would deform the touch targets. */
  .chat-actions-row > :global(*) {
    flex-shrink: 0;
  }

  .chat-actions-row :global(.model-select-btn) {
    flex-shrink: 1;
    min-width: 0;
  }

  /* Progressive collapse of the action row as the composer narrows.
     These breakpoints shed elements entirely, in priority order (least useful
     first), before/alongside the truncation above:

       1. <340px — drop the context-usage circle. It's the only thing in the
          row that isn't a control; you never need it to send a message. Also
          already hidden on mobile for exactly this reason.
       2. <260px — collapse the agent to its icon. The agent's icon is
          user-chosen and genuinely identifying, and the agent changes far
          less often than the model, so icon-only stays legible. This mirrors
          the existing `.is-mobile` rule in AgentPopover.

     The model name is deliberately NOT collapsed at either step: unlike the
     agent, its icon is generic, so an icon-only model button would tell you
     nothing about which model you're about to spend tokens on. It truncates
     with an ellipsis instead (`max-width` in ModelSelectButton) and is the
     last label standing. */
  @container chat-composer (max-width: 340px) {
    .chat-actions-row :global(.context-usage-trigger) {
      display: none;
    }
  }

  @container chat-composer (max-width: 260px) {
    .chat-actions-row :global(.agent-pill-label) {
      display: none;
    }

    /* The 190px trigger cap exists to bound the LABEL; with the label gone it
       would just leave dead space around the icon. */
    .chat-actions-row :global(.agent-popover-trigger) {
      max-width: none;
    }
  }

  /* Circular, matching the attach button (already `999px`) and the reference
     design. The 6px radius made it the odd one out in the action row. */
  :global(.chat-input-container button.send-message-button) {
    border-radius: 999px;
  }

  /* Tighter still on mobile, where vertical space is scarce and the card
     otherwise reads as mostly padding: the 44px touch-target buttons already
     carry their own visual weight, so the surrounding space can come in
     without the row feeling cramped. 6px on the sides and bottom sits the
     action row ~7px from the card's edges (vs ~13px at the previous 12px
     bottom / 10px sides), and the 2px gap keeps the editor and the row
     reading as one control. */
  :global(.is-mobile) .chat-input-wrapper {
    padding-left: 6px;
    padding-right: 6px;
    padding-bottom: 6px;
    gap: 2px;
  }

  /* Keeps the text ~13px from the card's edge while the wrapper's 6px sides
     put the action row at ~7px. The absolute inset is unchanged from before
     the wrapper was tightened — what makes it read as inset now is the 6px
     offset from the button row, not the distance itself. Pushing it further
     (10px here, ~17px total) overshot. Mobile only; desktop's wider card
     doesn't need it. */
  :global(.is-mobile) .markdown-editor-container {
    padding-left: 6px;
    padding-right: 6px;
  }

  .chat-input-container.chat-input-fullscreen {
    /* Breathing room between the expanded panel and the chat pane's edges. */
    --s2b-fs-gutter: 12px;
    position: absolute;
    top: var(--fs-top, 0px);
    left: var(--fs-left, 0px);
    width: var(--fs-width, 100%);
    height: var(--fs-height, 100%);
    margin: 0 !important;
    z-index: var(--layer-popover);
    background: var(--background-primary) !important;
    padding: 0;
    max-width: none;
    opacity: 1;
    /* Matches `.chat-input-wrapper`'s radius. With `overflow: hidden` here, a
       tighter radius on the container clips the wrapper's rounder corners and
       shaves off its bottom edge. */
    border-radius: 22px;
    overflow: hidden;
    transition:
      top 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
      left 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
      width 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
      height 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
      border-radius 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
      opacity 220ms ease;
    will-change: top, left, width, height, border-radius;
  }

  /* Expanded geometry. The toggle that reaches this state is desktop-only (see
     the `{#if !isMobileUI()}` guard on the fullscreen button), so this sizes
     against the chat pane, not the phone viewport.

     `.chat-input-container` is `position: absolute` inside `.chat-root`, which
     is `position: relative` — so percentages here resolve against the chat pane
     and the panel stays inside it instead of escaping to the window. An earlier
     `height: 100vh - <mobile keyboard/navbar bands>` measured the whole viewport
     while the top offset was relative to the pane, so in any pane shorter than
     the window the panel overhung its bottom edge and the send row was clipped —
     the reported "cut off slightly at the bottom". */
  .chat-input-container.chat-input-fullscreen.chat-input-fullscreen-visible {
    opacity: 1;
    top: var(--s2b-fs-gutter);
    height: calc(100% - (2 * var(--s2b-fs-gutter)));
    /* Match the collapsed composer's readable measure (`max-w-[--file-line-width]`,
       centered) rather than stretching edge to edge: a full-width editor gives
       lines far longer than the messages above it, so text written here does not
       wrap where it will once sent. Centering is done with `left` + `width`
       because `margin: 0 !important` above rules out `margin-inline: auto`. */
    width: min(calc(100% - (2 * var(--s2b-fs-gutter))), var(--file-line-width));
    left: max(
      var(--s2b-fs-gutter),
      calc((100% - min(calc(100% - (2 * var(--s2b-fs-gutter))), var(--file-line-width))) / 2)
    );
    /* Keep in step with the wrapper radius, as above. */
    border-radius: 22px;
  }

  .chat-input-container.chat-input-fullscreen.chat-input-fullscreen-no-transition {
    transition: none !important;
  }

  .chat-input-wrapper:focus-within {
    border-color: var(--interactive-accent);
  }

  .chat-input-wrapper-drag-active {
    background: color-mix(in srgb, var(--interactive-accent) 22%, var(--input-bg));
    border-color: color-mix(in srgb, var(--interactive-accent) 82%, white 18%) !important;
  }

  .chat-input-wrapper-drag-active > :not(:last-child) {
    opacity: 0;
    visibility: hidden;
  }

  /* `.chat-input-container button.…` (0,2,1) out-specifies every core button
     and `.clickable-icon` rule, mobile variants included, so nothing here needs
     `!important` — which also lets the touch-target rules in styles.css win on
     specificity alone. */
  :global(.chat-input-container button.send-message-button) {
    background: var(--send-button-bg);
    color: var(--text-on-accent);
    width: 1.75rem;
    height: 1.75rem;
    min-width: 1.75rem;
    min-height: 1.75rem;
    flex: 0 0 auto;
    aspect-ratio: 1;
  }

  /* Lucide ships at `stroke-width: 2`, which reads thin for a glyph reversed
     out of a filled accent circle at 28px — light-on-dark makes strokes
     optically thinner than the same weight dark-on-light. 2.5 matches the
     attach button, the other icon in this row that needed the same
     correction. Applies to all three states (arrow-up / check / square), so
     the button's weight doesn't shift as it changes state. */
  :global(.send-message-button .svg-icon) {
    stroke-width: 2.5;
  }

  /* Bump the send target to a comfortable touch size on mobile. */
  :global(.is-mobile .chat-input-container button.send-message-button) {
    width: 2.75rem;
    height: 2.75rem;
    min-width: 2.75rem;
    min-height: 2.75rem;
  }

  :global(.chat-input-container button.send-message-button:hover:not(:disabled)) {
    background: var(--send-button-bg-hover);
    color: var(--text-on-accent);
  }

  :global(.chat-input-container button.send-message-button:disabled) {
    background: var(--send-button-bg-disabled);
    color: color-mix(in srgb, var(--text-on-accent) 82%, transparent);
    opacity: 1;
  }

  :global(.chat-input-container .chat-input-icon-button.clickable-icon) {
    width: 1.75rem;
    height: 1.75rem;
    min-width: 1.75rem;
    min-height: 1.75rem;
    max-width: 1.75rem;
    max-height: 1.75rem;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    aspect-ratio: 1;
  }

  :global(.chat-input-wrapper:hover > .fullscreen-toggle-button.clickable-icon),
  :global(.chat-input-wrapper:focus-within > .fullscreen-toggle-button.clickable-icon),
  :global(.chat-input-fullscreen .chat-input-wrapper > .fullscreen-toggle-button.clickable-icon) {
    opacity: 1;
  }

  /* The toggle is absolutely positioned over the wrapper's top-right corner,
     outside the flow — reserve that corner in the tray row so a wrapping chip
     can't land underneath it, where the toggle would swallow the chip's
     clicks (its paperclip/close actions live exactly at a chip's right edge).
     2.5rem = the 6px right offset + 1.75rem button + a 6px gap. Only the
     row's FIRST line can collide (the toggle band ends where a second chip
     line begins), so the over-reservation on later lines is the price of
     doing this in CSS. Mobile never renders the toggle — no reservation. */
  .composer-tray-row {
    padding-right: 2.5rem;
  }

  :global(.is-mobile) .composer-tray-row {
    padding-right: 0;
  }

  /* Markdown editor styling */
  .markdown-editor-container {
    /* The text column starts 6px right of the wrapper's 12px rail (CM6's
       `.cm-line` keeps `padding: 0 2px 0 6px`; its horizontal padding is
       load-bearing for list hanging-indents — see the `.cm-content` note
       below). That offset is kept deliberately: bordered controls (chips, the
       attach button) can sit on the 12px rail because their border is their
       visual edge, but bare text at the same x hugs the card border. Strict
       geometric alignment here reads WORSE than the 6px optical inset. */

    /* Reset some CM6 styles for chat input look */
    :global(.cm-editor) {
      background: transparent !important;
      font-family: inherit;
      font-size: 0.95rem;
    }

    :global(.cm-editor.cm-focused) {
      outline: none !important;
    }

    :global(.cm-scroller) {
      overflow-x: hidden;
      /* Obsidian's mobile CSS adds a large `--view-top-spacing-markdown`
         padding-top to `.markdown-source-view > .cm-editor > .cm-scroller` to
         clear the phone header/toolbar. Our embedded composer carries the
         `markdown-source-view` class too, so it inherits ~119px of dead space
         above the placeholder. Reset it — the composer has no header to clear. */
      padding-top: 0 !important;
    }

    :global(.cm-content) {
      /* Reset only vertical padding; keep horizontal so Live Preview's
         list hanging-indents (padding-inline-start + negative text-indent)
         are not collapsed, which would clip "- " / "1." markers off-screen. */
      padding-block: 0 !important;
      caret-color: var(--text-normal);
    }

    :global(.cm-line) {
      padding-block: 0 !important;
      line-height: 1.5;
      /* Anchor for the absolutely-positioned placeholder below. `.cm-line` is
         `display: block` with no `position` in CM6's base theme, so promoting it
         to `relative` changes nothing about the layout. */
      position: relative;
    }

    /* Taken out of flow so it contributes no width to the line box.
       CM6 renders the placeholder as a real inline-block `<span>` widget inside
       the first line, not as an input `placeholder` attribute. Obsidian's
       embeddable editor omits CM6's `drawSelection`, so the caret here is the
       browser's native contenteditable caret — and the browser positions that
       from DOM layout, not from CM6's document model. With the widget in flow it
       occupies real width, so the caret was painted after it, appearing to sit
       "behind" the placeholder text. (The document is empty either way; this was
       cosmetic.) Absolute positioning leaves the line box genuinely zero-width,
       so the caret lands at the start where it belongs.

       `inset-inline-start: 0` is against the line's padding box, which already
       carries CM6's `padding: 0 2px 0 6px` — so this aligns with the line's text
       origin rather than needing to re-add that 6px. */
    :global(.cm-placeholder) {
      color: var(--text-muted);
      font-style: normal;
      position: absolute;
      inset-inline-start: 0;
      top: 0;
      pointer-events: none;
    }
  }
</style>
