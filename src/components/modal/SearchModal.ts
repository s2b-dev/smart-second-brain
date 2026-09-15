import {
	type App,
	MarkdownView,
	Notice,
	Platform,
	SuggestModal,
	TFile,
	TFolder,
	type WorkspaceLeaf,
	getAllTags,
	normalizePath,
	setIcon,
} from "obsidian";
import { performSearch } from "../../agent/tools/searchNotes";
import { getRecentNotes } from "../../search/recentNotes";
import { getLexicalSearchService, isLexicalSearchInitialized } from "../../search/LexicalSearchService";
import type { SearchResult } from "../../vectorstore/types";
import { getData } from "../../stores/dataStore.svelte";
import { getSessionRegistry } from "../../stores/chatStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import type { SearchAlgorithm } from "../../types/plugin";
import type { SearchFilter } from "../../vectorstore";
import { Logger } from "../../utils/logging";
import { isAgentFilePath } from "../../utils/fileFiltering";
import { isMobileUI } from "../../utils/platform";
import { openChatAction, showActionNotice, showSettingsLinkNotice } from "../../utils/actionNotice";
import { getPathIcon, getSearchResultNoteIcon, getTagIcon, resolveIconColor } from "../../utils/noteIcons";
import { applyPromptSafeArea } from "./promptLayout";
import {
	formatHeadingLabel,
	getBadgeIconId,
	getBadgeLabel,
	getDisplayTagLabel,
	getFrontmatterDisplayTags,
	getHighlightTerms,
	shouldShowMatchExplanation,
	stripHeadingPrefix,
} from "../../utils/searchResultPresentation";

interface AutocompleteSuggestion {
	type: "autocomplete";
	kind: "tag" | "folder";
	value: string;
	display: string;
}

type SearchSuggestion = SearchResult | AutocompleteSuggestion;
type SearchResultBadge = NonNullable<SearchResult["matchBadges"]>[number];

/**
 * The undocumented chooser that SuggestModal creates internally. It owns the
 * highlighted-row index, so we drive selection through it to keep our custom
 * Shift+Arrow handling in sync with Obsidian's own arrow navigation.
 */
interface SuggestModalChooser {
	selectedItem: number;
	setSelectedItem(index: number, evt?: Event): void;
}

function isAutocomplete(item: SearchSuggestion): item is AutocompleteSuggestion {
	return "type" in item && item.type === "autocomplete";
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appendHighlightedText(
	el: HTMLElement,
	text: string,
	terms: string[],
	highlightClass = "s2b-search-result-highlight",
): void {
	if (!terms.length) {
		el.setText(text);
		return;
	}

	const pattern = new RegExp(`(${terms.map((term) => escapeRegExp(term)).join("|")})`, "giu");
	let lastIndex = 0;

	for (const match of text.matchAll(pattern)) {
		const start = match.index ?? 0;
		if (start > lastIndex) {
			el.appendChild(document.createTextNode(text.slice(lastIndex, start)));
		}

		const mark = el.createEl("mark", { cls: highlightClass });
		mark.setText(match[0]);
		lastIndex = start + match[0].length;
	}

	if (lastIndex < text.length) {
		el.appendChild(document.createTextNode(text.slice(lastIndex)));
	}
}

function sanitizeNoteTitle(title: string): string {
	return title
		.replace(/[<>:"/\\|?*]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.substring(0, 100);
}

export interface SearchModalPickerText {
	searchPlaceholder?: string;
	searchAriaLabel?: string;
	defaultHeading?: string;
	defaultDescription?: string;
	emptySearchText?: string;
	selectionLabel?: string;
	confirmVerb?: string;
	alreadySelectedBadgeLabel?: string;
}

interface SearchModalPickerOptions {
	pickerText?: SearchModalPickerText;
	pickerExistingPaths?: string[];
	pickerIncludedPaths?: string[];
	onAddPaths: (paths: string[]) => void | Promise<void>;
}

interface SearchModalOptions {
	picker?: SearchModalPickerOptions;
}

function createVaultFileSearchResult(app: App, file: TFile): SearchResult {
	const cache = app.metadataCache.getFileCache(file);
	return {
		path: file.path,
		name: file.basename,
		frontmatter: cache?.frontmatter,
	};
}

/**
 * Search modal that provides a popup search experience using the configured search algorithm.
 * Similar to Obsidian's native search or Omnisearch.
 *
 * Supports inline filter chips via # (tags) and / (folders) autocomplete.
 */
export class SearchModal extends SuggestModal<SearchSuggestion> {
	private searchResults: SearchResult[] = [];
	private readonly selectedResultsByPath = new Map<string, SearchResult>();
	private readonly pickerOptions: SearchModalPickerOptions | null;
	private readonly pickerUnavailablePaths: Set<string>;
	private currentQuery = "";
	private isSearching = false;
	private isClosed = false;
	/** Guards the once-per-render-pass scheduling of the mobile results footer. */
	private resultsFooterScheduled = false;
	private semanticEnabled = false;
	/** When Tab arms a one-shot semantic search, this holds the query it was
	 * armed for. Semantic stays on (results visible) until the query text
	 * changes, at which point it auto-reverts to lexical. null = not armed. */
	private semanticOneShotQuery: string | null = null;
	private requireAllTags = false;
	private glowAnimationId: number | null = null;
	private borderEl: HTMLElement | null = null;
	private searchTimeout: number | null = null;
	private autocompleteHydrationTimeout: number | null = null;
	private searchRequestId = 0;
	private lastRequestedSearchKey = "";
	private lastResolvedSearchKey = "";
	private pendingSuggestionSearchKey: string | null = null;
	private pendingSuggestionResolvers: Array<(suggestions: SearchSuggestion[]) => void> = [];
	private cachedAutocompleteTags: string[] = [];
	private cachedTagChildCount = new Map<string, number>();
	private cachedAutocompleteFolders: string[] = [];
	private noteIconCache = new Map<string, ReturnType<typeof getSearchResultNoteIcon> | null>();
	private tagIconCache = new Map<string, ReturnType<typeof getTagIcon> | null>();
	private resolvedIconColorCache = new Map<string, string | null>();
	private noteIconElementCache = new Map<string, HTMLElement | null>();
	private tagIconElementCache = new Map<string, HTMLElement | null>();
	private tagPillElementCache = new Map<string, HTMLElement>();
	private badgeIconElementCache = new Map<string, HTMLElement>();
	/** Inline filter state — chips live inside the input container */
	private activeFilters: { type: "path" | "tag"; value: string }[] = [];
	private inlineChipsEl: HTMLElement | null = null;
	private inlineInputContentEl: HTMLElement | null = null;
	/** Query text the current selection was made under; null when nothing is selected. */
	private selectionQuery: string | null = null;
	/** Mobile-only tap bar: exposes semantic-toggle + ask-agent, which are
	   otherwise bound only to Tab / Alt+Enter (unreachable without a keyboard). */
	private pendingPostOpenFrameId: number | null = null;
	private pendingFocusFrameId: number | null = null;
	private pendingFocusTimeoutIds: number[] = [];
	private hasPrimedOpenResults = false;

	constructor(app: App, options: SearchModalOptions = {}) {
		super(app);
		this.pickerOptions = options.picker ?? null;
		this.pickerUnavailablePaths = new Set([
			...(this.pickerOptions?.pickerExistingPaths ?? []),
			...(this.pickerOptions?.pickerIncludedPaths ?? []),
		]);
		// The agent hint names a keyboard shortcut, which a phone has no way to
		// produce — and the mobile action bar already offers "Ask agent" as a
		// button right above this field, so the hint is both unusable and
		// redundant there. Keep the syntax help, drop the shortcut.
		this.setPlaceholder(
			this.pickerOptions?.pickerText?.searchPlaceholder ??
				(isMobileUI()
					? "Search notes with #tag or /folder..."
					: `Search notes with #tag or /folder, or ${Platform.isMacOS ? "⌥↵" : "Alt+↵"} to ask the agent...`),
		);
		this.updateInstructions();

		// Register Tab to toggle semantic search
		this.scope.register([], "Tab", (evt) => {
			evt.preventDefault();
			this.toggleSemanticMode();
			return false;
		});

		// Register Backspace to remove last filter chip when input is empty
		this.scope.register([], "Backspace", () => {
			const inputEl = this.getInputEl();
			if (inputEl && inputEl.value === "" && this.activeFilters.length > 0) {
				this.activeFilters.pop();
				this.renderInlineChips();
				this.invalidateSearch();
				this.triggerSearch(this.currentQuery);
				return false;
			}
			// Let default backspace behavior handle text deletion
			return true;
		});

		this.scope.register(["Mod"], "Enter", (evt) => {
			if (this.isPickerMode()) {
				evt.preventDefault();
				return false;
			}

			// Cmd/Ctrl+Enter opens in a new tab (native Obsidian convention).
			const selectedResults = this.getSelectedResults();
			if (selectedResults.length > 0) {
				evt.preventDefault();
				this.openSearchResults(selectedResults, "tab");
				return false;
			}

			const focused = this.getFocusedSearchResult();
			if (focused) {
				evt.preventDefault();
				this.openSearchResult(focused, "tab");
				return false;
			}

			return true;
		});

		this.scope.register(["Shift"], "ArrowDown", (evt) => {
			if (this.extendSelection(1)) {
				evt.preventDefault();
				return false;
			}
			return true;
		});

		this.scope.register(["Shift"], "ArrowUp", (evt) => {
			if (this.extendSelection(-1)) {
				evt.preventDefault();
				return false;
			}
			return true;
		});

		this.scope.register(["Shift"], "Enter", (evt) => {
			const focused = this.getFocusedSearchResult();
			if (focused) {
				evt.preventDefault();
				this.toggleSelection(focused);
				return false;
			}
			return true;
		});

		// Vim-style navigation: Ctrl+J/K move the highlight down/up (no footer hint).
		this.scope.register(["Ctrl"], "J", (evt) => {
			if (this.moveFocus(1)) {
				evt.preventDefault();
				return false;
			}
			return true;
		});

		this.scope.register(["Ctrl"], "K", (evt) => {
			if (this.moveFocus(-1)) {
				evt.preventDefault();
				return false;
			}
			return true;
		});

		// Ctrl+Shift+J/K select-while-navigating, mirroring Shift+Arrow (no footer hint).
		this.scope.register(["Ctrl", "Shift"], "J", (evt) => {
			if (this.extendSelection(1)) {
				evt.preventDefault();
				return false;
			}
			return true;
		});

		this.scope.register(["Ctrl", "Shift"], "K", (evt) => {
			if (this.extendSelection(-1)) {
				evt.preventDefault();
				return false;
			}
			return true;
		});

		this.scope.register(["Mod", "Shift"], "Enter", (evt) => {
			if (this.isPickerMode()) {
				evt.preventDefault();
				return false;
			}

			evt.preventDefault();
			void this.createNoteFromQuery();
			return false;
		});

		this.scope.register(["Alt"], "Enter", (evt) => {
			if (this.isPickerMode()) {
				evt.preventDefault();
				return false;
			}

			evt.preventDefault();
			void this.askAgentWithQuery();
			return false;
		});

		this.scope.register(["Alt"], "A", (evt) => {
			if (this.isPickerMode()) {
				return true;
			}

			evt.preventDefault();
			void this.attachToChat();
			return false;
		});

		this.scope.register([], "Enter", (evt) => {
			if (this.isPickerMode()) {
				evt.preventDefault();
				this.confirmSelection();
				return false;
			}

			if (evt.shiftKey || evt.altKey || evt.metaKey || evt.ctrlKey || this.selectedResultsByPath.size === 0) {
				return true;
			}

			evt.preventDefault();
			this.confirmSelection();
			return false;
		});

		// Add custom class for styling
		this.modalEl.addClass("s2b-search-modal");
		if (this.isPickerMode()) {
			this.modalEl.addClass("space-file-picker");
		}
		this.modalEl.setAttribute("data-testid", "search-modal");
	}

	private isPickerMode(): boolean {
		return this.pickerOptions !== null;
	}

	private getPickerConfirmVerb(): string {
		return this.pickerOptions?.pickerText?.confirmVerb ?? "Add";
	}

	private isPickerUnavailable(path: string): boolean {
		return this.pickerUnavailablePaths.has(path);
	}

	private getPickerBrowseResults(): SearchResult[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => !isAgentFilePath(file.path) && !this.isPickerUnavailable(file.path))
			.slice()
			.sort((left, right) => left.path.localeCompare(right.path))
			.slice(0, 40)
			.map((file) => createVaultFileSearchResult(this.app, file));
	}

	private getVisibleResults(results: SearchResult[]): SearchResult[] {
		if (!this.isPickerMode()) {
			return results;
		}

		return results.filter((result) => !this.isPickerUnavailable(result.path));
	}

	private confirmPickerResults(results: SearchResult[]): void {
		const pickerOptions = this.pickerOptions;
		if (!pickerOptions || results.length === 0) {
			return;
		}

		const uniquePaths = [
			...new Set(results.map((result) => result.path).filter((path) => !this.isPickerUnavailable(path))),
		];
		if (uniquePaths.length === 0) {
			return;
		}

		this.close();
		void pickerOptions.onAddPaths(uniquePaths);
	}

	/**
	 * `semantic`, not `hybrid`, when the toggle is on.
	 *
	 * `semanticEnabled` starts false and resets on every open, so pressing Tab
	 * always means "I have looked at the lexical results and they are not what I
	 * wanted". Fusing lexical back in at that point re-injects the ordering the
	 * user just rejected — measured on the graded benchmark, the lexical leg's
	 * only genuine rescue in the whole suite is a note that was already *rank 1*
	 * in the lexical search they dismissed, while it actively misdirects cases
	 * like `griechischer salat` (0.431 hybrid vs 1.000 without it).
	 *
	 * The agent's `search_notes` tool is unaffected, but note it does NOT default
	 * to hybrid either: it defaults to lexical and its description tells it to
	 * escalate, reaching for hybrid only when a query mixes a specific term with a
	 * fuzzy concept. So hybrid runs only when the agent explicitly selects it —
	 * no surface uses it by default.
	 */
	private get activeAlgorithm(): SearchAlgorithm {
		return this.semanticEnabled ? "semantic" : "lexical";
	}

	private hasSearchEmbeddingIndex(): boolean {
		return Boolean(getData().searchEmbedIndex);
	}

	private showMissingSearchEmbeddingIndexNotice(): void {
		showSettingsLinkNotice(this.app, "Select a search embedding index before enabling semantic search.", {
			tab: "search",
			linkText: "Open search settings",
		});
	}

	private toggleSemanticMode(): void {
		if (!this.semanticEnabled && !this.hasSearchEmbeddingIndex()) {
			this.showMissingSearchEmbeddingIndexNotice();
			return;
		}

		this.semanticEnabled = !this.semanticEnabled;
		// Arm one-shot only when turning semantic ON, keyed to the current query
		// so it reverts to lexical once the user changes what they're searching.
		this.semanticOneShotQuery = this.semanticEnabled ? this.currentQuery : null;
		this.updateInstructions();
		this.syncGlowAnimation();

		if (this.currentQuery.trim() || this.activeFilters.length > 0) {
			this.invalidateSearch();
			this.triggerSearch(this.currentQuery);
		}
	}

	private syncGlowAnimation(): void {
		if (this.semanticEnabled && this.isSearching) {
			this.startGlowAnimation();
			return;
		}

		this.stopGlowAnimation();
	}

	private getSemanticGlowColor(): string {
		return getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim() || "#7f6df2";
	}

	private setSearching(isSearching: boolean): void {
		if (this.isSearching === isSearching) {
			return;
		}

		this.isSearching = isSearching;
		this.syncGlowAnimation();
	}

	private getEnterInstructionPurpose(): string {
		if (this.isPickerMode()) {
			return this.selectedResultsByPath.size > 0
				? `${this.getPickerConfirmVerb()} selection`
				: `${this.getPickerConfirmVerb()} focused file`;
		}

		return this.selectedResultsByPath.size > 0 ? "Open selection" : "Open note";
	}

	private getCreateInstructionPurpose(): string | null {
		if (this.isPickerMode()) {
			return null;
		}

		const trimmedQuery = this.currentQuery.trim();
		if (!trimmedQuery) {
			return null;
		}

		const preview = trimmedQuery.length > 36 ? `${trimmedQuery.slice(0, 33)}...` : trimmedQuery;
		return `Create "${preview}"`;
	}

	private updateInstructions(): void {
		const pluginData = getData();
		if (!pluginData.searchShowKeyboardHints) {
			this.setInstructions([]);
			return;
		}

		if (this.isPickerMode()) {
			this.setInstructions([
				{ command: "↑↓", purpose: "Navigate" },
				{ command: "↵", purpose: this.getEnterInstructionPurpose() },
				{ command: "⇧↑↓/↵", purpose: "Select" },
				{ command: "esc", purpose: "Close" },
			]);
			return;
		}

		const tabKey = Platform.isMacOS ? "⇥" : "Tab";
		const modEnterKey = Platform.isMacOS ? "⌘↵" : "Ctrl+↵";
		const modShiftEnterKey = Platform.isMacOS ? "⌘⇧↵" : "Ctrl+Shift+↵";
		const altEnterKey = Platform.isMacOS ? "⌥↵" : "Alt+↵";
		const attachKey = Platform.isMacOS ? "⌥A" : "Alt+A";
		const attachPurpose = this.selectedResultsByPath.size > 0 ? "Attach selection to chat" : "Attach to chat";
		const semanticLabel = this.semanticEnabled ? "semantic: on" : "semantic: off";
		const instructions = [
			{ command: "↑↓", purpose: "Navigate" },
			{ command: "↵", purpose: this.getEnterInstructionPurpose() },
			{ command: "⇧↑↓/↵", purpose: "Select" },
			{ command: modEnterKey, purpose: "Open in new tab" },
			{ command: altEnterKey, purpose: "Ask agent" },
			{ command: attachKey, purpose: attachPurpose },
			{ command: tabKey, purpose: semanticLabel },
			{ command: "esc", purpose: "Close" },
		];

		const createPurpose = this.getCreateInstructionPurpose();
		if (createPurpose) {
			instructions.splice(5, 0, { command: modShiftEnterKey, purpose: createPurpose });
		}

		this.setInstructions(instructions);
	}

	private getSelectedResults(): SearchResult[] {
		return [...this.selectedResultsByPath.values()];
	}

	/** The rendered suggestion rows, in display order. */
	private getSuggestionEls(): HTMLElement[] {
		return Array.from(this.resultContainerEl?.children ?? []).filter(
			(child): child is HTMLElement =>
				child.instanceOf(HTMLElement) && child.classList.contains("suggestion-item"),
		);
	}

	/** Access SuggestModal's internal chooser (undocumented) so we stay in sync with its highlight index. */
	private getChooser(): SuggestModalChooser | null {
		const chooser = (this as unknown as { chooser?: SuggestModalChooser }).chooser;
		return chooser && typeof chooser.setSelectedItem === "function" ? chooser : null;
	}

	/** Index of the row Obsidian currently highlights (the one arrow keys move), or 0. */
	private getFocusedIndex(): number {
		const chooser = this.getChooser();
		if (chooser && chooser.selectedItem >= 0) {
			return chooser.selectedItem;
		}

		const suggestionEls = this.getSuggestionEls();
		if (suggestionEls.length === 0) {
			return 0;
		}

		const selectedIndex = suggestionEls.findIndex((child) => child.classList.contains("is-selected"));
		return selectedIndex >= 0 ? selectedIndex : 0;
	}

	private getFocusedSearchResult(): SearchResult | null {
		if (this.searchResults.length === 0) {
			return null;
		}

		const resultIndex = this.getFocusedIndex();
		return this.searchResults[resultIndex] ?? this.searchResults[0] ?? null;
	}

	/**
	 * Toggle the currently highlighted row (select if unselected, unselect if
	 * selected), then move the highlight one row per the arrow direction. Returns
	 * false when there is nowhere to move.
	 */
	private extendSelection(direction: -1 | 1): boolean {
		const suggestionEls = this.getSuggestionEls();
		if (suggestionEls.length === 0 || this.searchResults.length === 0) {
			return false;
		}

		const fromIndex = this.getFocusedIndex();
		const toIndex = fromIndex + direction;
		if (toIndex < 0 || toIndex >= suggestionEls.length) {
			return false;
		}

		const current = this.searchResults[fromIndex];
		if (current && !this.isPickerUnavailable(current.path)) {
			if (this.selectedResultsByPath.has(current.path)) {
				this.selectedResultsByPath.delete(current.path);
			} else {
				this.selectedResultsByPath.set(current.path, current);
			}
		}

		this.setFocusedIndex(toIndex);
		this.selectionQuery = this.currentQuery;
		this.updateInstructions();
		this.syncRenderedSelectionState();
		return true;
	}

	/** Move the row highlight by one step (Vim-style navigation). Returns false when there is nowhere to move. */
	private moveFocus(direction: -1 | 1): boolean {
		const suggestionEls = this.getSuggestionEls();
		if (suggestionEls.length === 0) {
			return false;
		}

		const toIndex = this.getFocusedIndex() + direction;
		if (toIndex < 0 || toIndex >= suggestionEls.length) {
			return false;
		}

		this.setFocusedIndex(toIndex);
		return true;
	}

	/** Move Obsidian's row highlight to the given index and scroll it into view. */
	private setFocusedIndex(index: number): void {
		// Prefer the chooser so its internal index tracks the visible highlight;
		// otherwise a following plain arrow press would move from a stale index.
		const chooser = this.getChooser();
		if (chooser) {
			chooser.setSelectedItem(index);
			return;
		}

		const suggestionEls = this.getSuggestionEls();
		const target = suggestionEls[index];
		if (!target) {
			return;
		}

		for (const child of suggestionEls) {
			child.toggleClass("is-selected", child === target);
		}
		target.scrollIntoView({ block: "nearest" });
	}

	private syncRenderedSelectionState(): void {
		const suggestionEls = this.getSuggestionEls();
		if (suggestionEls.length === 0) {
			return;
		}

		for (const child of suggestionEls) {
			const path = child.dataset.searchResultPath;
			child.toggleClass(
				"s2b-search-result-item-selected",
				typeof path === "string" && this.selectedResultsByPath.has(path),
			);
		}
	}

	private toggleSelection(result: SearchResult): void {
		if (this.isPickerUnavailable(result.path)) {
			return;
		}

		if (this.selectedResultsByPath.has(result.path)) {
			this.selectedResultsByPath.delete(result.path);
		} else {
			this.selectedResultsByPath.set(result.path, result);
		}

		this.selectionQuery = this.currentQuery;
		this.updateInstructions();
		this.syncRenderedSelectionState();
	}

	private clearSelection(): void {
		if (this.selectedResultsByPath.size === 0) {
			return;
		}

		this.selectedResultsByPath.clear();
		this.selectionQuery = null;
		this.updateInstructions();
		this.syncRenderedSelectionState();
	}

	private confirmSelection(): void {
		const selectedResults = this.getSelectedResults();
		if (this.isPickerMode()) {
			if (selectedResults.length > 0) {
				this.confirmPickerResults(selectedResults);
				return;
			}

			const focusedResult = this.getFocusedSearchResult();
			if (focusedResult) {
				this.confirmPickerResults([focusedResult]);
			}
			return;
		}

		if (selectedResults.length === 0) {
			return;
		}

		// Plain Enter opens in place (native Obsidian convention). A multi-note
		// selection still fans the extras out into tabs (see openSearchResults).
		this.openSearchResults(selectedResults, false);
	}

	private openSearchResults(results: SearchResult[], destination: false | "tab"): void {
		if (results.length === 0) {
			return;
		}

		if (results.length === 1) {
			this.openSearchResult(results[0], destination);
			return;
		}

		this.close();
		for (const [index, result] of results.entries()) {
			getData().recordRecentlyOpenedNote(result.path);
			void this.app.workspace.openLinkText(result.path, "", destination === "tab" || index > 0 ? "tab" : false);
		}
	}

	private openSearchResult(result: SearchResult, destination: false | "tab"): void {
		const file = this.app.vault.getAbstractFileByPath(result.path);
		if (!(file instanceof TFile)) {
			return;
		}

		// Always reuse a leaf that already has this note open, regardless of the
		// requested destination — no point opening a duplicate.
		let existingLeaf: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (existingLeaf) {
				return;
			}

			const viewState = leaf.getViewState();
			if (viewState.type === "markdown" && viewState.state?.file === file.path) {
				existingLeaf = leaf;
				return;
			}

			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
				existingLeaf = leaf;
			}
		});

		if (existingLeaf) {
			getData().recordRecentlyOpenedNote(file.path);
			this.close();
			this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
			void this.app.workspace.revealLeaf(existingLeaf);
			return;
		}

		this.close();
		void this.app.workspace.openLinkText(result.path, "", destination);
	}

	/**
	 * Send the typed query to an agent: open/reveal the chat, prefill the query,
	 * attach the selected (or focused) notes, and auto-submit. When the query is
	 * empty, the selected/focused notes are still attached — the chat opens
	 * without submitting so the user can type their question.
	 */
	/**
	 * Attach the selected (or focused) notes to a chat without sending. Targets an
	 * already-open chat (most-recently-used); if none is open, a fresh chat thread
	 * is created. The notes are queued as pending attachments scoped to that thread
	 * so the chat's composer picks them up without auto-submitting.
	 */
	private async attachToChat(): Promise<void> {
		// Explicit selections win; otherwise fall back to the highlighted row.
		const selectedResults = this.getSelectedResults();
		const focusedResult = selectedResults.length === 0 ? this.getFocusedSearchResult() : null;
		const paths =
			selectedResults.length > 0
				? selectedResults.map((result) => result.path)
				: focusedResult
					? [focusedResult.path]
					: [];

		if (paths.length === 0) {
			return;
		}

		this.close();

		const messenger = getSessionRegistry();
		if (!messenger) {
			// Reached before any chat has been opened, so the link has something to do —
			// unlike the post-`createNewChat` guard below.
			showActionNotice("Chat is not initialized yet.", openChatAction());
			return;
		}

		const plugin = getPlugin();
		const threadPath = await plugin.agentManager.resolveOrOpenChatForAttach();
		if (!threadPath) {
			new Notice("Could not open a chat to attach to.");
			return;
		}

		// Scope the pending attachments to the resolved chat so a different open
		// chat tab doesn't consume them. No auto-submit: the notes just land in
		// the composer for the user to add a question.
		messenger.pendingSubmitThreadPath = threadPath;
		messenger.pendingAttachmentPaths = paths;
		messenger.pendingAutoSubmit = false;
	}

	private async askAgentWithQuery(): Promise<void> {
		const query = this.currentQuery.trim();

		// Resolve the notes to attach. Explicit selections are always attached.
		// The focused-row fallback only applies to a note-only ask (empty query):
		// there the highlighted row is the intended subject. With a query typed,
		// don't silently attach the auto-highlighted first result the user never
		// selected — attach only what they explicitly picked.
		const selectedResults = this.getSelectedResults();
		const focusedResult = selectedResults.length === 0 && !query ? this.getFocusedSearchResult() : null;
		const paths =
			selectedResults.length > 0
				? selectedResults.map((result) => result.path)
				: focusedResult
					? [focusedResult.path]
					: [];

		// Nothing to ask about — no query text and no notes to attach.
		if (!query && paths.length === 0) {
			return;
		}

		const prompt = query ? this.appendFilterContext(query) : "";

		this.close();

		// Always start a fresh chat rather than appending to whatever thread the
		// open chat leaf happens to be showing. createNewChat() reveals the leaf and
		// reuses an existing empty "New Chat" so we don't accumulate empty threads.
		const plugin = getPlugin();
		const threadPath = await plugin.agentManager.createNewChat();

		const messenger = getSessionRegistry();
		if (!messenger) {
			new Notice("Chat is not initialized yet. Please open a chat first.");
			return;
		}

		// Scope the pending submission to the chat we just opened, so a stale chat
		// tab doesn't consume the input/auto-submit meant for this new thread.
		messenger.pendingSubmitThreadPath = threadPath;

		if (paths.length > 0) {
			messenger.pendingAttachmentPaths = paths;
		}

		// With a query, prefill and auto-submit. Note-only (empty query): attach
		// the notes and open the chat without submitting, so the user can type.
		if (prompt) {
			messenger.pendingInput = prompt;
			messenger.pendingAutoSubmit = true;
		}
	}

	/**
	 * Append the active tag/folder filters as scope context so the agent knows the
	 * user has narrowed to those notes. Returns the query unchanged when no filters
	 * are set.
	 */
	private appendFilterContext(query: string): string {
		const tags = this.activeFilters
			.filter((f) => f.type === "tag")
			.map((f) => (f.value.startsWith("#") ? f.value : `#${f.value}`));
		const folders = this.activeFilters.filter((f) => f.type === "path").map((f) => f.value.replace(/\/$/, ""));

		const scopes: string[] = [];
		if (tags.length > 0) {
			const joiner = tags.length > 1 && this.requireAllTags ? " and " : " or ";
			scopes.push(`tagged ${tags.join(joiner)}`);
		}
		if (folders.length > 0) {
			scopes.push(`in the folder${folders.length > 1 ? "s" : ""} ${folders.join(" or ")}`);
		}

		if (scopes.length === 0) {
			return query;
		}

		return `${query}\n\n(Scope: notes ${scopes.join(", ")}.)`;
	}

	private async getUniqueNotePath(baseTitle: string): Promise<{ title: string; path: string }> {
		const targetFolder = this.getDefaultNewNoteFolder();
		let index = 1;
		while (true) {
			const title = index === 1 ? baseTitle : `${baseTitle} (${index})`;
			const path = targetFolder ? normalizePath(`${targetFolder}/${title}.md`) : normalizePath(`${title}.md`);

			if (!(await this.app.vault.adapter.exists(path))) {
				return { title, path };
			}

			index += 1;
		}
	}

	private getDefaultNewNoteFolder(): string {
		try {
			// @ts-expect-error - internal Obsidian config API
			const newFileLocation: unknown = this.app.vault.getConfig("newFileLocation");
			if (newFileLocation === "folder") {
				// @ts-expect-error - internal Obsidian config API
				const configuredFolder: unknown = this.app.vault.getConfig("newFileFolderPath");
				if (typeof configuredFolder === "string" && configuredFolder.length > 0 && configuredFolder !== "/") {
					return normalizePath(configuredFolder);
				}
			}

			if (newFileLocation === "current") {
				const activeFile = this.app.workspace.getActiveFile();
				const activeFolder = activeFile?.parent?.path;
				if (activeFolder && activeFolder !== "/") {
					return normalizePath(activeFolder);
				}
			}
		} catch {
			// Ignore internal config lookup failures and fall back to vault root.
		}

		return "";
	}

	private async createNoteFromQuery(): Promise<void> {
		const requestedTitle = this.currentQuery.trim();
		const baseTitle = sanitizeNoteTitle(requestedTitle) || "Untitled";

		try {
			const { title, path } = await this.getUniqueNotePath(baseTitle);
			const content = title === "Untitled" ? "" : `# ${title}\n`;
			const file = await this.app.vault.create(path, content);

			this.close();
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
			await this.app.workspace.revealLeaf(leaf);
		} catch (error) {
			Logger.error("[SearchModal] Failed to create note from query:", error);
			new Notice("Failed to create note");
		}
	}

	/**
	 * Escape clears the selection first; a second press (nothing selected) closes
	 * the modal. Overrides Modal.onEscapeKey, which is not in the public typings.
	 */
	onEscapeKey(evt?: KeyboardEvent): void {
		if (this.selectedResultsByPath.size > 0) {
			evt?.preventDefault();
			this.clearSelection();
			return;
		}

		this.close();
	}

	onOpen(): void {
		this.isClosed = false;
		this.selectedResultsByPath.clear();
		this.selectionQuery = null;
		this.currentQuery = "";
		this.lastRequestedSearchKey = "";
		this.activeFilters = [];
		this.hasPrimedOpenResults = false;
		this.semanticEnabled = false;
		this.semanticOneShotQuery = null;

		this.searchResults = this.getModalRecentNotes();
		this.hasPrimedOpenResults = true;

		void super.onOpen();

		applyPromptSafeArea(this.modalEl);
		this.schedulePostOpenHydration();
		this.scheduleInputFocus();
	}

	onClose(): void {
		this.isClosed = true;
		this.selectedResultsByPath.clear();
		this.selectionQuery = null;
		this.noteIconCache.clear();
		this.tagIconCache.clear();
		this.resolvedIconColorCache.clear();
		this.noteIconElementCache.clear();
		this.tagIconElementCache.clear();
		this.tagPillElementCache.clear();
		this.badgeIconElementCache.clear();
		this.stopGlowAnimation();
		this.inlineChipsEl?.remove();
		this.inlineChipsEl = null;
		this.inlineInputContentEl?.remove();
		this.inlineInputContentEl = null;
		this.cachedAutocompleteTags = [];
		this.cachedTagChildCount.clear();
		this.cachedAutocompleteFolders = [];
		// Cancel any pending search
		if (this.searchTimeout !== null) {
			window.clearTimeout(this.searchTimeout);
			this.searchTimeout = null;
		}
		if (this.autocompleteHydrationTimeout !== null) {
			window.clearTimeout(this.autocompleteHydrationTimeout);
			this.autocompleteHydrationTimeout = null;
		}
		if (this.pendingPostOpenFrameId !== null) {
			window.cancelAnimationFrame(this.pendingPostOpenFrameId);
			this.pendingPostOpenFrameId = null;
		}
		this.hasPrimedOpenResults = false;
		if (this.pendingFocusFrameId !== null) {
			window.cancelAnimationFrame(this.pendingFocusFrameId);
			this.pendingFocusFrameId = null;
		}
		this.clearPendingFocusTimeouts();
	}

	private schedulePostOpenHydration(): void {
		if (this.pendingPostOpenFrameId !== null) {
			window.cancelAnimationFrame(this.pendingPostOpenFrameId);
		}

		this.pendingPostOpenFrameId = window.requestAnimationFrame(() => {
			this.pendingPostOpenFrameId = null;
			if (this.isClosed) {
				return;
			}

			this.buildAutocompleteCaches();
			this.setupInlineChips();
			if (this.activeFilters.length > 0) {
				this.renderInlineChips();
			}
		});
	}

	private tryPopulateAutocompleteCachesFromLexicalIndex(): boolean {
		if (!isLexicalSearchInitialized()) {
			return false;
		}

		const lexicalSearch = getLexicalSearchService();
		const snapshot = lexicalSearch.getAutocompleteCache();
		if (snapshot.tags.length === 0 && snapshot.folders.length === 0 && lexicalSearch.documentCount === 0) {
			return false;
		}

		this.cachedTagChildCount = new Map(snapshot.tagChildCount);
		this.cachedAutocompleteTags = [...snapshot.tags];
		this.cachedAutocompleteFolders = [...snapshot.folders];
		return true;
	}

	private populateAutocompleteCachesFromVault(): void {
		const leafTags = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (isAgentFilePath(file.path)) {
				continue;
			}
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) {
				continue;
			}

			for (const tag of getAllTags(cache) ?? []) {
				leafTags.add(tag);
			}
		}

		this.cachedTagChildCount.clear();
		for (const tag of leafTags) {
			const parts = tag.split("/");
			for (let index = 1; index < parts.length; index++) {
				const parent = parts.slice(0, index).join("/");
				this.cachedTagChildCount.set(parent, (this.cachedTagChildCount.get(parent) ?? 0) + 1);
			}
		}

		this.cachedAutocompleteTags = Array.from(new Set([...leafTags, ...this.cachedTagChildCount.keys()])).sort();
		this.cachedAutocompleteFolders = this.app.vault
			.getAllLoadedFiles()
			.filter(
				(abstractFile): abstractFile is TFolder => abstractFile instanceof TFolder && abstractFile.path !== "/",
			)
			.map((folder) => folder.path)
			.sort();
	}

	private scheduleAutocompleteHydration(): void {
		if (this.isClosed || this.autocompleteHydrationTimeout !== null) {
			return;
		}

		this.autocompleteHydrationTimeout = window.setTimeout(() => {
			this.autocompleteHydrationTimeout = null;
			if (this.isClosed) {
				return;
			}

			if (!this.tryPopulateAutocompleteCachesFromLexicalIndex()) {
				this.populateAutocompleteCachesFromVault();
			}

			if (this.getAutocompleteSuggestions(this.currentQuery)?.length) {
				// @ts-ignore - updateSuggestions is a protected method
				this.updateSuggestions();
			}
		}, 0);
	}

	/**
	 * Set up the inline chip container inside the prompt-input-container,
	 * before the <input> element, so chips appear inside the input field.
	 */
	private setupInlineChips(): void {
		const inputContainer = this.modalEl.querySelector<HTMLElement>(".prompt-input-container");
		const inputEl = this.getInputEl();
		if (!inputContainer || !inputEl) return;

		// Reserve a dedicated content column so wrapped chips never slide beneath the search icon.
		inputContainer.addClass("s2b-inline-chips-container");

		this.inlineInputContentEl = createDiv();
		this.inlineInputContentEl.className = "s2b-inline-input-content";
		inputContainer.insertBefore(this.inlineInputContentEl, inputEl);

		// Create the chip wrapper inside the content flow, before the input.
		this.inlineChipsEl = createDiv();
		this.inlineChipsEl.className = "s2b-inline-chips";
		this.inlineInputContentEl.appendChild(this.inlineChipsEl);
		this.inlineInputContentEl.appendChild(inputEl);

		// Make the input grow to fill the remaining space inside the flow container.
		inputEl.addClass("s2b-inline-input");
		this.updateInlineInputSpacing();
	}

	private getInputEl(): HTMLInputElement | null {
		return this.modalEl.querySelector<HTMLInputElement>(".prompt-input");
	}

	private scheduleInputFocus(): void {
		if (this.pendingFocusFrameId !== null) {
			window.cancelAnimationFrame(this.pendingFocusFrameId);
		}
		this.clearPendingFocusTimeouts();

		this.pendingFocusFrameId = window.requestAnimationFrame(() => {
			this.pendingFocusFrameId = null;
			this.focusInput();
			for (const delay of [0, 50, 150, 400, 800]) {
				const timeoutId = window.setTimeout(() => {
					this.pendingFocusTimeoutIds = this.pendingFocusTimeoutIds.filter((id) => id !== timeoutId);
					this.focusInput();
				}, delay);
				this.pendingFocusTimeoutIds.push(timeoutId);
			}
		});
	}

	private clearPendingFocusTimeouts(): void {
		for (const timeoutId of this.pendingFocusTimeoutIds) {
			window.clearTimeout(timeoutId);
		}
		this.pendingFocusTimeoutIds = [];
	}

	private focusInput(): void {
		if (this.isClosed) {
			return;
		}

		const inputEl = this.getInputEl();
		if (!inputEl) {
			return;
		}

		inputEl.focus();
		const cursorPosition = inputEl.value.length;
		inputEl.setSelectionRange(cursorPosition, cursorPosition);
	}

	private getCachedSearchResultNoteIcon(path: string) {
		if (!this.noteIconCache.has(path)) {
			this.noteIconCache.set(path, getSearchResultNoteIcon(this.app, path) ?? null);
		}

		return this.noteIconCache.get(path) ?? null;
	}

	private getCachedTagIcon(tag: string) {
		if (!this.tagIconCache.has(tag)) {
			this.tagIconCache.set(tag, getTagIcon(this.app, tag) ?? null);
		}

		return this.tagIconCache.get(tag) ?? null;
	}

	private getCachedResolvedIconColor(color?: string): string | undefined {
		if (!color) {
			return undefined;
		}

		if (!this.resolvedIconColorCache.has(color)) {
			this.resolvedIconColorCache.set(color, resolveIconColor(color) ?? null);
		}

		return this.resolvedIconColorCache.get(color) ?? undefined;
	}

	private getCachedSearchResultNoteIconElement(path: string): HTMLElement | null {
		if (!this.noteIconElementCache.has(path)) {
			const noteIcon = this.getCachedSearchResultNoteIcon(path);
			if (!noteIcon) {
				this.noteIconElementCache.set(path, null);
			} else {
				const iconEl = createSpan();
				iconEl.className = "s2b-search-result-note-icon";
				iconEl.setAttribute("aria-hidden", "true");
				noteIcon.render(iconEl);
				this.noteIconElementCache.set(path, iconEl);
			}
		}

		return this.noteIconElementCache.get(path)?.cloneNode(true) as HTMLElement | null;
	}

	private getCachedTagIconElement(tag: string): HTMLElement | null {
		if (!this.tagIconElementCache.has(tag)) {
			const tagIcon = this.getCachedTagIcon(tag);
			if (!tagIcon) {
				this.tagIconElementCache.set(tag, null);
			} else {
				const iconEl = createSpan();
				iconEl.className = "s2b-search-result-tag-icon iconic-icon";
				iconEl.setAttribute("aria-hidden", "true");
				tagIcon.render(iconEl);
				this.tagIconElementCache.set(tag, iconEl);
			}
		}

		return this.tagIconElementCache.get(tag)?.cloneNode(true) as HTMLElement | null;
	}

	private getCachedTagPillElement(tag: string): HTMLElement {
		if (!this.tagPillElementCache.has(tag)) {
			const tagEl = createSpan();
			tagEl.className = "s2b-search-result-tag";

			const tagIcon = this.getCachedTagIcon(tag);
			if (tagIcon) {
				tagEl.classList.add(`s2b-search-result-tag-${tagIcon.provider}`);
				const resolvedTagColor = this.getCachedResolvedIconColor(tagIcon.color);
				if (resolvedTagColor) {
					const rgbaColor = resolvedTagColor.replace("rgb(", "rgba(").replace(")", "");
					tagEl.style.setProperty("--tag-color", resolvedTagColor);
					tagEl.style.setProperty("--tag-color-hover", resolvedTagColor);
					tagEl.style.setProperty("--tag-color-remove-hover", resolvedTagColor);
					tagEl.style.setProperty("--tag-background", `${rgbaColor}, 0.1)`);
					tagEl.style.setProperty("--tag-background-hover", `${rgbaColor}, 0.1)`);
					tagEl.style.setProperty("--tag-border-color", `${rgbaColor}, 0.25)`);
					tagEl.style.setProperty("--tag-border-color-hover", `${rgbaColor}, 0.5)`);
				}

				const tagIconEl = this.getCachedTagIconElement(tag);
				if (tagIconEl) {
					tagEl.appendChild(tagIconEl);
				}
			}

			tagEl.createSpan({ text: getDisplayTagLabel(tag), cls: "s2b-search-result-tag-label" });
			this.tagPillElementCache.set(tag, tagEl);
		}

		return this.tagPillElementCache.get(tag)?.cloneNode(true) as HTMLElement;
	}

	private getCachedBadgeIconElement(badge: SearchResultBadge): HTMLElement {
		if (!this.badgeIconElementCache.has(badge)) {
			const badgeIconEl = createSpan();
			badgeIconEl.className = "s2b-search-result-badge-icon";
			badgeIconEl.setAttribute("aria-hidden", "true");
			setIcon(badgeIconEl, getBadgeIconId(badge));
			this.badgeIconElementCache.set(badge, badgeIconEl);
		}

		return this.badgeIconElementCache.get(badge)?.cloneNode(true) as HTMLElement;
	}

	private usesCupertinoTheme(): boolean {
		const customCss = (this.app as App & { customCss?: { theme?: string } }).customCss;
		const themeName = customCss?.theme?.toLowerCase() ?? "";
		return themeName.includes("cupertino") || themeName.includes("baseline");
	}

	private updateInlineInputSpacing(): void {
		const inputEl = this.getInputEl();
		if (!inputEl) return;

		const usesCupertinoTheme = this.usesCupertinoTheme();
		const hasChips = this.activeFilters.length > 0;
		if (this.inlineInputContentEl) {
			this.inlineInputContentEl.style.setProperty(
				"padding-left",
				hasChips && usesCupertinoTheme ? "36px" : "8px",
				"important",
			);
		}

		// Only the theme-dependent leading inset is set here; the static resets
		// live on `.s2b-inline-input` (styles.css). Inline `!important` because
		// Cupertino pins `padding-inline-start` on `.prompt-input` at that priority.
		const leadingInset = hasChips || !usesCupertinoTheme ? "0" : "36px";
		inputEl.style.setProperty("padding-left", leadingInset, "important");
		inputEl.style.setProperty("padding-inline-start", leadingInset, "important");
	}

	private getModalRecentNotes(): SearchResult[] {
		if (this.isPickerMode()) {
			return this.getPickerBrowseResults();
		}

		const activeFilePath = this.app.workspace.getActiveFile()?.path;
		const filter = this.buildActiveFilter();
		// `getRecentNotes` already bounds this by age; the slice is purely a display
		// limit so the empty-state list stays scannable when a week's worth of notes
		// qualifies.
		return getRecentNotes(this.app, filter)
			.filter((result) => result.path !== activeFilePath)
			.slice(0, 20);
	}

	private setSearchQuery(cleanQuery: string): void {
		this.currentQuery = cleanQuery;
		this.updateInstructions();

		const inputEl = this.getInputEl();
		if (inputEl && inputEl.value !== cleanQuery) {
			inputEl.value = cleanQuery;
		}

		if (!cleanQuery.trim()) {
			this.searchResults = this.getModalRecentNotes();
			this.lastRequestedSearchKey = "";
			this.setSearching(false);
			// @ts-ignore - updateSuggestions is a protected method
			this.updateSuggestions();
			return;
		}

		if (cleanQuery.trim() || this.activeFilters.length > 0) {
			this.invalidateSearch();
			this.triggerSearch(cleanQuery);
			// Refresh the display immediately with current (possibly stale) results
			// while the debounced search runs in the background.
			// @ts-ignore - updateSuggestions is a protected method
			this.updateSuggestions();
		} else {
			this.searchResults = this.getModalRecentNotes();
			this.lastRequestedSearchKey = "";
			this.setSearching(false);
			// @ts-ignore - updateSuggestions is a protected method
			this.updateSuggestions();
		}
	}

	private removeFilter(index: number): void {
		this.activeFilters.splice(index, 1);

		const activeTags = this.activeFilters.filter((f) => f.type === "tag");
		if (activeTags.length < 2) {
			this.requireAllTags = false;
		}

		this.renderInlineChips();
		this.invalidateSearch();
		this.triggerSearch(this.currentQuery);
	}

	private toggleRequireAllTags(): void {
		this.requireAllTags = !this.requireAllTags;
		this.renderInlineChips();
		if (this.currentQuery.trim() || this.activeFilters.length > 0) {
			this.invalidateSearch();
			this.triggerSearch(this.currentQuery);
		}
	}

	/** Build a SearchFilter from the active inline chips */
	private buildActiveFilter(): SearchFilter | undefined {
		const tags = this.activeFilters.filter((f) => f.type === "tag").map((f) => f.value);
		const pathPrefixes = this.activeFilters.filter((f) => f.type === "path").map((f) => f.value);

		if (tags.length === 0 && pathPrefixes.length === 0) return undefined;

		return {
			tags: tags.length > 0 ? tags : undefined,
			pathPrefixes: pathPrefixes.length > 0 ? pathPrefixes : undefined,
			requireAllTags: tags.length > 1 ? this.requireAllTags : undefined,
		};
	}

	private buildSearchKey(query: string): string {
		return JSON.stringify({
			query,
			algorithm: this.activeAlgorithm,
			filter: this.buildActiveFilter() ?? null,
		});
	}

	private buildAutocompleteCaches(): void {
		if (this.tryPopulateAutocompleteCachesFromLexicalIndex()) {
			return;
		}

		this.cachedTagChildCount.clear();
		this.cachedAutocompleteTags = [];
		this.cachedAutocompleteFolders = [];
		this.scheduleAutocompleteHydration();
	}

	/** Render inline filter chips inside the input container */
	private renderInlineChips(): void {
		const chipsEl = this.inlineChipsEl;
		if (!chipsEl) return;

		chipsEl.empty();
		this.inlineInputContentEl?.toggleClass("s2b-inline-input-content-has-chips", this.activeFilters.length > 0);
		this.updateInlineInputSpacing();

		for (const [index, filter] of this.activeFilters.entries()) {
			const chip = chipsEl.createEl("button", { cls: "s2b-inline-chip" });
			chip.type = "button";

			// Try to get an icon from Iconic / Iconize
			const iconRenderer =
				filter.type === "tag"
					? getTagIcon(this.app, filter.value)
					: getPathIcon(this.app, filter.value.replace(/\/$/, ""), "folder");

			if (iconRenderer) {
				chip.classList.add(`s2b-inline-chip-${iconRenderer.provider}`);
				const resolvedColor = resolveIconColor(iconRenderer.color);
				if (resolvedColor) {
					const rgbaColor = resolvedColor.replace("rgb(", "rgba(").replace(")", "");
					chip.style.setProperty("--tag-color", resolvedColor);
					chip.style.setProperty("--tag-color-hover", resolvedColor);
					chip.style.setProperty("--tag-color-remove-hover", resolvedColor);
					chip.style.setProperty("--tag-background", `${rgbaColor}, 0.1)`);
					chip.style.setProperty("--tag-background-hover", `${rgbaColor}, 0.1)`);
					chip.style.setProperty("--tag-border-color", `${rgbaColor}, 0.25)`);
					chip.style.setProperty("--tag-border-color-hover", `${rgbaColor}, 0.5)`);
				}
				const iconEl = chip.createSpan({ cls: "s2b-inline-chip-icon" });
				iconEl.setAttribute("aria-hidden", "true");
				iconRenderer.render(iconEl);
			} else {
				// Fallback: default icon for type
				const iconEl = chip.createSpan({ cls: "s2b-inline-chip-icon" });
				iconEl.setAttribute("aria-hidden", "true");
				setIcon(iconEl, filter.type === "tag" ? "tag" : "folder");
			}

			const label = filter.type === "path" ? filter.value.replace(/\/$/, "") : filter.value.replace(/^#/, "");
			chip.setAttribute("aria-label", `Remove filter ${label}`);
			chip.createSpan({ cls: "s2b-inline-chip-label", text: label });
			chip.createSpan({ cls: "s2b-inline-chip-remove", text: "×" });
			chip.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.removeFilter(index);
				this.getInputEl()?.focus();
			});
		}

		// Tags ANY/ALL toggle chip (only with 2+ tags)
		const tagCount = this.activeFilters.filter((f) => f.type === "tag").length;
		if (tagCount > 1) {
			const modeChip = chipsEl.createEl("button", {
				cls: "s2b-inline-chip s2b-inline-chip-mode",
				text: this.requireAllTags ? "ALL" : "ANY",
			});
			modeChip.type = "button";
			modeChip.setAttribute("aria-label", "Toggle tag match mode");
			modeChip.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.toggleRequireAllTags();
			});
		}
	}

	private startGlowAnimation(): void {
		if (this.glowAnimationId !== null) return;

		const muted =
			getComputedStyle(document.body).getPropertyValue("--background-modifier-border").trim() || "#363636";
		const radius = getComputedStyle(this.modalEl).borderRadius || "12px";
		const borderWidth = 2;

		// Hide the modal's own border so the gradient replaces it
		this.modalEl.addClass("s2b-search-modal-glowing");

		// Create a fixed-position overlay exactly on top of the modal
		const border = createDiv();
		const modalRect = this.modalEl.getBoundingClientRect();
		Object.assign(border.style, {
			position: "fixed",
			top: `${modalRect.top}px`,
			left: `${modalRect.left}px`,
			width: `${modalRect.width}px`,
			height: `${modalRect.height}px`,
			pointerEvents: "none",
			zIndex: "9999",
		});
		border.className = "s2b-search-modal-glow";
		document.body.appendChild(border);
		this.borderEl = border;

		const canvas = createEl("canvas");
		const dpr = window.devicePixelRatio || 1;
		canvas.addClass("s2b-search-modal-glow-canvas");
		border.appendChild(canvas);

		const animate = () => {
			const rect = this.modalEl.getBoundingClientRect();
			const w = rect.width;
			const h = rect.height;

			border.style.top = `${rect.top}px`;
			border.style.left = `${rect.left}px`;
			border.style.width = `${w}px`;
			border.style.height = `${h}px`;

			canvas.width = w * dpr;
			canvas.height = h * dpr;

			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			ctx.scale(dpr, dpr);

			const r = Number.parseFloat(radius) || 12;
			const angle = ((performance.now() % 2000) / 2000) * Math.PI * 2;
			const accent = this.getSemanticGlowColor();

			const cx = w / 2;
			const cy = h / 2;
			const grad = ctx.createConicGradient(angle, cx, cy);
			grad.addColorStop(0, accent);
			grad.addColorStop(0.25, muted);
			grad.addColorStop(0.5, accent);
			grad.addColorStop(0.75, muted);
			grad.addColorStop(1, accent);

			// Draw ring inward from the modal edges
			ctx.beginPath();
			ctx.roundRect(0, 0, w, h, r);
			ctx.roundRect(
				borderWidth,
				borderWidth,
				w - borderWidth * 2,
				h - borderWidth * 2,
				Math.max(0, r - borderWidth),
			);
			ctx.fillStyle = grad;
			ctx.fill("evenodd");

			this.glowAnimationId = window.requestAnimationFrame(animate);
		};
		this.glowAnimationId = window.requestAnimationFrame(animate);
	}

	private stopGlowAnimation(): void {
		if (this.glowAnimationId !== null) {
			cancelAnimationFrame(this.glowAnimationId);
			this.glowAnimationId = null;
		}
		if (this.borderEl) {
			this.borderEl.remove();
			this.borderEl = null;
		}
		this.modalEl.removeClass("s2b-search-modal-glowing");
	}

	/** Force the next getSuggestions call to re-trigger a search. */
	private invalidateSearch(): void {
		this.lastRequestedSearchKey = "";
		this.lastResolvedSearchKey = "";
		this.resolvePendingSuggestions([]);
	}

	private waitForResolvedSuggestions(searchKey: string): Promise<SearchSuggestion[]> {
		if (this.pendingSuggestionSearchKey !== searchKey) {
			this.resolvePendingSuggestions([]);
			this.pendingSuggestionSearchKey = searchKey;
		}

		return new Promise((resolve) => {
			this.pendingSuggestionResolvers.push(resolve);
		});
	}

	private resolvePendingSuggestions(suggestions: SearchSuggestion[]): void {
		const resolvers = this.pendingSuggestionResolvers;
		this.pendingSuggestionResolvers = [];
		this.pendingSuggestionSearchKey = null;

		for (const resolve of resolvers) {
			resolve(suggestions);
		}
	}

	/**
	 * Schedule a search with the appropriate debounce for the active algorithm.
	 * Uses a monotonic request ID to discard stale results.
	 */
	private triggerSearch(cleanQuery: string): void {
		if (this.searchTimeout !== null) {
			window.clearTimeout(this.searchTimeout);
			this.searchTimeout = null;
		}

		const delay = this.activeAlgorithm === "lexical" ? 40 : 200;

		this.searchTimeout = window.setTimeout(() => {
			this.searchTimeout = null;
			void this.requestSearch(cleanQuery);
		}, delay);
	}

	/**
	 * Single search path for all algorithms.
	 * A monotonic `searchRequestId` ensures only the latest request can update the UI.
	 */
	private async requestSearch(cleanQuery: string): Promise<void> {
		if (this.isClosed) return;

		const filter = this.buildActiveFilter();
		const algorithm = this.activeAlgorithm;
		const searchKey = this.buildSearchKey(cleanQuery);
		const requestId = ++this.searchRequestId;

		if (!cleanQuery.trim()) {
			this.searchResults = this.getModalRecentNotes();
			this.lastResolvedSearchKey = "";
			this.resolvePendingSuggestions(this.searchResults);
			this.setSearching(false);
			// @ts-ignore - updateSuggestions is a protected method
			this.updateSuggestions();
			return;
		}

		this.setSearching(true);

		try {
			const results = await performSearch(this.app, cleanQuery, algorithm, filter);

			// Discard results from stale requests
			if (requestId !== this.searchRequestId || this.isClosed) {
				this.resolvePendingSuggestions([]);
				return;
			}

			this.searchResults = this.getVisibleResults(results).slice(0, 20);
			this.lastResolvedSearchKey = searchKey;
			this.resolvePendingSuggestions(this.searchResults);
			this.logVerboseSearchDiagnostics(cleanQuery, algorithm, filter, this.searchResults);
			// @ts-ignore - updateSuggestions is a protected method
			this.updateSuggestions();
		} catch (error) {
			Logger.error("[SearchModal] Search failed:", error);
			if (requestId === this.searchRequestId) {
				this.searchResults = [];
				this.lastResolvedSearchKey = searchKey;
				this.resolvePendingSuggestions(this.searchResults);
				// @ts-ignore - updateSuggestions is a protected method
				this.updateSuggestions();
			}
		} finally {
			if (requestId === this.searchRequestId) {
				this.setSearching(false);
			}
		}
	}

	private logVerboseSearchDiagnostics(
		query: string,
		algorithm: SearchAlgorithm,
		filter: SearchFilter | undefined,
		results: SearchResult[],
	): void {
		if (!getData().isVerbose) {
			return;
		}

		const summary = results.slice(0, 10).map((result) => ({
			finalRank: result.rankingDebug?.finalRank,
			originalRank: result.rankingDebug?.originalRank,
			lexicalRank: result.rankingDebug?.lexicalRank,
			semanticRank: result.rankingDebug?.semanticRank,
			recentRank: result.rankingDebug?.recentRank,
			recentBoost: result.rankingDebug?.recentBoost,
			rerankScore: result.rankingDebug?.rerankScore,
			finalScore: result.rankingDebug?.finalScore,
			recentAliasBonus: result.rankingDebug?.recentAliasBonus,
			score: result.rankingDebug?.baseScore ?? result.score,
			lexicalRrfScore: result.rankingDebug?.lexicalRrfScore,
			semanticRrfScore: result.rankingDebug?.semanticRrfScore,
			finalTitleBoost: result.rankingDebug?.finalTitleBoost,
			finalAliasBoost: result.rankingDebug?.finalAliasBoost,
			bestChunkScore: result.rankingDebug?.bestChunkScore,
			matchingChunks: result.rankingDebug?.matchingChunks,
			lexicalAdjustedScore: result.rankingDebug?.lexicalFeatures?.adjustedScore,
			lexicalMatchTier: result.rankingDebug?.lexicalFeatures?.matchTier,
			identityScore: result.rankingDebug?.lexicalFeatures?.identityScore,
			contentScore: result.rankingDebug?.lexicalFeatures?.contentScore,
			priorityScore: result.rankingDebug?.lexicalFeatures?.priorityScore,
			titleBoost: result.rankingDebug?.lexicalFeatures?.titleBoost,
			aliasBoost: result.rankingDebug?.lexicalFeatures?.aliasBoost,
			tagBoost: result.rankingDebug?.lexicalFeatures?.tagBoost,
			pathBoost: result.rankingDebug?.lexicalFeatures?.pathBoost,
			numericSuffixPenalty: result.rankingDebug?.lexicalFeatures?.numericSuffixPenalty,
			name: result.name,
			path: result.path,
			badges: result.matchBadges?.join(", ") ?? "",
		}));

		console.debug(`[S2B][SearchDebug] ${algorithm} query="${query}" results=${results.length}`, {
			filter: filter ?? null,
			results: summary,
		});
	}

	/**
	 * Detect whether the user is typing a partial filter token at the end of the query.
	 * Returns autocomplete suggestions for tags (#) or folders (path/) when applicable.
	 */
	private getAutocompleteSuggestions(query: string): AutocompleteSuggestion[] | null {
		// Match a partial tag at the end: "#" or "#part"
		const tagMatch = query.match(/(#)([^\s]*)$/u);
		if (tagMatch) {
			const partial = tagMatch[2].toLowerCase();
			return this.getTagSuggestions(partial);
		}

		// Match a partial folder path at the end.
		// Triggers when the trailing token contains "/" (e.g. "src/", "/fo", "my/deep/path")
		// or when it starts with "/" (e.g. "/docs").
		// Excludes URLs (http:// https://).
		const folderMatch = query.match(/(?:^|\s)((?!https?:\/\/)(\/[^\s]*|[^\s]*\/[^\s]*))$/u);
		if (folderMatch) {
			const partial = folderMatch[1].toLowerCase();
			const suggestions = this.getFolderSuggestions(partial);
			// Only enter folder autocomplete if there are matching folders.
			if (suggestions.length > 0) {
				return suggestions;
			}
		}

		return null;
	}

	private getTagSuggestions(partial: string): AutocompleteSuggestion[] {
		return this.cachedAutocompleteTags
			.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
			.filter((tag) => !partial || tag.toLowerCase().slice(1).includes(partial))
			.slice(0, 20)
			.map((tag) => {
				const children = this.cachedTagChildCount.get(tag);
				const label = tag.startsWith("#") ? tag.slice(1) : tag;
				return {
					type: "autocomplete" as const,
					kind: "tag" as const,
					value: tag,
					display: children ? `${label} (${children} subtags)` : label,
				};
			});
	}

	private getFolderSuggestions(partial: string): AutocompleteSuggestion[] {
		// Strip leading/trailing slashes so "/fo" → "fo" matches folder "foobar"
		const needle = partial.replace(/^\/+|\/+$/gu, "");
		return this.cachedAutocompleteFolders
			.filter((folder) => !needle || folder.toLowerCase().includes(needle))
			.slice(0, 20)
			.map((folder) => ({
				type: "autocomplete" as const,
				kind: "folder" as const,
				value: `${folder}/`,
				display: folder,
			}));
	}

	private deferSuggestions(suggestions: SearchSuggestion[]): Promise<SearchSuggestion[]> {
		return new Promise((resolve) => {
			window.setTimeout(() => resolve(suggestions), 0);
		});
	}

	private applyAutocompleteSuggestion(suggestion: AutocompleteSuggestion): void {
		// Add the selected suggestion as an inline filter chip
		const chipType = suggestion.kind === "tag" ? "tag" : "path";
		this.activeFilters.push({ type: chipType, value: suggestion.value });
		this.renderInlineChips();

		// Remove the partial token from the input (the #... or folder/ text)
		let cleanQuery: string;
		if (suggestion.kind === "tag") {
			cleanQuery = this.currentQuery.replace(/(#)[^\s]*$/u, "").trim();
		} else {
			cleanQuery = this.currentQuery.replace(/(?:^|\s)((?!https?:\/\/)(\/[^\s]*|[^\s]*\/[^\s]*))$/u, "").trim();
		}

		this.setSearchQuery(cleanQuery);
	}

	getSuggestions(query: string): SearchSuggestion[] | Promise<SearchSuggestion[]> {
		this.currentQuery = query;

		// One-shot semantic (armed by Tab) reverts to lexical as soon as the
		// query text changes — the semantic results for the armed query stay
		// visible, but the next search the user types runs lexically.
		if (this.semanticOneShotQuery !== null && query !== this.semanticOneShotQuery) {
			this.semanticOneShotQuery = null;
			this.semanticEnabled = false;
			this.updateInstructions();
		}

		// Check for autocomplete mode (typing # or folder/)
		const autocompleteSuggestions = this.getAutocompleteSuggestions(query);
		if (autocompleteSuggestions && autocompleteSuggestions.length > 0) {
			this.lastRequestedSearchKey = "";
			if (this.searchTimeout !== null) {
				window.clearTimeout(this.searchTimeout);
				this.searchTimeout = null;
			}
			return autocompleteSuggestions;
		}

		// A selection only makes sense against the result set it was made in: the
		// rows are the sole indicator, so selections held over from an earlier query
		// would be invisible state the user cannot review. Drop them once the typed
		// query moves on.
		//
		// Keyed on the query TEXT, not on `buildSearchKey` — that folds in the active
		// filters and algorithm, and adding a `#tag` / `/folder` chip (or toggling
		// semantic) must not wipe a selection. Hand-picking notes out of a tag
		// listing is exactly the workflow multi-select is kept for. Placed after the
		// autocomplete return above so mid-token typing (`#ma…`) doesn't clear either.
		if (this.selectionQuery !== null && query !== this.selectionQuery) {
			this.clearSelection();
		}

		if (!query.trim()) {
			if (this.hasPrimedOpenResults) {
				this.hasPrimedOpenResults = false;
				this.lastRequestedSearchKey = "";
				this.resolvePendingSuggestions(this.searchResults);
				return this.searchResults;
			}

			this.searchResults = this.getModalRecentNotes();
			this.lastRequestedSearchKey = "";
			this.lastResolvedSearchKey = "";
			this.resolvePendingSuggestions(this.searchResults);
			return this.searchResults;
		}

		// Deduplicate: only trigger a new search when the key changes
		const searchKey = this.buildSearchKey(query);
		if (searchKey !== this.lastRequestedSearchKey) {
			this.lastRequestedSearchKey = searchKey;
			this.triggerSearch(query);
		}

		if (this.lastResolvedSearchKey !== searchKey) {
			return this.waitForResolvedSuggestions(searchKey);
		}

		return this.deferSuggestions(this.searchResults);
	}

	/**
	 * Render each suggestion item
	 */
	renderSuggestion(item: SearchSuggestion, el: HTMLElement): void {
		if (isAutocomplete(item)) {
			this.renderAutocompleteSuggestion(item, el);
			return;
		}

		// `SuggestModal` renders row-by-row with no "list finished" hook, so the
		// footer is scheduled once per render pass and appended on a microtask,
		// after the last row has landed.
		this.scheduleResultsFooter();

		const result = item;
		el.dataset.searchResultPath = result.path;
		el.toggleClass("s2b-search-result-item-selected", this.selectedResultsByPath.has(result.path));
		const container = el.createDiv({ cls: "s2b-search-result" });
		const highlightTerms = getHighlightTerms(this.currentQuery);
		const searchSettings = getData();
		const showPath = searchSettings.searchShowPath;
		// A phone row has no width to spare: a tag strip is `max-content` wide and
		// squeezes the note name — the one thing the row exists to show — down to
		// nothing. Suppress tags there regardless of the setting, which is desktop-
		// scoped (the settings toggle says so, and is disabled on phones).
		const showTags = searchSettings.searchShowTags && !Platform.isPhone;
		const showMatchBadges = searchSettings.searchShowMatchBadges;
		const showMatchContext = searchSettings.searchShowMatchContext;
		// Feeds `shouldShowMatchExplanation` too: with tags hidden the snippet is no
		// longer redundant with them, so an empty list is the right input there.
		const displayTags = showTags ? getFrontmatterDisplayTags(result.frontmatter) : [];

		// Title row
		const titleRow = container.createDiv({ cls: "s2b-search-result-title" });
		const titleMeta = titleRow.createDiv({ cls: "s2b-search-result-title-meta" });
		const noteIconEl = this.getCachedSearchResultNoteIconElement(result.path);
		if (noteIconEl) {
			titleMeta.appendChild(noteIconEl);
		}
		const titleEl = titleMeta.createSpan({ cls: "s2b-search-result-name" });
		titleEl.setAttribute("title", result.name);
		appendHighlightedText(titleEl, result.name, highlightTerms, "s2b-search-result-highlight-title");

		const pathParts = result.path.split("/");
		const folder = showPath && pathParts.length > 1 ? pathParts.slice(0, -1).join("/") : "";
		if (folder || displayTags.length > 0) {
			const visibleTags = displayTags.slice(0, 3);
			const hiddenTags = displayTags.slice(visibleTags.length);
			const titleSecondary = titleMeta.createDiv({ cls: "s2b-search-result-title-secondary" });

			if (folder) {
				titleSecondary.createSpan({ text: "•", cls: "s2b-search-result-separator" });
				const pathEl = titleSecondary.createSpan({ text: folder, cls: "s2b-search-result-path" });
				pathEl.setAttribute("title", folder);
			}

			if (displayTags.length > 0) {
				const tagsContainer = titleSecondary.createDiv({ cls: "s2b-search-result-tags" });
				for (const tag of visibleTags) {
					tagsContainer.appendChild(this.getCachedTagPillElement(tag));
				}

				if (hiddenTags.length > 0) {
					const overflowTagEl = tagsContainer.createSpan({
						text: `+${hiddenTags.length}`,
						cls: "s2b-search-result-tag s2b-search-result-tag-overflow",
					});
					overflowTagEl.setAttribute("title", hiddenTags.join(", "));
				}
			}
		}

		if (showMatchBadges && result.matchBadges?.length) {
			const badgesRow = titleRow.createDiv({ cls: "s2b-search-result-badges" });
			for (const badge of result.matchBadges) {
				const badgeLabel = getBadgeLabel(badge);
				const badgeEl = badgesRow.createSpan({
					cls: `s2b-search-result-badge s2b-search-result-badge-${badge}`,
				});
				badgeEl.setAttribute("aria-label", badgeLabel);
				badgeEl.setAttribute("title", badgeLabel);
				badgeEl.appendChild(this.getCachedBadgeIconElement(badge));
			}
		}

		if (
			showMatchContext &&
			result.matchExplanation &&
			shouldShowMatchExplanation(result.matchExplanation, displayTags)
		) {
			const explanationRow = container.createDiv({ cls: "s2b-search-result-explanation" });

			if (result.matchExplanation.heading) {
				const headingEl = explanationRow.createDiv({ cls: "s2b-search-result-heading" });
				appendHighlightedText(
					headingEl,
					formatHeadingLabel(result.matchExplanation.heading, result.matchExplanation.headingLevel),
					highlightTerms,
				);

				const snippetText = stripHeadingPrefix(result.matchExplanation.text, result.matchExplanation.heading);
				if (snippetText) {
					const snippetEl = explanationRow.createDiv({ cls: "s2b-search-result-snippet" });
					appendHighlightedText(snippetEl, snippetText, highlightTerms);
				}
			} else {
				const snippetEl = explanationRow.createDiv({ cls: "s2b-search-result-snippet" });
				appendHighlightedText(snippetEl, result.matchExplanation.text, highlightTerms);
			}
		}
	}

	private renderAutocompleteSuggestion(suggestion: AutocompleteSuggestion, el: HTMLElement): void {
		const container = el.createDiv({ cls: "s2b-search-autocomplete" });
		const iconEl = container.createSpan({ cls: "s2b-search-autocomplete-icon" });

		// Use Iconic/Iconize tag icon if available, otherwise fall back to default icons
		if (suggestion.kind === "tag") {
			const tagIcon = getTagIcon(this.app, suggestion.value);
			if (tagIcon) {
				iconEl.classList.add(`s2b-search-autocomplete-icon-${tagIcon.provider}`);
				const resolvedColor = resolveIconColor(tagIcon.color);
				if (resolvedColor) {
					iconEl.style.color = resolvedColor;
				}
				tagIcon.render(iconEl);
			} else {
				setIcon(iconEl, "tag");
			}
		} else {
			const folderIcon = getPathIcon(this.app, suggestion.value.replace(/\/$/, ""), "folder");
			if (folderIcon) {
				iconEl.classList.add(`s2b-search-autocomplete-icon-${folderIcon.provider}`);
				const resolvedColor = resolveIconColor(folderIcon.color);
				if (resolvedColor) {
					iconEl.style.color = resolvedColor;
				}
				folderIcon.render(iconEl);
			} else {
				setIcon(iconEl, "folder");
			}
		}

		container.createSpan({ cls: "s2b-search-autocomplete-text", text: suggestion.display });
		container.createSpan({
			cls: "s2b-search-autocomplete-hint",
			text: suggestion.kind === "tag" ? "Filter by tag" : "Filter by folder",
		});
	}

	/**
	 * Handle selection — open note, or apply autocomplete suggestion
	 */
	onChooseSuggestion(item: SearchSuggestion, evt: MouseEvent | KeyboardEvent): void {
		if (isAutocomplete(item)) {
			this.applyAutocompleteSuggestion(item);
			return;
		}

		if (evt.shiftKey) {
			this.toggleSelection(item);
			return;
		}

		if (this.isPickerMode()) {
			const selectedResults = this.getSelectedResults();
			if (selectedResults.length > 0) {
				this.confirmPickerResults(selectedResults);
				return;
			}

			this.confirmPickerResults([item]);
			return;
		}

		// Open in the current pane (reusing an existing leaf when the note is
		// already open), matching native Obsidian Enter/click behavior.
		this.openSearchResult(item, false);
	}

	/**
	 * Override selectSuggestion to prevent closing the modal on autocomplete selection.
	 */
	selectSuggestion(value: SearchSuggestion, evt: MouseEvent | KeyboardEvent): void {
		if (isAutocomplete(value)) {
			this.applyAutocompleteSuggestion(value);
			return;
		}

		// Shift-click (or shift+enter) toggles selection and keeps the modal open,
		// in every mode. super.selectSuggestion would otherwise close the modal.
		if (evt.shiftKey) {
			this.toggleSelection(value);
			return;
		}

		if (this.isPickerMode() && evt instanceof KeyboardEvent) {
			this.confirmSelection();
			return;
		}

		super.selectSuggestion(value, evt);
	}

	/**
	 * Append the semantic offer beneath a populated result list, once per render.
	 *
	 * Autocomplete passes (typing `#tag` / `folder/`) render their own rows and
	 * must not carry it — the user is mid-token there, not judging results.
	 */
	private scheduleResultsFooter(): void {
		if (!isMobileUI() || this.resultsFooterScheduled) return;
		this.resultsFooterScheduled = true;
		queueMicrotask(() => {
			this.resultsFooterScheduled = false;
			if (this.isClosed) return;
			const container = this.resultContainerEl;
			if (!container) return;
			// Already appended for this pass, or nothing to append under.
			if (container.querySelector(".s2b-search-followup")) return;
			if (!container.querySelector(".suggestion-item")) return;
			if (container.querySelector(".s2b-search-autocomplete")) return;
			this.appendSemanticHint();
		});
	}

	/**
	 * Append a hint encouraging the user to enable semantic search.
	 * Only shown when semantic is off and an embedding index is configured.
	 *
	 * On desktop this stays a keyboard hint. On mobile it is a real tappable
	 * control, and it is the ONLY way in — semantic used to be a toggle in a strip
	 * above the input, which asked the user to predict they'd need it before
	 * seeing a single result. Offering it beneath the results puts it where the
	 * doubt actually forms ("these aren't what I meant"), and matches what the
	 * feature already does: `semanticOneShotQuery` clears the mode as soon as the
	 * query text changes, so it was never the sticky mode a toggle implied.
	 */
	private appendSemanticHint(): void {
		if (this.semanticEnabled) return;
		if (!this.hasSearchEmbeddingIndex()) return;

		if (!isMobileUI()) {
			const tabKey = Platform.isMacOS ? "⇥" : "Tab";
			const hint = this.resultContainerEl.createDiv({ cls: "s2b-search-semantic-hint" });
			hint.setText(`Press ${tabKey} to enhance results with semantic search`);
			return;
		}

		const row = this.resultContainerEl.createDiv({ cls: "s2b-search-followup" });
		row.createSpan({ cls: "s2b-search-followup-label", text: "Not what you meant?" });

		const btn = row.createEl("button", { cls: "s2b-pill s2b-pill--interactive s2b-search-followup-action" });
		btn.type = "button";
		const icon = btn.createSpan({ cls: "s2b-search-mobile-icon" });
		setIcon(icon, "sparkles");
		btn.appendChild(document.createTextNode("Search by meaning"));
		// Pointerdown, not click: the input keeps focus on mobile and a tap that
		// blurs it first can dismiss the sheet before the click lands.
		btn.addEventListener("pointerdown", (evt) => {
			evt.preventDefault();
			this.toggleSemanticMode();
		});
	}

	/**
	 * "Ask the agent" for mobile, rendered in the empty state.
	 *
	 * It used to sit beside the semantic toggle above the input, which read as a
	 * sibling filter — but it is not a filter at all: it closes the modal, opens a
	 * fresh chat, and carries the query plus the active tag/folder filters as
	 * scope. That is worth keeping (redoing it by hand means retyping the query),
	 * but it earns its place at the moment search has failed, not before the user
	 * has searched at all.
	 *
	 * Note it can only ever carry the QUERY on mobile: multi-select is Shift-gated
	 * throughout, so `getSelectedResults()` is always empty on a phone.
	 */
	private appendAskAgentAction(): void {
		if (!isMobileUI() || this.isPickerMode()) return;
		if (!this.currentQuery.trim()) return;

		const row = this.resultContainerEl.createDiv({ cls: "s2b-search-followup" });
		const btn = row.createEl("button", { cls: "s2b-pill s2b-pill--interactive s2b-search-followup-action" });
		btn.type = "button";
		const icon = btn.createSpan({ cls: "s2b-search-mobile-icon" });
		setIcon(icon, "brain");
		btn.appendChild(document.createTextNode("Ask the agent instead"));
		btn.addEventListener("pointerdown", (evt) => {
			evt.preventDefault();
			void this.askAgentWithQuery();
		});
	}

	/**
	 * Empty state message
	 */
	onNoSuggestion(): void {
		this.resultContainerEl.empty();

		const emptyEl = this.resultContainerEl.createDiv({ cls: "s2b-search-empty" });
		if (this.currentQuery.trim() && (this.isSearching || this.searchTimeout !== null)) {
			emptyEl.setText("Searching...");
		} else if (this.currentQuery.trim()) {
			emptyEl.setText("No notes found");
			this.appendSemanticHint();
			this.appendAskAgentAction();
		} else {
			emptyEl.setText("No recent notes yet. Open a note to see it here, or type to search your notes.");
		}
	}
}
