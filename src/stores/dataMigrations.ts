import type { PluginData } from "../types/plugin";

/** Increment this when making any breaking change to PluginData. Add a corresponding entry to MIGRATIONS. */
export const CURRENT_SCHEMA_VERSION = 13;

type Migration = (data: PluginData) => void;

/**
 * One entry per version step. MIGRATIONS[v] upgrades data from version v → v+1.
 * Keep entries in order; never remove them.
 */
const MIGRATIONS: Migration[] = [
	// v0 → v1: first versioned release — no structural changes needed
	(_data) => {},
	// v1 → v2: prompt auto-migration added — logic lives in normalizeAgent() which
	//           runs on every load; the version bump marks that the tracking fields exist
	(_data) => {},
	// v2 → v3: per-capability / per-tool guidance version stamps were added here (issue #356) on
	//          loosely-typed old data. Those fields (capabilityPrompts/promptGuidance and their
	//          version stamps) were all later removed — capability guidance and per-tool how-to now
	//          live in skill bodies (v6, "everything is a skill"). This step is now a historical
	//          no-op; the removed fields are stripped in later migrations / normalizeAgent.
	(_data) => {},
	// v3 → v4: skills relocated from `<configDir>/skills` into a vault folder ("Skills").
	//          Existing installs have skills under the config dir, so mark the async move as
	//          pending (SkillsService.migrateSkillsLocation runs it on next init). The actual
	//          file I/O cannot happen here — migrations are synchronous and data-only.
	(data) => {
		(data as unknown as { skillsRelocated: boolean }).skillsRelocated = false;
	},
	// v4 → v5: all agent context consolidated under one configurable vault root `Agent/`
	//          (Memories/ + Skills/{GUIDANCE.md,skills} + Base Prompts/<id>.md). Guidance
	//          and the base system prompt become files (global guidance; per-agent base prompt),
	//          so the per-agent config fields that used to hold them are dropped, along with the
	//          per-agent memory folder (memory is now the global Agent/Memories/). The async file
	//          move (Skills/ or legacy <configDir>/skills → Agent/Skills/) is marked pending
	//          for SkillsService.migrateAgentFolder to run on next init.
	(data) => {
		data.agentFolder ??= "Agents";
		data.agentFolderMigrated = false;
		// Drop removed top-level fields (superseded by agentFolder).
		const loose = data as unknown as Record<string, unknown>;
		loose.skillsFolder = undefined;
		loose.skillsRelocated = undefined;
		// Drop removed per-agent fields — their content is now file-backed or global.
		for (const agent of Object.values(data.agents ?? {})) {
			const a = agent as unknown as Record<string, unknown>;
			// The base system prompt moved from this config field to a file. A customization used
			// to be stashed in a transient for the async seed to write out, but the seeding path
			// that consumed it went away with the AGENT.md consolidation (v10) — the field is now
			// simply dropped.
			a.systemPrompt = undefined;
			a.systemPromptVersion = undefined;
			a.capabilityPrompts = undefined;
			a.capabilityPromptsVersion = undefined;
			a.memoryFolder = undefined;
		}
	},
	// v5 → v6: "everything is a skill". The 4 former capabilities (vault/notes/web/update) become
	//          bundled core skills (`Skills/<id>/SKILL.md`, tools attached via `allowed-tools`); the
	//          eager capability-guidance sections and per-capability GUIDANCE.md files are gone.
	//          Mark the async seed/cleanup pending — SkillsService.migrateCoreSkills runs it on next
	//          init (delete orphan GUIDANCE.md, then bootstrap seeds the new SKILL.md). Also strip the
	//          removed per-tool guidance fields (promptGuidance/promptGuidanceVersion) — per-tool
	//          how-to now lives in the core skill body, not a config field.
	(data) => {
		data.coreSkillsSeeded = false;
		for (const agent of Object.values(data.agents ?? {})) {
			for (const toolCfg of Object.values(agent.toolsConfig ?? {})) {
				const t = toolCfg as unknown as Record<string, unknown>;
				t.promptGuidance = undefined;
				t.promptGuidanceVersion = undefined;
			}
		}
	},
	// v6 → v7: the memory prompt moved from this config field to a file, same treatment as the
	//          v4→v5 base-prompt move — and, like it, the seeding path that consumed the stashed
	//          customization went away with the AGENT.md consolidation (v10), so the field is now
	//          simply dropped.
	(data) => {
		for (const agent of Object.values(data.agents ?? {})) {
			(agent as unknown as Record<string, unknown>).memoryPrompt = undefined;
		}
	},
	// v7 → v8: `update_skill` renamed to `manage_skills` (tool now also creates/deletes skills,
	//          not just edits them) and its bundled skill folder renamed `update-skills` →
	//          `manage-skills`. Two independent keyspaces reference the old names and must both
	//          move, preserving any `enabled: false` veto — otherwise a disabled tool/skill would
	//          silently read as enabled again under the new key (toolsConfig via its own default,
	//          agent.skills via the `?? true` fallback in AgentManager.collectEnabledSkills /
	//          attachedToolIds). The on-disk skill folder itself is renamed by
	//          SkillsService.migrateCoreSkills, not here — migrations are synchronous and data-only.
	(data) => {
		for (const agent of Object.values(data.agents ?? {})) {
			const toolsConfig = agent.toolsConfig as unknown as Record<string, unknown>;
			if (toolsConfig && "update_skill" in toolsConfig) {
				toolsConfig.manage_skills = toolsConfig.update_skill;
				toolsConfig.update_skill = undefined;
			}
			const skills = agent.skills as unknown as Record<string, unknown>;
			if (skills && "update-skills" in skills) {
				skills["manage-skills"] = skills["update-skills"];
				skills["update-skills"] = undefined;
			}
		}
	},
	// v8 → v9: clear `authMode: "codex"` from non-OpenAI providers. ProviderSetup's API-key
	//          toggle writes the literal "codex" to mean "not the API-key path" for ANY
	//          OAuth-capable provider, so simply signing in to OpenRouter persisted an OpenAI
	//          ChatGPT-auth flag onto it. isProviderUsingCodexAuth then read that as real codex
	//          auth and suppressed every embedding model the provider offers. The predicate is
	//          now template-scoped, but stored data keeps the bogus flag — and it would still
	//          reopen ProviderSetup with the API-key field hidden — so strip it here.
	(data) => {
		for (const [providerId, config] of Object.entries(data.providerConfig ?? {})) {
			const templateId = data.providerMeta?.[providerId]?.templateId;
			if (templateId === "openai" || templateId === "openai-codex") continue;
			const auth = config?.auth as unknown as Record<string, unknown> | undefined;
			if (auth && auth.authMode === "codex") {
				auth.authMode = "apiKey";
			}
		}
	},
	// v9 → v10: the per-agent `System Prompts/<Agent Name>/{Base,Memory}.md` pair consolidated
	//           into one `<Agent Name>/AGENT.md`, and `memoryEnabled` was removed — the memory
	//           machinery is always on, and an agent participates iff its AGENT.md body has a
	//           `# Memory` section (which the user can just delete). The file half ran as a
	//           one-shot service that has since been deleted along with the pre-AGENT.md
	//           defaults it needed; only the stale config key is stripped here.
	(data) => {
		for (const agent of Object.values(data.agents ?? {})) {
			(agent as unknown as Record<string, unknown>).memoryEnabled = undefined;
		}
	},
	// v10 → v11: the `edit-notes` core skill renamed `manage-notes` (matching its attached
	//            tool, `manage_notes`), and the manage_notes per-operation settings
	//            (allowCreate/allowUpdate/allowDelete/allowMove) plus its diff-view-mode
	//            dropdown were removed — the staged-review flow is the user's control point,
	//            and `diffViewMode` is now toggled from the pending-changes review bars.
	//            The skills key moves preserving an `enabled: false` veto (same reasoning as
	//            v7 → v8); the stale settings object is dropped so it stops being carried
	//            forward. The on-disk skill folder is renamed/cleaned by
	//            SkillsService.migrateManageNotesFolder — migrations are synchronous and
	//            data-only.
	(data) => {
		for (const agent of Object.values(data.agents ?? {})) {
			const skills = agent.skills as unknown as Record<string, unknown>;
			// Move only into a vacant destination: a pre-v11 vault can already hold a
			// "manage-notes" entry (a user-created skill of that name — the same collision
			// the folder migration refuses to guess about), and that preference must win
			// over the legacy key. In that case the edit-notes key is also KEPT, because
			// the folder migration leaves the legacy folder on disk when both exist, so an
			// "edit-notes" skill remains discoverable and its veto stays meaningful.
			if (skills && "edit-notes" in skills && !("manage-notes" in skills)) {
				skills["manage-notes"] = skills["edit-notes"];
				skills["edit-notes"] = undefined;
			}
			const manageNotes = agent.toolsConfig?.manage_notes as unknown as Record<string, unknown> | undefined;
			if (manageNotes) {
				manageNotes.settings = undefined;
			}
		}
	},
	// v11 → v12: grep_notes' only setting (`contextLines`) was removed. How many lines of
	//            context surround a match is a detail of how the result is formatted for the
	//            model, not something a user has any basis to tune, so it is now a constant in
	//            the tool. Drop the stale settings object — with the tool's gear icon gone from
	//            ToolsModal, the config form never opens for it again and would otherwise never
	//            get the chance to clear it.
	(data) => {
		for (const agent of Object.values(data.agents ?? {})) {
			const grepNotes = agent.toolsConfig?.grep_notes as unknown as Record<string, unknown> | undefined;
			if (grepNotes) {
				grepNotes.settings = undefined;
			}
		}
	},
	// v12 → v13: the stdio MCP transport was removed — it spawned local processes
	//            (`child_process`), i.e. shell access the plugin no longer ships. Any
	//            stdio server entry is dropped; the transport type is `"http"` only from
	//            here on, so a leftover entry would fail type narrowing everywhere it is read.
	(data) => {
		for (const agent of Object.values(data.agents ?? {})) {
			const servers = agent.mcpServers as unknown as
				| Record<string, { transport?: string } | undefined>
				| undefined;
			if (!servers) continue;
			for (const [id, server] of Object.entries(servers)) {
				if (server?.transport === "stdio") delete servers[id];
			}
		}
	},
];

export function runMigrations(data: PluginData): void {
	const from = data.schemaVersion ?? 0;
	// If data was written by a newer plugin, leave schemaVersion untouched so the
	// correct migrations run again when the user upgrades back to the newer version.
	if (from > CURRENT_SCHEMA_VERSION) return;
	for (let v = from; v < CURRENT_SCHEMA_VERSION; v++) {
		MIGRATIONS[v]?.(data);
	}
	data.schemaVersion = CURRENT_SCHEMA_VERSION;
}
