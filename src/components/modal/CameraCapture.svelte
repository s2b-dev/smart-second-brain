<script lang="ts">
import { untrack } from "svelte";
import Button from "../ui/Button.svelte";
import Dropdown from "../ui/Dropdown.svelte";
import type { CameraCaptureModal } from "./CameraCaptureModal";

interface Props {
	modal: CameraCaptureModal;
	/** Called once per photo the user chooses to attach. */
	onCapture: (file: File) => void;
}

const { modal, onCapture }: Props = $props();

let videoEl: HTMLVideoElement | undefined = $state();
let stream: MediaStream | null = $state(null);
let error = $state("");
let starting = $state(true);
let devices: MediaDeviceInfo[] = $state([]);
let selectedDeviceId: string | undefined = $state(undefined);
/** The frozen frame awaiting Attach/Retake; `null` while the live view shows. */
let snapshot: { blob: Blob; url: string } | null = $state(null);
let attachedCount = $state(0);

const deviceOptions = $derived(devices.map((d, i) => ({ display: d.label || `Camera ${i + 1}`, value: d.deviceId })));

function stopStream() {
	for (const track of stream?.getTracks() ?? []) track.stop();
	stream = null;
}

async function startStream(deviceId: string | undefined) {
	stopStream();
	starting = true;
	error = "";
	try {
		// Ask for the highest resolution the camera offers: the point is to read
		// text off a page, and `ideal` degrades gracefully to whatever exists.
		const video: MediaTrackConstraints = deviceId
			? { deviceId: { exact: deviceId }, width: { ideal: 4096 }, height: { ideal: 2160 } }
			: { facingMode: "environment", width: { ideal: 4096 }, height: { ideal: 2160 } };
		const next = await navigator.mediaDevices.getUserMedia({ video, audio: false });
		stream = next;
		// Device labels are only populated once a stream has been granted, so
		// enumerate after, not before. Also learn which device we actually got
		// when none was requested, so the dropdown reflects it.
		devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
		const activeId = next.getVideoTracks()[0]?.getSettings().deviceId;
		if (activeId && selectedDeviceId !== activeId) selectedDeviceId = activeId;
	} catch (e) {
		const name = e instanceof Error ? e.name : "";
		error =
			name === "NotAllowedError"
				? "Camera access was denied. Allow Obsidian to use the camera in your system settings, then try again."
				: name === "NotFoundError"
					? "No camera found on this device."
					: `Could not start the camera: ${e instanceof Error ? e.message : String(e)}`;
	} finally {
		starting = false;
	}
}

// Start once on mount; the cleanup stops whatever stream is live on close, so
// the camera light goes off with the modal. Device switches go through the
// dropdown's `onchange`, not this effect: `startStream` reads and writes
// `stream` synchronously, so a tracked call here would re-run on its own
// assignment and stop the camera it just started.
$effect(() => {
	untrack(() => void startStream(undefined));
	return () => stopStream();
});

// The live `<video>` is remounted when we return from a snapshot, so bind the
// stream whenever either changes rather than only once.
$effect(() => {
	if (videoEl && stream) videoEl.srcObject = stream;
});

$effect(() => {
	// Enter snaps the live view / attaches the frozen one — same as clicking the
	// primary button, so a stack of pages can be captured without the mouse.
	// Registered on the modal's own scope so it only fires while it is frontmost.
	const handler = modal.scope.register([], "Enter", () => {
		if (snapshot) void attach(false);
		else void takePhoto();
		return false;
	});
	return () => modal.scope.unregister(handler);
});

async function takePhoto() {
	if (!videoEl || !stream || snapshot) return;
	const canvas = document.createElement("canvas");
	canvas.width = videoEl.videoWidth;
	canvas.height = videoEl.videoHeight;
	if (canvas.width === 0 || canvas.height === 0) return;
	canvas.getContext("2d")?.drawImage(videoEl, 0, 0);
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
	if (!blob) {
		error = "Could not capture a frame from the camera.";
		return;
	}
	snapshot = { blob, url: URL.createObjectURL(blob) };
}

function retake() {
	if (snapshot) URL.revokeObjectURL(snapshot.url);
	snapshot = null;
}

function photoFileName(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	return `Photo ${stamp}.jpg`;
}

async function attach(andAnother: boolean) {
	if (!snapshot) return;
	onCapture(new File([snapshot.blob], photoFileName(), { type: "image/jpeg" }));
	attachedCount += 1;
	retake();
	if (!andAnother) modal.close();
}
</script>

<div class="s2b-camera">
	{#if error}
		<div class="s2b-camera-error">{error}</div>
	{:else}
		<div class="s2b-camera-frame">
			{#if snapshot}
				<img src={snapshot.url} alt="Captured frame, awaiting Attach or Retake" />
			{:else}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video bind:this={videoEl} autoplay playsinline muted></video>
				{#if starting}
					<div class="s2b-camera-status">Starting camera…</div>
				{/if}
			{/if}
		</div>
	{/if}

	<div class="s2b-camera-bar">
		<div class="s2b-camera-bar-left">
			{#if deviceOptions.length > 1 && !snapshot}
				<Dropdown
					type="options"
					dropdown={deviceOptions}
					bind:selected={selectedDeviceId}
					onchange={(id) => void startStream(id)}
				/>
			{/if}
			{#if attachedCount > 0}
				<span class="setting-item-description">
					{attachedCount} {attachedCount === 1 ? "photo" : "photos"} attached
				</span>
			{/if}
		</div>
		<div class="modal-button-container s2b-camera-buttons">
			{#if snapshot}
				<Button buttonText="Retake" iconId="rotate-ccw" onClick={retake} />
				<Button buttonText="Attach & take another" iconId="plus" onClick={() => attach(true)} />
				<Button buttonText="Attach" iconId="check" cta={true} onClick={() => attach(false)} />
			{:else if error}
				<Button buttonText="Try again" onClick={() => startStream(selectedDeviceId)} />
				<Button buttonText="Close" onClick={() => modal.close()} />
			{:else}
				<Button buttonText="Cancel" onClick={() => modal.close()} />
				<Button buttonText="Take photo" iconId="camera" cta={true} disabled={!stream} onClick={takePhoto} />
			{/if}
		</div>
	</div>
</div>

<style>
	.s2b-camera {
		display: flex;
		flex-direction: column;
		gap: var(--size-4-3);
	}

	/* Letterboxed black frame so portrait and landscape cameras both sit
	   centred at a stable height instead of resizing the modal per device. */
	.s2b-camera-frame {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		background: black;
		border-radius: var(--radius-m);
		overflow: hidden;
		max-height: 70vh;
		min-height: 240px;
	}

	.s2b-camera-frame video,
	.s2b-camera-frame img {
		display: block;
		max-width: 100%;
		max-height: 70vh;
		object-fit: contain;
	}

	.s2b-camera-status {
		position: absolute;
		color: var(--text-on-accent);
		opacity: 0.8;
	}

	.s2b-camera-error {
		padding: var(--size-4-4);
		color: var(--text-error);
		background: var(--background-modifier-error);
		border-radius: var(--radius-m);
	}

	.s2b-camera-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--size-4-3);
		flex-wrap: wrap;
	}

	.s2b-camera-bar-left {
		display: flex;
		align-items: center;
		gap: var(--size-4-3);
	}

	/* Core gives .modal-button-container a top margin for the usual
	   full-width footer; here it shares a row with the device picker. */
	.s2b-camera-buttons {
		margin-top: 0;
		margin-left: auto;
	}
</style>
