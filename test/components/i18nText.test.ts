import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";

import I18nText from "../../src/components/ui/I18nText.svelte";

const bold = (text: string) => createRawSnippet(() => ({ render: () => `<strong>${text}</strong>` }));

let mounted: Record<string, unknown> | null = null;

function render(props: Record<string, unknown>): HTMLElement {
	const target = document.createElement("div");
	mounted = mount(I18nText, { target, props: props as { message: string } });
	flushSync();
	return target;
}

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = null;
});

describe("I18nText", () => {
	it("renders a snippet where its slot token sits", () => {
		const el = render({ message: "Or {link} for instant access.", link: bold("set a hotkey") });
		expect(el.textContent).toBe("Or set a hotkey for instant access.");
		expect(el.querySelector("strong")?.textContent).toBe("set a hotkey");
	});

	it("adds no whitespace of its own, so CJK text stays unspaced", () => {
		const el = render({ message: "也可以{link}以便随时调用。", link: bold("设置快捷键") });
		expect(el.textContent).toBe("也可以设置快捷键以便随时调用。");
	});

	it("supports several slots in any order", () => {
		const el = render({ message: "{b} then {a}", a: bold("A"), b: bold("B") });
		expect(el.textContent).toBe("B then A");
	});

	it("leaves a token with no matching snippet as text", () => {
		const el = render({ message: "Hello {name}" });
		expect(el.textContent).toBe("Hello {name}");
	});
});
