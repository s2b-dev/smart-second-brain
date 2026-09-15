import { describe, expect, it } from "vitest";
import { findSealableEnd } from "../../src/utils/streamingMarkdown";

describe("findSealableEnd", () => {
	it("seals nothing while the first paragraph is still streaming", () => {
		expect(findSealableEnd("Hello wor")).toBe(0);
		expect(findSealableEnd("Hello world\n")).toBe(0);
	});

	it("seals a paragraph once the next line is complete", () => {
		const text = "para one\n\npara two\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("para two"));
	});

	it("waits for the line after the blank to be terminated", () => {
		expect(findSealableEnd("para one\n\npara tw")).toBe(0);
		expect(findSealableEnd("para one\n\n-")).toBe(0);
	});

	it("returns the last cut point when several are available", () => {
		const text = "a\n\nb\n\nc\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("c\n"));
	});

	it("does not split a loose list, but seals it once a paragraph follows", () => {
		const text = "- one\n\n- two\n\n3. three\n\nafter\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("after"));
	});

	it("does not split before an indented continuation of a list item", () => {
		const text = "- item\n\n    nested code\n\n  wrapped text\n\npara\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("para"));
	});

	it("does not split before an indented code block", () => {
		const text = "para\n\n    code\n\ntail\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("tail"));
	});

	it("seals a paragraph before a list that starts after it", () => {
		const text = "intro\n\n- item\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("- item"));
	});

	it("keeps consecutive blockquotes together", () => {
		const text = "> a\n\n> b\n\nplain\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("plain"));
	});

	it("ignores blank lines inside a fenced code block", () => {
		const open = "```ts\nconst a = 1;\n\nconst b = 2;\n";
		expect(findSealableEnd(open)).toBe(0);
		expect(findSealableEnd(`${open}more\n`)).toBe(0);
		const closed = `${open}\`\`\`\n\nafter\n`;
		expect(findSealableEnd(closed)).toBe(closed.indexOf("after"));
	});

	it("ignores blank lines inside a tilde fence", () => {
		const text = "~~~\nx\n\ny\n~~~\n\nz\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("z\n"));
	});

	it("ignores blank lines inside a $$ math block", () => {
		const text = "$$\na = b\n\nc = d\n$$\n\nafter\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("after"));
		expect(findSealableEnd("$$\na\n\nb\n")).toBe(0);
	});

	it("treats a single-line $$…$$ as closed", () => {
		const text = "$$x$$\n\nnext\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("next"));
	});

	it("treats whitespace-only lines as blank", () => {
		const text = "a\n  \nb\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("b\n"));
	});

	it("seals leading blank lines with the first paragraph", () => {
		const text = "\n\nfirst\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("first"));
	});

	it("ignores $$ that does not open a block: inline code and mid-line dollars", () => {
		const inline = "use `$$` for display math\n\nnext\n";
		expect(findSealableEnd(inline)).toBe(inline.indexOf("next"));
		const midline = "it costs $$5 total\n\nnext\n";
		expect(findSealableEnd(midline)).toBe(midline.indexOf("next"));
	});

	it("closes a math block on a content line ending with $$", () => {
		const text = "$$\na = b $$\n\nafter\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("after"));
	});

	it("only closes a fence with the same marker at least as long", () => {
		const nested = "````md\n```\ninner\n\nstill code\n````\n\nafter\n";
		expect(findSealableEnd(nested)).toBe(nested.indexOf("after"));
		expect(findSealableEnd("````\n```\n\nstill code\n")).toBe(0);
		expect(findSealableEnd("```\n~~~\n\nstill code\n")).toBe(0);
	});

	it("does not treat a fence line with an info string as closing", () => {
		expect(findSealableEnd("```\n``` js\n\nstill code\n")).toBe(0);
	});

	it("seals right before a fence or math block that opens after a blank line", () => {
		const fence = "para\n\n```ts\nx\n";
		expect(findSealableEnd(fence)).toBe(fence.indexOf("```"));
		const math = "para\n\n$$\nx\n";
		expect(findSealableEnd(math)).toBe(math.indexOf("$$"));
	});

	it("does not treat a backtick run with a backtick in its info string as a fence", () => {
		const text = "```foo`bar\n\nnext\n";
		expect(findSealableEnd(text)).toBe(text.indexOf("next"));
		// Tilde fences may carry anything in the info string.
		expect(findSealableEnd("~~~foo`bar\n\nstill code\n")).toBe(0);
	});
});
