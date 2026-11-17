import SmartGraphViewComponent from "../../components/graph/SmartGraphView.svelte";
import { getSessionRegistry } from "../../stores/chatStore.svelte";
import { SvelteItemView } from "../SvelteItemView";

export const VIEW_TYPE_SMART_GRAPH = "smart-second-brain-graph";

export class SmartGraphView extends SvelteItemView {
	// A main-area tab, like Obsidian's core graph (which also sets this). Left at
	// ItemView's default (false), Obsidian classifies the view as a sidebar
	// utility: its window-level Escape handler then yanks focus to the
	// most-recently-active navigation leaf, so pressing Escape in the graph
	// appeared to open a random note.
	navigation = true;

	getViewType(): string {
		return VIEW_TYPE_SMART_GRAPH;
	}

	getDisplayText(): string {
		return "Smart graph";
	}

	getIcon(): string {
		return "git-fork";
	}

	async onOpen(): Promise<void> {
		this.mountComponent(
			SmartGraphViewComponent,
			{},
			{ containerClass: "s2b-smart-graph-container", testId: "smart-graph-view" },
		);
	}

	async onClose(): Promise<void> {
		const messenger = getSessionRegistry();
		if (messenger) {
			// The graph is gone; drop the ambient selection so chats stop showing its chips.
			messenger.graphSelection = [];
			messenger.pendingGraphNotes = [];
		}
		await super.onClose();
	}
}
