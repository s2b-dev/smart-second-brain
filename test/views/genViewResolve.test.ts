import { describe, expect, it } from "vitest";
import { findViewFences } from "../../src/genview/viewFences";
import { resolveFence } from "../../src/views/gen-view/GenView";

const fence = (title?: string) =>
	`\`\`\`s2b-view\n${title ? `---\ntitle: ${title}\n---\n` : ""}<p>${title ?? "untitled"}</p>\n\`\`\``;

describe("resolveFence", () => {
	it("follows a titled fence when an earlier fence is inserted or removed", () => {
		const before = findViewFences([fence("A"), fence("B")].join("\n\n"));
		const state = { path: "n.md", index: 1, title: before[1].spec.title };
		const inserted = findViewFences([fence("X"), fence("A"), fence("B")].join("\n\n"));
		expect(resolveFence(inserted, state)?.index).toBe(2);
		const removed = findViewFences([fence("B")].join("\n\n"));
		expect(resolveFence(removed, state)?.index).toBe(0);
	});

	it("falls back to the ordinal for untitled fences", () => {
		const fences = findViewFences([fence(), fence()].join("\n\n"));
		expect(resolveFence(fences, { path: "n.md", index: 1 })?.index).toBe(1);
		// Ordinal still valid and untitled while the stored title matches nothing: accept it.
		const mixed = findViewFences([fence("A"), fence()].join("\n\n"));
		expect(resolveFence(mixed, { path: "n.md", index: 1, title: "B" })?.index).toBe(1);
	});

	it("treats a retitled fence as missing rather than guessing", () => {
		// Indistinguishable from a redirect by title alone; reopening from the note fixes it.
		const retitled = findViewFences([fence("A"), fence("B2")].join("\n\n"));
		expect(resolveFence(retitled, { path: "n.md", index: 1, title: "B" })).toBeNull();
	});

	it("reports a missing target instead of redirecting to another view", () => {
		const fences = findViewFences([fence("A"), fence("C")].join("\n\n"));
		// "B" is gone and ordinal 1 is now a different titled view.
		expect(resolveFence(fences, { path: "n.md", index: 1, title: "B" })).toBeNull();
		expect(resolveFence(fences, { path: "n.md", index: 5 })).toBeNull();
		expect(resolveFence([], { path: "n.md", index: 0 })).toBeNull();
	});
});
