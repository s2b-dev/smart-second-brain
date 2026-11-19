import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SystemPromptModalComponent from "../../src/components/modal/SystemPromptModal.svelte";
import type { SystemPromptAccessors, SystemPromptModal } from "../../src/components/modal/SystemPromptModal";
import type SecondBrainPlugin from "../../src/main";

// The modal is diff-only: editing happens in the vault note, so the only actions are
// Cancel, "Open note", and "Use default".
describe("SystemPromptModal (diff)", () => {
	let component: ReturnType<typeof mount> | undefined;
	let target: HTMLElement;

	afterEach(() => {
		if (component) unmount(component);
		component = undefined;
		target?.remove();
	});

	async function render(accessors: SystemPromptAccessors, readOnly = false) {
		target = document.body.appendChild(document.createElement("div"));
		const modal = { close: vi.fn() } as unknown as SystemPromptModal;
		const openLinkText = vi.fn().mockResolvedValue(undefined);
		const plugin = { app: { workspace: { openLinkText } } } as unknown as SecondBrainPlugin;
		component = mount(SystemPromptModalComponent, {
			target,
			props: { modal, plugin, accessors, description: "desc", readOnly },
		});
		// getPrompt resolves on a microtask after mount.
		await tick();
		await Promise.resolve();
		flushSync();
		return { modal, openLinkText };
	}

	const button = (text: string) =>
		Array.from(target.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);

	it("shows the two panes, and Use default writes the baseline and closes", async () => {
		const setPrompt = vi.fn();
		const { modal } = await render({
			getPrompt: () => "mine",
			defaultPrompt: "shipped",
			setPrompt,
			notePath: "Agents/A/AGENT.md",
		});

		expect(target.querySelectorAll(".prompt-diff-pane")).toHaveLength(2);
		expect(button("Back to editor")).toBeUndefined();
		button("Use default")?.click();
		expect(setPrompt).toHaveBeenCalledWith("shipped");
		expect(modal.close).toHaveBeenCalled();
	});

	it("Open note opens the diffed note and closes without writing", async () => {
		const setPrompt = vi.fn();
		const { modal, openLinkText } = await render({
			getPrompt: () => "mine",
			defaultPrompt: "shipped",
			setPrompt,
			notePath: "Agents/A/AGENT.md",
		});

		button("Open note")?.click();
		expect(openLinkText).toHaveBeenCalledWith("Agents/A/AGENT.md", "", true);
		expect(modal.close).toHaveBeenCalled();
		expect(setPrompt).not.toHaveBeenCalled();
	});

	it("says the note matches when there is nothing to diff, and offers no Use default", async () => {
		await render({ getPrompt: () => "same", defaultPrompt: "same", setPrompt: vi.fn(), notePath: "x.md" });

		expect(target.textContent).toContain("matches the current default");
		expect(target.querySelector(".prompt-diff-pane")).toBeNull();
		expect(button("Use default")).toBeUndefined();
	});

	it("read-only preview shows the prompt with no actions", async () => {
		await render({ getPrompt: () => "assembled" }, true);

		expect(target.querySelector(".system-prompt-preview")?.textContent).toBe("assembled");
		expect(target.querySelectorAll("button")).toHaveLength(0);
	});
});
