import { describe, expect, it } from "vitest";
import { formatIndexBuildStatus } from "../../src/vectorstore/VectorStoreService";

describe("formatIndexBuildStatus", () => {
	it("reports an index with notes but no completed build as incomplete, not never built (#466)", () => {
		expect(formatIndexBuildStatus(null, 120)).toBe("Build incomplete");
		expect(formatIndexBuildStatus(undefined, 1)).toBe("Build incomplete");
	});

	it("reports an empty index with no build as never built", () => {
		expect(formatIndexBuildStatus(null, 0)).toBe("Never built");
	});

	it("shows the build date once a run completed", () => {
		const at = Date.UTC(2026, 8, 1, 12);
		expect(formatIndexBuildStatus(at, 0)).toBe(new Date(at).toLocaleDateString());
	});
});
