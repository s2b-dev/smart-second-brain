import type SecondBrainPlugin from "../../main";
import { SvelteModal } from "./SvelteModal";
import SystemPromptModalComponent from "./SystemPromptModal.svelte";

/**
 * Accessors for the prompt modal. It has two modes: a read-only preview, and a two-pane diff of
 * a vault note's body against the version we ship. Editing always happens in the note itself —
 * the diff only shows what moved and offers to replace the body with the default.
 */
export interface SystemPromptAccessors {
	getPrompt: () => string | Promise<string>;
	/** Writes the body back; the diff only ever calls it with `defaultPrompt` ("Use default"). */
	setPrompt?: (prompt: string) => void;
	/**
	 * Baseline the diff compares against and that "Use default" restores to.
	 *
	 * Required whenever `setPrompt` is present, because "Use default" is destructive: this
	 * used to be optional with a `DEFAULT_AGENT_PROMPT` fallback, and `openSkillDiff` silently
	 * relied on it — diffing a skill body against the agent base prompt and offering to
	 * overwrite the skill with it. Making the two fields co-required means a new diff surface
	 * cannot repeat that by omission.
	 */
	defaultPrompt?: string;
	/** Vault path of the note being diffed, so the user can merge changes by hand there. */
	notePath?: string;
}

/** Diff surfaces must name the baseline they compare and reset against. */
export type DiffSystemPromptAccessors = SystemPromptAccessors &
	Required<Pick<SystemPromptAccessors, "setPrompt" | "defaultPrompt" | "notePath">>;

/** Read-only previews have nothing to diff or reset. */
export type ReadOnlySystemPromptAccessors = Pick<SystemPromptAccessors, "getPrompt">;

export class SystemPromptModal extends SvelteModal {
	private plugin: SecondBrainPlugin;
	private accessors: SystemPromptAccessors;
	private readonly titleText: string;
	private readonly descriptionText: string;
	private readonly readOnly: boolean;

	// Overloads pair each accessor shape with its options: a diff modal must supply a
	// `defaultPrompt` (see DiffSystemPromptAccessors), a read-only one must set `readOnly: true`.
	constructor(
		plugin: SecondBrainPlugin,
		accessors: DiffSystemPromptAccessors,
		options?: { title?: string; description?: string; readOnly?: false },
	);
	constructor(
		plugin: SecondBrainPlugin,
		accessors: ReadOnlySystemPromptAccessors,
		options: { title?: string; description?: string; readOnly: true },
	);
	constructor(
		plugin: SecondBrainPlugin,
		accessors: SystemPromptAccessors,
		options?: { title?: string; description?: string; readOnly?: boolean },
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.accessors = accessors;
		this.titleText = options?.title ?? "System Prompt";
		this.descriptionText =
			options?.description ??
			"Your version compared with the current default. Edit the note to merge changes by hand, or replace it with the default.";
		this.readOnly = options?.readOnly ?? false;
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
