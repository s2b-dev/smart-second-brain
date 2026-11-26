import { Platform } from "obsidian";

/**
 * Keep a `SuggestModal`'s `.prompt` clear of the status bar / Dynamic Island on
 * phones.
 *
 * Core positions the mobile prompt below the safe-area inset with
 * `--prompt-top: calc(var(--safe-area-inset-top) + var(--header-height) + ...)`,
 * which is already correct. Some themes make the phone prompt full-bleed instead
 * (Cupertino sets `--prompt-top: 0` with `height: 100vh`), which anchors the
 * panel at y=0.
 *
 * Such a theme normally clears the island itself, inside the results list:
 * Cupertino pads `.prompt-results` by `inset + 16px` and masks that band to a
 * fade. Moving the whole prompt down on top of that counted the inset twice (a
 * ~140px empty gap above the first row) and, because the prompt carries the
 * theme's `backdrop-filter`, left an unblurred strip above it with a hard seam
 * at the inset line. Verified on-device (iPhone, Cupertino): leaving the prompt
 * where the theme put it lines our results up exactly with core's Quick
 * Switcher.
 *
 * So the prompt is only moved as a fallback, for a full-bleed theme whose
 * results list does NOT pad past the inset. When the modal injects a bar above
 * the results (`topBar`, the model picker's filter strip), that bar becomes the
 * first thing under the island: it takes the inset as its own top padding, and
 * the results list gives back the padding the bar now covers. The theme's fade
 * mask is anchored to the results box, whose top just moved down by the bar's
 * height, so it is shifted back up by the same amount to stay where the theme
 * drew it relative to the screen (a no-op for themes without a mask).
 *
 * This has to be script rather than CSS. The natural CSS spelling,
 * `top: max(var(--prompt-top), var(--safe-area-inset-top))`, is invalid whenever
 * a theme writes a *unitless* `0`: mixing a number with a length makes the whole
 * declaration fail and silently fall back to `top: 0`. `calc()` does not rescue
 * it, and a style query cannot be used either, since `--prompt-top` is set on
 * `.prompt` itself and style queries evaluate an ancestor container, never the
 * element.
 */
export function applyPromptSafeArea(promptEl: HTMLElement, topBar?: HTMLElement | null): void {
	if (!Platform.isPhone) return;

	const styles = getComputedStyle(promptEl);
	const inset = Number.parseFloat(styles.getPropertyValue("--safe-area-inset-top")) || 0;
	if (inset <= 0) return;

	// The resolved `top` is what actually positions the panel, whatever
	// `--prompt-top` was written as.
	const top = Number.parseFloat(styles.top) || 0;
	if (top >= inset) return;

	const results = promptEl.querySelector<HTMLElement>(".prompt-results");
	const resultsPadding = results ? Number.parseFloat(getComputedStyle(results).paddingTop) || 0 : 0;

	if (topBar && results) {
		placeBarUnderInset(promptEl, topBar, results, inset - top, resultsPadding);
		return;
	}
	if (resultsPadding >= inset) return;

	shiftPromptBelowInset(promptEl, styles, inset);
}

function placeBarUnderInset(
	promptEl: HTMLElement,
	bar: HTMLElement,
	results: HTMLElement,
	overlap: number,
	resultsPadding: number,
): void {
	const barStyles = getComputedStyle(bar);
	const padTop = Number.parseFloat(barStyles.paddingTop) || 0;
	const minHeight = Number.parseFloat(barStyles.minHeight) || 0;
	bar.style.paddingTop = `${overlap + padTop}px`;
	if (minHeight > 0) bar.style.minHeight = `${overlap + minHeight}px`;

	// How far the results box now starts below the prompt's top edge: the bar,
	// plus anything else the modal stacks above the list. `offsetTop`, not a
	// rect: this runs from `onOpen`, while Cupertino is still sliding the list in
	// with a `translateY`, and a rect would fold that transform in.
	const shift = results.offsetParent === promptEl ? results.offsetTop : 0;
	if (shift <= 0) return;

	results.style.paddingTop = `${Math.max(8, resultsPadding - shift)}px`;
	for (const prefix of ["", "-webkit-"]) {
		results.style.setProperty(`${prefix}mask-position`, `0 -${shift}px`);
		results.style.setProperty(`${prefix}mask-size`, `100% calc(100% + ${shift}px)`);
		results.style.setProperty(`${prefix}mask-repeat`, "no-repeat");
	}
}

function shiftPromptBelowInset(promptEl: HTMLElement, styles: CSSStyleDeclaration, inset: number): void {
	promptEl.style.setProperty("top", `${inset}px`, "important");

	// A theme that anchored the prompt at the top edge usually also sized it to
	// the full viewport (`height: 100vh`); shifting it down by the inset would
	// push its bottom — and the input pinned there — off screen. Compensate by
	// the same amount, but only when the box really is full-bleed, so a theme
	// that pulled a content-sized panel to the top keeps its height. `vh` on
	// purpose, matching the unit such themes use: `dvh` tracks the
	// keyboard-shrunken viewport on iOS and lands the cap mid-screen.
	const height = Number.parseFloat(styles.height) || 0;
	if (height >= window.innerHeight - 1) {
		promptEl.style.setProperty("height", `calc(100vh - ${inset}px)`, "important");
	}
}
