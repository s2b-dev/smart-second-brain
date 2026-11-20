import { describe, expect, it } from "vitest";
import {
	RETRIEVAL_TASK_INSTRUCTION,
	documentPrefixLength,
	formatRetrievalDocument,
	formatRetrievalQuery,
	queryInstructionFamilyName,
} from "../../src/vectorstore/queryInstruction";

describe("formatRetrievalQuery", () => {
	const qwenPrefix = `Instruct: ${RETRIEVAL_TASK_INSTRUCTION}\nQuery: `;

	it("wraps queries for Qwen3-Embedding ids as each host spells them", () => {
		// OpenRouter, oMLX and Ollama all spell the same model differently.
		for (const id of ["qwen/qwen3-embedding-4b", "Qwen3-Embedding-4B-4bit-DWQ", "qwen3-embedding:0.6b"]) {
			expect(formatRetrievalQuery(id, "history")).toBe(`${qwenPrefix}history`);
		}
	});

	it("treats harrier and gte-Qwen2 as the Qwen3 instruct family", () => {
		expect(formatRetrievalQuery("harrier-oss-v1-0.6b-MLX-8bit", "history")).toBe(`${qwenPrefix}history`);
		expect(formatRetrievalQuery("Alibaba-NLP/gte-Qwen2-1.5B-instruct", "history")).toBe(`${qwenPrefix}history`);
	});

	it("treats the instruct-tuned e5 models as the Qwen3 instruct family", () => {
		for (const id of [
			"e5-mistral-7b-instruct",
			"intfloat/e5-mistral-7b-instruct",
			"multilingual-e5-large-instruct",
		]) {
			expect(formatRetrievalQuery(id, "history")).toBe(`${qwenPrefix}history`);
		}
	});

	it("uses the BAAI sentence prefix for English BGE retrievers and mxbai", () => {
		const expected = "Represent this sentence for searching relevant passages: history";
		expect(formatRetrievalQuery("bge-large-en-v1.5", "history")).toBe(expected);
		expect(formatRetrievalQuery("BAAI/bge-base-en", "history")).toBe(expected);
		expect(formatRetrievalQuery("mxbai-embed-large", "history")).toBe(expected);
	});

	it("leaves symmetric models untouched", () => {
		for (const id of [
			"text-embedding-3-small",
			"text-embedding-ada-002",
			"bge-m3",
			"all-minilm",
			"nomic-embed-text",
		]) {
			expect(formatRetrievalQuery(id, "history")).toBe("history");
			expect(queryInstructionFamilyName(id)).toBeNull();
		}
	});

	it("preserves the query verbatim inside the prefix", () => {
		const query = "  Zwiebelkuchen mit Sauerteig? ";
		expect(formatRetrievalQuery("qwen3-embedding:0.6b", query)).toBe(`${qwenPrefix}${query}`);
	});

	it("matches the family case-insensitively", () => {
		expect(queryInstructionFamilyName("QWEN3-EMBEDDING-8B")).toBe("qwen3-instruct");
		expect(queryInstructionFamilyName("Harrier-OSS-v1-270m")).toBe("qwen3-instruct");
	});
});

describe("EmbeddingGemma", () => {
	const ids = ["embeddinggemma", "embeddinggemma-2:latest", "google/embeddinggemma-300m", "EmbeddingGemma-2-270m"];

	it("prefixes queries with the card's search-result task", () => {
		for (const id of ids) {
			expect(formatRetrievalQuery(id, "history")).toBe("task: search result | query: history");
			expect(queryInstructionFamilyName(id)).toBe("embeddinggemma");
		}
	});

	it("prefixes documents with an empty title slot", () => {
		for (const id of ids) {
			expect(formatRetrievalDocument(id, "# Ancient Egypt\n\nPyramids")).toBe(
				"title: none | text: # Ancient Egypt\n\nPyramids",
			);
			expect(documentPrefixLength(id)).toBe("title: none | text: ".length);
		}
	});
});

describe("formatRetrievalDocument", () => {
	it("leaves documents raw for query-only and symmetric families", () => {
		for (const id of [
			"qwen3-embedding:0.6b",
			"harrier-oss-v1-0.6b",
			"bge-large-en-v1.5",
			"text-embedding-3-small",
		]) {
			expect(formatRetrievalDocument(id, "body")).toBe("body");
			expect(documentPrefixLength(id)).toBe(0);
		}
	});
});

describe("plain e5", () => {
	it("prefixes queries and passages across hosts' spellings", () => {
		for (const id of [
			"intfloat/e5-large-v2",
			"e5-small",
			"multilingual-e5-large",
			"intfloat/multilingual-e5-base",
			"jeffh/intfloat-multilingual-e5-large:f16",
		]) {
			expect(formatRetrievalQuery(id, "history")).toBe("query: history");
			expect(formatRetrievalDocument(id, "body")).toBe("passage: body");
			expect(queryInstructionFamilyName(id)).toBe("e5");
		}
	});

	it("leaves the instruct e5 models in the Qwen3 family, documents raw", () => {
		for (const id of ["multilingual-e5-large-instruct", "intfloat/e5-mistral-7b-instruct"]) {
			expect(queryInstructionFamilyName(id)).toBe("qwen3-instruct");
			expect(formatRetrievalDocument(id, "body")).toBe("body");
		}
	});

	it("does not match unrelated ids that merely contain e5", () => {
		expect(queryInstructionFamilyName("gte5-large")).toBeNull();
		expect(queryInstructionFamilyName("model-e5x-large")).toBeNull();
	});
});

describe("snowflake-arctic-embed", () => {
	it("uses `query: ` for v2.0 and documents raw", () => {
		for (const id of [
			"snowflake-arctic-embed2",
			"snowflake-arctic-embed2:568m",
			"Snowflake/snowflake-arctic-embed-l-v2.0",
		]) {
			expect(formatRetrievalQuery(id, "history")).toBe("query: history");
			expect(formatRetrievalDocument(id, "body")).toBe("body");
			expect(queryInstructionFamilyName(id)).toBe("arctic-v2");
		}
	});

	it("uses the BGE sentence for v1/v1.5", () => {
		for (const id of [
			"snowflake-arctic-embed",
			"snowflake-arctic-embed:335m",
			"Snowflake/snowflake-arctic-embed-m-v1.5",
		]) {
			expect(formatRetrievalQuery(id, "history")).toBe(
				"Represent this sentence for searching relevant passages: history",
			);
			expect(formatRetrievalDocument(id, "body")).toBe("body");
			expect(queryInstructionFamilyName(id)).toBe("arctic-v1");
		}
	});
});
