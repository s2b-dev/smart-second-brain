import { DEFAULT_TOOLS_CONFIG } from "../agent/tools/builtInToolDefaults";
import { type AgentConfig, type AgentsConfig, DEFAULT_AGENT_ICON, type PluginData } from "../types/plugin";
import { sanitizeAgentFileName } from "../utils/agentPaths";
import { genUUIDv7 } from "../utils/uuid7Validator";

/**
 * ID for the default agent that is always present.
 * This agent cannot be deleted.
 */
export const DEFAULT_AGENT_ID = "default-agent";

/**
 * Creates a new agent configuration with default values.
 * @param id - The unique ID for the agent (defaults to a new UUID)
 * @param name - The display name for the agent (defaults to "New Agent")
 */
export function createDefaultAgentConfig(id?: string, name?: string): AgentConfig {
	return {
		id: id ?? genUUIDv7(),
		name: name ?? "New Agent",
		icon: DEFAULT_AGENT_ICON,
		chatModel: null,
		summarizationModel: null,
		titleModel: null,
		skills: {},
		toolsConfig: structuredClone(DEFAULT_TOOLS_CONFIG),
		mcpServers: {},
		subAgentIds: [],
	};
}

/**
 * Creates the default agent that is always present.
 */
export function createDefaultAgent(): AgentConfig {
	return {
		id: DEFAULT_AGENT_ID,
		name: "S2B Agent",
		icon: DEFAULT_AGENT_ICON,
		chatModel: null,
		summarizationModel: null,
		titleModel: null,
		skills: {},
		toolsConfig: structuredClone(DEFAULT_TOOLS_CONFIG),
		mcpServers: {},
		subAgentIds: [],
	};
}

/**
 * Normalizes an agent in place: fills defaults. The base system prompt is file-backed now
 * (not agent config), so its auto-migration/staleness lives in the prompt-file layer; per-tool
 * and per-skill guidance moved into skill bodies, so there is no per-agent guidance to
 * migrate here anymore.
 */
export function normalizeAgent(agent: AgentConfig): void {
	// Ensure toolsConfig exists and has all tools
	if (agent.toolsConfig) {
		agent.toolsConfig = { ...structuredClone(DEFAULT_TOOLS_CONFIG), ...agent.toolsConfig };
	} else {
		agent.toolsConfig = structuredClone(DEFAULT_TOOLS_CONFIG);
	}

	// Ensure read_content settings have processor fields
	const readSettings = agent.toolsConfig.read_content?.settings as
		| { imageProcessor?: unknown; pdfProcessor?: unknown }
		| undefined;
	if (readSettings) {
		// Do NOT default imageProcessor/pdfProcessor — undefined means "auto-derive
		// from chat model", null means "explicitly disabled by user".
	}

	agent.skills ??= {};
	agent.mcpServers ??= {};
	agent.pluginExecTools ??= {};

	agent.summarizationModel ??= null;
	agent.titleModel ??= null;
}

export function normalizeAgents(mergedData: PluginData): void {
	if (!mergedData.agents[DEFAULT_AGENT_ID]) {
		mergedData.agents[DEFAULT_AGENT_ID] = createDefaultAgent();
	}
	for (const agentId of Object.keys(mergedData.agents)) {
		normalizeAgent(mergedData.agents[agentId]);
	}
	// Repair any persisted name clashes: two agents whose names sanitize to the same
	// base-prompt filename would share/overwrite one note. Uniqueness is normally enforced
	// on write (uniqueAgentName), but a vault could predate that or be hand-edited — so
	// de-duplicate on load too. The built-in default agent is processed first so it keeps
	// its name; later clashers get a numeric suffix (matching uniqueAgentName's scheme).
	dedupeAgentNames(mergedData.agents);
	// Ensure defaultAgentId points at a real agent; fall back to the built-in default
	if (!mergedData.defaultAgentId || !mergedData.agents[mergedData.defaultAgentId]) {
		mergedData.defaultAgentId = DEFAULT_AGENT_ID;
	}
	if (!mergedData.selectedAgentId || !mergedData.agents[mergedData.selectedAgentId]) {
		mergedData.selectedAgentId = mergedData.defaultAgentId;
	}
}

/**
 * Force every agent's name to yield a unique sanitized base-prompt filename, mutating
 * clashing names in place. Deterministic: the built-in default agent is claimed first,
 * then the rest in insertion order; each later clash is suffixed " 2", " 3", … until its
 * sanitized filename is free. Mirrors {@link PluginDataStore.uniqueAgentName} for load time.
 */
function dedupeAgentNames(agents: AgentsConfig): void {
	const taken = new Set<string>();
	const order = Object.keys(agents).sort((a, b) => {
		if (a === DEFAULT_AGENT_ID) return -1;
		if (b === DEFAULT_AGENT_ID) return 1;
		return 0;
	});
	for (const id of order) {
		const agent = agents[id];
		const base = agent.name?.trim() || "Agent";
		let candidate = base;
		for (let n = 2; taken.has(sanitizeAgentFileName(candidate)); n++) {
			candidate = `${base} ${n}`;
		}
		if (candidate !== agent.name) agent.name = candidate;
		taken.add(sanitizeAgentFileName(candidate));
	}
}
