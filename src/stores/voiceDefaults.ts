import type { VoiceSettings } from "../types/plugin";

/**
 * Factory defaults for the experimental voice mode. Lives in its own leaf (like
 * `agentDefaults.ts`) so `dataMigrations.ts` can seed the block without importing
 * `DEFAULT_SETTINGS` from `dataStore` — which imports `dataMigrations` itself.
 */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
	enabled: false,
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
