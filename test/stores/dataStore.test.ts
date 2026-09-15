import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

// Polyfill Obsidian's Array.prototype.remove (added at runtime by Obsidian)
beforeAll(() => {
	if (!(Array.prototype as unknown as Record<string, unknown>).remove) {
		(Array.prototype as unknown as Record<string, unknown>).remove = function <T>(this: T[], item: T) {
			const idx = this.indexOf(item);
			if (idx >= 0) this.splice(idx, 1);
		};
	}

	// jsdom ships no indexedDB. The store only ever calls `databases()` here, so this stubs
	// that one method rather than the whole IDBFactory surface — hence the cast, which is
	// deliberately narrowed to the assignment instead of widening the global's type.
	if (!globalThis.indexedDB) {
		globalThis.indexedDB = { databases: vi.fn().mockResolvedValue([]) } as unknown as IDBFactory;
	}
});

// Mock secretStorage — provider auth tests need it
vi.mock("../../src/lib/secretStorage", () => ({
	getSecret: vi.fn(() => null),
	setSecret: vi.fn(),
	listSecrets: vi.fn(() => []),
}));

import { DEFAULT_TOOLS_CONFIG } from "../../src/agent/tools/builtInToolDefaults";
import { DEFAULT_AGENT_ID, createDefaultAgentConfig } from "../../src/stores/agentDefaults";
import {
	PluginDataStore,
	DEFAULT_SETTINGS,
	createData,
	__resetPluginDataStoreForTests,
	AddChatModelError,
	AddEmbedModelError,
	SetChatModelError,
	SetEmbedModelError,
} from "../../src/stores/dataStore.svelte";
import { compilePrivacyMembershipDraft } from "../../src/lib/views";
import type { StoredProviderState } from "../../src/stores/dataStore.svelte";
import type { PromptFileReader, PromptFileSnapshot } from "../../src/types/plugin";
import { AGENT_PROMPT_VERSION, DEFAULT_AGENT_PROMPT } from "../../src/agent/prompts";
import { fingerprint, shippedVersion } from "../../src/utils/shippedDefaults";

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------*/

function createMockPlugin() {
	return {
		app: {
			vault: {
				adapter: { exists: vi.fn(), read: vi.fn(), write: vi.fn() },
				getName: vi.fn().mockReturnValue("Test Vault"),
				getAbstractFileByPath: vi.fn(),
				getFolderByPath: vi.fn().mockReturnValue(null),
				createFolder: vi.fn().mockResolvedValue(undefined),
				// `PluginDataStore` subscribes to vault renames (to keep the privacy
				// filter from going stale) directly in its constructor, so every store
				// under test needs this even when the test has nothing to do with renames.
				on: vi.fn().mockReturnValue({}),
			},
			appId: "test-vault-id",
		},
		manifest: { id: "smart-second-brain", dir: "smart-second-brain" },
		saveData: vi.fn().mockResolvedValue(undefined),
		registerEvent: vi.fn(),
	};
}

function createProviderState(overrides?: Partial<StoredProviderState>): StoredProviderState {
	return {
		isConfigured: false,
		auth: { values: {}, secretIds: {} },
		chatModels: {},
		embedModels: {},
		trustedForPrivateData: false,
		...overrides,
	};
}

function makeStore(overrides?: Partial<typeof DEFAULT_SETTINGS>) {
	const plugin = createMockPlugin();
	const data = structuredClone({
		...DEFAULT_SETTINGS,
		providerConfig: {
			openai: createProviderState(),
			anthropic: createProviderState(),
			ollama: createProviderState({ trustedForPrivateData: true }),
			openrouter: createProviderState(),
		},
		...overrides,
	});
	return { store: new PluginDataStore(plugin as never, data as never), plugin };
}

/* --------------------------------------------------------------------------
 * createDefaultAgentConfig
 * ------------------------------------------------------------------------*/

describe("createDefaultAgentConfig", () => {
	it("should create agent config with defaults", () => {
		const agent = createDefaultAgentConfig();
		expect(agent.id).toBeDefined();
		expect(agent.name).toBe("New Agent");
		expect(agent.chatModel).toBeNull();
		expect(agent.summarizationModel).toBeNull();
		expect(agent.toolsConfig).toBeDefined();
		expect(agent.mcpServers).toEqual({});
	});

	it("should accept custom id and name", () => {
		const agent = createDefaultAgentConfig("custom-id", "My Agent");
		expect(agent.id).toBe("custom-id");
		expect(agent.name).toBe("My Agent");
	});

	it("should include default tools config", () => {
		const agent = createDefaultAgentConfig();
		expect(agent.toolsConfig.search_notes).toBeDefined();
		expect(agent.toolsConfig.read_content).toBeDefined();
		expect(agent.toolsConfig.manage_notes).toBeDefined();
	});
});

/* --------------------------------------------------------------------------
 * Agent CRUD
 * ------------------------------------------------------------------------*/

describe("PluginDataStore – Agent CRUD", () => {
	let store: PluginDataStore;

	beforeEach(() => {
		({ store } = makeStore());
	});

	it("should have the default agent on creation", () => {
		expect(store.getAgent(DEFAULT_AGENT_ID)).toBeDefined();
		expect(store.getAgent(DEFAULT_AGENT_ID)!.name).toBe("S2B Agent");
		expect(store.getAgentIds()).toContain(DEFAULT_AGENT_ID);
	});

	it("should create a new agent", () => {
		const agent = store.createAgent("Test Agent");
		expect(agent.name).toBe("Test Agent");
		expect(agent.id).toBeDefined();
		expect(store.getAgent(agent.id)).toBeDefined();
		expect(store.getAgentIds()).toContain(agent.id);
	});

	it("should update an existing agent", () => {
		const agent = store.createAgent("Original");
		store.updateAgent(agent.id, { name: "Updated" });
		expect(store.getAgent(agent.id)!.name).toBe("Updated");
	});

	it("should throw when updating a non-existent agent", () => {
		expect(() => store.updateAgent("nonexistent", { name: "X" })).toThrow("not found");
	});

	it("should delete an agent", () => {
		const agent = store.createAgent("To Delete");
		store.deleteAgent(agent.id);
		expect(store.getAgent(agent.id)).toBeUndefined();
	});

	it("should not allow deleting the default agent", () => {
		expect(() => store.deleteAgent(DEFAULT_AGENT_ID)).toThrow("Cannot delete");
	});

	it("should throw when deleting non-existent agent", () => {
		expect(() => store.deleteAgent("nonexistent")).toThrow("not found");
	});

	it("should switch selectedAgentId to default when deleted agent was selected", () => {
		const agent = store.createAgent("Temp");
		store.selectedAgentId = agent.id;
		expect(store.selectedAgentId).toBe(agent.id);

		store.deleteAgent(agent.id);
		expect(store.selectedAgentId).toBe(DEFAULT_AGENT_ID);
	});

	it("should fall back to the built-in default when that agent is deleted", () => {
		const agent = store.createAgent("Custom Default");
		store.setDefaultAgentId(agent.id);
		expect(store.defaultAgentId).toBe(agent.id);

		store.deleteAgent(agent.id);
		expect(store.defaultAgentId).toBe(DEFAULT_AGENT_ID);
	});

	it("should duplicate an agent", () => {
		store.updateAgent(DEFAULT_AGENT_ID, {
			summarizationModel: { provider: "openai", model: "gpt-4o-mini" } as never,
		});
		const dupe = store.duplicateAgent(DEFAULT_AGENT_ID, "Copy of Default");
		expect(dupe.name).toBe("Copy of Default");
		expect(dupe.id).not.toBe(DEFAULT_AGENT_ID);
		expect(dupe.summarizationModel).toEqual({ provider: "openai", model: "gpt-4o-mini" });
	});

	// Display names must be unique because they drive each agent's base-prompt filename.
	it("auto-suffixes a duplicate name on create", () => {
		const first = store.createAgent("Research");
		const second = store.createAgent("Research");
		expect(first.name).toBe("Research");
		expect(second.name).toBe("Research 2");
	});

	it("auto-suffixes a duplicate name on duplicate", () => {
		store.createAgent("Research");
		const dupe = store.duplicateAgent(DEFAULT_AGENT_ID, "Research");
		expect(dupe.name).toBe("Research 2");
	});

	it("auto-suffixes when renaming into an existing name", () => {
		store.createAgent("Research");
		const other = store.createAgent("Draft");
		store.updateAgent(other.id, { name: "Research" });
		expect(store.getAgent(other.id)!.name).toBe("Research 2");
	});

	it("renaming an agent to its own current name is a no-op (no suffix)", () => {
		const agent = store.createAgent("Research");
		store.updateAgent(agent.id, { name: "Research" });
		expect(store.getAgent(agent.id)!.name).toBe("Research");
	});

	it("falls back to 'Agent' for an empty name", () => {
		const agent = store.createAgent("   ");
		expect(agent.name).toBe("Agent");
	});

	it("auto-suffixes when two distinct names sanitize to the same filename", () => {
		// "A/B" and "A B" both sanitize to "A B" — uniqueness is enforced on the sanitized
		// filename, so the second must be nudged even though the raw names differ.
		const first = store.createAgent("A/B");
		const second = store.createAgent("A B");
		expect(first.name).toBe("A/B");
		expect(second.name).toBe("A B 2");
	});

	it("should throw when duplicating non-existent agent", () => {
		expect(() => store.duplicateAgent("nonexistent", "Copy")).toThrow("not found");
	});

	it("should scrub deleted agent from other agents' subAgentIds", () => {
		const parent = store.createAgent("Parent");
		const sub = store.createAgent("Sub");
		store.setSubAgentEnabled(parent.id, sub.id, true);
		expect(store.getSubAgentIds(parent.id)).toContain(sub.id);

		store.deleteAgent(sub.id);
		expect(store.getSubAgentIds(parent.id)).not.toContain(sub.id);
	});

	it("should remap a self-reference to the duplicate when duplicating", () => {
		const agent = store.createAgent("Self-Delegating");
		store.setSubAgentEnabled(agent.id, agent.id, true); // self-reference
		const dupe = store.duplicateAgent(agent.id, "Copy");
		// The duplicate must delegate to ITSELF, not back to the source agent.
		expect(dupe.subAgentIds).toContain(dupe.id);
		expect(dupe.subAgentIds).not.toContain(agent.id);
	});

	it("should keep a non-self subagent reference intact when duplicating", () => {
		const agent = store.createAgent("Delegator");
		const other = store.createAgent("Other");
		store.setSubAgentEnabled(agent.id, other.id, true);
		const dupe = store.duplicateAgent(agent.id, "Copy");
		expect(dupe.subAgentIds).toContain(other.id);
		expect(dupe.subAgentIds).not.toContain(dupe.id);
	});
});

/* --------------------------------------------------------------------------
 * Agent selection
 * ------------------------------------------------------------------------*/

describe("PluginDataStore – Agent Selection", () => {
	let store: PluginDataStore;

	beforeEach(() => {
		({ store } = makeStore());
	});

	it("should get and set selectedAgentId", () => {
		const agent = store.createAgent("Agent A");
		store.selectedAgentId = agent.id;
		expect(store.selectedAgentId).toBe(agent.id);
	});

	it("should not set selectedAgentId to non-existent agent", () => {
		store.selectedAgentId = "nonexistent";
		expect(store.selectedAgentId).toBe(DEFAULT_AGENT_ID);
	});

	it("should get the selected agent config", () => {
		const selected = store.getSelectedAgent();
		expect(selected.id).toBe(DEFAULT_AGENT_ID);
	});

	it("should get and set defaultAgentId", () => {
		const agent = store.createAgent("Default Candidate");
		store.setDefaultAgentId(agent.id);
		expect(store.defaultAgentId).toBe(agent.id);
	});

	it("should throw when setting default to non-existent agent", () => {
		expect(() => store.setDefaultAgentId("nonexistent")).toThrow("not found");
	});
});

/* --------------------------------------------------------------------------
 * Agent tool configuration
 * ------------------------------------------------------------------------*/

describe("PluginDataStore – Agent Tools", () => {
	let store: PluginDataStore;

	beforeEach(() => {
		({ store } = makeStore());
	});

	it("should check if a tool is enabled for an agent", () => {
		expect(store.isAgentToolEnabled(DEFAULT_AGENT_ID, "search_notes")).toBe(true);
	});

	it("should toggle tool enabled state", () => {
		store.toggleAgentToolEnabled(DEFAULT_AGENT_ID, "search_notes");
		expect(store.isAgentToolEnabled(DEFAULT_AGENT_ID, "search_notes")).toBe(false);

		store.toggleAgentToolEnabled(DEFAULT_AGENT_ID, "search_notes");
		expect(store.isAgentToolEnabled(DEFAULT_AGENT_ID, "search_notes")).toBe(true);
	});

	it("should update tool config", () => {
		store.updateAgentToolConfig(DEFAULT_AGENT_ID, "search_notes", {
			description: "Custom description",
		});

		const agent = store.getAgent(DEFAULT_AGENT_ID)!;
		expect(agent.toolsConfig.search_notes.description).toBe("Custom description");
	});
});

/* --------------------------------------------------------------------------
 * Agent MCP servers
 * ------------------------------------------------------------------------*/

describe("PluginDataStore – Agent MCP Servers", () => {
	let store: PluginDataStore;

	beforeEach(() => {
		({ store } = makeStore());
	});

	it("should return empty MCP config by default", () => {
		expect(store.getAgentMCPServers(DEFAULT_AGENT_ID)).toEqual({});
	});

	it("should set and get MCP server for agent", () => {
		store.setAgentMCPServer(DEFAULT_AGENT_ID, "my-server", {
			displayName: "my-server",
			transport: "http",
			url: "http://localhost:3000/mcp",
			enabled: true,
		});

		const servers = store.getAgentMCPServers(DEFAULT_AGENT_ID);
		expect(servers["my-server"]).toBeDefined();
		expect(servers["my-server"].transport).toBe("http");
		expect(servers["my-server"].enabled).toBe(true);
	});

	it("should delete MCP server from agent", () => {
		store.setAgentMCPServer(DEFAULT_AGENT_ID, "to-delete", {
			displayName: "to-delete",
			transport: "http",
			url: "http://localhost:3000",
			enabled: true,
		});

		store.deleteAgentMCPServer(DEFAULT_AGENT_ID, "to-delete");
		expect(store.getAgentMCPServers(DEFAULT_AGENT_ID)["to-delete"]).toBeUndefined();
	});

	it("should toggle MCP server enabled state", () => {
		store.setAgentMCPServer(DEFAULT_AGENT_ID, "toggle-me", {
			displayName: "toggle-me",
			transport: "http",
			url: "http://localhost:3000/mcp",
			enabled: true,
		});

		store.toggleAgentMCPServerEnabled(DEFAULT_AGENT_ID, "toggle-me");
		expect(store.getAgentMCPServers(DEFAULT_AGENT_ID)["toggle-me"].enabled).toBe(false);
	});

	it("should convert MCP config for client (only enabled servers)", () => {
		store.setAgentMCPServer(DEFAULT_AGENT_ID, "enabled-server", {
			displayName: "enabled-server",
			transport: "http",
			url: "http://localhost:3001/mcp",
			enabled: true,
		});
		store.setAgentMCPServer(DEFAULT_AGENT_ID, "disabled-server", {
			displayName: "disabled-server",
			transport: "http",
			url: "http://localhost:3002/mcp",
			enabled: false,
		});

		const clientConfig = store.getAgentMCPServersForClient(DEFAULT_AGENT_ID);
		expect(clientConfig["enabled-server"]).toBeDefined();
		expect(clientConfig["disabled-server"]).toBeUndefined();
	});
});

/* --------------------------------------------------------------------------
 * Chat model management
 * ------------------------------------------------------------------------*/

describe("PluginDataStore – Chat Models", () => {
	let store: PluginDataStore;

	beforeEach(() => {
		({ store } = makeStore());
	});

	it("should add a chat model", () => {
		store.addChatModel("openai", "gpt-4", { temperature: 0.7 } as never);
		const models = store.getChatModels("openai");
		expect(models["gpt-4"]).toBeDefined();
	});

	it("should throw when adding duplicate chat model", () => {
		store.addChatModel("openai", "gpt-4", {} as never);
		expect(() => store.addChatModel("openai", "gpt-4", {} as never)).toThrow(AddChatModelError);
	});

	it("should update an existing chat model", () => {
		store.addChatModel("openai", "gpt-4", { temperature: 0.5 } as never);
		store.updateChatModel("openai", "gpt-4", { temperature: 0.9 } as never);
		expect(store.getChatModels("openai")["gpt-4"].temperature).toBe(0.9);
	});

	it("should throw when updating non-existent model", () => {
		expect(() => store.updateChatModel("openai", "nonexistent", {} as never)).toThrow(SetChatModelError);
	});

	it("should delete a chat model", () => {
		store.addChatModel("openai", "gpt-4", {} as never);
		store.deleteChatModel("openai", "gpt-4");
		expect(store.getChatModels("openai")["gpt-4"]).toBeUndefined();
	});

	it("should clear agent chatModel reference when its model is deleted", () => {
		store.addChatModel("openai", "gpt-4", {} as never);
		store.updateAgent(DEFAULT_AGENT_ID, { chatModel: { provider: "openai", model: "gpt-4", modelConfig: {} } });

		store.deleteChatModel("openai", "gpt-4");
		expect(store.getAgent(DEFAULT_AGENT_ID)!.chatModel).toBeNull();
	});

	it("should clear agent summarizationModel reference when its model is deleted", () => {
		store.addChatModel("openai", "gpt-4o-mini", {} as never);
		store.updateAgent(DEFAULT_AGENT_ID, {
			summarizationModel: { provider: "openai", model: "gpt-4o-mini" } as never,
		});

		store.deleteChatModel("openai", "gpt-4o-mini");
		expect(store.getAgent(DEFAULT_AGENT_ID)!.summarizationModel).toBeNull();
	});
});

describe("createData", () => {
	// createData memoizes a module-level singleton; reset it so each fixture migrates fresh.
	beforeEach(() => {
		__resetPluginDataStoreForTests();
	});

	it("should default missing summarizationModel to null for saved agents without that field", async () => {
		const plugin = {
			...createMockPlugin(),
			loadData: vi.fn().mockResolvedValue({
				...structuredClone(DEFAULT_SETTINGS),
				agents: {
					[DEFAULT_AGENT_ID]: {
						id: DEFAULT_AGENT_ID,
						name: "S2B Agent",
						chatModel: null,
						systemPrompt: "Saved prompt",
						skills: {},
						toolsConfig: structuredClone(DEFAULT_TOOLS_CONFIG),
						mcpServers: {},
					},
				},
			}),
		};

		const store = await createData(plugin as never);
		expect(store.getAgent(DEFAULT_AGENT_ID)?.summarizationModel).toBeNull();
	});

	// v4→v5 moved the base system prompt from the `systemPrompt` config field to a file. A
	// customization used to be stashed on `migratedBasePrompt` for the async seed to write out,
	// but the seeding path that consumed it went away with the AGENT.md consolidation (v10), so
	// the field is now simply dropped either way.
	it("drops the legacy systemPrompt field across the v4→v5 migration", async () => {
		const plugin = {
			...createMockPlugin(),
			loadData: vi.fn().mockResolvedValue({
				...structuredClone(DEFAULT_SETTINGS),
				schemaVersion: 4,
				agents: {
					[DEFAULT_AGENT_ID]: {
						id: DEFAULT_AGENT_ID,
						name: "S2B Agent",
						chatModel: null,
						systemPrompt: "MY CUSTOM PROMPT",
						skills: {},
						toolsConfig: structuredClone(DEFAULT_TOOLS_CONFIG),
						mcpServers: {},
					},
				},
			}),
		};

		const store = await createData(plugin as never);
		const agent = store.getAgent(DEFAULT_AGENT_ID) as unknown as {
			systemPrompt?: unknown;
			migratedBasePrompt?: string;
		};
		expect(agent.systemPrompt).toBeUndefined();
		expect(agent.migratedBasePrompt).toBeUndefined();
	});

	/*
	 * v9→v10 removed `memoryEnabled`: the memory machinery is always on, and participation is
	 * expressed by the `# Memory` section of the agent's AGENT.md instead. The stale config key
	 * must not survive the load.
	 */
	it("strips memoryEnabled across the v9→v10 migration", async () => {
		const mkAgent = (id: string, memoryEnabled: boolean) => ({
			id,
			name: id,
			chatModel: null,
			skills: {},
			toolsConfig: structuredClone(DEFAULT_TOOLS_CONFIG),
			mcpServers: {},
			memoryEnabled,
		});
		const plugin = {
			...createMockPlugin(),
			loadData: vi.fn().mockResolvedValue({
				...structuredClone(DEFAULT_SETTINGS),
				schemaVersion: 9,
				agents: { [DEFAULT_AGENT_ID]: mkAgent(DEFAULT_AGENT_ID, true), off: mkAgent("off", false) },
			}),
		};

		const store = await createData(plugin as never);

		const on = store.getAgent(DEFAULT_AGENT_ID) as unknown as { memoryEnabled?: boolean };
		const off = store.getAgent("off") as unknown as { memoryEnabled?: boolean };
		expect(on.memoryEnabled).toBeUndefined();
		expect(off.memoryEnabled).toBeUndefined();
	});

	/*
	 * v10→v11 renamed the `edit-notes` core skill to `manage-notes` and removed the
	 * manage_notes per-operation settings. The skills key must move preserving an
	 * `enabled: false` veto (otherwise the `?? true` fallback silently re-enables the
	 * skill under its new name), and the stale settings object must not survive the load.
	 */
	it("moves the edit-notes skill key and drops manage_notes settings across the v10→v11 migration", async () => {
		const toolsConfig = structuredClone(DEFAULT_TOOLS_CONFIG) as unknown as Record<string, { settings?: unknown }>;
		toolsConfig.manage_notes.settings = {
			allowCreate: true,
			allowUpdate: true,
			allowDelete: false,
			allowMove: true,
		};
		const plugin = {
			...createMockPlugin(),
			loadData: vi.fn().mockResolvedValue({
				...structuredClone(DEFAULT_SETTINGS),
				schemaVersion: 10,
				agents: {
					[DEFAULT_AGENT_ID]: {
						id: DEFAULT_AGENT_ID,
						name: "S2B Agent",
						chatModel: null,
						skills: { "edit-notes": { enabled: false } },
						toolsConfig,
						mcpServers: {},
					},
				},
			}),
		};

		const store = await createData(plugin as never);

		const agent = store.getAgent(DEFAULT_AGENT_ID)!;
		expect(agent.skills["manage-notes"]?.enabled).toBe(false);
		expect(agent.skills["edit-notes"]).toBeUndefined();
		expect((agent.toolsConfig.manage_notes as { settings?: unknown }).settings).toBeUndefined();
	});

	/*
	 * A pre-v11 vault can already hold a "manage-notes" entry — a user-created skill of
	 * that name. Its preference must win over the legacy key, and the edit-notes key is
	 * kept because the folder migration also leaves the legacy folder on disk when both
	 * exist, so that skill remains discoverable and its veto stays meaningful.
	 */
	it("keeps an existing manage-notes preference when both skill keys are present (v10→v11)", async () => {
		const plugin = {
			...createMockPlugin(),
			loadData: vi.fn().mockResolvedValue({
				...structuredClone(DEFAULT_SETTINGS),
				schemaVersion: 10,
				agents: {
					[DEFAULT_AGENT_ID]: {
						id: DEFAULT_AGENT_ID,
						name: "S2B Agent",
						chatModel: null,
						skills: { "edit-notes": { enabled: false }, "manage-notes": { enabled: true } },
						toolsConfig: structuredClone(DEFAULT_TOOLS_CONFIG),
						mcpServers: {},
					},
				},
			}),
		};

		const store = await createData(plugin as never);

		const agent = store.getAgent(DEFAULT_AGENT_ID)!;
		expect(agent.skills["manage-notes"]?.enabled).toBe(true);
		expect(agent.skills["edit-notes"]?.enabled).toBe(false);
	});

	it("de-duplicates persisted agent names that sanitize to the same prompt filename", async () => {
		const mkAgent = (id: string, name: string) => ({
			id,
			name,
			chatModel: null,
			systemPrompt: "",
			skills: {},
			toolsConfig: structuredClone(DEFAULT_TOOLS_CONFIG),
			mcpServers: {},
		});
		const plugin = {
			...createMockPlugin(),
			loadData: vi.fn().mockResolvedValue({
				...structuredClone(DEFAULT_SETTINGS),
				agents: {
					[DEFAULT_AGENT_ID]: mkAgent(DEFAULT_AGENT_ID, "S2B Agent"),
					// Distinct raw names that both sanitize to "Research Assistant".
					a1: mkAgent("a1", "Research/Assistant"),
					a2: mkAgent("a2", "Research Assistant"),
				},
			}),
		};

		const store = await createData(plugin as never);
		const n1 = store.getAgent("a1")!.name;
		const n2 = store.getAgent("a2")!.name;
		// First occurrence keeps its name; the clashing one is suffixed so the sanitized
		// filenames differ.
		expect(n1).not.toBe(n2);
		expect(new Set([n1, n2]).size).toBe(2);
	});
});

/* --------------------------------------------------------------------------
 * Stale-guidance detection (#356) — reactive, derived from live agent state
 * ------------------------------------------------------------------------*/

describe("PluginDataStore – staleGuidance", () => {
	// A minimal agent (no removed prompt/guidance fields — the base prompt is file-backed now,
	// and skill/tool guidance moved into skill bodies).
	function agentData() {
		return {
			agents: {
				[DEFAULT_AGENT_ID]: {
					id: DEFAULT_AGENT_ID,
					name: "S2B Agent",
					chatModel: null,
					skills: {},
					toolsConfig: { ...structuredClone(DEFAULT_TOOLS_CONFIG) },
					mcpServers: {},
				},
			},
			defaultAgentId: DEFAULT_AGENT_ID,
			selectedAgentId: DEFAULT_AGENT_ID,
		};
	}

	// A reader over the file-backed prompt surface. Values are parsed snapshots: the
	// frontmatter-stripped body plus the baseline version the note's frontmatter records.
	function makeReader(files: { agentPrompt?: Record<string, PromptFileSnapshot> }): PromptFileReader {
		return {
			getAgentPromptFile: (agentId) => files.agentPrompt?.[agentId] ?? null,
		};
	}

	it("reports nothing when no reader is set (early startup)", () => {
		const { store } = makeStore(agentData() as never);
		expect(store.staleGuidance).toEqual([]);
	});

	it("does NOT flag a prompt file that equals the current default", () => {
		const { store } = makeStore(agentData() as never);
		store.setPromptFileReader(
			makeReader({
				agentPrompt: { [DEFAULT_AGENT_ID]: { body: DEFAULT_AGENT_PROMPT, version: AGENT_PROMPT_VERSION } },
			}),
		);
		expect(store.staleGuidance).toEqual([]);
	});

	it("does NOT flag absent prompt files (the live defaults are used)", () => {
		const { store } = makeStore(agentData() as never);
		store.setPromptFileReader(makeReader({}));
		expect(store.staleGuidance).toEqual([]);
	});

	it("does NOT flag a customization whose baseline is still the current default", () => {
		const { store } = makeStore(agentData() as never);
		// The note's frontmatter stamps the current version: they customized it, but the
		// default hasn't moved since — there is nothing to tell them about. Uses the live
		// version constants so this keeps meaning "current" across prompt revisions.
		store.setPromptFileReader(
			makeReader({
				agentPrompt: { [DEFAULT_AGENT_ID]: { body: "my own custom prompt", version: AGENT_PROMPT_VERSION } },
			}),
		);
		expect(store.staleGuidance).toEqual([]);
	});

	it("does NOT flag a customization with no recorded baseline", () => {
		const { store } = makeStore(agentData() as never);
		// version: undefined = the user removed (or predates) the note's frontmatter.
		store.setPromptFileReader(
			makeReader({ agentPrompt: { [DEFAULT_AGENT_ID]: { body: "my own custom prompt", version: undefined } } }),
		);
		// No baseline ⇒ we cannot substantiate that the default moved under this edit.
		// Staying silent beats asserting drift we can't prove.
		expect(store.staleGuidance).toEqual([]);
	});

	/*
	 * The case this stamp exists for: the user customized a prompt, and a LATER release
	 * changed the shipped default. Their edit is untouched (correct), but they'd otherwise
	 * never learn the default moved — the improvement would be invisible to exactly the
	 * users who engaged with the prompt enough to edit it.
	 */
	it("flags a customization whose baseline has been superseded", () => {
		const { store } = makeStore(agentData() as never);
		// The note's frontmatter records a baseline older than the current shipped version.
		store.setPromptFileReader(
			makeReader({ agentPrompt: { [DEFAULT_AGENT_ID]: { body: "my own custom prompt", version: 0 } } }),
		);

		const stale = store.staleGuidance;
		expect(stale.map((s) => s.kind)).toEqual(["system-prompt"]);
		// `customized: true` drives the "your customized version was kept" wording and the
		// Review action's diff — distinct from the untouched-old-default case.
		expect(stale[0].customized).toBe(true);
		expect(stale[0].agentId).toBe(DEFAULT_AGENT_ID);
	});

	it("does NOT flag a prompt whose only difference is line endings or a trailing newline", () => {
		const { store } = makeStore(agentData() as never);
		store.setPromptFileReader(
			makeReader({
				agentPrompt: {
					[DEFAULT_AGENT_ID]: {
						body: `${DEFAULT_AGENT_PROMPT.replace(/\n/g, "\r\n")}\n`,
						version: AGENT_PROMPT_VERSION,
					},
				},
			}),
		);
		// Round-tripping through the vault adapter or an editor can do this without the user
		// touching a character; treating it as a customization would misclassify installs
		// wholesale, in the direction that silently withholds updates.
		expect(store.staleGuidance).toEqual([]);
	});

	// Exercised against synthetic histories so the test stays independent of how many
	// versions have actually shipped. This is the case that was previously untestable and
	// that the memory prompt had no mechanism for at all.
	it("flags a prompt file that matches an OLD shipped default", () => {
		const oldPrompt = "an older agent prompt we used to ship";
		const neverShipped = "text we never shipped";

		expect(shippedVersion(oldPrompt, new Map([[1, fingerprint(oldPrompt)]]))).toBe(1);

		// Two versions: the old one is not the newest key, so it reads as stale.
		const history = new Map([
			[1, fingerprint(oldPrompt)],
			[2, fingerprint(DEFAULT_AGENT_PROMPT)],
		]);
		expect(shippedVersion(oldPrompt, history)).toBe(1);
		expect(shippedVersion(DEFAULT_AGENT_PROMPT, history)).toBe(2);
		expect(shippedVersion(neverShipped, history)).toBeNull();
	});

	it("flags stale skills reported by the skills service, keyed globally", () => {
		const { store } = makeStore(agentData() as never);
		store.setPromptFileReader(makeReader({}));
		store.setStaleSkills(["explore-vault", "web"]);

		const stale = store.staleGuidance;
		expect(stale.map((s) => s.kind)).toEqual(["skill", "skill"]);
		expect(stale.map((s) => s.skillName)).toEqual(["explore-vault", "web"]);
		// Skills are one shared vault file, not per-agent state.
		expect(stale.every((s) => s.agentId === undefined)).toBe(true);
	});

	it("drops a skill notice once the skill is re-aligned", () => {
		const { store } = makeStore(agentData() as never);
		store.setPromptFileReader(makeReader({}));
		store.setStaleSkills(["explore-vault"]);
		expect(store.staleGuidance).toHaveLength(1);

		// Each bootstrap replaces the list wholesale rather than appending.
		store.setStaleSkills([]);
		expect(store.staleGuidance).toEqual([]);
	});
});

/* --------------------------------------------------------------------------
 * Embed model management
 * ------------------------------------------------------------------------*/

describe("PluginDataStore – Embed Models", () => {
	let store: PluginDataStore;

	beforeEach(() => {
		({ store } = makeStore());
	});

	it("should add an embed model", () => {
		store.addEmbedModel("openrouter", "custom-embed-model", { dimensions: 1536 } as never);
		expect(store.getEmbedModels("openrouter")["custom-embed-model"]).toBeDefined();
	});

	it("should throw when adding duplicate embed model", () => {
		store.addEmbedModel("openrouter", "dupe-model", {} as never);
		expect(() => store.addEmbedModel("openrouter", "dupe-model", {} as never)).toThrow(AddEmbedModelError);
	});

	it("should delete an embed model", () => {
		store.addEmbedModel("openrouter", "to-delete", {} as never);
		store.deleteEmbedModel("openrouter", "to-delete");
		expect(store.getEmbedModels("openrouter")["to-delete"]).toBeUndefined();
	});

	it("should throw when deleting non-existent embed model", () => {
		expect(() => store.deleteEmbedModel("openai", "nonexistent")).toThrow(SetEmbedModelError);
	});
});

/* --------------------------------------------------------------------------
 * Privacy list
 * ------------------------------------------------------------------------*/

describe("PluginDataStore – Privacy List", () => {
	let store: PluginDataStore;

	beforeEach(() => {
		({ store } = makeStore());
	});

	it("should default to private-by-default mode", () => {
		expect(store.privacyMode).toBe("private-by-default");
	});

	it("should treat unlisted files as private in private-by-default mode", () => {
		store.setPrivacyFilter(
			compilePrivacyMembershipDraft({
				manualPaths: ["shared.md"],
				autoIncludeRules: [],
				excludedPaths: [],
			}),
		);

		expect(store.isFilePrivate("shared.md")).toBe(false);
		expect(store.isFilePrivate("secret.md")).toBe(true);
	});

	it("should treat listed files as private in public-by-default mode", () => {
		store.setPrivacyMode("public-by-default");
		store.setPrivacyFilter(
			compilePrivacyMembershipDraft({
				manualPaths: ["secret.md"],
				autoIncludeRules: [],
				excludedPaths: [],
			}),
		);

		expect(store.isFilePrivate("secret.md")).toBe(true);
		expect(store.isFilePrivate("shared.md")).toBe(false);
	});

	it("should check provider trust status", () => {
		expect(store.isProviderTrusted("openai")).toBe(false);
		store.setProviderTrusted("openai", true);
		expect(store.isProviderTrusted("openai")).toBe(true);
	});
});

/* --------------------------------------------------------------------------
 * Favorite models
 * ------------------------------------------------------------------------*/

describe("PluginDataStore – Favorite Models", () => {
	let store: PluginDataStore;

	beforeEach(() => {
		({ store } = makeStore());
	});

	it("should start with no favorites", () => {
		expect(store.favoriteModels).toEqual([]);
	});

	it("should toggle a model as favorite", () => {
		store.toggleFavoriteModel("openai", "gpt-4");
		expect(store.isFavoriteModel("openai", "gpt-4")).toBe(true);

		store.toggleFavoriteModel("openai", "gpt-4");
		expect(store.isFavoriteModel("openai", "gpt-4")).toBe(false);
	});
});

/* --------------------------------------------------------------------------
 * Provider configuration
 * ------------------------------------------------------------------------*/

describe("PluginDataStore – Provider Config", () => {
	let store: PluginDataStore;

	beforeEach(() => {
		({ store } = makeStore());
	});

	it("should return all provider IDs", () => {
		const ids = store.getAllProviderIds();
		expect(ids).toContain("openai");
		expect(ids).toContain("anthropic");
		expect(ids).toContain("ollama");
	});

	it("should return no configured providers by default", () => {
		expect(store.getConfiguredProviders()).toEqual([]);
	});

	it("should toggle provider configured state", () => {
		store.toggleProviderIsConfigured("openai");
		expect(store.getProviderIsConfigured("openai")).toBe(true);

		store.toggleProviderIsConfigured("openai");
		expect(store.getProviderIsConfigured("openai")).toBe(false);
	});
});

/* --------------------------------------------------------------------------
 * Simple getters/setters
 * ------------------------------------------------------------------------*/

describe("PluginDataStore – Settings", () => {
	let store: PluginDataStore;

	beforeEach(() => {
		({ store } = makeStore());
	});

	it("should get and set targetFolder", () => {
		store.targetFolder = "MyChats";
		expect(store.targetFolder).toBe("MyChats");
	});

	it("should normalize empty targetFolder to 'Chats'", () => {
		store.targetFolder = "";
		expect(store.targetFolder).toBe("Chats");
	});

	it("should get and set chatOpenLocation", () => {
		expect(store.chatOpenLocation).toBe("tab");
		store.chatOpenLocation = "right";
		expect(store.chatOpenLocation).toBe("right");
	});

	it("should get and set diffViewMode", () => {
		expect(store.diffViewMode).toBe("two-pane");
		store.diffViewMode = "word-diff";
		expect(store.diffViewMode).toBe("word-diff");
	});
});

/* --------------------------------------------------------------------------
 * Embedding indexes
 * ------------------------------------------------------------------------*/

describe("PluginDataStore – Embedding Indexes", () => {
	let store: PluginDataStore;

	beforeEach(() => {
		({ store } = makeStore());
	});

	it("should start with no embedding indexes", () => {
		expect(store.embeddingIndexes).toEqual([]);
		expect(store.searchEmbedIndex).toBeNull();
		expect(store.graphEmbedIndex).toBeNull();
	});

	it("should set an embed index for search", () => {
		store.setEmbedIndex("search", "openai", "text-embedding-3-small");

		expect(store.searchEmbedIndex).toBe("openai:text-embedding-3-small");
		expect(store.graphEmbedIndex).toBeNull();
		expect(store.embeddingIndexes).toHaveLength(1);
		expect(store.embeddingIndexes[0].provider).toBe("openai");
	});

	it("should keep search and graph index selections independent", () => {
		store.setEmbedIndex("search", "openai", "text-embedding-3-small");
		store.setEmbedIndex("graph", "ollama", "nomic-embed-text");

		expect(store.searchEmbedIndex).toBe("openai:text-embedding-3-small");
		expect(store.graphEmbedIndex).toBe("ollama:nomic-embed-text");
		expect(store.embeddingIndexes).toHaveLength(2);
	});

	it("should update embedding index stats", () => {
		store.setEmbedIndex("search", "openai", "text-embedding-3-small");
		store.updateEmbeddingIndexStats("openai:text-embedding-3-small", {
			lastBuiltAt: 1000,
			documentCount: 42,
		});

		const idx = store.getEmbeddingIndex("openai:text-embedding-3-small");
		expect(idx?.lastBuiltAt).toBe(1000);
		expect(idx?.documentCount).toBe(42);
	});

	it("should remove an embedding index", () => {
		store.setEmbedIndex("search", "openai", "text-embedding-3-small");
		store.removeEmbeddingIndex("openai:text-embedding-3-small");

		expect(store.embeddingIndexes).toHaveLength(0);
		expect(store.searchEmbedIndex).toBeNull();
		expect(store.graphEmbedIndex).toBeNull();
	});
});

/* --------------------------------------------------------------------------
 * Graph index availability
 * ------------------------------------------------------------------------*/

describe("PluginDataStore graph index availability", () => {
	let store: PluginDataStore;

	beforeEach(() => {
		({ store } = makeStore());
	});

	/**
	 * The smart graph derives `hasGraphIndex` from `getGraphEmbedModel()` and
	 * disables the "Inferred links" controls on it. Svelte tracks that read
	 * because the method goes through the store's `$state`-backed data on every
	 * call; these pin that it answers each transition the settings UI can
	 * trigger from live state, never from anything cached at construction.
	 * (Effects are inert under this Vitest config — Svelte modules compile in
	 * server mode here — so the tracking itself can't be exercised in a unit test.)
	 */
	it("reports a graph index only while one is selected", () => {
		expect(store.getGraphEmbedModel()).toBeNull();

		store.setEmbedIndex("graph", "ollama", "nomic-embed-text");
		expect(store.getGraphEmbedModel()).toEqual({ provider: "ollama", model: "nomic-embed-text" });

		store.clearEmbedIndex("graph");
		expect(store.getGraphEmbedModel()).toBeNull();

		store.setEmbedIndex("graph", "ollama", "nomic-embed-text");
		expect(store.getGraphEmbedModel()).not.toBeNull();
	});

	it("reports no graph index once its config is removed, even via the search purpose", () => {
		store.setEmbedIndex("graph", "ollama", "nomic-embed-text");
		store.setEmbedIndex("search", "ollama", "nomic-embed-text");
		expect(store.getGraphEmbedModel()).not.toBeNull();

		store.removeEmbeddingIndex("ollama:nomic-embed-text");
		expect(store.graphEmbedIndex).toBeNull();
		expect(store.getGraphEmbedModel()).toBeNull();
	});

	it("reports no graph index when the selected id has no config", () => {
		// A stale selection can survive a sync; the lookup, not the id, decides.
		({ store } = makeStore({ graphEmbedIndex: "ollama:gone", embeddingIndexes: [] }));
		expect(store.graphEmbedIndex).toBe("ollama:gone");
		expect(store.getGraphEmbedModel()).toBeNull();
	});
});
