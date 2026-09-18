import { getIcon } from "obsidian";

/** Tab and toolbar icon for a widget that does not choose its own. */
export const DEFAULT_WIDGET_ICON = "component";

/**
 * The icon a widget shows: its frontmatter `icon` when that is a Lucide name Obsidian
 * knows, the default otherwise. Validated here so a typo in a widget never leaves a
 * blank tab.
 */
export function resolveWidgetIcon(name: string | undefined): string {
	const candidate = name?.trim();
	return candidate && getIcon(candidate) ? candidate : DEFAULT_WIDGET_ICON;
}
