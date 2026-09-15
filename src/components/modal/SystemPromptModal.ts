import type SecondBrainPlugin from "../../main";
import { SvelteModal } from "./SvelteModal";
import SystemPromptModalComponent from "./SystemPromptModal.svelte";

/**
 * Custom accessors for agent-specific system prompt editing
 */
export interface SystemPromptAccessors {
	getPrompt: () => string | Promise<string>;
	setPrompt?: (prompt: string) => void;
	viewFinalPrompt?: () => void;
	/**
	 * Baseline the "Diff with default" pane compares against and that "Reset to default" /
	 * "Use default" restore to.
	 *
	 * Required whenever `setPrompt` is present, because both of those are destructive: this
	 * used to be optional with a `DEFAULT_AGENT_PROMPT` fallback, and `openSkillDiff` silently
	 * relied on it — diffing a skill body against the agent base prompt and offering to
	 * overwrite the skill with it. Making the two fields co-required means a new editable
	 * surface cannot repeat that by omission.
	 *
	 * Read-only previews (no `setPrompt`) have nothing to diff or reset, so they omit it.
	 */
	defaultPrompt?: string;
}

/** Editable surfaces must name the baseline they diff and reset against. */
export type EditableSystemPromptAccessors = SystemPromptAccessors &
	Required<Pick<SystemPromptAccessors, "setPrompt" | "defaultPrompt">>;

/** Read-only previews have nothing to save, diff, or reset. */
export type ReadOnlySystemPromptAccessors = Omit<SystemPromptAccessors, "setPrompt" | "defaultPrompt">;

export class SystemPromptModal extends SvelteModal {
	private plugin: SecondBrainPlugin;
	private accessors: SystemPromptAccessors;
	private readonly titleText: string;
	private readonly descriptionText: string;
	private readonly readOnly: boolean;
	private readonly showDiff: boolean;

	// Overloads pair each accessor shape with its options: an editable modal must supply a
	// `defaultPrompt` (see EditableSystemPromptAccessors), a read-only one must set
	// `readOnly: true` and cannot diff.
	constructor(
		plugin: SecondBrainPlugin,
		accessors: EditableSystemPromptAccessors,
		options?: { title?: string; description?: string; readOnly?: false; showDiff?: boolean },
	);
	constructor(
		plugin: SecondBrainPlugin,
		accessors: ReadOnlySystemPromptAccessors,
		options: { title?: string; description?: string; readOnly: true; showDiff?: false },
	);
	constructor(
		plugin: SecondBrainPlugin,
		accessors: SystemPromptAccessors,
		options?: { title?: string; description?: string; readOnly?: boolean; showDiff?: boolean },
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.accessors = accessors;
		this.titleText = options?.title ?? "System Prompt";
		this.descriptionText = options?.description ?? "Customize the system instructions used for every chat.";
		this.readOnly = options?.readOnly ?? false;
		this.showDiff = options?.showDiff ?? false;
		this.setTitle(this.titleText);
	}

	onOpen() {
		this.mountComponent(
			SystemPromptModalComponent,
			{
				modal: this,
				plugin: this.plugin,
				accessors: this.accessors,
				description: this.descriptionText,
				readOnly: this.readOnly,
				showDiff: this.showDiff,
			},
			{
				fullScreenOnPhone: true,
				width: "min(1200px, 94vw)",
				maxWidth: "94vw",
				height: "85vh",
				contentOverflow: "hidden",
			},
		);
	}
}
