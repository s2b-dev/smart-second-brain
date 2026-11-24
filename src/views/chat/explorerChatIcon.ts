import { type Plugin, setIcon } from "obsidian";

/** Same icon the chat view's tab uses (`ChatView.getIcon`). */
const CHAT_ICON = "message-square";
const ICON_CLASS = "s2b-explorer-file-icon";
const ROW_SELECTOR = ".nav-file-title[data-path]";

function isChatPath(path: string | null): boolean {
	return !!path && path.toLowerCase().endsWith(".chat");
}

/** Add the chat icon to a file-explorer row for a `.chat` file, or drop it once the row stops being one. */
function decorateRow(row: HTMLElement): void {
	const existing = row.querySelector(`:scope > .${ICON_CLASS}`);
	if (isChatPath(row.getAttribute("data-path"))) {
		if (existing) return;
		const icon = createDiv({ cls: ICON_CLASS });
		setIcon(icon, CHAT_ICON);
		row.prepend(icon);
	} else {
		existing?.remove();
	}
}

function decorateWithin(node: Node): void {
	if (!(node instanceof HTMLElement)) return;
	if (node.matches(ROW_SELECTOR)) decorateRow(node);
	for (const row of Array.from(node.querySelectorAll<HTMLElement>(ROW_SELECTOR))) decorateRow(row);
}

/**
 * Show the chat icon in front of `.chat` files in the file explorer.
 *
 * Obsidian draws no per-file icons there and offers no API for them, and a stylesheet-only
 * rule would have to key on Obsidian's own `.nav-file-title`, which the S2B style-scoping rule
 * forbids. So each explorer's container is watched instead: rows it renders (on load, on
 * create, when its virtualized list scrolls them in) and rows whose `data-path` changes on
 * rename are decorated with an `s2b-` element. Idempotent, so re-attached rows are no-ops.
 */
export function registerExplorerChatIcons(plugin: Plugin): void {
	const observed = new Map<HTMLElement, MutationObserver>();

	const attach = () => {
		for (const leaf of plugin.app.workspace.getLeavesOfType("file-explorer")) {
			const container = leaf.view.containerEl;
			if (observed.has(container)) continue;
			const observer = new MutationObserver((records) => {
				for (const record of records) {
					if (record.type === "attributes") decorateWithin(record.target);
					else for (const node of Array.from(record.addedNodes)) decorateWithin(node);
				}
			});
			observer.observe(container, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["data-path"],
			});
			observed.set(container, observer);
			decorateWithin(container);
		}
		// Forget explorers that were closed.
		for (const [container, observer] of observed) {
			if (!container.isConnected) {
				observer.disconnect();
				observed.delete(container);
			}
		}
	};

	plugin.app.workspace.onLayoutReady(attach);
	plugin.registerEvent(plugin.app.workspace.on("layout-change", attach));
	plugin.register(() => {
		for (const [container, observer] of observed) {
			observer.disconnect();
			for (const icon of Array.from(container.querySelectorAll(`.${ICON_CLASS}`))) icon.remove();
		}
		observed.clear();
	});
}
