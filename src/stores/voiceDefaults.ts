import type { VoiceOrbStyle, VoiceSettings } from "../types/plugin";

/**
 * Factory defaults for the experimental voice mode. Lives in its own leaf (like
 * `agentDefaults.ts`) so `dataMigrations.ts` can seed the block without importing
 * `DEFAULT_SETTINGS` from `dataStore` — which imports `dataMigrations` itself.
 */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
	enabled: false,
	orbStyle: "nebula",
	model: "gpt-realtime",
	voice: "marin",
	turnDetection: "semantic_vad",
};

/** Voice presets offered by the OpenAI Realtime API. `marin` and `cedar` ship with `gpt-realtime`. */
export const VOICE_OPTIONS: readonly string[] = [
	"marin",
	"cedar",
	"alloy",
	"ash",
	"ballad",
	"coral",
	"echo",
	"sage",
	"shimmer",
	"verse",
];

/** Orb looks offered in Developer settings, with their labels. */
export const VOICE_ORB_STYLES: readonly { value: VoiceOrbStyle; display: string }[] = [
	{ value: "nebula", display: "Nebula (morphing colour clouds)" },
	{ value: "blob", display: "Blob (morphing, Siri-like)" },
	{ value: "aurora", display: "Aurora (drifting colour clouds)" },
	{ value: "spectrum", display: "Spectrum (radial equaliser)" },
	{ value: "ripple", display: "Ripple (sonar rings)" },
	{ value: "pulse", display: "Pulse (plain glowing disc)" },
];
