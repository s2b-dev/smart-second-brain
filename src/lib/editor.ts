import { EditorSelection, EditorState, type Extension, Prec, StateEffect } from "@codemirror/state";
import { EditorView, type ViewUpdate, keymap, placeholder, tooltips } from "@codemirror/view";
import { type App, type Constructor, type Editor, Scope, type TFile } from "obsidian";

/**
 * The CodeMirror 6 view behind an Obsidian `Editor`. `cm` is an internal field
 * absent from the public typings; it is undefined for editors not backed by CM6.
 */
export function getEditorView(editor: Editor | undefined | null): EditorView | undefined {
	if (!editor || !("cm" in editor)) return undefined;
	return editor.cm as EditorView | undefined;
}

// Internal Obsidian type - not exported in official API
interface ScrollableMarkdownEditor {
	app: App;
	containerEl: HTMLElement;
	editor: {
		cm: EditorView;
	};
	editorEl: HTMLElement;
	activeCM: EditorView | null;
	owner: {
		editMode: unknown;
		editor: unknown;
	};
	_loaded: boolean;
	set(value: string): void;
	onUpdate(update: ViewUpdate, changed: boolean): void;
	buildLocalExtensions(): Extension[];
	destroy(): void;
	unload(): void;
}

// Internal Obsidian type - not exported in official API
interface WidgetEditorView {
	editable: boolean;
	editMode: unknown;
	showEditor(): void;
	unload(): void;
}

/**
 * Resolves the internal ScrollableMarkdownEditor prototype from Obsidian.
 *
 * WARNING: Uses internal Obsidian APIs (app.embedRegistry) that are not part of
 * the official plugin API. This may break with future Obsidian updates.
 * Tested with Obsidian 1.5.x - 1.10.x
 *
 * @param app - The Obsidian App instance
 * @returns The ScrollableMarkdownEditor constructor
 * @throws Error if internal APIs are unavailable or changed
 */
function resolveEditorPrototype(app: App): Constructor<ScrollableMarkdownEditor> {
	try {
		// @ts-expect-error - Using internal API
		const embedRegistry = app.embedRegistry?.embedByExtension?.md;
		if (!embedRegistry) {
			throw new Error("Obsidian embedRegistry API not available");
		}

		// The md embed factory takes a TFile; passing no file yields a detached editor.
		const widgetEditorView = embedRegistry(
			{ app, containerEl: createDiv() },
			null as TFile | null,
			"",
		) as WidgetEditorView;

		widgetEditorView.editable = true;
		widgetEditorView.showEditor();

		if (!widgetEditorView.editMode) {
			throw new Error("Editor mode not initialized");
		}

		const MarkdownEditor = Object.getPrototypeOf(Object.getPrototypeOf(widgetEditorView.editMode));
		widgetEditorView.unload();

		return MarkdownEditor.constructor as Constructor<ScrollableMarkdownEditor>;
	} catch (error) {
		throw new Error(
			`Failed to resolve Obsidian editor prototype. This may be due to an incompatible Obsidian version. ${error}`,
		);
	}
}

export interface MarkdownEditorProps {
	/** Whether the editor is editable */
	editable?: boolean;
	/** Initial cursor position */
	cursorLocation?: { anchor: number; head: number };
	/** Initial text content */
	value?: string;
	/** CSS class to add to editor element */
	cls?: string;
	/** Placeholder text when empty */
	placeholder?: string;
	/** Handler for Enter key (return false to use default behavior) */
	onEnter?: (editor: EmbeddableMarkdownEditor, mod: boolean, shift: boolean) => boolean;
	/** Handler for Escape key */
	onEscape?: (editor: EmbeddableMarkdownEditor) => void;
	/** Handler for Tab key (return false to use default behavior) */
	onTab?: (editor: EmbeddableMarkdownEditor) => boolean;
	/** Handler for Ctrl/Cmd+Enter */
	onSubmit?: (editor: EmbeddableMarkdownEditor) => void;
	/** Handler for blur event */
	onBlur?: (editor: EmbeddableMarkdownEditor) => void;
	/** Handler for focus event */
	onFocus?: (editor: EmbeddableMarkdownEditor) => void;
	/** Handler for paste event */
	onPaste?: (e: ClipboardEvent, editor: EmbeddableMarkdownEditor) => void;
	/** Handler for content changes */
	onChange?: (value: string, update: ViewUpdate) => void;
	/** Handler for keyup events (for wiki-link detection) */
	onKeyup?: (editor: EmbeddableMarkdownEditor, event: KeyboardEvent) => void;
	/** Additional CodeMirror extensions (e.g., autocomplete) */
	extensions?: Extension[];
	/** Automatically enter vim insert mode on first focus when vim keybindings are enabled */
	enterVimInsertMode?: boolean;
}

const defaultProperties: Required<MarkdownEditorProps> = {
	editable: true,
	cursorLocation: undefined as unknown as { anchor: number; head: number },
	value: "",
	cls: "",
	placeholder: "",
	onEnter: () => false,
	onEscape: () => {},
	onTab: () => false,
	onSubmit: () => {},
	onBlur: () => {},
	onFocus: () => {},
	onPaste: () => {},
	onChange: () => {},
	onKeyup: () => {},
	extensions: [],
	enterVimInsertMode: false,
};

/**
 * An embeddable markdown editor that provides full CodeMirror editing capabilities
 * within any container element. Based on Fevol's implementation from tasknotes.
 *
 * This wraps Obsidian's internal ScrollableMarkdownEditor to provide:
 * - Full markdown syntax highlighting
 * - Live preview (if enabled)
 * - Wiki-link support ([[]])
 * - Obsidian's native keyboard shortcuts
 *
 * @example
 * ```typescript
 * const editor = new EmbeddableMarkdownEditor(app, containerEl, {
 *   value: "Initial content",
 *   placeholder: "Enter text...",
 *   onChange: (value) => console.log(value),
 *   onSubmit: (editor) => sendMessage(editor.value)
 * });
 *
 * // Later, clean up
 * editor.destroy();
 * ```
 */
export class EmbeddableMarkdownEditor {
	private readonly baseEditor: ScrollableMarkdownEditor;
	private readonly options: Required<MarkdownEditorProps>;
	private readonly scope: Scope;
	private hasEnteredVimInsertMode = false;
	private readonly app: App;
	private readonly containerEl: HTMLElement;

	constructor(app: App, container: HTMLElement, options: Partial<MarkdownEditorProps> = {}) {
		this.app = app;
		this.containerEl = container;
		this.options = { ...defaultProperties, ...options };
		this.scope = new Scope(this.app.scope);

		// Override Mod+Enter to prevent default workspace behavior
		this.scope.register(["Mod"], "Enter", () => true);

		// Resolve and instantiate the base editor
		const EditorClass = resolveEditorPrototype(app);
		// @ts-expect-error - Constructor signature differs from abstract class
		this.baseEditor = new EditorClass(app, container, {
			app,
			onMarkdownScroll: () => {},
			getMode: () => "source",
		});

		this.baseEditor.owner.editMode = this.baseEditor;
		this.baseEditor.owner.editor = this.baseEditor.editor;
		// Add syncScroll stub to prevent errors when scrolling
		// @ts-expect-error - Adding missing method expected by internal editor
		this.baseEditor.owner.syncScroll = () => {};

		// IMPORTANT: From Obsidian 1.5.8+, must explicitly set value
		this.baseEditor.set(options.value || "");

		// Set up blur handler
		this.baseEditor.editor.cm.contentDOM.addEventListener("blur", () => {
			this.app.keymap.popScope(this.scope);
			if (this.baseEditor._loaded) {
				this.options.onBlur(this);
			}
		});

		// Set up focus handler
		this.baseEditor.editor.cm.contentDOM.addEventListener("focusin", () => {
			this.app.keymap.pushScope(this.scope);
			// @ts-expect-error - Using internal API
			this.app.workspace.activeEditor = this.baseEditor.owner;

			this.options.onFocus(this);

			// Enter vim insert mode on first focus if requested and vim mode is enabled
			if (this.options.enterVimInsertMode && !this.hasEnteredVimInsertMode) {
				this.hasEnteredVimInsertMode = true;
				this.enterVimInsertMode();
			}
		});

		// Set up keyup handler for wiki-link detection
		this.baseEditor.editor.cm.contentDOM.addEventListener("keyup", (event) => {
			this.options.onKeyup(this, event);
		});

		// Add custom CSS class if provided
		if (options.cls) {
			this.baseEditor.editorEl.classList.add(options.cls);
		}

		// Set initial cursor position
		if (options.cursorLocation) {
			this.baseEditor.editor.cm.dispatch({
				selection: EditorSelection.range(options.cursorLocation.anchor, options.cursorLocation.head),
			});
		}

		// Set up update handler and add our extensions to the live editor
		this.setupUpdateHandler();
		this.addKeyboardExtensions();

		if (!this.options.editable) {
			this.baseEditor.editor.cm.dispatch({
				effects: StateEffect.appendConfig.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
			});
		}
	}

	/**
	 * Get the current text content of the editor
	 */
	get value(): string {
		return this.baseEditor.editor.cm.state.doc.toString();
	}

	/**
	 * Get the CodeMirror EditorView instance
	 */
	get cm(): EditorView {
		return this.baseEditor.editor.cm;
	}

	/**
	 * Get the cursor position in the editor
	 */
	get cursorPosition(): number {
		return this.baseEditor.editor.cm.state.selection.main.head;
	}

	/**
	 * Set the text content of the editor
	 */
	setValue(value: string): void {
		this.baseEditor.set(value);
	}

	/**
	 * Clear the editor content
	 */
	clear(): void {
		this.setValue("");
	}

	/**
	 * Focus the editor
	 */
	focus(): void {
		this.baseEditor.editor.cm.focus();
	}

	/**
	 * Set cursor position
	 */
	setCursor(pos: number): void {
		this.baseEditor.editor.cm.dispatch({
			selection: EditorSelection.cursor(pos),
		});
	}

	/**
	 * Insert text at the current cursor position
	 */
	insertText(text: string): void {
		const cm = this.baseEditor.editor.cm;
		const pos = cm.state.selection.main.head;
		cm.dispatch({
			changes: { from: pos, insert: text },
			selection: EditorSelection.cursor(pos + text.length),
		});
	}

	/**
	 * Replace text in a range
	 */
	replaceRange(text: string, from: number, to: number): void {
		const cm = this.baseEditor.editor.cm;
		cm.dispatch({
			changes: { from, to, insert: text },
		});
	}

	/**
	 * Enter vim insert mode if vim keybindings are enabled in Obsidian.
	 */
	private enterVimInsertMode(): void {
		window.setTimeout(() => {
			try {
				// Check if vim mode is enabled in Obsidian settings
				// @ts-expect-error - Using internal API
				const vimModeEnabled = this.app.vault.getConfig("vimMode");
				if (!vimModeEnabled) return;

				// Access the Vim API from Obsidian's CodeMirrorAdapter (internal global)
				const Vim = (
					window as {
						CodeMirrorAdapter?: { Vim?: { handleKey(cm: unknown, key: string, origin: string): void } };
					}
				).CodeMirrorAdapter?.Vim;
				if (!Vim) return;

				// Get the CM5 adapter
				// @ts-expect-error - Using internal API
				const cm5 = this.baseEditor.editor?.cm?.cm ?? this.baseEditor.activeCM;
				if (!cm5) return;

				Vim.handleKey(cm5, "i", "api");
			} catch {
				// Silently fail if vim integration isn't available
			}
		}, 50);
	}

	/**
	 * Set up the update handler for content changes
	 */
	private setupUpdateHandler(): void {
		const originalOnUpdate = this.baseEditor.onUpdate.bind(this.baseEditor);
		this.baseEditor.onUpdate = (update: ViewUpdate, changed: boolean) => {
			originalOnUpdate(update, changed);
			if (changed) {
				this.options.onChange(this.value, update);
			}
		};
	}

	/**
	 * Add keyboard extensions to the live CodeMirror instance
	 */
	private addKeyboardExtensions(): void {
		const cm = this.baseEditor.editor.cm;

		// Build all our extensions
		const extensions: Extension[] = [
			// Hide line numbers and gutters for a cleaner look
			EditorView.theme({
				".cm-lineNumbers": { display: "none !important" },
				".cm-gutters": { display: "none !important" },
				".cm-content": { padding: "0" },
				".cm-scroller": { overflow: "auto" },
			}),

			// Ensure tooltips render properly
			tooltips({
				parent: document.body,
			}),

			// Add paste handler
			EditorView.domEventHandlers({
				paste: (event) => {
					this.options.onPaste(event, this);
				},
			}),

			// Add keyboard handlers with highest precedence
			Prec.highest(
				keymap.of([
					{
						key: "Enter",
						run: () => this.options.onEnter(this, false, false),
						shift: () => this.options.onEnter(this, false, true),
					},
					{
						key: "Mod-Enter",
						run: () => {
							this.options.onSubmit(this);
							return true;
						},
					},
					{
						key: "Escape",
						run: () => {
							this.options.onEscape(this);
							return true;
						},
					},
					{
						key: "Tab",
						run: () => this.options.onTab(this),
					},
				]),
			),
		];

		// Add placeholder if specified
		if (this.options.placeholder) {
			extensions.push(placeholder(this.options.placeholder));
		}

		// Add any custom extensions
		if (this.options.extensions && this.options.extensions.length > 0) {
			extensions.push(...this.options.extensions);
		}

		// Add extensions to the live editor using reconfigure
		cm.dispatch({
			effects: StateEffect.appendConfig.of(extensions),
		});
	}

	/**
	 * Clean up the editor and remove all event listeners
	 */
	destroy(): void {
		if (this.baseEditor._loaded) {
			this.baseEditor.unload();
		}

		this.app.keymap.popScope(this.scope);

		this.containerEl.empty();
		this.baseEditor.destroy();
	}
}
