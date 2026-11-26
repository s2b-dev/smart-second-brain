import { Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPromptSafeArea } from "../../src/components/modal/promptLayout";

type Styles = Record<string, string>;

const INSET = 62;

/** A `.prompt` with a filter bar and a results list, plus the styles a theme gave them. */
function buildPrompt(opts: {
	promptTop: number;
	promptHeight?: number;
	resultsPadding: number;
	withBar?: boolean;
	resultsOffsetTop?: number;
	resultsOffsetParentIsPrompt?: boolean;
}) {
	const prompt = document.createElement("div");
	prompt.className = "prompt";
	const bar = document.createElement("div");
	bar.className = "s2b-model-filter-bar";
	const results = document.createElement("div");
	results.className = "prompt-results";
	if (opts.withBar) prompt.appendChild(bar);
	prompt.appendChild(results);
	document.body.appendChild(prompt);

	Object.defineProperty(results, "offsetTop", { configurable: true, value: opts.resultsOffsetTop ?? 0 });
	Object.defineProperty(results, "offsetParent", {
		configurable: true,
		value: opts.resultsOffsetParentIsPrompt === false ? document.body : prompt,
	});

	const styles = new Map<Element, Styles>([
		[
			prompt,
			{
				"--safe-area-inset-top": `${INSET}px`,
				top: `${opts.promptTop}px`,
				height: `${opts.promptHeight ?? 400}px`,
			},
		],
		[results, { paddingTop: `${opts.resultsPadding}px` }],
		[bar, { paddingTop: "8px", minHeight: "52px" }],
	]);
	vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
		const s = styles.get(el) ?? {};
		return {
			...s,
			getPropertyValue: (name: string) => s[name] ?? "",
		} as unknown as CSSStyleDeclaration;
	});

	return { prompt, bar, results };
}

describe("applyPromptSafeArea", () => {
	beforeEach(() => {
		Platform.isPhone = true;
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 874 });
	});

	afterEach(() => {
		Platform.isPhone = false;
		vi.restoreAllMocks();
		document.body.innerHTML = "";
	});

	it("does nothing off a phone", () => {
		Platform.isPhone = false;
		const { prompt } = buildPrompt({ promptTop: 0, resultsPadding: 0 });
		applyPromptSafeArea(prompt);
		expect(prompt.style.top).toBe("");
	});

	it("leaves a prompt that already sits below the inset alone", () => {
		const { prompt, bar, results } = buildPrompt({
			promptTop: 100,
			resultsPadding: 0,
			withBar: true,
			resultsOffsetTop: 52,
		});
		applyPromptSafeArea(prompt, bar);
		expect(prompt.style.top).toBe("");
		expect(bar.style.paddingTop).toBe("");
		expect(results.style.paddingTop).toBe("");
	});

	it("trusts a full-bleed theme whose results already pad past the inset (Cupertino)", () => {
		const { prompt } = buildPrompt({ promptTop: 0, promptHeight: 874, resultsPadding: 78 });
		applyPromptSafeArea(prompt);
		expect(prompt.style.top).toBe("");
		expect(prompt.style.height).toBe("");
	});

	it("shifts a full-bleed prompt whose results do not clear the inset", () => {
		const { prompt } = buildPrompt({ promptTop: 0, promptHeight: 874, resultsPadding: 8 });
		applyPromptSafeArea(prompt);
		expect(prompt.style.getPropertyValue("top")).toBe(`${INSET}px`);
		expect(prompt.style.getPropertyPriority("top")).toBe("important");
		expect(prompt.style.getPropertyValue("height")).toBe(`calc(100vh - ${INSET}px)`);
	});

	it("keeps a content-sized panel's height when shifting it", () => {
		const { prompt } = buildPrompt({ promptTop: 0, promptHeight: 400, resultsPadding: 0 });
		applyPromptSafeArea(prompt);
		expect(prompt.style.getPropertyValue("top")).toBe(`${INSET}px`);
		expect(prompt.style.getPropertyValue("height")).toBe("");
	});

	it("moves the inset onto a top bar and re-anchors the results below it", () => {
		const { prompt, bar, results } = buildPrompt({
			promptTop: 0,
			promptHeight: 874,
			resultsPadding: 78,
			withBar: true,
			resultsOffsetTop: 126,
		});
		// jsdom's CSS parser drops some of these values (`calc()` in `mask-size`),
		// so assert on what was written rather than what it kept.
		const setProperty = vi.spyOn(results.style, "setProperty");
		applyPromptSafeArea(prompt, bar);

		expect(prompt.style.top).toBe("");
		expect(bar.style.paddingTop).toBe(`${INSET + 8}px`);
		expect(bar.style.minHeight).toBe(`${INSET + 52}px`);
		// The theme's 78px of padding is now covered by the bar.
		expect(results.style.paddingTop).toBe("8px");
		for (const prefix of ["", "-webkit-"]) {
			expect(setProperty).toHaveBeenCalledWith(`${prefix}mask-position`, "0 -126px");
			expect(setProperty).toHaveBeenCalledWith(`${prefix}mask-size`, "100% calc(100% + 126px)");
			expect(setProperty).toHaveBeenCalledWith(`${prefix}mask-repeat`, "no-repeat");
		}
	});

	it("keeps whatever theme padding the bar does not cover", () => {
		const { prompt, bar, results } = buildPrompt({
			promptTop: 0,
			resultsPadding: 160,
			withBar: true,
			resultsOffsetTop: 126,
		});
		applyPromptSafeArea(prompt, bar);
		expect(results.style.paddingTop).toBe("34px");
	});

	it("leaves the results alone when their offset is not measured against the prompt", () => {
		const { prompt, bar, results } = buildPrompt({
			promptTop: 0,
			resultsPadding: 78,
			withBar: true,
			resultsOffsetTop: 126,
			resultsOffsetParentIsPrompt: false,
		});
		const setProperty = vi.spyOn(results.style, "setProperty");
		applyPromptSafeArea(prompt, bar);
		expect(bar.style.paddingTop).toBe(`${INSET + 8}px`);
		expect(results.style.paddingTop).toBe("");
		expect(setProperty).not.toHaveBeenCalled();
	});
});
