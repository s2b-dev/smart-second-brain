import type { App } from "obsidian";
import { IntegrationPrivacyWarningModal } from "../../components/modal/IntegrationPrivacyWarningModal";
import type { PluginDataStore } from "../../stores/dataStore.svelte";

/**
 * A plugin integration exposes another Obsidian community plugin's public api
 * object (`.api`, or `.apiV1` as a fallback) to the S2B agent via a per-plugin,
 * separately-approvable code-exec tool (`exec:<pluginId>`). Skills that carry
 * `metadata.linkedPlugin: "<pluginId>"` document the api's shape so the agent
 * knows how to call it.
 */
export interface PluginIntegration {
	/** The Obsidian plugin id whose `api` object is exposed to the agent. */
	pluginId: string;
	/** Human-friendly name shown in the UI and to the agent. */
	displayName: string;
	/** Optional bundled skill id (folder name) documenting this plugin's api. */
	skillId?: string;
}

/**
 * Curated integrations S2B ships with good display names and, where available,
 * a bundled skill documenting the plugin's api. Any *other* enabled plugin that
 * exposes an object `api` is auto-discovered at runtime (see AgentManager), so
 * this list is not exhaustive — it just provides nicer defaults for the plugins
 * we know matter.
 */
export const CURATED_PLUGIN_INTEGRATIONS: PluginIntegration[] = [
	{ pluginId: "dataview", displayName: "Dataview", skillId: "dataview" },
	{ pluginId: "obsidian-tasks-plugin", displayName: "Tasks", skillId: "tasks" },
	{ pluginId: "tasknotes", displayName: "TaskNotes", skillId: "tasknotes" },
];

/**
 * Resolve the public api object an *enabled* plugin exposes for scripting.
 * Prefers the conventional `.api`, falling back to `.apiV1` (e.g. the Obsidian
 * Tasks plugin exposes its surface as `apiV1`, not `api`). Both accessors may be
 * lazy or throwing getters, so probe defensively. Returns `null` if neither
 * yields a non-null object.
 */
export function resolvePluginApi(app: App, pluginId: string): object | null {
	// @ts-ignore - Obsidian plugin API (not in official types)
	const plugin = app.plugins?.plugins?.[pluginId];
	if (!plugin) return null;
	for (const key of ["api", "apiV1"] as const) {
		try {
			const candidate = plugin[key];
			if (typeof candidate === "object" && candidate !== null) return candidate;
		} catch {
			// lazy/throwing getter — try the next accessor
		}
	}
	return null;
}

/**
 * Whether an *enabled* plugin exposes an object api we can hand to evaluated
 * code (via `.api` or `.apiV1`). `.api` may be a lazy or throwing getter, so
 * probe defensively.
 */
export function pluginExposesApi(app: App, pluginId: string): boolean {
	return resolvePluginApi(app, pluginId) !== null;
}

/**
 * Whether an Obsidian community plugin is enabled (installed and active).
 */
export function isCommunityPluginEnabled(app: App, pluginId: string): boolean {
	// @ts-ignore - Obsidian plugin API (not in official types)
	return Boolean(app.plugins?.enabledPlugins?.has(pluginId));
}

export type CommunityPluginStatus = "enabled" | "disabled" | "missing";

/**
 * Installed-and-enabled / installed-but-disabled / not installed, for a community
 * plugin id. "Installed" is read from the manifests Obsidian loaded from the plugins
 * folder, so a plugin the user turned off still reads as installed.
 */
export function communityPluginStatus(app: App, pluginId: string): CommunityPluginStatus {
	if (isCommunityPluginEnabled(app, pluginId)) return "enabled";
	// @ts-ignore - Obsidian plugin API (not in official types)
	return app.plugins?.manifests?.[pluginId] ? "disabled" : "missing";
}

/** Human-friendly name for a community plugin id, from the curated table; the id otherwise. */
export function communityPluginDisplayName(pluginId: string): string {
	return (
		CURATED_PLUGIN_INTEGRATIONS.find((integration) => integration.pluginId === pluginId)?.displayName ?? pluginId
	);
}

/**
 * Whether an Obsidian core (internal) plugin is enabled (e.g. "canvas", "bases").
 * Uses undocumented internal API — may need updates with Obsidian changes.
 */
export function isInternalPluginEnabled(app: App, pluginId: string): boolean {
	// @ts-ignore - Obsidian internal plugin API (not in official types)
	const internalPlugins = app.internalPlugins;
	if (!internalPlugins) return false;

	// @ts-ignore - internal API
	const pluginById = internalPlugins.getPluginById?.(pluginId);
	if (pluginById) {
		// @ts-ignore - internal API
		return Boolean(pluginById.enabled);
	}

	// @ts-ignore - internal API
	return Boolean(internalPlugins.plugins?.[pluginId]?.enabled);
}

/** Config key used to persist the per-plugin exec enable state on an agent. */
export const toExecToolId = (pluginId: string): string => `exec:${pluginId}`;

/**
 * Shows the privacy warning before enabling a plugin integration's `exec_<plugin>` tool, unless
 * the user has suppressed it (`pluginData.suppressIntegrationPrivacyWarning`). Shared by every
 * enable surface (AgentEditorModal's Integrations list, the chat empty-state plugin nudge) so
 * the gate can't be skipped by adding a new one — see `createPluginApiExecTool` for why this
 * tool needs the warning: it bypasses `shouldBlockFile` entirely.
 *
 * @returns true if the caller should proceed with enabling the integration.
 */
export async function confirmEnableIntegrationPrivacy(
	app: App,
	pluginData: Pick<PluginDataStore, "suppressIntegrationPrivacyWarning">,
	displayName: string,
): Promise<boolean> {
	if (pluginData.suppressIntegrationPrivacyWarning) return true;

	const modal = new IntegrationPrivacyWarningModal(app, displayName);
	const { confirmed, dontAskAgain } = await modal.prompt();
	if (dontAskAgain) {
		pluginData.suppressIntegrationPrivacyWarning = true;
	}
	return confirmed;
}

/**
 * Runtime tool name bound to the agent. Must be a valid identifier-ish token for
 * the LLM tool-call layer, so the plugin id is sanitized (the raw `exec:<id>`
 * config key keeps the colon; the bound tool name does not).
 */
export const toRuntimeToolName = (pluginId: string): string => `exec_${pluginId.replace(/[^a-zA-Z0-9_]/g, "_")}`;

/**
 * Native Lucide icon ids used by Obsidian core plugins and well-known community
 * plugins, keyed by plugin id. Sourced from each plugin's own ribbon/view icon so
 * a skill row reads with the same glyph the user sees elsewhere in Obsidian
 * (e.g. Canvas's `layout-dashboard`, Bases's `layout-list`). Plugins not listed
 * fall back to a generic category icon (see `getPluginIcon`).
 */
const PLUGIN_ICON_BY_ID: Record<string, string> = {
	// Core plugins.
	canvas: "layout-dashboard",
	bases: "layout-list",
	graph: "git-fork",
	backlink: "links-coming-in",
	"outgoing-link": "links-going-out",
	"tag-pane": "tags",
	outline: "list",
	bookmarks: "bookmark",
	"daily-notes": "calendar",
	templates: "files",
	"command-palette": "terminal",
	properties: "archive",
	"file-explorer": "folder-closed",
	"global-search": "search",
	"word-count": "file-text",
	slides: "presentation",
	"audio-recorder": "mic",
	sync: "refresh-cw",
	// Community plugins we ship curated integrations / skills for.
	"notebook-navigator": "notebook",
	tasknotes: "check-square",
	"obsidian-tasks-plugin": "check-square",
	dataview: "code",
	"obsidian-charts": "bar-chart-3",
};

/**
 * Resolve the Lucide icon id for a plugin by id, matching the glyph Obsidian
 * uses natively. `fallback` is returned for plugins with no known native icon
 * (defaults to a generic puzzle-piece).
 */
export function getPluginIcon(pluginId: string | undefined, fallback = "puzzle"): string {
	if (!pluginId) return fallback;
	return PLUGIN_ICON_BY_ID[pluginId] ?? fallback;
}

/**
 * Distinct glyphs for the bundled core skills (the 4 former capabilities), keyed by skill
 * name. Core-plugin skills (Canvas, Bases, …) have no entry and fall back to their plugin
 * icon via `skillIcon`.
 */
const BUNDLED_CORE_SKILL_ICONS: Record<string, string> = {
	"explore-vault": "compass",
	"manage-notes": "file-pen",
	web: "globe",
	"manage-skills": "wand-2",
	widgets: "component", // = DEFAULT_WIDGET_ICON in widget/widgetIcon.ts
};

/**
 * Fixed display order for the S2B built-in core skills (the 4 former capabilities). Used by
 * both the agent editor's Core Skills list and the agents-summary icon strip so the two never
 * drift. Core-plugin skills (Canvas, Bases, …) are ranked after all of these.
 */
const S2B_CORE_SKILL_ORDER = ["explore-vault", "manage-notes", "web", "manage-skills", "widgets"];

/**
 * Sort rank for a core-category skill: listed S2B built-ins first in `S2B_CORE_SKILL_ORDER`,
 * then any unlisted built-in, then core-plugin skills (which carry a `corePluginId`) last.
 */
export function coreSkillRank(skill: { id: string; corePluginId?: string }): number {
	if (skill.corePluginId) return 1000; // core-plugin skills come last
	const idx = S2B_CORE_SKILL_ORDER.indexOf(skill.id);
	return idx === -1 ? 999 : idx;
}

/**
 * Resolve the icon id for a skill row, shared by the agent editor and the agents-list
 * strip so the two never drift. Order: an explicit frontmatter icon (custom skills) →
 * the bundled core-skill glyph by name → the linked community/core plugin's native icon →
 * a category fallback (`sparkles` for a plain custom skill, else `puzzle`).
 */
export function skillIcon(skill: {
	id: string;
	icon?: string;
	linkedPluginId?: string;
	corePluginId?: string;
	category?: string;
}): string {
	if (skill.icon?.trim()) return skill.icon.trim();
	if (BUNDLED_CORE_SKILL_ICONS[skill.id]) return BUNDLED_CORE_SKILL_ICONS[skill.id];
	if (skill.linkedPluginId) return getPluginIcon(skill.linkedPluginId);
	if (skill.corePluginId) return getPluginIcon(skill.corePluginId, "sparkles");
	return skill.category === "custom" ? "sparkles" : "puzzle";
}
