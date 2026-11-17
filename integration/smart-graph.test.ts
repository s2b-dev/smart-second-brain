import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	clearBuffers,
	domCount,
	domText,
	executeCommand,
	getErrors,
	obsidianEval,
	obsidian,
	waitForSelector,
} from "./helpers/cli.ts";

function expandGraphPanel() {
	obsidianEval(`(() => {
		const button = Array.from(document.querySelectorAll(".graph-toolbar button")).find((el) => {
			const label = el.getAttribute("aria-label") || el.getAttribute("title") || "";
			return label.includes("Show graph panel");
		});
		if (!(button instanceof HTMLElement)) return "already-open";
		button.click();
		return "clicked";
	})()`);
}

describe("graph view UI", () => {
	beforeAll(async () => {
		clearBuffers();
		executeCommand("smart-second-brain:open-smart-graph");
		await waitForSelector(".s2b-smart-graph-container");
		expandGraphPanel();
		await waitForSelector(".graph-controls-title");
	});

	afterAll(() => {
		clearBuffers();
	});

	it("should render the graph container", () => {
		expect(domCount(".s2b-smart-graph-container")).toBeGreaterThanOrEqual(1);
	});

	it("should render a canvas element for the force graph", () => {
		expect(domCount(".s2b-smart-graph-container canvas")).toBeGreaterThanOrEqual(1);
	});

	it("should display graph statistics (nodes and edges)", () => {
		const stats = domText(".graph-controls-subtitle");
		expect(stats).toMatch(/\d+ notes/);
		expect(stats).toContain("Force-directed");
	});

	it("should show the current layout mode", () => {
		const mode = domText(".graph-controls-subtitle");
		expect(mode).toContain("Force-directed");
	});

	it("should render the graph toolbar with action buttons", () => {
		expect(domCount('[aria-label="Fit graph to view (F)"]')).toBe(1);
		expect(domCount('[aria-label="Rebuild graph"]')).toBe(1);
		expect(domCount('[aria-label="Lasso selection (or hold Shift + drag)"]')).toBe(1);
		expect(domCount('[aria-label="Hide graph panel"]')).toBe(1);
	});

	it("should have collapsible Layout section with Positioning dropdown", () => {
		const sections = obsidian(`dev:dom selector='.section-header' all text`, { ignoreError: true });
		expect(sections).toContain("Layout");
	});

	it("should render the Graph Settings panel", () => {
		expect(domText(".graph-controls-title")).toBe("Graph Panel");
	});

	it("should have collapsible sections for Overview, Color by, and Layout", () => {
		const sections = obsidian(`dev:dom selector='.section-header' all text`, { ignoreError: true });
		expect(sections).toContain("Overview");
		expect(sections).toContain("Color by");
		expect(sections).toContain("Layout");
	});

	it("should not produce errors during graph rendering", () => {
		expect(getErrors()).toBe("");
	});
});

describe("graph with vault content", () => {
	beforeAll(async () => {
		clearBuffers();
		// Ensure graph is open
		executeCommand("smart-second-brain:open-smart-graph");
		await waitForSelector(".s2b-smart-graph-container");
		expandGraphPanel();
		await waitForSelector(".graph-controls-title");
	});

	afterAll(() => {
		clearBuffers();
	});

	it("should show a non-zero node count when vault has files", () => {
		const stats = domText(".graph-controls-subtitle");
		const match = stats.match(/(\d+) notes/);
		expect(match).not.toBeNull();
		const nodeCount = Number.parseInt(match![1], 10);
		expect(nodeCount).toBeGreaterThan(0);
	});
});
