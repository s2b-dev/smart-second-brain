import { type EventRef, MarkdownView, Menu, Notice, Plugin, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { mount, unmount } from "svelte";
import "./lib/i18n";
import "./lib/langgraphContext";
import { Logger as Log, applyVerboseLogging } from "./utils/logging";
import { isAgentFilePath } from "./utils/fileFiltering";
import { resetAvailableModels, useAvailableModels } from "./hooks/useAvailableModels.svelte";
import { isMobileUI } from "./utils/platform";
import { StartupProfiler } from "./utils/startupProfiler";
import { persistStartupRecord, recordStartupEnvironment } from "./utils/startupTimingsStore";
import "./styles.css";
import { AgentManager } from "./agent/AgentManager";
import { PromptFilesService } from "./agent/promptFiles";
import { performSearch } from "./agent/tools/searchNotes";
import type { SearchAlgorithm } from "./types/plugin";
import { inlineDiffPlugin } from "./editor/inlineDiffExtension";
import { selectionHighlightPlugin } from "./editor/selectionHighlightExtension";
import { createReadingViewDiffPostProcessor } from "./editor/readingViewDiffProcessor";
import { terminateWorker as terminateClusteringWorker } from "./utils/computeWorkerManager";
import { SearchModal } from "./components/modal/SearchModal";
import { confirmDelete } from "./components/modal/ConfirmModal";
import { promptText } from "./components/modal/PromptModal";
import { getQueryClient } from "./lib/query";
import { SkillsService } from "./skills";
import { createSessionRegistry, getSessionRegistry, type SessionRegistry } from "./stores/chatStore.svelte";
import { type PluginDataStore, createData, getData } from "./stores/dataStore.svelte";
import { PendingChangesStore, initPendingChangesStore } from "./stores/pendingChangesStore.svelte";
import { setPlugin } from "./stores/state.svelte";
import { onCodexSessionChange } from "./stores/providerRuntime.svelte";
import { invalidateAuthState, invalidateProviderState } from "./lib/query";
import { LexicalSearchService } from "./search/LexicalSearchService";
import { ChatView, VIEW_TYPE_CHAT } from "./views/chat/Chat";
import { navigateToPendingChange } from "./lib/pendingChangeNavigation";
import { registerChatEmbed, unregisterChatEmbed } from "./views/chat/chatEmbed";
import RunningIndicator from "./components/chat/RunningIndicator.svelte";
// DISABLED FOR INITIAL RELEASE — Note Context view; see the registerView block in onload().
// import { NoteContextView, VIEW_TYPE_NOTE_CONTEXT } from "./views/note-context/NoteContextView";
import { OnboardingView, VIEW_TYPE_ONBOARDING } from "./views/onboarding/OnboardingView";
import { SmartGraphView, VIEW_TYPE_SMART_GRAPH } from "./views/smart-graph/SmartGraphView";
import SettingsTab from "./views/settings/Settings";
import { VectorStoreService, waitForVectorStore } from "./vectorstore";

const SUPPORTED_CHAT_ATTACHMENT_EXTENSIONS = new Set([
	"txt",
	"md",
	"csv",
	"json",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"pdf",
]);

export default class SecondBrainPlugin extends Plugin {
	agentManager!: AgentManager;
	skillsService!: SkillsService;
	promptFilesService!: PromptFilesService;
	lexicalSearchService!: LexicalSearchService;
	vectorStoreService!: VectorStoreService;
	pendingChangesStore!: PendingChangesStore;
	queryClient = getQueryClient();
	pluginData!: PluginDataStore;
	/** The global session registry (per-thread ChatSessions, running set, eviction).
	 *  Same instance the module singleton returns — held here so it's reachable for
	 *  debugging and any host-side wiring. */
	sessionRegistry!: SessionRegistry;
	/** `performance.now()` when `onload` finished; -1 until then. Used to attribute the
	 *  Obsidian pre-layout gap (onload:end → onLayoutReady). */
	private onloadEndAt = -1;
	/** Mounted status-bar running-agent indicator (unmounted on plugin unload). */
	private runningIndicator: ReturnType<typeof mount> | null = null;

	/**
	 * Run the shared search + ranking pipeline and return the ranked paths.
	 *
	 * `performSearch` is the single ranking entry point behind both the search modal
	 * (`SearchModal.ts`) and the `search_notes` agent tool, but it is a module-level
	 * export and therefore unreachable from the Obsidian CLI's `eval`. Exposing it
	 * here lets the relevance benchmark
	 * (`integration/search-relevance-benchmark.test.ts`) measure the real fusion
	 * ranking rather than re-implementing it. Not part of the plugin's user-facing
	 * surface.
	 */
	async searchNotesForBenchmark(
		query: string,
		algorithm: SearchAlgorithm,
		limit: number,
	): Promise<Array<{ path: string; name: string; score?: number }>> {
		const results = await performSearch(this.app, query, algorithm);
		return results.slice(0, limit).map((result) => ({
			path: result.path,
			name: result.name,
			score: result.score,
		}));
	}

	private getAddToChatMenuLabel(selectedCount: number): string {
		if (selectedCount <= 1) {
			return "Add to chat";
		}
		return `Add ${selectedCount} files to chat`;
	}

	/** Thread path for pending-change navigation: the focused chat if there is one,
	 *  else the most-recently-active open chat leaf. Jumping to a change makes the
	 *  target NOTE the active view, so relying on `getActiveViewOfType(ChatView)`
	 *  alone would break the second command press — the fallback keeps repeated
	 *  next/prev working while any chat is open. */
	private resolveChatThreadIdForNavigation(): string | null {
		const active = this.app.workspace.getActiveViewOfType(ChatView)?.file?.path;
		if (active) return active;
		const chatLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
		const recent = this.app.workspace.getMostRecentLeaf();
		const preferred = recent && chatLeaves.includes(recent) ? recent : chatLeaves[0];
		const view = preferred?.view;
		return view instanceof ChatView ? (view.file?.path ?? null) : null;
	}

	/** Add rename/delete actions to the right-click menu of a `.chat` file. */
	private addChatFileMenuItems(menu: Menu, file: TFile): void {
		menu.addItem((item) =>
			item
				.setTitle("Rename chat")
				.setIcon("pencil")
				.onClick(async () => {
					const newTitle = await promptText(this.app, "Rename chat", file.basename, "Rename");
					if (!newTitle || newTitle === file.basename) return;
					try {
						await this.agentManager.renameThread(file.path, newTitle);
					} catch (error) {
						new Notice(`Failed to rename chat: ${error instanceof Error ? error.message : String(error)}`);
					}
				}),
		);

		menu.addItem((item) =>
			item
				.setTitle("Delete chat")
				.setIcon("trash")
				.setWarning(true)
				.onClick(async () => {
					const confirmed = await confirmDelete(this.app, file.basename);
					if (!confirmed) return;
					try {
						await this.agentManager.deleteThread(file.path);
					} catch (error) {
						new Notice(`Failed to delete chat: ${error instanceof Error ? error.message : String(error)}`);
					}
				}),
		);
	}

	private registerNotebookNavigatorMenus() {
		type NavigatorMenuItem = {
			setTitle(title: string): NavigatorMenuItem;
			setIcon(icon: string): NavigatorMenuItem;
			onClick(cb: () => void | Promise<void>): NavigatorMenuItem;
		};

		type NavigatorFileMenuContext = {
			file?: unknown;
			selection?: { files?: unknown[] };
			addItem?: (cb: (item: NavigatorMenuItem) => void) => void;
		};

		type NavigatorMenusApi = {
			registerFileMenu?: (cb: (context: NavigatorFileMenuContext) => void) => (() => void) | undefined;
		};

		type NotebookNavigatorApi = {
			menus?: NavigatorMenusApi;
		};

		const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins;
		const notebookNavigator = plugins?.plugins?.["notebook-navigator"] as
			| { api?: NotebookNavigatorApi }
			| undefined;
		const registerFileMenu = notebookNavigator?.api?.menus?.registerFileMenu;

		if (typeof registerFileMenu !== "function") {
			return;
		}

		const dispose = registerFileMenu((context) => {
			if (typeof context.addItem !== "function") {
				return;
			}

			const selectedFiles = (
				Array.isArray(context.selection?.files) ? context.selection.files : [context.file]
			).filter((file): file is TFile => file instanceof TFile);

			if (selectedFiles.length === 0) {
				return;
			}

			// Single .chat file — show rename/delete instead of "Add to Chat"
			if (selectedFiles.length === 1 && selectedFiles[0].extension === "chat") {
				const file = selectedFiles[0];
				context.addItem((item) => {
					item.setTitle("Rename chat")
						.setIcon("pencil")
						.onClick(async () => {
							const newTitle = await promptText(this.app, "Rename chat", file.basename, "Rename");
							if (!newTitle || newTitle === file.basename) return;
							try {
								await this.agentManager.renameThread(file.path, newTitle);
							} catch (error) {
								new Notice(
									`Failed to rename chat: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						});
				});
				context.addItem((item) => {
					item.setTitle("Delete chat")
						.setIcon("trash")
						.onClick(async () => {
							const confirmed = await confirmDelete(this.app, file.basename);
							if (!confirmed) return;
							try {
								await this.agentManager.deleteThread(file.path);
							} catch (error) {
								new Notice(
									`Failed to delete chat: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						});
				});
				return;
			}

			context.addItem((item) => {
				item.setTitle(this.getAddToChatMenuLabel(selectedFiles.length))
					.setIcon("message-square-plus")
					.onClick(async () => {
						try {
							await this.queueFilesForChatAttachment(selectedFiles);
						} catch (error) {
							new Notice(
								`Failed to add files to chat: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					});
			});
		});

		if (typeof dispose === "function") {
			this.register(dispose);
		}
	}

	private getSupportedFiles(files: TFile[]): TFile[] {
		return files.filter((file) => SUPPORTED_CHAT_ATTACHMENT_EXTENSIONS.has(file.extension.toLowerCase()));
	}

	private async queueFilesForChatAttachment(files: TFile[]) {
		const supportedFiles = this.getSupportedFiles(files);
		if (supportedFiles.length === 0) {
			new Notice("No supported files selected. Supported: txt, md, csv, json, images, pdf.");
			return;
		}

		await this.agentManager.openLatestChat();

		const registry = getSessionRegistry();
		if (!registry) {
			new Notice("Chat is not initialized yet. Please open chat and try again.");
			return;
		}

		const existing = registry.pendingAttachmentPaths ?? [];
		const merged = [...existing, ...supportedFiles.map((file) => file.path)];
		const deduped = [...new Set(merged)];
		registry.pendingAttachmentPaths = deduped;

		const skipped = files.length - supportedFiles.length;
		if (skipped > 0) {
			new Notice(`Queued ${supportedFiles.length} file(s) for chat. Skipped ${skipped} unsupported file(s).`);
		}
	}

	async clearRecentNotesCache(): Promise<void> {
		await this.pluginData.clearRecentNotes();
	}

	/**
	 * Mobile only: route the magnifier button in Obsidian's bottom navbar to S2B
	 * search, when `overrideMobileNavbarSearch` is on.
	 *
	 * That button draws a `lucide-search` icon, but it is NOT global search — core
	 * builds it as `mobile-navbar-action-quick-switcher` and its click handler
	 * calls the switcher internal plugin directly:
	 *
	 *     internalPlugins.getPluginById("switcher").instance.onOpen()
	 *
	 * It never dispatches a command, which is why wrapping `global-search:open`
	 * did nothing here. So the hook goes on that `onOpen`.
	 *
	 * The switcher is also reachable by hotkey and from the command palette, and
	 * those must still open the real quick switcher — only the navbar tap is
	 * redirected. A capture-phase `pointerdown` on the navbar action arms a flag,
	 * which `onOpen` consumes.
	 *
	 * The flag is cleared on a TIMER, not a microtask. Core's handler is bound to
	 * `click`, which on a real finger tap lands 50–300ms after `pointerdown`; a
	 * microtask cleared the flag within the same millisecond, so by the time
	 * `onOpen` ran the flag was already down and every tap fell through to the
	 * core switcher. Verified on-device: firing `onOpen` 60ms after a synthetic
	 * `pointerdown` took the fall-through branch. The window is generous enough to
	 * cover a slow tap and is consumed on first use, so it cannot leak into a
	 * later unrelated `onOpen`.
	 */
	private registerMobileNavbarSearchOverride(): void {
		if (!isMobileUI()) return;

		type SwitcherInstance = { onOpen?: () => unknown };
		const switcherInstance = (
			this.app as unknown as {
				internalPlugins?: { getPluginById?: (id: string) => { instance?: SwitcherInstance } | undefined };
			}
		).internalPlugins?.getPluginById?.("switcher")?.instance;
		const originalOnOpen = switcherInstance?.onOpen;
		if (!switcherInstance || typeof originalOnOpen !== "function") {
			Log.warn("[S2B] Could not hook the quick switcher — mobile navbar search override unavailable.");
			return;
		}

		/** How long after a navbar tap an `onOpen` still counts as coming from it. */
		const NAVBAR_TAP_WINDOW_MS = 700;
		let navbarTapAt = 0;
		this.registerDomEvent(
			document,
			"pointerdown",
			(evt) => {
				const target = evt.target;
				if (!(target instanceof Element)) return;
				// Match the ancestor so a tap on the inner icon/svg counts too.
				if (!target.closest(".mobile-navbar-action-quick-switcher")) return;
				navbarTapAt = Date.now();
			},
			{ capture: true },
		);

		// `onOpen` is called as a method on the switcher instance, so the wrapper is
		// a plain function that forwards `this` — an arrow would capture the wrong
		// receiver and break core's own switcher when it falls through.
		const app = this.app;
		const ourOnOpen = function (this: SwitcherInstance, ...args: unknown[]) {
			const fromNavbar = navbarTapAt > 0 && Date.now() - navbarTapAt < NAVBAR_TAP_WINDOW_MS;
			// Consume it either way: one tap may only ever redirect one open, so a
			// hotkey press moments later can't ride on a stale tap.
			navbarTapAt = 0;
			if (!fromNavbar || !getData().overrideMobileNavbarSearch) {
				return originalOnOpen.apply(this, args as []);
			}
			new SearchModal(app).open();
		};
		switcherInstance.onOpen = ourOnOpen;

		this.register(() => {
			// Restore only if OUR hook is still installed. If someone else wrapped
			// it after us, theirs is live and writing the original back would
			// silently uninstall it.
			if (switcherInstance.onOpen === ourOnOpen) {
				switcherInstance.onOpen = originalOnOpen;
			}
		});
	}

	async onload() {
		StartupProfiler.mark("onload:start", true);
		// Time (ms) since the renderer process began until our onload ran. A large value
		// means Obsidian core / earlier plugins were slow *before* us — not our fault.
		StartupProfiler.setMeta("rendererToOnloadMs", Math.round(performance.now()));
		setPlugin(this);
		this.pluginData = await StartupProfiler.measure("data:load", () => createData(this), true);
		// A Codex sign-in/sign-out changes the auth state of every provider instance on that
		// template; refresh their queries. Wired here (not inside providerRuntime) so the
		// runtime store stays free of dataStore/query imports.
		this.register(
			onCodexSessionChange(() => {
				for (const providerId of this.pluginData.getProviderIdsByTemplate("openai-codex")) {
					invalidateAuthState(providerId);
					invalidateProviderState(providerId);
				}
			}),
		);
		// Sync the Logger's level to the persisted "Developer Console logging" preference.
		applyVerboseLogging(this.pluginData.isVerbose);

		// Sweep orphaned draft providers. A "draft" (an unconfigured provider instance)
		// only lives for the duration of an open Setup Provider modal, which deletes it on
		// close if never configured. Any unconfigured provider present at load leaked from a
		// modal that never ran its onClose cleanup (app reload / crash mid-draft). It's
		// invisible everywhere the UI gates on getConfiguredProviders(), but it pollutes the
		// provider ID/name space — causing new instances to be named "OpenAI 2" etc. — so
		// reclaim it here, before any view or modal can open.
		const orphanedDrafts = this.pluginData
			.getAllProviderIds()
			.filter((id) => !this.pluginData.isProviderConfigured(id));
		for (const id of orphanedDrafts) {
			await this.pluginData.deleteProvider(id);
		}

		// Create Skills Service instance (discovery deferred to onLayoutReady)
		this.skillsService = new SkillsService(this);

		// File-backed prompt store (per-agent base prompts). Seeded and
		// refreshed during deferred init; provides the reader the data store uses for staleness.
		this.promptFilesService = new PromptFilesService(this.app);
		this.pluginData.setPromptFileReader(this.promptFilesService.reader);

		// Register file-based chat view and .chat extension (v2 ChatView)
		// const VIEW_TYPE = "my-view";

		this.registerHoverLinkSource(VIEW_TYPE_CHAT, {
			display: "S2B Chat",
			// true = by default require Cmd/Ctrl for this source
			// false = by default no modifier required (more “reading-mode-like”)
			defaultMod: false,
		});
		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
		this.registerExtensions(["chat"], VIEW_TYPE_CHAT);

		// Read-only preview for embedded (![[chat.chat]]) and hovered .chat links.
		registerChatEmbed(this);

		// Intercept .chat file opens so they go directly to the sidebar
		// without ever replacing the note in the main editor area.
		// Read as a plain function value: it is only ever re-invoked below with an
		// explicit receiver (`.call(leaf, …)` / `.apply(this, …)`).
		const leafProto = WorkspaceLeaf.prototype as { openFile: WorkspaceLeaf["openFile"] };
		const origOpenFile = leafProto.openFile;
		const app = this.app;
		WorkspaceLeaf.prototype.openFile = async function (file, openState) {
			if (file.extension === "chat") {
				const location = getData().chatOpenLocation;
				if (location === "left" || location === "right") {
					const ws = app.workspace;
					const root = this.getRoot();
					if (root !== ws.leftSplit && root !== ws.rightSplit) {
						const targetSplit = location === "left" ? ws.leftSplit : ws.rightSplit;
						const sidebarLeaf =
							ws
								.getLeavesOfType(VIEW_TYPE_CHAT)
								.find((l: WorkspaceLeaf) => l.getRoot() === targetSplit) ??
							(location === "left" ? ws.getLeftLeaf(false) : ws.getRightLeaf(false));
						if (sidebarLeaf) {
							await origOpenFile.call(sidebarLeaf, file, openState);
							await ws.revealLeaf(sidebarLeaf);
							return;
						}
					}
				}
			}
			return origOpenFile.call(this, file, openState);
		};
		this.register(() => {
			WorkspaceLeaf.prototype.openFile = origOpenFile;
		});

		// Register Smart Graph view
		this.registerHoverLinkSource(VIEW_TYPE_SMART_GRAPH, {
			display: "S2B Graph",
			defaultMod: true,
		});
		this.registerView(VIEW_TYPE_SMART_GRAPH, (leaf) => new SmartGraphView(leaf, this));
		// DISABLED FOR INITIAL RELEASE — Note Context view. Re-enable together with the
		// "open-note-context" command. Note that graphEmbedIndex is no longer gated on this:
		// the Smart Graph consumes it for semantic edges, so the index selector lives in
		// GraphSettings and the index is opened at startup.
		// this.registerHoverLinkSource(VIEW_TYPE_NOTE_CONTEXT, {
		// 	display: "S2B Note Context",
		// 	defaultMod: true,
		// });
		// this.registerView(VIEW_TYPE_NOTE_CONTEXT, (leaf) => new NoteContextView(leaf, this));
		this.registerView(VIEW_TYPE_ONBOARDING, (leaf) => new OnboardingView(leaf, this));

		if (this.manifest.dir === undefined) {
			this.unload();
			throw new Error("Cannot localize plugin directory.");
		}

		this.addRibbonIcon("message-square", "New chat", () => this.createNewChat());
		this.addRibbonIcon("search", "Search notes", () => new SearchModal(this.app).open());
		this.addRibbonIcon("git-fork", "Open smart graph", () => this.activateSmartGraphView());

		// Create Agent Manager (v2) + session registry BEFORE mounting the status-bar
		// indicator below. Both constructors are cheap (heavy init is deferred to
		// onLayoutReady). The indicator reads the registry singleton via a plain
		// getSessionRegistry() call inside a $derived — if the registry doesn't exist
		// yet at mount time, that derived pins to null with no reactive source to
		// update it later, so the indicator would never show a running chat.
		this.agentManager = new AgentManager(this);
		this.sessionRegistry = createSessionRegistry(this.agentManager);

		// Global running-agent indicator in the status bar: shows the single
		// streaming chat (if any) and lets the user stop it from anywhere. Mobile has
		// no status bar (addStatusBarItem is a no-op there), so skip the mount entirely
		// rather than running a reactive component into a detached element.
		if (!isMobileUI()) {
			const statusBarEl = this.addStatusBarItem();
			this.runningIndicator = mount(RunningIndicator, { target: statusBarEl, props: {} });
		}

		this.addCommand({
			id: "open-chat",
			name: "Open chat",
			icon: "message-square",
			callback: async () => await this.agentManager.openLatestChat(),
		});

		this.addCommand({
			id: "new-chat",
			name: "New chat",
			icon: "plus",
			callback: async () => await this.agentManager.createNewChat(),
		});

		this.addCommand({
			id: "search-notes",
			name: "Search notes",
			icon: "search",
			callback: () => new SearchModal(this.app).open(),
		});

		this.registerMobileNavbarSearchOverride();

		this.addCommand({
			id: "open-smart-graph",
			name: "Open smart graph",
			icon: "git-fork",
			callback: () => this.activateSmartGraphView(),
		});

		// DISABLED FOR INITIAL RELEASE — see the Note Context registerView block above.
		// this.addCommand({
		// 	id: "open-note-context",
		// 	name: "Open Note Context",
		// 	icon: "git-fork",
		// 	callback: () => this.activateNoteContextView(),
		// });

		this.addCommand({
			id: "open-onboarding",
			name: "Show welcome",
			icon: "zap",
			callback: () => this.activateOnboardingView(),
		});

		this.addCommand({
			id: "next-pending-change",
			name: "Next pending change",
			icon: "chevron-down",
			callback: async () => {
				const threadId = this.resolveChatThreadIdForNavigation();
				if (!threadId) {
					new Notice("No chat is currently open");
					return;
				}
				const target = await navigateToPendingChange(this, threadId, "next");
				if (!target) new Notice("No pending changes in this chat");
			},
		});

		this.addCommand({
			id: "previous-pending-change",
			name: "Previous pending change",
			icon: "chevron-up",
			callback: async () => {
				const threadId = this.resolveChatThreadIdForNavigation();
				if (!threadId) {
					new Notice("No chat is currently open");
					return;
				}
				const target = await navigateToPendingChange(this, threadId, "prev");
				if (!target) new Notice("No pending changes in this chat");
			},
		});

		this.addSettingTab(new SettingsTab(this));

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!(file instanceof TFile)) return;
				this.pluginData.recordRecentlyOpenedNote(file.path);
			}),
		);

		// Each chat tab binds to its own thread path and renders its own session,
		// so switching tabs no longer needs to move a global pointer. But a parked
		// idle session can be evicted (LRU) while its tab stays open; if the user
		// returns to that tab, its session is gone from the registry and the view
		// would be empty. Rebuild it on focus when missing. (Running sessions are
		// never evicted, so this only ever reloads idle ones.)
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!(leaf?.view instanceof ChatView)) return;
				const file = leaf.view.file;
				if (!file) return;
				const registry = getSessionRegistry();
				if (!registry) return;
				if (registry.sessionFor(file.path)) return; // still live — nothing to do
				void registry.loadSession(file);
			}),
		);

		this.registerNotebookNavigatorMenus();

		// Enabling/disabling a plugin changes which skills are advertised to the agent
		// (skills gate on their linked plugin being enabled). The live agent bakes its
		// system prompt at build time, so without this it keeps a stale skill list until
		// a full reload. Obsidian's community-plugin manager emits an (untyped) "changed"
		// event on install/enable/disable — reassemble the prompt so newly available
		// skills appear immediately.
		// @ts-ignore - Obsidian plugin API (app.plugins is not in the official types)
		const pluginManager = this.app.plugins as {
			on?: (name: string, cb: () => void) => import("obsidian").EventRef;
		};
		if (typeof pluginManager?.on === "function") {
			this.registerEvent(
				pluginManager.on("changed", () => {
					this.agentManager.invalidateSystemPromptCaches();
				}),
			);
		}
		StartupProfiler.mark("onload:registrations-done", true);

		// Defer ALL heavy initialization to onLayoutReady so the Obsidian workspace
		// renders immediately. This includes:
		// - LexicalSearch / VectorStore: IDB opens can take seconds when cold
		// - SkillsService: filesystem discovery
		// - AgentManager: chat index loading, provider registration
		// If a chat view opens before this completes, AgentManager.ensureAgent() handles lazy init.
		this.app.workspace.onLayoutReady(() => {
			// Everything from here runs after the workspace has rendered — tag it deferred.
			StartupProfiler.leaveBlockingPhase();
			StartupProfiler.mark("layoutReady:start");
			// The gap between onload:end and here is Obsidian core building its workspace /
			// metadata cache (+ other plugins' onload). On a cold start this dominates and is
			// outside our control — capture it explicitly so it's not mistaken for our cost.
			// -1 means onLayoutReady fired synchronously mid-onload (already-warm workspace):
			// there's no meaningful gap in that case.
			StartupProfiler.setMeta(
				"obsidianPreLayoutMs",
				this.onloadEndAt < 0 ? 0 : Math.round(performance.now()) - this.onloadEndAt,
			);
			recordStartupEnvironment(this);

			// First-run onboarding: orient the user before heavy init. Only auto-open
			// when they've never completed it AND haven't configured a provider some
			// other way. Onboarding is skippable — the plugin works without a provider.
			if (!this.pluginData.onboardingComplete && this.pluginData.getConfiguredProviders().length === 0) {
				void this.activateOnboardingView();
			}

			// Agents whose customized prompt/guidance couldn't be auto-updated after a
			// default changed are surfaced in the new-chat recommendations view
			// (ChatRecommendations.svelte reads pluginData.staleGuidance), so no startup
			// Notice here — that would double-notify.

			// Bring up the shared model store now rather than on first UI read. It keeps a
			// QueryObserver subscribed per configured provider, which is what actually
			// fetches each provider's auth + model list. Constructing it lazily tied that
			// to whichever view happened to mount first: with, say, only the graph view
			// open, nothing read it, so a provider added afterwards was never subscribed
			// and its models never loaded ("Loading models…" until an Obsidian reload).
			// Initializing here makes the subscriptions view-independent.
			useAvailableModels();

			// Start search/vector store initialization (non-blocking, fire-and-forget)
			this.lexicalSearchService = StartupProfiler.measureSync("lexical:startInit", () =>
				LexicalSearchService.startInitialize(this),
			);
			this.vectorStoreService = StartupProfiler.measureSync("vectorstore:startInit", () =>
				VectorStoreService.startInitialize(this),
			);

			// Skills + Agent init (sequential, but non-blocking relative to workspace)
			void (async () => {
				try {
					await StartupProfiler.measure("skills:init", () => this.skillsService.initialize());
					// Seed default guidance / base-prompt files (if absent) then load them into cache,
					// so the assembled system prompt and staleness detection see file content.
					await StartupProfiler.measure("promptFiles:init", async () => {
						await this.promptFilesService.seedDefaults(this.pluginData.agents);
						await this.promptFilesService.refresh(this.pluginData.agents);
					});
					await StartupProfiler.measure("agent:init", () => this.agentManager.initialize());
					// Fold in the fire-and-forget search/vectorstore inits so their sub-phase
					// spans (IDB opens, storage loads) are captured in the summary. The cold
					// lexical buildIndex is scheduled separately and logs its own line.
					await StartupProfiler.measure("vectorstore:ready", () => waitForVectorStore());
				} catch (e) {
					Log.error("Deferred initialization failed", e);
				} finally {
					StartupProfiler.mark("deferred:end");
					const record = StartupProfiler.flush("S2B startup");
					if (record) void persistStartupRecord(this, record);
				}
			})();
		});

		// Everything under the agent folder now lives in the vault, so an accepted `manage_skills`
		// create/update/delete or a manual user edit to a skill / GUIDANCE.md / base-prompt file
		// fires a vault modify/create/delete event. Re-discover skills, reload the prompt-file
		// caches, and rebuild the live agent's system prompt so revised content takes effect
		// without a reload. Debounced: a burst of events (Obsidian replaying `create` for every
		// existing file while the vault resolves on plugin enable, or bootstrap/migration writing
		// many skill files at once) previously re-ran full discovery — and its per-skill logging —
		// once per event instead of once for the whole burst.
		const refreshAgentContext = debounce(
			() => {
				void (async () => {
					await this.skillsService?.discoverSkills();
					await this.promptFilesService?.refresh(this.pluginData.agents);
					this.agentManager?.invalidateSystemPromptCaches();
				})();
			},
			500,
			true,
		);
		const refreshAgentContextOnVaultChange = (file: TFile | { path?: string }) => {
			const path = file?.path;
			if (!path || !isAgentFilePath(path)) return;
			refreshAgentContext();
		};
		this.registerEvent(this.app.vault.on("modify", refreshAgentContextOnVaultChange));
		this.registerEvent(this.app.vault.on("create", refreshAgentContextOnVaultChange));
		this.registerEvent(this.app.vault.on("delete", refreshAgentContextOnVaultChange));

		this.registerEvent(
			(
				this.app.workspace as unknown as {
					on(name: "leaf-menu", cb: (menu: Menu, leaf: WorkspaceLeaf) => void): EventRef;
				}
			).on("leaf-menu", (menu, leaf) => {
				const file = (leaf.view as { file?: TFile }).file;
				if (!(file instanceof TFile) || file.extension !== "chat") return;
				this.addChatFileMenuItems(menu, file);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile)) return;

				// .chat files get chat-specific actions instead of "Add to Chat".
				if (file.extension === "chat") {
					this.addChatFileMenuItems(menu, file);
					return;
				}

				menu.addItem((item) =>
					item
						.setTitle(this.getAddToChatMenuLabel(1))
						.setIcon("message-square-plus")
						.onClick(async () => {
							try {
								await this.queueFilesForChatAttachment([file]);
							} catch (error) {
								new Notice(
									`Failed to add file to chat: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						}),
				);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("files-menu", (menu, files) => {
				const selectedFiles = files.filter((file): file is TFile => file instanceof TFile);
				if (selectedFiles.length === 0) return;

				// Don't offer "Add to Chat" when the selection is only chat files.
				const attachableFiles = selectedFiles.filter((file) => file.extension !== "chat");
				if (attachableFiles.length === 0) return;

				menu.addItem((item) =>
					item
						.setTitle(this.getAddToChatMenuLabel(attachableFiles.length))
						.setIcon("message-square-plus")
						.onClick(async () => {
							try {
								await this.queueFilesForChatAttachment(attachableFiles);
							} catch (error) {
								new Notice(
									`Failed to add files to chat: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						}),
				);
			}),
		);

		// Initialize Pending Changes Store for write tool staging
		this.pendingChangesStore = new PendingChangesStore(this);
		initPendingChangesStore(this.pendingChangesStore);
		await StartupProfiler.measure("pendingChanges:load", () => this.pendingChangesStore.load(), true);

		// Register inline diff decorations in the editor
		this.registerEditorExtension(inlineDiffPlugin);

		// Register selection highlight persistence (dim accent marks for captured selections)
		this.registerEditorExtension(selectionHighlightPlugin);

		// Register reading view diff highlighting
		this.registerMarkdownPostProcessor(createReadingViewDiffPostProcessor(this));

		// Re-render reading views when pending changes update. `rerender(true)`
		// rebuilds the preview from scratch and Obsidian re-asserts its OWN scroll
		// position several hundred ms later on a large note — so accepting/rejecting
		// a change would jump the reader away from the spot they were reviewing.
		// Snapshot each PREVIEW scroller's scrollTop and re-assert it repeatedly past
		// that late reset (edit mode preserves scroll natively, so it's skipped).
		// Verified on a 328-line note: without the later re-asserts scrollTop landed
		// ~1628 after a 3000 scroll; with them it holds at 3000.
		const refreshReadingViews = () => {
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				const view = leaf.view;
				if (!(view instanceof MarkdownView)) continue;
				const isPreview = view.getMode() === "preview";
				const scroller = isPreview ? view.contentEl.querySelector<HTMLElement>(".markdown-preview-view") : null;
				const prevScrollTop = scroller?.scrollTop ?? null;
				view.previewMode?.rerender(true);
				if (scroller && prevScrollTop !== null) {
					const restore = () => {
						if (scroller.isConnected) scroller.scrollTop = prevScrollTop;
					};
					window.requestAnimationFrame(restore);
					for (const delay of [50, 100, 200, 350, 500]) {
						window.setTimeout(restore, delay);
					}
				}
			}
		};
		document.addEventListener("s2b-pending-changes-updated", refreshReadingViews);
		this.register(() => document.removeEventListener("s2b-pending-changes-updated", refreshReadingViews));

		StartupProfiler.mark("onload:end", true);
		this.onloadEndAt = Math.round(performance.now());
	}

	onunload() {
		Log.info("Unloading plugin");
		// The model store's module state survives a disable/enable cycle. Without this
		// reset, its QueryObservers keep fetching with the unloaded plugin's credentials
		// and the next enable reuses a singleton bound to this (now dead) data store.
		resetAvailableModels();
		if (this.runningIndicator) {
			void unmount(this.runningIndicator);
			this.runningIndicator = null;
		}
		if (this.lexicalSearchService) void this.lexicalSearchService.cleanup();
		if (this.vectorStoreService) void this.vectorStoreService.cleanup();
		if (this.agentManager) void this.agentManager.cleanup();
		if (this.pendingChangesStore) this.pendingChangesStore.cleanup();
		terminateClusteringWorker();

		// Two separate Obsidian registries were populated in onload via registerExtensions
		// calls that have no public unregister counterpart on Plugin — unlike
		// registerView/registerEvent/etc., neither is torn down automatically by the
		// Component lifecycle:
		//  - app.viewRegistry (this.registerExtensions(["chat"], VIEW_TYPE_CHAT) in onload)
		//  - app.embedRegistry (registerChatEmbed in onload — see chatEmbed.ts)
		// Leaving either stale after unload throws "Attempting to register a
		// view/embed for an already registered extension" the next time the plugin
		// loads. Both are undocumented internal APIs, so calls are optional-chained —
		// if a shape changes upstream this silently does nothing rather than throwing
		// during unload.
		(
			this.app as typeof this.app & { viewRegistry?: { unregisterExtensions?: (extensions: string[]) => void } }
		).viewRegistry?.unregisterExtensions?.(["chat"]);
		unregisterChatEmbed(this);
	}

	async createNewChat() {
		return this.agentManager.createNewChat();
	}

	/**
	 * Re-seed and re-discover agent context after the configurable agent folder changes at runtime.
	 * All steps are skip-if-exists, so the new location is populated (core skills + per-agent base
	 * prompts) without touching or moving files in the old folder. Mirrors the startup init order
	 * ({@link SkillsService.initialize}) and the vault-change refresh path.
	 */
	async reinitAgentFolder(): Promise<void> {
		// Await the agent-root folder before seeding: the `agentFolder` setter's createFolder is
		// fire-and-forget, so it may not have completed by the time we get here. Bootstrapping
		// the nested `Skills/` dir or a per-agent folder against a not-yet-created root could
		// otherwise throw and abort the rest of reinit (prompt refresh + cache invalidation),
		// leaving chats on the old folder's prompts. (bootstrapDefaultSkills/seedDefaults also
		// ensure the root now, but making the dependency explicit here keeps reinit correct
		// independent of their internals.)
		const root = this.pluginData.agentFolder;
		if (!this.app.vault.getFolderByPath(root)) {
			await this.app.vault.createFolder(root).catch(() => {});
		}
		await this.skillsService?.migrateCoreSkills();
		await this.skillsService?.bootstrapDefaultSkills();
		await this.skillsService?.discoverSkills();
		await this.promptFilesService?.seedDefaults(this.pluginData.agents);
		// Reload the prompt cache from the *new* folder — seedDefaults only writes files,
		// it doesn't touch the cache, so without this the assembled prompt keeps serving the old
		// folder's content (or the default) until a later vault event refreshes it.
		await this.promptFilesService?.refresh(this.pluginData.agents);
		this.agentManager?.invalidateSystemPromptCaches();
	}

	async openLatestChat() {
		return this.agentManager.openLatestChat();
	}

	async activateSmartGraphView() {
		const { workspace } = this.app;

		// Check if the view is already open
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_SMART_GRAPH)[0];

		if (!leaf) {
			// Open in a new tab in the main editor area
			const newLeaf = workspace.getLeaf("tab");
			await newLeaf.setViewState({
				type: VIEW_TYPE_SMART_GRAPH,
				active: true,
			});
			leaf = newLeaf;
		}

		await workspace.revealLeaf(leaf);
	}

	// DISABLED FOR INITIAL RELEASE — see the Note Context registerView block in onload().
	// async activateNoteContextView() {
	// 	const { workspace } = this.app;
	//
	// 	let leaf = workspace.getLeavesOfType(VIEW_TYPE_NOTE_CONTEXT)[0];
	//
	// 	if (!leaf) {
	// 		const newLeaf = workspace.getLeaf("tab");
	// 		await newLeaf.setViewState({
	// 			type: VIEW_TYPE_NOTE_CONTEXT,
	// 			active: true,
	// 		});
	// 		leaf = newLeaf;
	// 	}
	//
	// 	workspace.revealLeaf(leaf);
	// }

	async activateOnboardingView() {
		// Enabling the plugin from Settings → Community plugins fires onLayoutReady
		// (and this auto-open) while the Settings modal is still on top of the
		// workspace — revealing the leaf underneath would be invisible otherwise.
		// Same applies if "Show Welcome" is run manually with Settings open.
		// app.setting is undocumented internal API, so every hop is optional —
		// if the shape changes upstream this silently does nothing rather than throw.
		(this.app as typeof this.app & { setting?: { close?: () => void } }).setting?.close?.();

		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(VIEW_TYPE_ONBOARDING)[0];

		if (!leaf) {
			// Open in a new tab in the main editor area
			const newLeaf = workspace.getLeaf("tab");
			await newLeaf.setViewState({
				type: VIEW_TYPE_ONBOARDING,
				active: true,
			});
			leaf = newLeaf;
		}

		await workspace.revealLeaf(leaf);
	}
}
