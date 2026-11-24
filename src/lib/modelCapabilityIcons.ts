import type { HydratedChatModelMetadata } from "../types/modelMetadata";
import { t } from "../i18n";

/**
 * Icon + label for each chat-model capability flag, shared by the desktop
 * card (ModelSelectionModal.svelte) and the mobile row (ModelSuggestModal.ts)
 * so both surfaces stay in sync. `structuredOutput` reads as "JSON" in the
 * underlying flag name, but that's the wire format, not something a user
 * asked for — the label spells out what it actually buys them (constrained,
 * schema-valid output), since an icon alone can't carry that.
 */
export const MODEL_CAPABILITY_ICONS: Record<
	Exclude<keyof HydratedChatModelMetadata["capabilities"], "effortLevels">,
	{ icon: string; label: string }
> = {
	toolCalls: { icon: "wrench", label: t("plugin.model_capabilities.tool_calls") },
	reasoning: { icon: "brain", label: t("plugin.model_capabilities.reasoning") },
	vision: { icon: "eye", label: t("plugin.model_capabilities.vision") },
	structuredOutput: { icon: "braces", label: t("plugin.model_capabilities.structured_output") },
};
