import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => ({ getSelectedAgent: () => ({ chatModel: undefined }) }),
}));

import { SelectionTracker, formatSelectionContext, type SelectionRef } from "../../src/hooks/useSelection.svelte";
import { setPlugin } from "../../src/stores/state.svelte";
import { VIEW_TYPE_CHAT } from "../../src/views/chat/viewType";
import type SecondBrainPlugin from "../../src/main";

/* --------------------------------------------------------------------------
 * Quoting text from a chat (#591).
 *
 * A selection in a chat's message text shows as a chip at once, like a note
 * selection; it is kept once the composer is engaged, and reaches the model
 * framed as a quote rather than as a file.
 * ------------------------------------------------------------------------*/

const THREAD = "Chats/Planning.chat";

function chatLeaf(path: string) {
	const containerEl = document.createElement("div");
	containerEl.innerHTML = `
		<div class="message-area">
			<div class="s2b-message-text"><p class="answer">The second step is wrong.</p></div>
			<div class="tool-card"><span class="tool-label">search_notes</span></div>
			<div class="s2b-message-text"><p class="final">Use step three instead.</p></div>
		</div>
		<div class="composer"><p class="draft">my draft</p></div>`;
	document.body.appendChild(containerEl);
	const basename = path.replace(/^.*\//, "").replace(/\.chat$/, "");
	return { view: { containerEl, file: { path, basename }, getViewType: () => VIEW_TYPE_CHAT } };
}

function select(node: Node, start = 0, end = node.textContent?.length ?? 0) {
	const range = document.createRange();
	range.setStart(node, start);
	range.setEnd(node, end);
	const sel = window.getSelection();
	sel?.removeAllRanges();
	sel?.addRange(range);
	document.dispatchEvent(new Event("selectionchange"));
	flushFrames();
}

let frames: FrameRequestCallback[] = [];
function flushFrames() {
	const pending = frames;
	frames = [];
	for (const cb of pending) cb(0);
}

function caret(node: Node) {
	select(node, 1, 1);
}

let leaves: ReturnType<typeof chatLeaf>[] = [];
let renameHandler: ((file: { path: string; basename: string }, oldPath: string) => void) | undefined;

beforeEach(() => {
	(globalThis as { activeWindow?: Window }).activeWindow = window;
	frames = [];
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
		frames.push(cb);
		return frames.length;
	});
	leaves = [chatLeaf(THREAD)];
	renameHandler = undefined;
	setPlugin({
		app: {
			vault: {
				on: (_name: string, cb: typeof renameHandler) => {
					renameHandler = cb;
					return {};
				},
				offref: () => {},
			},
			workspace: {
				on: () => ({}),
				offref: () => {},
				getMostRecentLeaf: () => null,
				getLeavesOfType: (type: string) => (type === VIEW_TYPE_CHAT ? leaves : []),
				getActiveViewOfType: () => null,
				iterateAllLeaves: (cb: (leaf: unknown) => void) => leaves.forEach(cb),
			},
		},
	} as unknown as SecondBrainPlugin);
});

afterEach(() => {
	window.getSelection()?.removeAllRanges();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

function textOf(selector: string, leaf = leaves[0]): Node {
	const el = leaf.view.containerEl.querySelector(selector);
	if (!el?.firstChild) throw new Error(`missing ${selector}`);
	return el.firstChild;
}

describe("SelectionTracker — chat quotes", () => {
	it("shows a chat selection as soon as it is made", () => {
		const tracker = new SelectionTracker();
		select(textOf(".answer"));
		expect(tracker.selection).toMatchObject({
			path: THREAD,
			basename: "Planning",
			viewType: "chat",
			text: "The second step is wrong.",
		});
		tracker.destroy();
	});

	it("drops the chip when the selection goes away without the composer being engaged", () => {
		const tracker = new SelectionTracker();
		select(textOf(".answer"));
		window.getSelection()?.removeAllRanges();
		document.dispatchEvent(new Event("selectionchange"));
		flushFrames();
		expect(tracker.selection).toBeUndefined();
		tracker.destroy();
	});

	it("still pins the selection after the press already moved it into the editor", () => {
		const tracker = new SelectionTracker();
		select(textOf(".answer"), 4, 10);
		// The press collapsed the selection before the composer's handler ran.
		window.getSelection()?.removeAllRanges();
		tracker.pinChatSelection();
		expect(tracker.selection?.text).toBe("second");
		tracker.destroy();
	});

	it("ignores selections outside message text", () => {
		const tracker = new SelectionTracker();
		select(textOf(".tool-label"));
		tracker.pinChatSelection();
		expect(tracker.selection).toBeUndefined();

		select(textOf(".draft"));
		tracker.pinChatSelection();
		expect(tracker.selection).toBeUndefined();
		tracker.destroy();
	});

	it("records which chat a quote came from", () => {
		leaves.push(chatLeaf("Chats/Other.chat"));
		const tracker = new SelectionTracker();
		select(textOf(".answer", leaves[1]));
		tracker.pinChatSelection();
		expect(tracker.selection).toMatchObject({ path: "Chats/Other.chat", basename: "Other" });
		tracker.destroy();
	});

	it("cuts the UI between two messages out of a selection spanning both", () => {
		const tracker = new SelectionTracker();
		const range = document.createRange();
		range.setStart(textOf(".answer"), 4);
		range.setEnd(textOf(".final"), 3);
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
		flushFrames();
		tracker.pinChatSelection();
		expect(tracker.selection?.text).toBe("second step is wrong.\n\nUse");
		tracker.destroy();
	});

	it("keeps the pinned quote while typing, and drops it on a click into message text", () => {
		const tracker = new SelectionTracker();
		select(textOf(".answer"));
		tracker.pinChatSelection();

		caret(textOf(".draft"));
		expect(tracker.selection?.viewType).toBe("chat");

		caret(textOf(".answer"));
		expect(tracker.selection).toBeUndefined();
		tracker.destroy();
	});
});

describe("SelectionTracker — renamed chats", () => {
	it("moves a pinned quote along when its chat is auto-titled", () => {
		const tracker = new SelectionTracker();
		select(textOf(".answer"));
		tracker.pinChatSelection();
		renameHandler?.({ path: "Chats/Roadmap.chat", basename: "Roadmap" }, THREAD);
		expect(tracker.selection).toMatchObject({ path: "Chats/Roadmap.chat", basename: "Roadmap" });
		tracker.destroy();
	});
});

describe("formatSelectionContext — chat quotes", () => {
	const base: SelectionRef = {
		path: THREAD,
		basename: "Planning",
		viewType: "chat",
		text: "Step two",
	};

	it("frames a same-thread selection as a quote of the conversation", () => {
		expect(formatSelectionContext({ ...base, sameThread: true })).toBe(
			"[Quoted from earlier in this conversation]\nStep two",
		);
	});

	it("names the chat a cross-thread quote came from", () => {
		expect(formatSelectionContext({ ...base, sameThread: false })).toBe(
			'[Quoted from the chat "Planning" (Chats/Planning.chat)]\nStep two',
		);
	});

	it("leaves note selections unchanged", () => {
		expect(formatSelectionContext({ ...base, viewType: "markdown", path: "Notes/A.md" })).toBe(
			"[Selected text from Notes/A.md]\nStep two",
		);
	});
});
