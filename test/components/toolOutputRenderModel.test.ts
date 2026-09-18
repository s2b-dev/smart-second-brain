import { describe, expect, it } from "vitest";
import {
	buildToolOutputRenderModel,
	MAX_RENDERED_TOOL_OUTPUT_CHARS,
} from "../../src/components/chat/toolOutputRenderModel";

describe("buildToolOutputRenderModel", () => {
	it.each([MAX_RENDERED_TOOL_OUTPUT_CHARS - 1, MAX_RENDERED_TOOL_OUTPUT_CHARS, MAX_RENDERED_TOOL_OUTPUT_CHARS + 1])(
		"caps string previews at 20k characters plus a truncation notice, length %s",
		(length) => {
			const output = "x".repeat(length);
			const model = buildToolOutputRenderModel("mcp_tool", output);
			const expected =
				length <= MAX_RENDERED_TOOL_OUTPUT_CHARS
					? output
					: `${output.slice(0, MAX_RENDERED_TOOL_OUTPUT_CHARS)}\n\n[UI preview truncated: 1 characters omitted]`;
			expect(model).toEqual({ kind: "markdown", markdown: expected, rawText: expected });
		},
	);

	it.each([
		'Content of "Large.md"',
		'Content of PDF "Large.pdf"',
		'Content of Excalidraw drawing "Large.excalidraw"',
	])("marks large read_content previews as truncated: %s", (header) => {
		const output = { type: "text", text: `${header}:\n\n${"x".repeat(MAX_RENDERED_TOOL_OUTPUT_CHARS * 8)}` };
		const original = output.text;
		const model = buildToolOutputRenderModel("read_content", output);
		expect(model.kind).toBe("read_content");
		if (model.kind !== "read_content") return;
		expect(model.payload.truncated).toBe(true);
		expect(model.payload.content).toContain("[UI preview truncated:");
		expect(model.rawText.length).toBeLessThan(MAX_RENDERED_TOOL_OUTPUT_CHARS + 100);
		expect(output.text).toBe(original);
	});

	it.each(['Content of "Note.md"', 'Content of PDF "Note.pdf"', 'Content of Excalidraw drawing "Note.excalidraw"'])(
		"does not treat literal UI markers as truncation: %s",
		(header) => {
			const content = "Example notice:\n\n[UI preview truncated: 123 characters omitted]";
			const model = buildToolOutputRenderModel("read_content", `${header}:\n\n${content}`);
			expect(model).toMatchObject({ kind: "read_content", payload: { content, truncated: false } });

			const toolTruncated = buildToolOutputRenderModel(
				"read_content",
				`${header}:\n\n[Content truncated at 100 characters]`,
			);
			expect(toolTruncated).toMatchObject({ kind: "read_content", payload: { truncated: true } });
		},
	);

	it("renders search_notes payloads as a specialized model", () => {
		const model = buildToolOutputRenderModel(
			"search_notes",
			JSON.stringify({
				query: "machine learning",
				totalResults: 2,
				returnedResults: 2,
				results: [{ rank: 1, name: "ML Basics", path: "Notes/ML Basics.md", tags: ["#ml"] }],
			}),
		);

		expect(model.kind).toBe("search_notes");
		if (model.kind !== "search_notes") return;
		expect(model.payload.results).toHaveLength(1);
		expect(model.payload.results?.[0]?.name).toBe("ML Basics");
	});

	it("renders list_directory payloads as a specialized model", () => {
		const model = buildToolOutputRenderModel("list_directory", {
			root: "/",
			tree: {
				folders: {
					Projects: {
						files: [{ name: "Welcome.md", extension: "md", size: 12 }],
					},
				},
				files: [{ name: "root.md", extension: "md", size: 4 }],
			},
			totalFolders: 1,
			totalFiles: 2,
		});

		expect(model.kind).toBe("list_directory");
		if (model.kind !== "list_directory") return;
		expect(model.payload.tree?.folders?.Projects?.files?.[0]?.name).toBe("Welcome.md");
		expect(model.payload.tree?.files?.[0]?.name).toBe("root.md");
	});

	it("keeps raw object output compact while preserving pretty structured sections", () => {
		const model = buildToolOutputRenderModel("mcp_tool", {
			status: "ok",
			meta: { total: 2, nested: { value: true } },
		});

		expect(model.rawText).toBe('{"status":"ok","meta":{"total":2,"nested":{"value":true}}}');
		expect(model.kind).toBe("structured");
		if (model.kind !== "structured") return;
		expect(model.sections[0]?.json).toContain("\n");
	});

	it("rejects malformed list_directory trees", () => {
		const model = buildToolOutputRenderModel("list_directory", {
			root: "/",
			tree: {
				folders: {
					Projects: {
						files: [{ name: 42 }],
					},
				},
			},
		});

		expect(model.kind).toBe("structured");
	});

	it("renders manage_notes summaries as a specialized model", () => {
		const model = buildToolOutputRenderModel(
			"manage_notes",
			"Proposed 3 note operation(s) across 2 path(s) (1 create, 2 update) - the user will review and approve or reject these changes.",
		);

		expect(model.kind).toBe("manage_notes");
		if (model.kind !== "manage_notes") return;
		expect(model.summary.operations).toBe(3);
		expect(model.summary.breakdown).toEqual(["1 create", "2 update"]);
	});

	it("renders read_content payloads as a specialized model", () => {
		const model = buildToolOutputRenderModel(
			"read_content",
			'[Analyzed via vision model] Content of PDF "Spec.pdf" (page(s) 2 of 4):\n\n## Heading\n\nBody text',
		);

		expect(model.kind).toBe("read_content");
		if (model.kind !== "read_content") return;
		expect(model.payload.sourceType).toBe("pdf");
		expect(model.payload.target).toBe("Spec.pdf");
		expect(model.payload.analysisLabel).toBe("Analyzed via vision model");
		expect(model.payload.label).toBe("page(s) 2 of 4");
	});

	it("renders execute_javascript outputs as a specialized model", () => {
		const model = buildToolOutputRenderModel(
			"execute_javascript",
			"Execution completed in 12ms.\n\nConsole output:\n- [log] doubled [4,8,12]\n\nReturn value:\n[4,8,12]",
			{ code: "return input.map((value) => value * 2);", input: [2, 4, 6] },
		);

		expect(model.kind).toBe("execute_javascript");
		if (model.kind !== "execute_javascript") return;
		expect(model.payload.state).toBe("success");
		expect(model.payload.durationMs).toBe(12);
		expect(model.payload.logs).toEqual(["[log] doubled [4,8,12]"]);
		expect(model.payload.resultText).toBe("[4,8,12]");
		expect(model.payload.code).toContain("return input.map");
	});

	it("renders execute_javascript failures as a specialized model", () => {
		const model = buildToolOutputRenderModel("execute_javascript", "JavaScript execution failed: boom", {
			code: 'throw new Error("boom");',
		});

		expect(model.kind).toBe("execute_javascript");
		if (model.kind !== "execute_javascript") return;
		expect(model.payload.state).toBe("error");
		expect(model.payload.errorMessage).toBe("boom");
	});

	it("renders arrays of plain objects as tables", () => {
		const model = buildToolOutputRenderModel("mcp_tool", [
			{ name: "one", status: "ok" },
			{ name: "two", status: "done" },
		]);

		expect(model.kind).toBe("table");
		if (model.kind !== "table") return;
		expect(model.columns).toEqual(["name", "status"]);
		expect(model.rows[0]?.name).toBe("one");
	});

	it("renders shallow objects as key value blocks", () => {
		const model = buildToolOutputRenderModel("mcp_tool", { count: 3, ok: true, message: "done" });

		expect(model.kind).toBe("keyValue");
		if (model.kind !== "keyValue") return;
		expect(model.entries).toEqual([
			{ key: "count", value: "3" },
			{ key: "ok", value: "true" },
			{ key: "message", value: "done" },
		]);
	});

	it("renders nested objects as structured blocks", () => {
		const model = buildToolOutputRenderModel("mcp_tool", {
			status: "ok",
			meta: { total: 2 },
			items: [{ id: 1 }],
		});

		expect(model.kind).toBe("structured");
		if (model.kind !== "structured") return;
		expect(model.summaryEntries).toEqual([{ key: "status", value: "ok" }]);
		expect(model.sections.map((section) => section.key)).toEqual(["meta", "items"]);
	});

	it("preserves the full payload for a heterogeneous array (rendered when no sections exist)", () => {
		// A non-scalar, non-tabular array reduces to an item count with no nested
		// sections; the complete payload must still live in `json` so the UI can
		// render it as the friendly result (issue: it must not be lost behind the
		// developer-only raw-I/O toggle).
		const model = buildToolOutputRenderModel("mcp_tool", [{ a: 1 }, "text", 42]);

		expect(model.kind).toBe("structured");
		if (model.kind !== "structured") return;
		expect(model.sections).toEqual([]);
		expect(model.summaryEntries).toEqual([{ key: "items", value: "3" }]);
		// The full contents survive in `json` (not just the count).
		expect(model.json).toContain('"a": 1');
		expect(model.json).toContain("text");
		expect(model.json).toContain("42");
	});

	it("unwraps langchain content blocks", () => {
		const model = buildToolOutputRenderModel("mcp_tool", [{ type: "json", data: { count: 2 } }]);

		expect(model.kind).toBe("keyValue");
		if (model.kind !== "keyValue") return;
		expect(model.entries).toEqual([{ key: "count", value: "2" }]);
	});

	it("unwraps streamed tool wrapper content into specialized models", () => {
		const model = buildToolOutputRenderModel("search_notes", {
			lc_serializable: true,
			name: "search_notes",
			content: JSON.stringify({
				query: "home",
				totalResults: 14,
				returnedResults: 10,
				results: [{ rank: 1, name: "Home", path: "Public/Home.md" }],
			}),
		});

		expect(model.kind).toBe("search_notes");
		if (model.kind !== "search_notes") return;
		expect(model.payload.query).toBe("home");
		expect(model.payload.results?.[0]?.path).toBe("Public/Home.md");
	});
});
