/**
 * Open Obsidian's search pane on a tag — what clicking a tag does in a note.
 *
 * Shared by the chat's rendered markdown (tag pills) and the smart graph (tag
 * nodes). The search view's query API is internal and has changed across
 * Obsidian versions, so this tries each known entry point in turn.
 */

import type { App, View } from "obsidian";
import { Notice } from "obsidian";
import { Logger } from "./logging";

// Internal Obsidian types not in public API
interface ObsidianApp {
	commands?: {
		executeCommandById: (id: string) => Promise<void>;
	};
}

interface SearchView extends View {
	_children?: unknown[];
	setQuery?: (query: string) => void;
	searchComponent?: {
		setValue: (value: string) => void;
	};
	searchInputEl?: HTMLInputElement;
	startSearch?: () => void;
}

/**
 * Open the search pane with a `tag:#<tag>` query.
 *
 * @param tag — With or without the leading `#`.
 * @returns whether the query was set on a search pane.
 */
export async function openTagSearch(app: App, tag: string): Promise<boolean> {
	const { workspace } = app;
	// Access the internal commands API (not in public types but available)
	const commands = (app as unknown as ObsidianApp).commands;
	const bareTag = tag.startsWith("#") ? tag.slice(1) : tag;

	try {
		const searchQuery = `tag:#${bareTag}`;

		// Try to find existing search view first
		let searchLeaf = workspace.getLeavesOfType("search").first();
		let searchView = searchLeaf?.view as SearchView | undefined;

		// Check if view exists but isn't fully initialized
		// A deferred/lazy view will have no children and no setQuery method
		const isViewDeferred =
			searchLeaf &&
			searchView &&
			((searchView._children as unknown[])?.length === 0 || typeof searchView.setQuery !== "function");

		if (!searchLeaf || isViewDeferred) {
			// Use Obsidian's native command to properly initialize search
			if (commands?.executeCommandById) {
				await commands.executeCommandById("global-search:open");
				await new Promise((resolve) => window.setTimeout(resolve, 50));
				searchLeaf = workspace.getLeavesOfType("search").first();
				searchView = searchLeaf?.view as SearchView | undefined;
			}

			// Fallback: try to create the view manually
			if (!searchLeaf) {
				const leftLeaf = workspace.getLeftLeaf(false);
				if (leftLeaf) {
					await leftLeaf.setViewState({
						type: "search",
						active: true,
					});
					searchLeaf = leftLeaf;
					searchView = searchLeaf?.view as SearchView | undefined;
				}
			}
		}

		// Ensure we have a valid search leaf
		if (!searchLeaf || !searchView) {
			Logger.warn("[TagSearch] No search leaf available");
			return false;
		}

		// Try different methods to set the search query based on Obsidian version
		if (typeof searchView.setQuery === "function") {
			// Newer Obsidian versions
			searchView.setQuery(searchQuery);
		} else if (typeof searchView.searchComponent?.setValue === "function") {
			// Alternative method
			searchView.searchComponent.setValue(searchQuery);
		} else if (searchView.searchInputEl) {
			// Fallback: set the input value directly
			searchView.searchInputEl.value = searchQuery;
			// Trigger search if possible
			if (typeof searchView.startSearch === "function") {
				searchView.startSearch();
			}
		} else {
			Logger.warn("[TagSearch] Could not find method to set search query");
			new Notice("Search pane opened but could not set tag query");
			return false;
		}

		// Reveal and focus the search pane
		workspace.revealLeaf(searchLeaf);
		workspace.setActiveLeaf(searchLeaf, { focus: true });

		return true;
	} catch (error) {
		Logger.error("[TagSearch] Error opening search pane with tag:", error);
		new Notice(`Failed to open search pane for tag: ${bareTag}`);
		return false;
	}
}
