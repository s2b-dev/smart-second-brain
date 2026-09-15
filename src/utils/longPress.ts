/**
 * Svelte action: fire a callback when the user long-presses an element on a
 * touch device.
 *
 * Mirrors the gesture already used for graph nodes (see `GraphCanvas.svelte`):
 * arm a timer on touch/pen pointerdown, cancel it if the finger moves past a
 * small tolerance (that's a scroll, not a press) or lifts early. Mouse input is
 * ignored entirely — on desktop the equivalent affordance is hover/right-click,
 * and arming this for a mouse would hijack text selection.
 *
 * After the menu fires we swallow the click that the browser synthesises on
 * lift, so the press doesn't also trigger the element's own tap handler (the
 * user bubble's expand/collapse, for instance).
 *
 * While a press is armed, the node carries `.s2b-long-pressing` so CSS can
 * give the user a "charging up" cue toward the menu opening.
 */

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

/** Class toggled on the node for the duration of an armed press, so CSS can
 *  animate a "charging up" cue (see `.s2b-long-pressing` in styles.css). */
const PRESSING_CLASS = "s2b-long-pressing";

interface LongPressOptions {
	onLongPress: (x: number, y: number) => void;
	/** Skip wiring entirely (e.g. desktop). Re-evaluated when params update. */
	enabled?: boolean;
}

export function longPress(node: HTMLElement, options: LongPressOptions) {
	let timer: number | null = null;
	let fired = false;
	let startX = 0;
	let startY = 0;
	let current = options;

	function cancel() {
		if (timer !== null) {
			window.clearTimeout(timer);
			timer = null;
		}
		node.classList.remove(PRESSING_CLASS);
	}

	function onPointerDown(e: PointerEvent) {
		if (current.enabled === false) return;
		if (e.pointerType !== "touch" && e.pointerType !== "pen") return;

		fired = false;
		startX = e.clientX;
		startY = e.clientY;
		cancel();
		node.classList.add(PRESSING_CLASS);
		timer = window.setTimeout(() => {
			timer = null;
			fired = true;
			node.classList.remove(PRESSING_CLASS);
			current.onLongPress(startX, startY);
		}, LONG_PRESS_MS);
	}

	function onPointerMove(e: PointerEvent) {
		if (timer === null) return;
		if (Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_TOLERANCE_PX) cancel();
	}

	function onPointerUp() {
		cancel();
	}

	// The synthesised click after a long press must not reach the element's own
	// handler. Capture phase so we win before it bubbles.
	function onClick(e: MouseEvent) {
		if (!fired) return;
		fired = false;
		e.preventDefault();
		e.stopPropagation();
	}

	node.addEventListener("pointerdown", onPointerDown);
	node.addEventListener("pointermove", onPointerMove);
	node.addEventListener("pointerup", onPointerUp);
	node.addEventListener("pointercancel", onPointerUp);
	node.addEventListener("click", onClick, true);

	return {
		update(next: LongPressOptions) {
			current = next;
		},
		destroy() {
			cancel();
			node.removeEventListener("pointerdown", onPointerDown);
			node.removeEventListener("pointermove", onPointerMove);
			node.removeEventListener("pointerup", onPointerUp);
			node.removeEventListener("pointercancel", onPointerUp);
			node.removeEventListener("click", onClick, true);
		},
	};
}
