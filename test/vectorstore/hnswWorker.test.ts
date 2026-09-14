import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The worker is a thin dispatcher over `HNSWVectorStore`; what matters here is
 * the protocol: the analytics operations (#432) are reachable by name with
 * their arguments forwarded intact, vectors cross untouched as Float32Array,
 * and the whole-set `getAll` is gone from the protocol entirely.
 */

const calls: Array<{ method: string; args: unknown[] }> = [];

vi.mock("../../src/vectorstore/HNSWVectorStore", () => {
	class FakeStore {
		constructor(...args: unknown[]) {
			calls.push({ method: "constructor", args });
		}
		providerId = "p";
		modelId = "m";
		async open() {
			calls.push({ method: "open", args: [] });
		}
		async upsert(doc: unknown) {
			calls.push({ method: "upsert", args: [doc] });
		}
		async listNoteMeta() {
			calls.push({ method: "listNoteMeta", args: [] });
			return [{ path: "a.md", mtime: 1 }];
		}
		async semanticPairs(...args: unknown[]) {
			calls.push({ method: "semanticPairs", args });
			return [{ source: 0, target: 1, score: 0.9 }];
		}
		async noteNeighbors(...args: unknown[]) {
			calls.push({ method: "noteNeighbors", args });
			return [{ path: "b.md", score: 0.8 }];
		}
		async search(...args: unknown[]) {
			calls.push({ method: "search", args });
			return [];
		}
	}
	return { HNSWVectorStore: FakeStore };
});

type Handler = (e: { data: { id: number; method: string; args: unknown[] } }) => Promise<void>;

let posted: unknown[];
let handler: Handler;

beforeEach(async () => {
	calls.length = 0;
	posted = [];
	vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
	vi.resetModules();
	await import("../../src/vectorstore/hnswWorker");
	handler = globalThis.onmessage as unknown as Handler;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function send(id: number, method: string, ...args: unknown[]) {
	await handler({ data: { id, method, args } });
	return posted.at(-1) as { id: number; result?: unknown; error?: string };
}

describe("hnswWorker protocol", () => {
	it("initialises the store with the vault and index ids, then serves calls", async () => {
		await send(1, "init", "vault-1", "openai:small");
		expect(calls[0]).toEqual({ method: "constructor", args: ["vault-1", "openai:small"] });

		const response = await send(2, "open");
		expect(response).toEqual({ id: 2, result: undefined });
		expect(await send(3, "getProviderId")).toEqual({ id: 3, result: "p" });
	});

	it("rejects every call before init with a clear error", async () => {
		const response = await send(1, "count");
		expect(response.error).toMatch(/not initialized/i);
	});

	it("passes a Float32Array vector through to upsert without converting it", async () => {
		await send(1, "init", "v");
		const vector = new Float32Array([1, 2, 3]);
		await send(2, "upsert", { id: "a.md#0", path: "a.md", mtime: 1, vector });

		const upsert = calls.find((c) => c.method === "upsert");
		expect((upsert?.args[0] as { vector: unknown }).vector).toBe(vector);
	});

	it("dispatches the analytics operations with their arguments intact", async () => {
		await send(1, "init", "v");

		const pairs = await send(2, "semanticPairs", ["a.md", "b.md"], { threshold: 0.5, excludePairs: ["0:1"] });
		expect(pairs.result).toEqual([{ source: 0, target: 1, score: 0.9 }]);
		expect(calls.find((c) => c.method === "semanticPairs")?.args).toEqual([
			["a.md", "b.md"],
			{ threshold: 0.5, excludePairs: ["0:1"] },
		]);

		const neighbors = await send(3, "noteNeighbors", "a.md", 0.35);
		expect(neighbors.result).toEqual([{ path: "b.md", score: 0.8 }]);
		expect(calls.find((c) => c.method === "noteNeighbors")?.args).toEqual(["a.md", 0.35]);

		const meta = await send(4, "listNoteMeta");
		expect(meta.result).toEqual([{ path: "a.md", mtime: 1 }]);
	});

	it("no longer offers a whole-set getAll", async () => {
		await send(1, "init", "v");
		const response = await send(2, "getAll");
		expect(response.error).toMatch(/unknown method: getAll/i);
	});
});
