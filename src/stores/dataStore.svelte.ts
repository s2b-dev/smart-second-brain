import { Notice, normalizePath } from "obsidian";
import {
	createEmptyPrivacyFilter,
	matchesPrivacyMembershipDraftPath,
	parsePrivacyMembershipFilter,
	resolveViewFilter,
	rewriteViewFilterForRename,
} from "../lib/views";
import { getSecret, listSecrets, removeSecret, setSecret } from "../lib/secretStorage";
import { isAgentFilePath } from "../utils/fileFiltering";
import { sanitizeAgentFileName } from "../utils/agentPaths";
import { installAgentPathSource } from "../utils/agentPathSource";
import { DEFAULT_AGENT_ID, createDefaultAgent, createDefaultAgentConfig, normalizeAgents } from "./agentDefaults";
import { CURRENT_SCHEMA_VERSION, runMigrations } from "./dataMigrations";
import { computeStaleGuidance } from "./staleGuidance";
import type SecondBrainPlugin from "../main";
import type {
	AgentConfig,
	AgentSkillState,
	AgentsConfig,
	BuiltInToolId,
	DefaultEmbedModel,
	ChatOpenLocation,
	DiffViewMode,
	EmbeddingIndexConfig,
	MCPServerConfig,
	MCPServersConfig,
	PluginData,
	PrivacyMode,
	PromptFileReader,
	RecentNoteEntry,
	StaleGuidance,
	ToolConfig,
} from "../types/plugin";
import { RECENT_NOTE_WINDOW_MS } from "../types/plugin";
import { getDefaultEmbeddingBatchSize, normalizeEmbeddingBatchSize } from "../vectorstore/batchSize";
import { type UUIDv7, genUUIDv7 } from "../utils/uuid7Validator";

import { type SmartGraphSettings, DEFAULT_SMART_GRAPH_SETTINGS } from "../types/graph";
import { Logger, applyVerboseLogging } from "../utils/logging";
import { extractErrorMessage } from "../utils/errorMessage";

// Provider system types
import {
	type AuthObject,
	type ChatModelConfig,
	type EmbedModelConfig,
	type OpenAIAuthMode,
	type ProviderInstanceMeta,
	type ProviderTemplateId,
} from "../providers/index";
import { syncAllProviders, syncProvider, unsyncProvider } from "../providers/registrySync";

const LANGSMITH_API_KEY_SECRET_ID = buildManagedSecretId("langsmith", "apiKey");
/** Managed secret id for a web-search provider's API key, e.g. "web-search-brave-api-key". */
function webSearchSecretId(provider: string): string {
	return buildManagedSecretId(`web-search-${provider}`, "apiKey");
}

// ============================================================================
// Error Classes
// ============================================================================

export class AddEmbedModelError extends Error {
	constructor(provider: string, modelName: string) {
		super(`Embed model "${modelName}" already exists for provider "${provider}"`);
		this.name = "AddEmbedModelError";
	}
}

export class AddChatModelError extends Error {
	constructor(provider: string, modelName: string) {
		super(`Chat model "${modelName}" already exists for provider "${provider}"`);
		this.name = "AddChatModelError";
	}
}

export class SetEmbedModelError extends Error {
	constructor(provider: string, modelName: string) {
		super(`Embed model "${modelName}" not found for provider "${provider}"`);
		this.name = "SetEmbedModelError";
	}
}

export class SetChatModelError extends Error {
	constructor(provider: string, modelName: string) {
		super(`Chat model "${modelName}" not found for provider "${provider}"`);
		this.name = "SetChatModelError";
	}
}

// ============================================================================
// Provider State Types (Unified)
// ============================================================================

/**
 * Stored auth state with secret IDs (not resolved secrets).
 * Secret values are stored in SecretStorage, we only keep IDs here.
 */
export interface StoredAuthState {
	/** Non-secret auth values (e.g., baseUrl) */
	values: Record<string, string>;
	/** Secret IDs for fields stored in SecretStorage (e.g., apiKey) */
	secretIds: Record<string, string>;
	/** Selected auth mode for providers that support multiple login routes */
	authMode?: OpenAIAuthMode;
}

/**
 * State for a single provider stored in data.json.
 * Unified structure for ALL providers (built-in and custom).
 */
export interface StoredProviderState {
	/** Whether the provider is configured and enabled */
	isConfigured: boolean;
	/** Authentication state with secret IDs */
	auth: StoredAuthState;
	/** Chat model configurations keyed by model ID */
	chatModels: Record<string, ChatModelConfig>;
	/** Embedding model configurations keyed by model ID */
	embedModels: Record<string, EmbedModelConfig>;
	/** Whether this provider is trusted to process private/sensitive files */
	trustedForPrivateData?: boolean;
}

// ============================================================================
// Default Provider States (New System)
// ============================================================================

/**
 * Creates default auth state.
 * All fields start empty (no default values).
 */
function createDefaultAuth(authMode: OpenAIAuthMode = "apiKey"): StoredAuthState {
	return {
		values: {},
		secretIds: {},
		authMode,
	};
}

function toSecretIdSegment(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase();
}

function buildManagedSecretId(providerId: string, fieldName: string): string {
	return `${toSecretIdSegment(providerId)}-${toSecretIdSegment(fieldName)}`;
}

function createProviderState(templateId: ProviderTemplateId): StoredProviderState {
	// Base URL pre-seed. Only local providers (Ollama, oMLX) are seeded: their baseUrl is a
	// REQUIRED field (shown in the main section) pointing at a well-known local default, so
	// filling it in saves the user typing without side effects.
	//
	// Anthropic is intentionally NOT seeded even though it has a default endpoint: its
	// baseUrl is an OPTIONAL (Advanced) field, and a stored value there forces the Advanced
	// section open on a fresh provider. The provider falls back to its default at runtime
	// (auth.baseUrl || DEFAULT) and the field placeholder shows it, so seeding adds nothing.
	// openai-compatible ("Custom") is likewise not seeded — a generic endpoint shouldn't
	// bias toward one vendor.
	const baseUrlByTemplate: Partial<Record<ProviderTemplateId, string>> = {
		ollama: "http://localhost:11434",
		omlx: "http://localhost:8000",
	};
	const authMode = templateId === "openai-codex" ? "codex" : "apiKey";

	return {
		isConfigured: false,
		auth: {
			...createDefaultAuth(authMode),
			values: baseUrlByTemplate[templateId] ? { baseUrl: baseUrlByTemplate[templateId] } : {},
		},
		chatModels: {},
		embedModels: {},
		trustedForPrivateData: templateId === "ollama" || templateId === "omlx",
	};
}

// ============================================================================
// Default Agent Configuration
// ============================================================================

/**
 * Safety cap only — it bounds the size of the plugin data file. What actually
 * decides whether a note counts as recent is its age (`RECENT_NOTE_WINDOW_MS`),
 * applied at read time in `search/recentNotes.ts`. The cap is deliberately far
 * above a normal week of note-opening so that a heavy day cannot evict notes
 * that are still inside the window.
 */
const MAX_RECENT_NOTES = 200;

// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: PluginData = {
	schemaVersion: CURRENT_SCHEMA_VERSION,
	// Configured provider instances keyed by opaque provider instance ID
	providerConfig: {},
	// Persisted metadata for configured provider instances
	providerMeta: {},

	// Agent configuration (new)
	agents: {
		[DEFAULT_AGENT_ID]: createDefaultAgent(),
	},
	defaultAgentId: DEFAULT_AGENT_ID,
	selectedAgentId: DEFAULT_AGENT_ID,

	// Chat settings
	targetFolder: "Chats",
	attachmentFolder: "",
	agentFolder: "Agents",
	agentFolderMigrated: false,
	coreSkillsSeeded: false,
	manageSkillsFolderMigrated: false,
	manageNotesFolderMigrated: false,

	// Privacy
	privacyMode: "private-by-default",
	privacyFilter: createEmptyPrivacyFilter(),

	// UI state
	isVerbose: false,
	showToolIODetails: false,
	chatOpenLocation: "tab",
	lastActiveChatId: null,
	onboardingComplete: false,
	onboardingSplashSeen: false,
	dismissedRecommendations: [],
	thinkingProcessExpanded: true,
	showActiveAgentsInStatusBar: true,
	overrideMobileNavbarSearch: false,
	suppressIntegrationPrivacyWarning: false,

	// Debugging & telemetry
	enableLangSmith: false,
	langSmithApiKeyId: "",
	langSmithProject: "obsidian-agent",
	langSmithEndpoint: "https://api.smith.langchain.com",

	// Web search
	webSearchProvider: "firecrawl",
	webSearchApiKeyIds: {},

	// Other
	searchShowPath: true,
	searchShowTags: true,
	searchShowMatchBadges: true,
	searchShowMatchContext: true,
	searchShowKeyboardHints: true,
	recentNotes: [],
	embeddingIndexes: [],
	searchEmbedIndex: null,
	graphEmbedIndex: null,
	favoriteModels: [],

	// Smart Graph View
	smartGraphSettings: DEFAULT_SMART_GRAPH_SETTINGS,

	// Diff view
	diffViewMode: "two-pane",

	vaultSlug: null,
};

export class PluginDataStore {
	#data: PluginData;
	private readonly _plugin: SecondBrainPlugin;
	/** Rate-limits the "could not save" Notice; see `notifySaveFailed`. */
	#saveFailureNotified = false;

	/**
	 * Guidance surfaces whose built-in default changed while the user had a customization
	 * that couldn't be auto-updated. Now driven by file content (the per-agent base prompt is
	 * file-backed), so the store needs a reader for the file-backed surface — injected via
	 * {@link setPromptFileReader}. Until a reader is set (early startup), nothing is reported.
	 * The moment a user re-aligns a surface, its notice disappears on the next recompute (#356).
	 */
	get staleGuidance(): readonly StaleGuidance[] {
		return computeStaleGuidance(this.#data.agents, this.#promptFileReader, this.#staleSkills);
	}

	/** Reader for file-backed prompt surfaces, injected by the prompt-file store once ready. */
	#promptFileReader: PromptFileReader | null = null;
	setPromptFileReader(reader: PromptFileReader | null): void {
		this.#promptFileReader = reader;
	}

	/**
	 * Bundled skills whose on-disk body is neither the current shipped version nor any older
	 * one — i.e. the user edited them, so seeding couldn't update them in place. Reported by
	 * SkillsService after each bootstrap. `$state` so the reactive `staleGuidance` getter
	 * re-runs when bootstrap finishes (it completes well after the first render).
	 */
	#staleSkills: string[] = $state([]);
	setStaleSkills(skillNames: readonly string[]): void {
		this.#staleSkills = [...skillNames];
	}

	constructor(plugin: SecondBrainPlugin, initialData: PluginData) {
		installAgentPathSource({
			agentFolder: () => this.agentFolder,
			agentName: (agentId) => this.agents[agentId]?.name,
		});
		this._plugin = plugin;
		this.#data = $state(initialData);

		// Keep the privacy filter following renames instead of silently going stale.
		// Under `public-by-default` a stale entry drops out of the *private* set —
		// a note the user marked private would then be readable by untrusted
		// providers with no corresponding edit — so this isn't just UI hygiene.
		// Obsidian fires a `rename` event for every renamed file AND folder
		// (including each descendant folder of a renamed parent), so a single
		// exact-match rewrite per event is sufficient; see `rewriteViewFilterForRename`.
		this._plugin.registerEvent(
			this._plugin.app.vault.on("rename", (file, oldPath) => {
				const rewritten = rewriteViewFilterForRename(this.#data.privacyFilter, oldPath, file.path);
				if (rewritten !== this.#data.privacyFilter) {
					this.#data.privacyFilter = rewritten;
					void this.saveSettings();
				}
			}),
		);
	}

	/**
	 * Persist current settings.
	 * Snapshots the $state to avoid saving reactive proxies.
	 */
	/**
	 * Persist the current data snapshot.
	 *
	 * Deliberately never rejects. ~70 setters call this as the last statement of a
	 * synchronous mutation (`this.#data.x = y; this.saveSettings();`) and have no
	 * meaningful way to recover, so a rejection here used to surface as an unhandled
	 * rejection: `saveData` failing (disk full, permissions, a sync conflict) left the
	 * user's change applied in memory, absent from disk, and unreported until the next
	 * reload silently reverted it.
	 *
	 * Failures are caught, logged, and surfaced once so the user learns their settings
	 * did not persist.
	 *
	 * This is for the fire-and-forget setters only. Anything that *awaits* a save is by
	 * definition persistence-dependent (provider create/rename/delete, `deleteData`) and
	 * must not be told a write succeeded when it did not — those call
	 * `saveSettingsOrThrow` and let the failure reach their own caller.
	 */
	private async saveSettings(): Promise<void> {
		try {
			await this.saveSettingsOrThrow();
		} catch (error) {
			Logger.error("Failed to persist plugin settings:", error);
			this.notifySaveFailed(error);
		}
	}

	/** Persist and propagate failure, for callers that must observe a failed write. */
	private async saveSettingsOrThrow(): Promise<void> {
		const snap = $state.snapshot(this.#data);
		await this._plugin.saveData(snap);
	}

	/**
	 * One notice per burst. A failing disk usually fails for every setter the user
	 * touches, and stacking a Notice per keystroke would bury the workspace.
	 */
	private notifySaveFailed(error: unknown): void {
		if (this.#saveFailureNotified) return;
		this.#saveFailureNotified = true;
		new Notice(`Smart Second Brain could not save your settings: ${extractErrorMessage(error)}`, 10000);
		window.setTimeout(() => {
			this.#saveFailureNotified = false;
		}, 30000);
	}

	getLastActiveChatId(): UUIDv7 | null {
		return this.#data.lastActiveChatId;
	}

	setLastActiveChatId(id: UUIDv7 | null) {
		this.#data.lastActiveChatId = id;
		void this.saveSettings();
	}

	async deleteData(): Promise<void> {
		this.#data = structuredClone(DEFAULT_SETTINGS);
		await this.saveSettingsOrThrow();
	}

	/**
	 * Get all configured provider IDs.
	 * Returns IDs of providers where isConfigured is true.
	 */
	getConfiguredProviders(): string[] {
		return Object.entries(this.#data.providerConfig)
			.filter(([_, state]) => state.isConfigured)
			.map(([id]) => id);
	}

	/**
	 * Get all available provider IDs (configured or not).
	 * This is simply all keys in providerConfig.
	 */
	getAllProviderIds(): string[] {
		return Object.keys(this.#data.providerConfig);
	}

	/**
	 * Get all configured models across all configured providers.
	 */
	getAllConfiguredModels(): string[] {
		return this.getConfiguredProviders().flatMap((providerId) => {
			const config = this.#data.providerConfig[providerId];
			return config ? Object.keys(config.chatModels) : [];
		});
	}

	// ============================================================================
	// Privacy Methods
	// ============================================================================

	get privacyFilter() {
		return this.#data.privacyFilter;
	}

	get privacyMode(): PrivacyMode {
		return this.#data.privacyMode;
	}

	setPrivacyMode(mode: PrivacyMode) {
		this.#data.privacyMode = mode;
		void this.saveSettings();
		this.notifyPrivacyRulesChanged();
	}

	setPrivacyFilter(filter: PluginData["privacyFilter"]) {
		this.#data.privacyFilter = filter;
		void this.saveSettings();
		this.notifyPrivacyRulesChanged();
	}

	/**
	 * Listeners for changes to what `isFilePrivate` / `isProviderTrusted` answer.
	 * The embedding indexer subscribes: which notes an index may hold follows
	 * from these, so a change means every index needs re-validating against
	 * the vault (notes to drop, notes now allowed in). A plain callback set
	 * rather than a rune, because the subscriber is a service, not a component.
	 */
	readonly #privacyListeners = new Set<() => void>();

	/** Subscribe to privacy-rule changes; returns the unsubscribe. */
	onPrivacyRulesChange(listener: () => void): () => void {
		this.#privacyListeners.add(listener);
		return () => this.#privacyListeners.delete(listener);
	}

	private notifyPrivacyRulesChanged(): void {
		for (const listener of this.#privacyListeners) listener();
	}

	/**
	 * Listeners for a provider rename, awaited by `renameProvider` before it
	 * resolves. Embedding indexes are keyed `provider:model`, and so are their
	 * IndexedDB databases: the embedding indexer moves each renamed index's
	 * vectors to the new name, and must have done so before the UI — which
	 * awaits the rename — opens the index under its new id.
	 */
	readonly #providerRenameListeners = new Set<(oldId: string, newId: string) => Promise<void> | void>();

	/** Subscribe to provider renames; returns the unsubscribe. */
	onProviderRenamed(listener: (oldId: string, newId: string) => Promise<void> | void): () => void {
		this.#providerRenameListeners.add(listener);
		return () => this.#providerRenameListeners.delete(listener);
	}

	isFilePrivate(filePath: string): boolean {
		const listed = this.isFileListedInPrivacyFilter(filePath);
		if (this.#data.privacyMode === "private-by-default") {
			return !listed;
		}
		return listed;
	}

	private isFileListedInPrivacyFilter(filePath: string): boolean {
		const parsed = parsePrivacyMembershipFilter(this.#data.privacyFilter);
		if (parsed.isAdvanced) {
			return resolveViewFilter(this._plugin.app, this.#data.privacyFilter, this.getAllVaultPaths()).paths.has(
				filePath,
			);
		}
		return matchesPrivacyMembershipDraftPath(this._plugin.app, parsed.draft, filePath);
	}

	/** Check whether a provider is trusted to process private/sensitive files. */
	isProviderTrusted(providerId: string): boolean {
		return this.#data.providerConfig[providerId]?.trustedForPrivateData ?? false;
	}

	/** Set whether a provider is trusted to process private/sensitive files. */
	setProviderTrusted(providerId: string, trusted: boolean) {
		const config = this.#data.providerConfig[providerId];
		if (!config) return;
		if (config.trustedForPrivateData === trusted) return;
		config.trustedForPrivateData = trusted;
		void this.saveSettings();
		this.notifyPrivacyRulesChanged();
	}

	private getAllVaultPaths(): Set<string> {
		return new Set(
			this._plugin.app.vault
				.getFiles()
				.map((file) => file.path)
				.filter((p) => !isAgentFilePath(p)),
		);
	}

	get targetFolder() {
		return this.#data.targetFolder;
	}
	set targetFolder(val: string) {
		const normalized = normalizePath(val || "Chats");
		this.#data.targetFolder = normalized;
		// Best-effort ensure the folder exists
		try {
			const exists = !!this._plugin.app.vault.getFolderByPath(normalized);
			if (!exists) {
				// Fire and forget; persistence updated regardless
				this._plugin.app.vault.createFolder(normalized).catch(() => {});
			}
		} catch {
			// ignore
		}
		void this.saveSettings();
	}

	get attachmentFolder() {
		return this.#data.attachmentFolder;
	}
	set attachmentFolder(val: string) {
		this.#data.attachmentFolder = val;
		void this.saveSettings();
	}

	get agentFolder() {
		return this.#data.agentFolder || "Agents";
	}
	set agentFolder(val: string) {
		const normalized = normalizePath(val || "Agents");
		this.#data.agentFolder = normalized;
		// Best-effort ensure the folder exists
		try {
			const exists = !!this._plugin.app.vault.getFolderByPath(normalized);
			if (!exists) {
				this._plugin.app.vault.createFolder(normalized).catch(() => {});
			}
		} catch {
			// ignore
		}
		void this.saveSettings();
	}

	get agentFolderMigrated() {
		return this.#data.agentFolderMigrated ?? false;
	}
	set agentFolderMigrated(val: boolean) {
		this.#data.agentFolderMigrated = val;
		void this.saveSettings();
	}

	get coreSkillsSeeded() {
		return this.#data.coreSkillsSeeded ?? false;
	}
	set coreSkillsSeeded(val: boolean) {
		this.#data.coreSkillsSeeded = val;
		void this.saveSettings();
	}

	get manageSkillsFolderMigrated() {
		return this.#data.manageSkillsFolderMigrated ?? false;
	}
	set manageSkillsFolderMigrated(val: boolean) {
		this.#data.manageSkillsFolderMigrated = val;
		void this.saveSettings();
	}

	get manageNotesFolderMigrated() {
		return this.#data.manageNotesFolderMigrated ?? false;
	}
	set manageNotesFolderMigrated(val: boolean) {
		this.#data.manageNotesFolderMigrated = val;
		void this.saveSettings();
	}

	/**
	 * Resolves the effective attachment folder:
	 * 1. User override (`attachmentFolder` setting) if non-empty
	 * 2. Obsidian's native attachment folder if it's an absolute vault path
	 * 3. Fallback: `{targetFolder}/attachments`
	 */
	get resolvedAttachmentFolder(): string {
		const userOverride = this.#data.attachmentFolder?.trim();
		if (userOverride) return normalizePath(userOverride);

		try {
			// @ts-expect-error — internal Obsidian API
			const obsidianPath: unknown = this._plugin.app.vault.getConfig("attachmentFolderPath");
			if (
				typeof obsidianPath === "string" &&
				obsidianPath.length > 0 &&
				obsidianPath !== "." &&
				!obsidianPath.startsWith("./")
			) {
				return normalizePath(obsidianPath);
			}
		} catch {
			// ignore — API may not exist
		}

		return normalizePath(`${this.#data.targetFolder}/attachments`);
	}

	get enableLangSmith() {
		return this.#data.enableLangSmith;
	}
	set enableLangSmith(val: boolean) {
		this.#data.enableLangSmith = val;
		void this.saveSettings();
	}

	get langSmithApiKey() {
		if (!this.#data.langSmithApiKeyId) return "";
		return getSecret(this._plugin.app, this.#data.langSmithApiKeyId) ?? "";
	}
	set langSmithApiKey(val: string) {
		const trimmedValue = val.trim();
		if (trimmedValue) {
			setSecret(this._plugin.app, LANGSMITH_API_KEY_SECRET_ID, trimmedValue);
			this.#data.langSmithApiKeyId = LANGSMITH_API_KEY_SECRET_ID;
		} else {
			if (this.#data.langSmithApiKeyId) {
				setSecret(this._plugin.app, this.#data.langSmithApiKeyId, "");
			}
			this.#data.langSmithApiKeyId = "";
		}
		void this.saveSettings();
	}

	get langSmithApiKeyId() {
		return this.#data.langSmithApiKeyId;
	}
	set langSmithApiKeyId(val: string) {
		this.#data.langSmithApiKeyId = val.trim();
		void this.saveSettings();
	}

	get langSmithProject() {
		return this.#data.langSmithProject;
	}
	set langSmithProject(val: string) {
		this.#data.langSmithProject = val;
		void this.saveSettings();
	}

	get langSmithEndpoint() {
		return this.#data.langSmithEndpoint;
	}
	set langSmithEndpoint(val: string) {
		this.#data.langSmithEndpoint = val;
		void this.saveSettings();
	}

	// ============================================================================
	// Web Search
	// ============================================================================

	get webSearchProvider() {
		return this.#data.webSearchProvider;
	}
	set webSearchProvider(val: string) {
		this.#data.webSearchProvider = val;
		void this.saveSettings();
	}

	/** Resolve the API key for the currently selected provider (empty string if none). */
	get webSearchApiKey() {
		const secretId = this.#data.webSearchApiKeyIds[this.#data.webSearchProvider];
		if (!secretId) return "";
		return getSecret(this._plugin.app, secretId) ?? "";
	}
	/** Store (or clear) the API key for the currently selected provider only. */
	set webSearchApiKey(val: string) {
		const provider = this.#data.webSearchProvider;
		if (!provider) return;
		const trimmedValue = val.trim();
		if (trimmedValue) {
			const secretId = webSearchSecretId(provider);
			setSecret(this._plugin.app, secretId, trimmedValue);
			this.#data.webSearchApiKeyIds[provider] = secretId;
		} else {
			const existing = this.#data.webSearchApiKeyIds[provider];
			if (existing) setSecret(this._plugin.app, existing, "");
			delete this.#data.webSearchApiKeyIds[provider];
		}
		void this.saveSettings();
	}

	/** Secret id bound to the current provider's key field in the UI (empty if unset). */
	get webSearchApiKeyId() {
		return this.#data.webSearchApiKeyIds[this.#data.webSearchProvider] ?? "";
	}
	/** Bind an existing secret to the current provider (used by the SecretSelect picker). */
	set webSearchApiKeyId(val: string) {
		const provider = this.#data.webSearchProvider;
		if (!provider) return;
		const trimmed = val.trim();
		if (trimmed) {
			this.#data.webSearchApiKeyIds[provider] = trimmed;
		} else {
			delete this.#data.webSearchApiKeyIds[provider];
		}
		void this.saveSettings();
	}

	// ============================================================================
	// Agent Configuration Methods
	// ============================================================================

	/**
	 * Get all agent configurations.
	 */
	get agents(): AgentsConfig {
		return this.#data.agents;
	}

	/**
	 * Get all agent IDs.
	 */
	getAgentIds(): string[] {
		return Object.keys(this.#data.agents);
	}

	/**
	 * Get a specific agent configuration by ID.
	 */
	getAgent(agentId: string): AgentConfig | undefined {
		return this.#data.agents[agentId];
	}

	/**
	 * Get the default agent ID that every new chat starts on. Always valid.
	 */
	get defaultAgentId(): string {
		return this.#data.defaultAgentId;
	}

	/**
	 * Get the currently selected agent ID.
	 */
	get selectedAgentId(): string {
		return this.#data.selectedAgentId;
	}

	/**
	 * Set the currently selected agent ID.
	 */
	set selectedAgentId(agentId: string) {
		if (this.#data.agents[agentId]) {
			this.#data.selectedAgentId = agentId;
			void this.saveSettings();
		}
	}

	/**
	 * Get the currently selected agent configuration.
	 */
	getSelectedAgent(): AgentConfig {
		const agent = this.#data.agents[this.#data.selectedAgentId];
		// Fallback to default agent if selected agent doesn't exist
		return agent ?? this.#data.agents[DEFAULT_AGENT_ID];
	}

	/**
	 * Get the default agent configuration.
	 */
	getDefaultAgent(): AgentConfig {
		// Fall back to the built-in agent if the pointer ever goes stale.
		return this.#data.agents[this.#data.defaultAgentId] ?? this.#data.agents[DEFAULT_AGENT_ID];
	}

	/**
	 * Set the default agent every new chat starts on.
	 * @param agentId - The ID of the agent to set as default
	 * @throws Error if the agent doesn't exist
	 */
	setDefaultAgentId(agentId: string): void {
		if (!this.#data.agents[agentId]) {
			throw new Error(`Agent with ID "${agentId}" not found`);
		}
		this.#data.defaultAgentId = agentId;
		void this.saveSettings();
	}

	/**
	 * Create a new agent with default configuration.
	 * @param name - Display name for the agent
	 * @returns The created agent configuration
	 */
	createAgent(name: string): AgentConfig {
		const agent = createDefaultAgentConfig(undefined, this.uniqueAgentName(name));
		this.#data.agents = {
			...this.#data.agents,
			[agent.id]: agent,
		};
		void this.saveSettings();
		return agent;
	}

	/**
	 * Ensure an agent's name yields a UNIQUE base-prompt filename. Display names drive each
	 * agent's note filename (via {@link sanitizeAgentFileName}), so uniqueness is enforced on
	 * the *sanitized* form — otherwise two distinct raw names that sanitize to the same file
	 * (e.g. "A/B" and "A B") could still share/orphan a note. Appends " 2", " 3", … until the
	 * sanitized filename is free. `exceptId` excludes the agent being renamed so it can keep
	 * its own name.
	 */
	private uniqueAgentName(desired: string, exceptId?: string): string {
		const base = desired.trim() || "Agent";
		const takenFiles = new Set(
			Object.values(this.#data.agents)
				.filter((agent) => agent.id !== exceptId)
				.map((agent) => sanitizeAgentFileName(agent.name)),
		);
		if (!takenFiles.has(sanitizeAgentFileName(base))) return base;
		for (let n = 2; ; n++) {
			const candidate = `${base} ${n}`;
			if (!takenFiles.has(sanitizeAgentFileName(candidate))) return candidate;
		}
	}

	/**
	 * Update an existing agent configuration.
	 * @param agentId - The ID of the agent to update
	 * @param updates - Partial agent configuration to merge
	 * @throws Error if agent doesn't exist
	 */
	updateAgent(agentId: string, updates: Partial<Omit<AgentConfig, "id">>): void {
		const agent = this.#data.agents[agentId];
		if (!agent) {
			throw new Error(`Agent with ID "${agentId}" not found`);
		}

		// Keep display names unique (they drive the base-prompt filename). Renaming to your
		// own current name is a no-op; a clash with another agent gets a numeric suffix.
		const normalizedUpdates =
			updates.name !== undefined ? { ...updates, name: this.uniqueAgentName(updates.name, agentId) } : updates;

		this.#data.agents = {
			...this.#data.agents,
			[agentId]: {
				...agent,
				...normalizedUpdates,
			},
		};
		void this.saveSettings();
	}

	/**
	 * Delete an agent.
	 * Cannot delete the default agent.
	 * @param agentId - The ID of the agent to delete
	 * @throws Error if agent doesn't exist or is the default agent
	 */
	deleteAgent(agentId: string): void {
		if (agentId === DEFAULT_AGENT_ID) {
			throw new Error("Cannot delete the built-in default agent");
		}
		if (!this.#data.agents[agentId]) {
			throw new Error(`Agent with ID "${agentId}" not found`);
		}

		const { [agentId]: _, ...rest } = this.#data.agents;
		this.#data.agents = rest;

		// Scrub the deleted agent from any other agent's subagent references, so a
		// dangling ID can't linger in `subAgentIds` (which would show as an enabled
		// subagent in settings while being silently dropped at resolution time).
		for (const other of Object.values(this.#data.agents)) {
			if (other.subAgentIds?.includes(agentId)) {
				other.subAgentIds = other.subAgentIds.filter((id) => id !== agentId);
			}
		}

		// If deleted agent was the default, fall back to the built-in default
		if (this.#data.defaultAgentId === agentId) {
			this.#data.defaultAgentId = DEFAULT_AGENT_ID;
		}

		// If deleted agent was selected, switch to the (now-valid) default agent
		if (this.#data.selectedAgentId === agentId) {
			this.#data.selectedAgentId = this.#data.defaultAgentId;
		}

		void this.saveSettings();
	}

	/**
	 * Duplicate an existing agent with a new name.
	 * @param agentId - The ID of the agent to duplicate
	 * @param newName - Name for the duplicated agent
	 * @returns The newly created agent configuration
	 */
	duplicateAgent(agentId: string, newName: string): AgentConfig {
		const sourceAgent = this.#data.agents[agentId];
		if (!sourceAgent) {
			throw new Error(`Agent with ID "${agentId}" not found`);
		}

		// Use $state.snapshot to unwrap Svelte proxies, then structuredClone for deep copy
		const clonedAgent = structuredClone($state.snapshot(sourceAgent));
		const newId = genUUIDv7();
		// Preserve self-reference semantics: if the source delegated to itself, the
		// duplicate should delegate to ITSELF (its own isolated copy), not back to the
		// source agent. Remap the source id in subAgentIds to the new id.
		const remappedSubAgentIds = (clonedAgent.subAgentIds ?? []).map((id) => (id === agentId ? newId : id));
		const newAgent: AgentConfig = {
			...clonedAgent,
			id: newId,
			name: this.uniqueAgentName(newName),
			subAgentIds: remappedSubAgentIds,
		};

		this.#data.agents = {
			...this.#data.agents,
			[newAgent.id]: newAgent,
		};
		void this.saveSettings();
		return newAgent;
	}

	// --- Agent-specific Tool Configuration ---

	/**
	 * Check if a specific tool is enabled for an agent.
	 */
	isAgentToolEnabled(agentId: string, toolId: BuiltInToolId): boolean {
		const agent = this.#data.agents[agentId];
		return agent?.toolsConfig[toolId]?.enabled ?? true;
	}

	/**
	 * Toggle tool enabled state for an agent.
	 */
	toggleAgentToolEnabled(agentId: string, toolId: BuiltInToolId): void {
		const agent = this.#data.agents[agentId];
		if (agent?.toolsConfig[toolId]) {
			agent.toolsConfig[toolId].enabled = !agent.toolsConfig[toolId].enabled;
			void this.saveSettings();
		}
	}

	/**
	 * Update tool configuration for an agent.
	 */
	updateAgentToolConfig(agentId: string, toolId: BuiltInToolId, config: Partial<ToolConfig>): void {
		const agent = this.#data.agents[agentId];
		if (agent?.toolsConfig[toolId]) {
			agent.toolsConfig[toolId] = {
				...agent.toolsConfig[toolId],
				...config,
			};
			void this.saveSettings();
		}
	}

	// --- Per-plugin Code-Exec Integrations ---

	/**
	 * Check whether a per-plugin code-exec integration is enabled for an agent.
	 * Defaults to `false` — integrations are disabled until the user approves them
	 * (contrast built-in tools, which default enabled).
	 */
	isAgentPluginExecEnabled(agentId: string, toolId: string): boolean {
		const agent = this.#data.agents[agentId];
		return agent?.pluginExecTools?.[toolId] ?? false;
	}

	/**
	 * Set the enabled state of a per-plugin code-exec integration for an agent.
	 */
	setAgentPluginExecEnabled(agentId: string, toolId: string, enabled: boolean): void {
		const agent = this.#data.agents[agentId];
		if (!agent) return;
		agent.pluginExecTools ??= {};
		agent.pluginExecTools[toolId] = enabled;
		void this.saveSettings();
	}

	// --- Agent-specific Subagent References ---

	/**
	 * Get the list of subagent (referenced agent) IDs for an agent.
	 */
	getSubAgentIds(agentId: string): string[] {
		return this.#data.agents[agentId]?.subAgentIds ?? [];
	}

	/**
	 * Enable or disable another agent as a subagent of this agent.
	 * Self-reference is allowed: an agent may delegate to an isolated-context
	 * copy of itself. Nesting is capped at one level (the self-copy has no
	 * `task` tool), so this cannot recurse.
	 */
	setSubAgentEnabled(agentId: string, refId: string, enabled: boolean): void {
		const agent = this.#data.agents[agentId];
		if (!agent) return;
		const current = agent.subAgentIds ?? [];
		const has = current.includes(refId);
		if (enabled && !has) {
			agent.subAgentIds = [...current, refId];
		} else if (!enabled && has) {
			agent.subAgentIds = current.filter((id) => id !== refId);
		} else {
			return;
		}
		void this.saveSettings();
	}

	/**
	 * Toggle another agent's enabled state as a subagent of this agent.
	 */
	toggleSubAgentRef(agentId: string, refId: string): void {
		const enabled = this.getSubAgentIds(agentId).includes(refId);
		this.setSubAgentEnabled(agentId, refId, !enabled);
	}

	/**
	 * Resolve an agent's subagent references to the live AgentConfig objects.
	 * Self-reference is allowed (isolated-context copy of the same agent);
	 * only IDs of agents that no longer exist are filtered out.
	 */
	resolveSubAgents(agentId: string): AgentConfig[] {
		const ids = this.getSubAgentIds(agentId);
		const resolved: AgentConfig[] = [];
		for (const refId of ids) {
			const ref = this.#data.agents[refId];
			if (ref) resolved.push(ref);
		}
		return resolved;
	}

	// --- Agent-specific MCP Server Configuration ---

	/**
	 * Get MCP servers for a specific agent.
	 */
	getAgentMCPServers(agentId: string): MCPServersConfig {
		return this.#data.agents[agentId]?.mcpServers ?? {};
	}

	/**
	 * Set MCP server for an agent.
	 */
	setAgentMCPServer(agentId: string, serverId: string, config: MCPServerConfig): void {
		const agent = this.#data.agents[agentId];
		if (agent) {
			agent.mcpServers = {
				...agent.mcpServers,
				[serverId]: config,
			};
			void this.saveSettings();
		}
	}

	/**
	 * Delete MCP server from an agent.
	 */
	deleteAgentMCPServer(agentId: string, serverId: string): void {
		const agent = this.#data.agents[agentId];
		if (agent) {
			const { [serverId]: _, ...rest } = agent.mcpServers;
			agent.mcpServers = rest;
			void this.saveSettings();
		}
	}

	/**
	 * Toggle MCP server enabled state for an agent.
	 */
	toggleAgentMCPServerEnabled(agentId: string, serverId: string): void {
		const agent = this.#data.agents[agentId];
		const server = agent?.mcpServers[serverId];
		if (agent && server) {
			agent.mcpServers = {
				...agent.mcpServers,
				[serverId]: { ...server, enabled: !server.enabled },
			};
			void this.saveSettings();
		}
	}

	/**
	 * Convert agent's MCP config to the format expected by MultiServerMCPClient.
	 * Only includes enabled servers.
	 */
	getAgentMCPServersForClient(agentId: string): Record<string, unknown> {
		const agent = this.#data.agents[agentId];
		if (!agent) return {};

		const result: Record<string, unknown> = {};

		for (const [id, config] of Object.entries(agent.mcpServers)) {
			if (!config.enabled) continue;

			result[id] = {
				transport: "http",
				url: config.url,
				...(config.headers && Object.keys(config.headers).length > 0 && { headers: config.headers }),
			};
		}

		return result;
	}

	// --- Agent-specific Skills ---

	/**
	 * Get skill enable states for a specific agent.
	 */
	getAgentSkills(agentId: string): Record<string, AgentSkillState> {
		return this.#data.agents[agentId]?.skills ?? {};
	}

	/**
	 * Set skill enabled state for an agent.
	 * Creates a minimal skill entry if it doesn't exist.
	 */
	setAgentSkillEnabled(agentId: string, skillId: string, enabled: boolean): void {
		const agent = this.#data.agents[agentId];
		if (!agent) return;

		agent.skills[skillId] = { enabled };
		void this.saveSettings();
	}

	/**
	 * Delete a skill entry from an agent (only removes enable state, file-based skills remain).
	 */
	deleteAgentSkillEntry(agentId: string, skillId: string): boolean {
		const agent = this.#data.agents[agentId];
		if (!agent?.skills[skillId]) return false;

		delete agent.skills[skillId];
		void this.saveSettings();
		return true;
	}

	get isVerbose() {
		return this.#data.isVerbose;
	}
	set isVerbose(val: boolean) {
		this.#data.isVerbose = val;
		applyVerboseLogging(val);
		void this.saveSettings();
	}

	get showToolIODetails() {
		return this.#data.showToolIODetails ?? false;
	}
	set showToolIODetails(val: boolean) {
		this.#data.showToolIODetails = val;
		void this.saveSettings();
	}

	get thinkingProcessExpanded() {
		return this.#data.thinkingProcessExpanded ?? true;
	}
	set thinkingProcessExpanded(val: boolean) {
		this.#data.thinkingProcessExpanded = val;
		void this.saveSettings();
	}

	get showActiveAgentsInStatusBar() {
		return this.#data.showActiveAgentsInStatusBar ?? true;
	}
	set showActiveAgentsInStatusBar(val: boolean) {
		this.#data.showActiveAgentsInStatusBar = val;
		void this.saveSettings();
	}

	get overrideMobileNavbarSearch() {
		return this.#data.overrideMobileNavbarSearch ?? false;
	}
	set overrideMobileNavbarSearch(val: boolean) {
		this.#data.overrideMobileNavbarSearch = val;
		void this.saveSettings();
	}

	get suppressIntegrationPrivacyWarning() {
		return this.#data.suppressIntegrationPrivacyWarning ?? false;
	}
	set suppressIntegrationPrivacyWarning(val: boolean) {
		this.#data.suppressIntegrationPrivacyWarning = val;
		void this.saveSettings();
	}

	get onboardingComplete() {
		return this.#data.onboardingComplete;
	}
	set onboardingComplete(val: boolean) {
		this.#data.onboardingComplete = val;
		void this.saveSettings();
	}

	get onboardingSplashSeen() {
		return this.#data.onboardingSplashSeen;
	}
	set onboardingSplashSeen(val: boolean) {
		this.#data.onboardingSplashSeen = val;
		void this.saveSettings();
	}

	get dismissedRecommendations() {
		return this.#data.dismissedRecommendations;
	}
	isRecommendationDismissed(id: string) {
		return this.#data.dismissedRecommendations.includes(id);
	}
	dismissRecommendation(id: string) {
		if (!this.#data.dismissedRecommendations.includes(id)) {
			// Reassign (not push) so $state reactivity fires.
			this.#data.dismissedRecommendations = [...this.#data.dismissedRecommendations, id];
			void this.saveSettings();
		}
	}
	/** Brings every dismissed recommendation back. Exposed in Developer settings. */
	restoreDismissedRecommendations() {
		this.#data.dismissedRecommendations = [];
		void this.saveSettings();
	}

	get searchShowPath() {
		return this.#data.searchShowPath;
	}
	set searchShowPath(val: boolean) {
		this.#data.searchShowPath = val;
		void this.saveSettings();
	}

	get searchShowTags() {
		return this.#data.searchShowTags;
	}
	set searchShowTags(val: boolean) {
		this.#data.searchShowTags = val;
		void this.saveSettings();
	}

	get searchShowMatchBadges() {
		return this.#data.searchShowMatchBadges;
	}
	set searchShowMatchBadges(val: boolean) {
		this.#data.searchShowMatchBadges = val;
		void this.saveSettings();
	}

	get searchShowMatchContext() {
		return this.#data.searchShowMatchContext;
	}
	set searchShowMatchContext(val: boolean) {
		this.#data.searchShowMatchContext = val;
		void this.saveSettings();
	}

	get searchShowKeyboardHints() {
		return this.#data.searchShowKeyboardHints;
	}
	set searchShowKeyboardHints(val: boolean) {
		this.#data.searchShowKeyboardHints = val;
		void this.saveSettings();
	}

	get recentNotes(): RecentNoteEntry[] {
		return [...(this.#data.recentNotes ?? [])].sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
	}

	async clearRecentNotes(): Promise<void> {
		this.#data.recentNotes = [];
		await this.saveSettingsOrThrow();
	}

	recordRecentlyOpenedNote(path: string): void {
		const normalizedPath = normalizePath(path);
		const now = Date.now();
		const existing = (this.#data.recentNotes ?? []).filter(
			// Drop the re-opened note (it is re-added at the front with a fresh
			// timestamp) and anything that has aged out of the recency window, so
			// the persisted list does not accumulate entries no reader can use.
			(entry) => entry.path !== normalizedPath && now - entry.lastOpenedAt < RECENT_NOTE_WINDOW_MS,
		);
		this.#data.recentNotes = [{ path: normalizedPath, lastOpenedAt: now }, ...existing].slice(0, MAX_RECENT_NOTES);
		void this.saveSettings();
	}

	// --- Embedding Indexes (Multi-Index) ---

	get embeddingIndexes(): EmbeddingIndexConfig[] {
		return this.#data.embeddingIndexes ?? [];
	}

	get searchEmbedIndex(): string | null {
		return this.#data.searchEmbedIndex;
	}

	get graphEmbedIndex(): string | null {
		return this.#data.graphEmbedIndex;
	}

	/**
	 * Get the index config for the search embed index.
	 */
	getSearchEmbedModel(): DefaultEmbedModel | null {
		const indexId = this.#data.searchEmbedIndex;
		if (!indexId) return null;
		const config = this.#data.embeddingIndexes.find((i) => i.id === indexId);
		return config ? { provider: config.provider, model: config.model } : null;
	}

	/**
	 * Get the index config for the graph embed index.
	 */
	getGraphEmbedModel(): DefaultEmbedModel | null {
		const indexId = this.#data.graphEmbedIndex;
		if (!indexId) return null;
		const config = this.#data.embeddingIndexes.find((i) => i.id === indexId);
		return config ? { provider: config.provider, model: config.model } : null;
	}

	/**
	 * Set or create the embedding index for search or graph.
	 * If no index exists for the given provider:model, creates one.
	 */
	setEmbedIndex(
		purpose: "search" | "graph",
		provider: string,
		model: string,
		options?: { batchSize?: number },
	): void {
		const indexId = `${provider}:${model}`;
		const configuredBatchSize =
			options?.batchSize !== undefined ? normalizeEmbeddingBatchSize(options.batchSize, provider) : undefined;

		// Ensure index config exists
		const existing = this.#data.embeddingIndexes.find((i) => i.id === indexId);
		if (!existing) {
			this.#data.embeddingIndexes.push({
				id: indexId,
				provider,
				model,
				createdAt: Date.now(),
				lastBuiltAt: null,
				documentCount: 0,
				batchSize: configuredBatchSize ?? getDefaultEmbeddingBatchSize(provider),
			});
		} else if (configuredBatchSize !== undefined) {
			existing.batchSize = configuredBatchSize;
		} else if (existing.batchSize === undefined) {
			existing.batchSize = getDefaultEmbeddingBatchSize(provider);
		}

		// Set the index for the requested purpose
		if (purpose === "search") {
			this.#data.searchEmbedIndex = indexId;
		} else {
			this.#data.graphEmbedIndex = indexId;
		}

		void this.saveSettings();
	}

	/**
	 * Clear the embedding index for a specific purpose.
	 */
	clearEmbedIndex(purpose: "search" | "graph"): void {
		if (purpose === "search") {
			this.#data.searchEmbedIndex = null;
		} else {
			this.#data.graphEmbedIndex = null;
		}

		void this.saveSettings();
	}

	/**
	 * Update cached stats for an embedding index.
	 */
	updateEmbeddingIndexStats(
		indexId: string,
		stats: {
			lastBuiltAt?: number | null;
			documentCount?: number;
			dimensions?: number;
			failedNotes?: Record<string, number>;
		},
	): void {
		const config = this.#data.embeddingIndexes.find((i) => i.id === indexId);
		if (!config) return;
		// Skip the save when nothing moved: the count is now re-synced at every
		// index open and bulk checkpoint, and most of those confirm the cached
		// value rather than change it.
		let changed = false;
		if (stats.lastBuiltAt !== undefined && config.lastBuiltAt !== stats.lastBuiltAt) {
			config.lastBuiltAt = stats.lastBuiltAt;
			changed = true;
		}
		if (stats.documentCount !== undefined && config.documentCount !== stats.documentCount) {
			config.documentCount = stats.documentCount;
			changed = true;
		}
		if (stats.dimensions !== undefined && config.dimensions !== stats.dimensions) {
			config.dimensions = stats.dimensions;
			changed = true;
		}
		if (stats.failedNotes !== undefined) {
			// Written only when the set actually moved (the indexer diffs first);
			// an empty record is dropped rather than stored.
			const next = Object.keys(stats.failedNotes).length > 0 ? stats.failedNotes : undefined;
			if (next !== undefined || config.failedNotes !== undefined) {
				config.failedNotes = next;
				changed = true;
			}
		}
		if (changed) void this.saveSettings();
	}

	/**
	 * Remove an embedding index config and its references.
	 * Returns false if the index is currently used by the other feature.
	 */
	removeEmbeddingIndex(indexId: string): boolean {
		const usedBySearch = this.#data.searchEmbedIndex === indexId;
		const usedByGraph = this.#data.graphEmbedIndex === indexId;

		if (usedBySearch) this.#data.searchEmbedIndex = null;
		if (usedByGraph) this.#data.graphEmbedIndex = null;

		this.#data.embeddingIndexes = this.#data.embeddingIndexes.filter((i) => i.id !== indexId);

		void this.saveSettings();
		return true;
	}

	/**
	 * Get the EmbeddingIndexConfig for a given index ID.
	 */
	getEmbeddingIndex(indexId: string): EmbeddingIndexConfig | undefined {
		return this.#data.embeddingIndexes.find((i) => i.id === indexId);
	}

	// --- Smart Graph Settings ---

	get smartGraphSettings(): SmartGraphSettings {
		return this.#data.smartGraphSettings ?? DEFAULT_SMART_GRAPH_SETTINGS;
	}
	set smartGraphSettings(val: SmartGraphSettings) {
		this.#data.smartGraphSettings = val;
		void this.saveSettings();
	}

	// --- Diff View Mode ---

	get diffViewMode(): DiffViewMode {
		return this.#data.diffViewMode ?? "two-pane";
	}
	set diffViewMode(val: DiffViewMode) {
		this.#data.diffViewMode = val;
		void this.saveSettings();
	}

	get vaultSlug(): string {
		// Always non-null after createData() resolves it; fallback for safety
		return this.#data.vaultSlug ?? "vault";
	}

	// --- Chat Open Location ---

	get chatOpenLocation(): ChatOpenLocation {
		return this.#data.chatOpenLocation ?? "tab";
	}
	set chatOpenLocation(val: ChatOpenLocation) {
		this.#data.chatOpenLocation = val;
		void this.saveSettings();
	}

	// --- Favorite Models ---

	get favoriteModels(): Array<{ provider: string; model: string }> {
		return this.#data.favoriteModels ?? [];
	}

	isFavoriteModel(provider: string, model: string): boolean {
		return this.#data.favoriteModels?.some((f) => f.provider === provider && f.model === model) ?? false;
	}

	toggleFavoriteModel(provider: string, model: string): void {
		if (!this.#data.favoriteModels) {
			this.#data.favoriteModels = [];
		}
		const idx = this.#data.favoriteModels.findIndex((f) => f.provider === provider && f.model === model);
		if (idx >= 0) {
			this.#data.favoriteModels.splice(idx, 1);
		} else {
			this.#data.favoriteModels.push({ provider, model });
		}
		void this.saveSettings();
	}

	// Get/set isConfigured for a provider
	getProviderIsConfigured(provider: string): boolean {
		const config = this.#data.providerConfig[provider];
		return config?.isConfigured ?? false;
	}

	toggleProviderIsConfigured(provider: string) {
		const config = this.#data.providerConfig[provider];
		if (!config) return;

		const wasConfigured = config.isConfigured;
		config.isConfigured = !wasConfigured;

		void this.saveSettings();
	}

	/**
	 * Get stored provider auth params.
	 * Returns auth values and secret IDs (not resolved secrets).
	 */
	getStoredProviderAuthParams(provider: string): {
		apiKeyId?: string;
		baseUrl?: string;
		headers?: Record<string, string>;
	} {
		const config = this.#data.providerConfig[provider];
		if (!config) return {};

		const auth = config.auth;
		const result: { apiKeyId?: string; baseUrl?: string; headers?: Record<string, string> } = {};

		if (auth.secretIds.apiKey) {
			result.apiKeyId = auth.secretIds.apiKey;
		}
		if (auth.values.baseUrl) {
			result.baseUrl = auth.values.baseUrl;
		}
		if (auth.values.headers) {
			try {
				result.headers = JSON.parse(auth.values.headers);
			} catch {
				// ignore parse errors
			}
		}
		return result;
	}

	/**
	 * Get resolved provider auth params with actual secrets from SecretStorage
	 */
	getResolvedProviderAuth(provider: string): { apiKey?: string; baseUrl?: string; headers?: Record<string, string> } {
		const config = this.#data.providerConfig[provider];
		if (!config) return {};

		const auth = config.auth;
		const resolved: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> } = {};

		// Resolve apiKey secret
		if (auth.secretIds.apiKey) {
			const secret = getSecret(this._plugin.app, auth.secretIds.apiKey);
			if (secret) {
				resolved.apiKey = secret;
			}
		}

		// Copy baseUrl
		if (auth.values.baseUrl) {
			resolved.baseUrl = auth.values.baseUrl;
		}

		// Parse headers
		if (auth.values.headers) {
			try {
				resolved.headers = JSON.parse(auth.values.headers);
			} catch {
				// ignore parse errors
			}
		}

		return resolved;
	}

	/**
	 * Set a stored auth parameter (for non-secret fields like baseUrl)
	 */
	setStoredAuthParam(provider: string, key: string, value: unknown): void {
		const config = this.#data.providerConfig[provider];
		if (!config) return;

		if (key === "apiKeyId") {
			// Store as secret ID
			config.auth.secretIds.apiKey = value as string;
		} else {
			// Store as value
			config.auth.values[key] = value as string;
		}
		void this.saveSettings();
	}

	/**
	 * Create a new secret and assign it to a provider
	 */
	createAndAssignSecret(provider: string, secretId: string, secretValue: string): void {
		setSecret(this._plugin.app, secretId, secretValue);
		this.setStoredAuthParam(provider, "apiKeyId", secretId);
	}

	/**
	 * Assign an existing secret to a provider
	 */
	assignSecretToProvider(provider: string, secretId: string): void {
		this.setStoredAuthParam(provider, "apiKeyId", secretId);
	}

	/**
	 * Get the actual API key from SecretStorage
	 */
	getProviderApiKey(provider: string): string | null {
		const config = this.#data.providerConfig[provider];
		if (!config) return null;

		const secretId = config.auth.secretIds.apiKey;
		if (!secretId) return null;
		return getSecret(this._plugin.app, secretId);
	}

	/**
	 * List all available secrets
	 */
	listAvailableSecrets(): string[] {
		return listSecrets(this._plugin.app);
	}

	// --- Embedding Model Management (Record-based) ---

	getEmbedModels(provider: string): Record<string, EmbedModelConfig> {
		const config = this.#data.providerConfig[provider];
		return config?.embedModels ?? {};
	}

	addEmbedModel(provider: string, modelName: string, conf: EmbedModelConfig) {
		const config = this.#data.providerConfig[provider];
		if (!config) return;
		if (modelName in config.embedModels) throw new AddEmbedModelError(provider, modelName);
		config.embedModels = { ...config.embedModels, [modelName]: conf };
		void this.saveSettings();
	}

	updateEmbedModel(provider: string, modelName: string, conf: EmbedModelConfig) {
		const config = this.#data.providerConfig[provider];
		if (!config) return;
		if (!(modelName in config.embedModels)) throw new SetEmbedModelError(provider, modelName);
		config.embedModels = { ...config.embedModels, [modelName]: conf };
		void this.saveSettings();
	}

	deleteEmbedModel(provider: string, modelName: string) {
		const config = this.#data.providerConfig[provider];
		if (!config) return;
		if (!(modelName in config.embedModels)) throw new SetEmbedModelError(provider, modelName);
		const { [modelName]: _, ...rest } = config.embedModels;
		config.embedModels = rest;
		void this.saveSettings();
	}

	// --- Chat Model Management (Record-based) ---

	getChatModels(provider: string): Record<string, ChatModelConfig> {
		const config = this.#data.providerConfig[provider];
		return config?.chatModels ?? {};
	}

	addChatModel(provider: string, modelName: string, conf: ChatModelConfig) {
		const config = this.#data.providerConfig[provider];
		if (!config) return;
		if (modelName in config.chatModels) throw new AddChatModelError(provider, modelName);
		config.chatModels = { ...config.chatModels, [modelName]: conf };
		void this.saveSettings();
	}

	updateChatModel(provider: string, modelName: string, conf: ChatModelConfig) {
		const config = this.#data.providerConfig[provider];
		if (!config) return;
		if (!(modelName in config.chatModels)) throw new SetChatModelError(provider, modelName);
		config.chatModels = { ...config.chatModels, [modelName]: conf };
		void this.saveSettings();
	}

	deleteChatModel(provider: string, modelName: string) {
		const config = this.#data.providerConfig[provider];
		if (!config) return;
		if (!(modelName in config.chatModels)) throw new SetChatModelError(provider, modelName);
		const { [modelName]: _, ...rest } = config.chatModels;
		config.chatModels = rest;

		for (const agent of Object.values(this.#data.agents)) {
			if (agent.chatModel?.provider === provider && agent.chatModel.model === modelName) {
				agent.chatModel = null;
			}
			if (agent.summarizationModel?.provider === provider && agent.summarizationModel.model === modelName) {
				agent.summarizationModel = null;
			}
			if (agent.titleModel?.provider === provider && agent.titleModel.model === modelName) {
				agent.titleModel = null;
			}
		}

		void this.saveSettings();
	}

	// Get/set chatModels
	getProviderChatModels(provider: string): Record<string, ChatModelConfig> | undefined {
		const config = this.#data.providerConfig[provider];
		return config?.chatModels;
	}

	setProviderChatModels(provider: string, value: Record<string, ChatModelConfig>) {
		const config = this.#data.providerConfig[provider];
		if (config) {
			config.chatModels = value;
			void this.saveSettings();
		}
	}

	// ============================================================================
	// Provider System Methods
	// ============================================================================

	getProviderMeta(providerId: string): ProviderInstanceMeta | undefined {
		return this.#data.providerMeta[providerId];
	}

	getAllProviderMeta(): Record<string, ProviderInstanceMeta> {
		return this.#data.providerMeta;
	}

	/**
	 * Get stored auth state for a provider.
	 * Returns the stored auth state with secret IDs (not resolved secrets).
	 */
	getStoredAuthState(providerId: string): StoredAuthState | undefined {
		const config = this.#data.providerConfig[providerId];
		return config?.auth;
	}

	/**
	 * Get resolved auth state for a provider.
	 * Resolves secret IDs to actual secret values and returns AuthObject.
	 */
	getResolvedAuthState(providerId: string): AuthObject | undefined {
		const stored = this.getStoredAuthState(providerId);
		if (!stored) return undefined;

		const result: AuthObject = {};

		if (stored.authMode) {
			result.authMode = stored.authMode;
		}

		// Copy non-secret values
		if (stored.values.baseUrl) {
			result.baseUrl = stored.values.baseUrl;
		}

		// Parse headers if present
		if (stored.values.headers) {
			try {
				result.headers = JSON.parse(stored.values.headers);
			} catch {
				// ignore parse errors
			}
		}

		// Resolve secret IDs to actual values
		for (const [fieldName, secretId] of Object.entries(stored.secretIds)) {
			const secretValue = getSecret(this._plugin.app, secretId);
			if (secretValue) {
				if (fieldName === "apiKey") {
					result.apiKey = secretValue;
				}
			}
		}

		return result;
	}

	/**
	 * Check if a provider is configured.
	 */
	isProviderConfigured(providerId: string): boolean {
		const config = this.#data.providerConfig[providerId];
		return config?.isConfigured ?? false;
	}

	/**
	 * Set provider configured status.
	 */
	setProviderConfigured(providerId: string, isConfigured: boolean): void {
		const config = this.#data.providerConfig[providerId];
		if (!config) return;

		const wasConfigured = config.isConfigured;
		config.isConfigured = isConfigured;

		// If disabling, clear every agent model slot pointing at this provider — not just
		// the chat model. A dangling summarization/title reference would still be handed to
		// the LLM path at runtime, and a dangling chatModel makes the chat view read as
		// "model selected" and hide the provider CTA. Same cleanup as deleteProvider.
		// (Favorites are deliberately kept: disabling is reversible, and an inert favorite
		// is harmless while the provider is off.)
		if (wasConfigured && !isConfigured) {
			for (const agent of Object.values(this.#data.agents)) {
				if (agent.chatModel?.provider === providerId) agent.chatModel = null;
				if (agent.summarizationModel?.provider === providerId) agent.summarizationModel = null;
				if (agent.titleModel?.provider === providerId) agent.titleModel = null;
			}
		}

		// This is the commit point for a newly added provider (ProviderSetup flips it on a
		// successful connection). Registering here is what makes the provider usable in chat
		// immediately, instead of only after the next Obsidian reload.
		if (isConfigured) {
			syncProvider(this, providerId);
		} else {
			unsyncProvider(providerId);
		}

		void this.saveSettings();
	}

	/**
	 * Set a stored auth field value.
	 * For non-secret fields, stores the value directly.
	 * For secret fields, creates/updates the secret in SecretStorage.
	 */
	setProviderAuthField(providerId: string, fieldName: string, value: string, isSecret: boolean): void {
		const config = this.#data.providerConfig[providerId];
		if (!config) return;

		if (isSecret) {
			// Store in SecretStorage and save the ID
			const secretId = buildManagedSecretId(providerId, fieldName);
			setSecret(this._plugin.app, secretId, value);
			config.auth.secretIds[fieldName] = secretId;
		} else {
			// Store directly
			config.auth.values[fieldName] = value;
		}
		// Refresh the registry's cached auth — it snapshots the resolved AuthObject at
		// registration, so an edited key/baseUrl would otherwise keep using the old value.
		this.syncProviderIfConfigured(providerId);
		void this.saveSettings();
	}

	/**
	 * Assign an existing secret ID to a provider field.
	 * Unlike setProviderAuthField, this doesn't create a new secret - it just
	 * stores the reference to an existing secret.
	 */
	assignSecretIdToProviderField(providerId: string, fieldName: string, secretId: string): void {
		const config = this.#data.providerConfig[providerId];
		if (!config) return;

		if (secretId.trim()) {
			config.auth.secretIds[fieldName] = secretId;
		} else {
			delete config.auth.secretIds[fieldName];
		}
		this.syncProviderIfConfigured(providerId);
		void this.saveSettings();
	}

	getProviderAuthMode(providerId: string): OpenAIAuthMode {
		const config = this.#data.providerConfig[providerId];
		const meta = this.#data.providerMeta[providerId];
		if (!config) return "apiKey";
		if (meta?.templateId === "openai-codex") {
			return "codex";
		}
		if (config.auth.authMode !== undefined) {
			return config.auth.authMode;
		}
		return "apiKey";
	}

	setProviderAuthMode(providerId: string, authMode: OpenAIAuthMode): void {
		const config = this.#data.providerConfig[providerId];
		if (!config) return;
		config.auth.authMode = authMode;
		this.syncProviderIfConfigured(providerId);
		void this.saveSettings();
	}

	/**
	 * Refreshes the runtime registry entry for a provider after its auth changed, but only
	 * once it's configured. Drafts are deliberately skipped: an unconfigured provider is a
	 * half-filled Setup modal, and registering it would expose a provider the user hasn't
	 * committed (and that onClose may delete).
	 */
	private syncProviderIfConfigured(providerId: string): void {
		if (!this.isProviderConfigured(providerId)) return;
		syncProvider(this, providerId);
	}

	isProviderUsingCodexAuth(providerId: string): boolean {
		// Covers both the legacy "openai-codex" template and the first-class "openai"
		// template switched to ChatGPT sign-in (auth.authMode === "codex"). A template-only
		// check would miss the latter, letting codex-mode providers be offered for
		// embeddings — which they don't support (createEmbeddingInstance throws).
		//
		// Scoped to OpenAI-family templates on purpose. `authMode` is a two-value flag
		// ("apiKey" | "codex") shared by every OAuth-capable provider, and ProviderSetup's
		// API-key toggle writes the literal "codex" to mean "not the API-key path" — so a
		// non-OpenAI OAuth provider (OpenRouter) ends up stored as authMode: "codex" merely
		// by signing in. Matching on the string alone then read that as ChatGPT auth and hid
		// every embedding model the provider offers (OpenRouter serves 32 via its dedicated
		// /embeddings/models endpoint). Codex auth only actually exists for OpenAI.
		const templateId = this.#data.providerMeta[providerId]?.templateId;
		if (templateId !== "openai" && templateId !== "openai-codex") {
			return false;
		}
		return this.getProviderAuthMode(providerId) === "codex";
	}

	isProviderEmbeddingAvailable(providerId: string): boolean {
		return !this.isProviderUsingCodexAuth(providerId);
	}

	getProviderTemplateId(providerId: string): ProviderTemplateId | undefined {
		return this.#data.providerMeta[providerId]?.templateId;
	}

	getProviderIdsByTemplate(templateId: ProviderTemplateId): string[] {
		return Object.entries(this.#data.providerMeta)
			.filter(([_, meta]) => meta.templateId === templateId)
			.map(([providerId]) => providerId);
	}

	async addProviderInstance(
		id: string,
		meta: ProviderInstanceMeta,
		{ configured = false }: { configured?: boolean } = {},
	): Promise<void> {
		if (id in this.#data.providerConfig || id in this.#data.providerMeta) {
			throw new Error(`Provider with ID "${id}" already exists`);
		}

		const duplicate = Object.values(this.#data.providerMeta).find(
			(m) => m.displayName.trim().toLowerCase() === meta.displayName.trim().toLowerCase(),
		);
		if (duplicate) {
			throw new Error(`A provider named "${meta.displayName}" already exists`);
		}

		this.#data.providerMeta[id] = meta;
		this.#data.providerConfig[id] = {
			...createProviderState(meta.templateId),
			isConfigured: configured,
		};

		await this.saveSettingsOrThrow();
	}

	async updateProviderMeta(providerId: string, updates: Partial<ProviderInstanceMeta>): Promise<void> {
		const existing = this.#data.providerMeta[providerId];
		if (!existing) {
			throw new Error(`Provider with ID "${providerId}" not found`);
		}

		if (updates.displayName !== undefined && updates.displayName !== existing.displayName) {
			const duplicate = Object.entries(this.#data.providerMeta).find(
				([id, m]) =>
					id !== providerId &&
					m.displayName.trim().toLowerCase() === updates.displayName?.trim().toLowerCase(),
			);
			if (duplicate) {
				throw new Error(`A provider named "${updates.displayName}" already exists`);
			}
		}

		const nextMeta = { ...existing, ...updates };
		this.#data.providerMeta[providerId] = nextMeta;

		if (updates.templateId && updates.templateId !== existing.templateId) {
			this.#data.providerConfig[providerId] = {
				...createProviderState(nextMeta.templateId),
				isConfigured: this.#data.providerConfig[providerId]?.isConfigured ?? false,
			};
		}

		await this.saveSettingsOrThrow();
	}

	/**
	 * Re-key a provider from oldId to newId, updating all references across plugin data.
	 * Used when the provider's display name changes and the ID should stay in sync.
	 */
	async renameProvider(oldId: string, newId: string): Promise<void> {
		if (oldId === newId) return;

		if (!(oldId in this.#data.providerMeta)) {
			throw new Error(`Provider with ID "${oldId}" not found`);
		}
		if (newId in this.#data.providerMeta || newId in this.#data.providerConfig) {
			throw new Error(`Provider with ID "${newId}" already exists`);
		}

		// Re-key providerMeta + providerConfig
		this.#data.providerMeta[newId] = this.#data.providerMeta[oldId];
		this.#data.providerConfig[newId] = this.#data.providerConfig[oldId];
		delete this.#data.providerMeta[oldId];
		delete this.#data.providerConfig[oldId];

		// Update embeddingIndexes: both .provider and composite .id
		for (const index of this.#data.embeddingIndexes) {
			if (index.provider === oldId) {
				index.provider = newId;
				index.id = `${newId}:${index.model}`;
			}
		}

		// Update searchEmbedIndex / graphEmbedIndex (composite "provider:model")
		if (this.#data.searchEmbedIndex?.startsWith(`${oldId}:`)) {
			this.#data.searchEmbedIndex = `${newId}:${this.#data.searchEmbedIndex.slice(oldId.length + 1)}`;
		}
		if (this.#data.graphEmbedIndex?.startsWith(`${oldId}:`)) {
			this.#data.graphEmbedIndex = `${newId}:${this.#data.graphEmbedIndex.slice(oldId.length + 1)}`;
		}

		// Update agent chatModel / summarizationModel provider references
		for (const agent of Object.values(this.#data.agents)) {
			if (agent.chatModel?.provider === oldId) {
				agent.chatModel = { ...agent.chatModel, provider: newId };
			}
			if (agent.summarizationModel?.provider === oldId) {
				agent.summarizationModel = { ...agent.summarizationModel, provider: newId };
			}
			if (agent.titleModel?.provider === oldId) {
				agent.titleModel = { ...agent.titleModel, provider: newId };
			}
		}

		// Update favoriteModels
		if (this.#data.favoriteModels) {
			for (const fav of this.#data.favoriteModels) {
				if (fav.provider === oldId) fav.provider = newId;
			}
		}

		// A rename touches two IDs (drop the old entry, add the new), so reconcile the whole
		// registry rather than syncing a single ID.
		syncAllProviders(this);

		await this.saveSettingsOrThrow();
		// The config is saved either way; a listener that fails logs and leaves
		// the index to rebuild, which is what happened before on every rename.
		await Promise.all([...this.#providerRenameListeners].map((listener) => listener(oldId, newId)));
	}

	/**
	 * Delete a provider and every reference to it across plugin data.
	 *
	 * Returns the IDs of embedding indexes that belonged to this provider. Their config
	 * records are gone, but their vectors are intentionally left on disk (see below) so
	 * they can be reused. Pass these IDs to `VectorStoreService.deleteIndex` only when
	 * the user has explicitly opted into discarding the embeddings; ignoring the return
	 * value is the correct default, and drafts never own indexes anyway.
	 */
	async deleteProvider(providerId: string): Promise<string[]> {
		if (!(providerId in this.#data.providerMeta)) {
			throw new Error(`Provider with ID "${providerId}" not found`);
		}

		// Collect this provider's secret IDs before dropping its config, so we can
		// clear the raw values from the (cross-plugin) SecretStorage instead of
		// orphaning API keys there after the provider is gone.
		const config = this.#data.providerConfig[providerId];
		const secretIdsToConsider = config ? Object.values(config.auth.secretIds ?? {}) : [];

		delete this.#data.providerMeta[providerId];
		delete this.#data.providerConfig[providerId];

		// Drop every reference to the provider that just went away. Without this the
		// selections survive as dangling pointers to a provider that no longer exists:
		// an agent keeps a `chatModel` whose provider is gone, so the chat view still
		// reads as "a model is selected" and shows suggestions instead of the "Add an
		// AI provider" CTA, and the composer offers a model it can never run.
		// `renameProvider` re-points these same fields; deletion clears them.
		for (const agent of Object.values(this.#data.agents)) {
			if (agent.chatModel?.provider === providerId) agent.chatModel = null;
			if (agent.summarizationModel?.provider === providerId) agent.summarizationModel = null;
			if (agent.titleModel?.provider === providerId) agent.titleModel = null;
		}

		if (this.#data.favoriteModels) {
			this.#data.favoriteModels = this.#data.favoriteModels.filter((fav) => fav.provider !== providerId);
		}

		// Embedding indexes are keyed "provider:model", so the provider's indexes go
		// too — along with the search/graph assignments pointing at them, which would
		// otherwise keep naming an index whose provider can no longer embed anything.
		//
		// Only the config *records* are dropped; the vectors themselves are deliberately
		// left in IndexedDB, because they are expensive to recompute. This does not
		// strand them: the IndexedDB name is derived from the same "provider:model" id,
		// and `setEmbedIndex` recreates the config record from that id — so re-adding
		// this provider and selecting the same model reopens the existing database
		// instead of re-embedding the vault. Purging is a separate, opt-in action, and
		// the orphaned IDs are returned so a caller holding the vector store can do it.
		const orphanedIndexIds = this.#data.embeddingIndexes
			.filter((index) => index.provider === providerId)
			.map((index) => index.id);
		if (orphanedIndexIds.length > 0) {
			this.#data.embeddingIndexes = this.#data.embeddingIndexes.filter((index) => index.provider !== providerId);
			if (this.#data.searchEmbedIndex && orphanedIndexIds.includes(this.#data.searchEmbedIndex)) {
				this.#data.searchEmbedIndex = null;
			}
			if (this.#data.graphEmbedIndex && orphanedIndexIds.includes(this.#data.graphEmbedIndex)) {
				this.#data.graphEmbedIndex = null;
			}
		}

		// A secret ID can be shared (assignSecretIdToProviderField lets one field
		// point at an existing secret). Only remove secrets no remaining provider
		// still references, so we never clear a key another provider depends on.
		const stillReferenced = new Set<string>();
		for (const cfg of Object.values(this.#data.providerConfig)) {
			for (const id of Object.values(cfg.auth.secretIds ?? {})) stillReferenced.add(id);
		}
		for (const secretId of secretIdsToConsider) {
			if (secretId && !stillReferenced.has(secretId)) {
				removeSecret(this._plugin.app, secretId);
			}
		}

		// Drop the runtime registry entry. Without this the deleted provider stays live and
		// fully usable in memory — holding the resolved API key we just cleared from
		// SecretStorage — until the next Obsidian reload.
		unsyncProvider(providerId);

		await this.saveSettingsOrThrow();

		return orphanedIndexIds;
	}
}

let _pluginDataStore: PluginDataStore | null = null;

export async function createData(plugin: SecondBrainPlugin): Promise<PluginDataStore> {
	if (_pluginDataStore) return _pluginDataStore;

	const rawData = await plugin.loadData();

	const mergedData: PluginData = {
		...DEFAULT_SETTINGS,
		...rawData,
	};

	runMigrations(mergedData);

	// If the data was written by a newer plugin, skip normalizeAgents() too — it
	// would rewrite prompt fields using this plugin's older defaults and those
	// mutations would be persisted on the next save, corrupting the newer state.
	const fromNewerPlugin = (rawData?.schemaVersion ?? 0) > CURRENT_SCHEMA_VERSION;

	if (fromNewerPlugin) {
		// Leave agents untouched; just ensure the bare minimum so the UI doesn't crash.
		if (!mergedData.agents || Object.keys(mergedData.agents).length === 0) {
			mergedData.agents = { [DEFAULT_AGENT_ID]: createDefaultAgent() };
			mergedData.defaultAgentId = DEFAULT_AGENT_ID;
			mergedData.selectedAgentId = DEFAULT_AGENT_ID;
		}
	} else if (!rawData?.agents || Object.keys(rawData.agents).length === 0) {
		mergedData.agents = { [DEFAULT_AGENT_ID]: createDefaultAgent() };
		mergedData.defaultAgentId = DEFAULT_AGENT_ID;
		mergedData.selectedAgentId = DEFAULT_AGENT_ID;
	} else {
		normalizeAgents(mergedData);
	}

	// Resolve vault slug once on first load; persisted so vault renames don't orphan indexes
	if (!mergedData.vaultSlug) {
		mergedData.vaultSlug = await resolveVaultSlug(plugin.app.vault.getName());
	}

	_pluginDataStore = new PluginDataStore(plugin, mergedData);

	return _pluginDataStore;
}

export function getData(): PluginDataStore {
	if (!_pluginDataStore) throw new Error("Plugin does not exist");
	return _pluginDataStore;
}

/**
 * Test-only: clear the module-level singleton so a subsequent `createData` runs migrations +
 * normalization on fresh input. `createData` memoizes its result, which is correct at runtime
 * (one store per session) but makes per-test fixtures leak across tests. Not used in production.
 */
export function __resetPluginDataStoreForTests(): void {
	_pluginDataStore = null;
}

/**
 * Resolve a stable slug for the vault, derived from its current name.
 * Checks existing IndexedDB databases to avoid collisions with other vaults
 * that may share the same origin. Increments a numeric suffix if needed.
 * e.g. "My Vault" → "my-vault", or "my-vault-2" if already taken.
 */
async function resolveVaultSlug(vaultName: string): Promise<string> {
	const base =
		vaultName
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "vault";

	const dbs =
		typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function"
			? []
			: ((await Promise.resolve(indexedDB.databases()).catch(() => [] as IDBDatabaseInfo[])) ?? []);
	const existingNames = new Set(dbs.map((d) => d.name ?? ""));

	// A slug is "taken by another vault" if any s2b- DB exists with that prefix
	// but our data.json doesn't have it yet (handled by caller).
	const isTaken = (slug: string) =>
		[`s2b-hnsw-${slug}`, `s2b-minisearch-${slug}`].some((prefix) =>
			[...existingNames].some((name) => name === prefix || name.startsWith(`${prefix}-`)),
		);

	if (!isTaken(base)) return base;
	let n = 2;
	while (isTaken(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

// Re-exported from utils/slugify so existing importers keep working; the
// implementation lives there to stay reachable from lib/secretStorage without
// an import cycle (dataStore already imports secretStorage).
export { slugifyProviderName } from "../utils/slugify";
