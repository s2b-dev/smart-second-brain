import { type Modal, Platform } from "obsidian";

export interface ModalLayoutOptions {
	width?: string;
	maxWidth?: string;
	height?: string;
	maxHeight?: string;
	contentPadding?: string;
	contentOverflow?: string;
	contentFill?: boolean;
	/**
	 * Present the modal as an edge-to-edge sheet on phones instead of the core
	 * inset floating card (12px side margins, large radius, height fitted to
	 * content). Opt-in per modal: the big editing surfaces want the full screen,
	 * but small dialogs read better keeping the card look.
	 */
	fullScreenOnPhone?: boolean;
}

export function applyModalLayout(modal: Modal, options: ModalLayoutOptions): () => void {
	const {
		width,
		maxWidth,
		height,
		maxHeight,
		contentPadding,
		contentOverflow,
		contentFill = true,
		fullScreenOnPhone = false,
	} = options;

	// Phones never get the desktop width/height (e.g. `min(720px, 94vw)` × `90vh`
	// turns the sheet into a floating box that neither fills the screen nor
	// respects the keyboard inset). What they get instead is one of two native-ish
	// presentations: core's inset card (default), or an edge-to-edge sheet
	// (opt-in).
	//
	// The sheet is sized in `dvh`, not `vh`/`%`: on iOS `vh` resolves against the
	// largest possible viewport (ignoring the browser/app chrome that comes and
	// goes), which overshoots the visible area, and `100%` depends on ancestors
	// that core positions absolutely. It pads with Obsidian's safe-area variables
	// because the modal element carries no padding of its own — without them the
	// title sits under the notch and the footer under the home indicator.
	//
	// `left`/`right` are pinned because themes that inset the phone modal do it
	// by offsetting those rather than by narrowing it, and a `width` alone would
	// leave the sheet shifted off-centre.
	const sizeOverrides = Platform.isPhone
		? fullScreenOnPhone
			? ([
					["width", "100vw"],
					["max-width", "100vw"],
					["height", "100dvh"],
					["max-height", "100dvh"],
					["border-radius", "0"],
					["margin", "0"],
					["left", "0"],
					["right", "0"],
					["padding-top", "var(--safe-area-inset-top, 0px)"],
					["padding-bottom", "var(--safe-area-inset-bottom, 0px)"],
				] as const)
			: []
		: ([
				["width", width],
				["max-width", maxWidth],
				["height", height],
				["max-height", maxHeight],
			] as const);

	const modalStyleMap = new Map<string, string | undefined>(sizeOverrides);

	// The phone sheet's geometry is set at `important` priority. Themes restyle the
	// mobile modal aggressively — Cupertino, for one, ships
	// `width: calc(100vw - 16px) !important` plus a `top: 16px !important` on the
	// close button, targeting `body.mod-macos.is-phone .modal`. An `!important`
	// theme rule beats a plain inline style, so without this the sheet silently
	// keeps the theme's inset card geometry and the close button lands back under
	// the Dynamic Island. Desktop sizing stays normal priority: nothing fights it
	// there, and overriding a user's theme is only justified where the layout
	// would otherwise break.
	const overridePriority = Platform.isPhone && fullScreenOnPhone ? "important" : "";

	for (const [property, value] of modalStyleMap) {
		if (value === undefined) {
			modal.modalEl.style.removeProperty(property);
			continue;
		}

		modal.modalEl.style.setProperty(property, value, overridePriority);
	}

	// Core's phone close/header buttons are absolutely positioned near the sheet's
	// top edge, which on a notched device is the status-bar / Dynamic Island zone.
	// `top` on an absolutely-positioned child resolves against the padding box's
	// outer edge, so the sheet's safe-area `padding-top` does NOT move them —
	// the inset has to be added explicitly. It is 0 on phones without a notch.
	const headerButtons =
		Platform.isPhone && fullScreenOnPhone
			? [...modal.modalEl.querySelectorAll<HTMLElement>(".modal-header-button, .modal-close-button")]
			: [];
	for (const button of headerButtons) {
		button.addClass("s2b-modal-sheet-header-button");
	}

	// Column-flex the modal and its content so the body fills the sheet.
	modal.modalEl.toggleClass("s2b-modal-fill", contentFill);
	modal.contentEl.toggleClass("s2b-modal-fill-content", contentFill);

	if (contentOverflow === undefined) {
		modal.contentEl.style.removeProperty("overflow");
	} else {
		modal.contentEl.style.overflow = contentOverflow;
	}

	if (contentPadding === undefined) {
		modal.contentEl.style.removeProperty("padding");
	} else {
		modal.contentEl.style.padding = contentPadding;
	}

	return () => {
		for (const property of modalStyleMap.keys()) {
			modal.modalEl.style.removeProperty(property);
		}

		for (const button of headerButtons) {
			button.removeClass("s2b-modal-sheet-header-button");
		}

		modal.modalEl.removeClass("s2b-modal-fill");
		modal.contentEl.removeClass("s2b-modal-fill-content");
		modal.contentEl.style.removeProperty("overflow");
		modal.contentEl.style.removeProperty("padding");
	};
}
