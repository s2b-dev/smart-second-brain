import { describe, expect, it } from "vitest";
import {
	RETRIEVAL_TASK_INSTRUCTION,
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
		for (const id of ["text-embedding-3-small", "text-embedding-ada-002", "bge-m3", "nomic-embed-text"]) {
			expect(formatRetrievalQuery(id, "history")).toBe("history");
			expect(queryInstructionFamilyName(id)).toBeNull();
		}
	});

	it("does not touch documents-side families that also need a passage prefix", () => {
		// e5 needs `passage: ` on documents, which the index does not store; adding
		// only `query: ` would be unvalidated, so the model must pass through raw.
		expect(formatRetrievalQuery("multilingual-e5-large", "history")).toBe("history");
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
