import type { App } from "obsidian";
import CameraCapture from "./CameraCapture.svelte";
import { SvelteModal } from "./SvelteModal";

/**
 * Live webcam preview for photographing something into the chat (a page of
 * handwritten notes, a whiteboard). Desktop has no native "take a photo"
 * sheet the way a phone's file input does, so this is the desktop equivalent:
 * `getUserMedia` into a `<video>`, one frame drawn to a canvas, handed back
 * as a JPEG `File`. Everything stays on the machine; nothing is uploaded until
 * the message is sent like any other attachment.
 */
export class CameraCaptureModal extends SvelteModal {
	private onCapture: (file: File) => void;

	constructor(app: App, onCapture: (file: File) => void) {
		super(app);
		this.onCapture = onCapture;
		this.setTitle("Take photo");
	}

	onOpen() {
		this.mountComponent(
			CameraCapture,
			{ modal: this, onCapture: this.onCapture },
			{ width: "min(960px, 94vw)", maxWidth: "94vw" },
		);
	}
}
