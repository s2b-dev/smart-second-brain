import { describe, expect, it } from "vitest";
import { makeChunkId, parseChunkId } from "../../src/vectorstore/types";

describe("parseChunkId", () => {
	it("inverts makeChunkId", () => {
		expect(parseChunkId(makeChunkId("notes/a.md", 0))).toEqual({ path: "notes/a.md", chunkIndex: 0 });
		expect(parseChunkId(makeChunkId("notes/a.md", 12))).toEqual({ path: "notes/a.md", chunkIndex: 12 });
	});

	it("splits on the last '#', so a '#' in the path survives", () => {
		expect(parseChunkId(makeChunkId("C# notes/issue #12.md", 3))).toEqual({
			path: "C# notes/issue #12.md",
			chunkIndex: 3,
		});
	});

	it("treats an id without a numeric chunk suffix as chunk 0 of the whole id", () => {
		expect(parseChunkId("legacy/path.md")).toEqual({ path: "legacy/path.md", chunkIndex: 0 });
		expect(parseChunkId("odd/name#tag.md")).toEqual({ path: "odd/name#tag.md", chunkIndex: 0 });
	});
});
