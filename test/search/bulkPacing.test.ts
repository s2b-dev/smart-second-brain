import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import {
	BulkAttemptMarker,
	MOBILE_BULK_BASE_DELAY_MS,
	MOBILE_BULK_MAX_DELAY_MS,
	bulkBatchPauseMs,
	bulkCheckpointPauseMs,
	bulkStartDelayMs,
	orderForBulkIndexing,
	resetBulkRunQueue,
	type VaultLocalStorage,
	scheduleBulkRun,
} from "../../src/search/bulkPacing";

/*
 * The pacing and crash-backoff shared by the lexical and embedding bulk
 * indexers (#430, #432). The values encode on-device measurements; these tests
 * pin the *shape* — mobile-only pauses, delay doubling per crashed attempt with
 * a cap, marker set on start and cleared on completion — so a refactor cannot
 * silently drop the backoff.
 */

/** In-memory stand-in for Obsidian's vault-scoped `App.loadLocalStorage` / `saveLocalStorage`. */
function memoryStorage(): VaultLocalStorage & { raw: Map<string, unknown> } {
	const raw = new Map<string, unknown>();
	return {
		raw,
		loadLocalStorage: (key: string) => raw.get(key) ?? null,
		saveLocalStorage: (key: string, data: unknown | null) => {
			if (data === null) raw.delete(key);
			else raw.set(key, data);
		},
	};
}

const platform = Platform as { isMobile: boolean };
let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
	storage = memoryStorage();
	resetBulkRunQueue();
});

afterEach(() => {
	platform.isMobile = false;
	vi.useRealTimers();
});

describe("pauses", () => {
	it("are real on mobile and bare yields on desktop", () => {
		platform.isMobile = false;
		expect(bulkBatchPauseMs()).toBe(0);
		expect(bulkCheckpointPauseMs()).toBe(0);
		platform.isMobile = true;
		expect(bulkBatchPauseMs()).toBeGreaterThan(0);
		expect(bulkCheckpointPauseMs()).toBeGreaterThan(bulkBatchPauseMs());
	});
});

describe("bulkStartDelayMs", () => {
	it("never delays on desktop, whatever the crash history", () => {
		platform.isMobile = false;
		expect(bulkStartDelayMs(0)).toBe(0);
		expect(bulkStartDelayMs(5)).toBe(0);
	});

	it("doubles the mobile base delay per crashed attempt, capped", () => {
		platform.isMobile = true;
		expect(bulkStartDelayMs(0)).toBe(MOBILE_BULK_BASE_DELAY_MS);
		expect(bulkStartDelayMs(1)).toBe(MOBILE_BULK_BASE_DELAY_MS * 2);
		expect(bulkStartDelayMs(2)).toBe(MOBILE_BULK_BASE_DELAY_MS * 4);
		expect(bulkStartDelayMs(20)).toBe(MOBILE_BULK_MAX_DELAY_MS);
	});
});

describe("BulkAttemptMarker", () => {
	it("keys per indexer, counts attempts, and clears on completion", () => {
		const marker = new BulkAttemptMarker("embedding", storage);
		expect(marker.read()).toBe(0);
		marker.markAttempt();
		expect(storage.raw.get("s2b-embedding-bulk-attempts")).toBe("1");
		marker.markAttempt();
		expect(marker.read()).toBe(2);
		// A different indexer on the same vault backs off independently.
		expect(new BulkAttemptMarker("lexical", storage).read()).toBe(0);
		marker.clear();
		expect(marker.read()).toBe(0);
		expect(storage.raw.has("s2b-embedding-bulk-attempts")).toBe(false);
	});

	it("treats garbage as no crashed attempts", () => {
		storage.saveLocalStorage("s2b-embedding-bulk-attempts", "nope");
		expect(new BulkAttemptMarker("embedding", storage).read()).toBe(0);
	});
});

describe("scheduleBulkRun", () => {
	it("waits the backed-off delay on mobile before starting the work", async () => {
		vi.useFakeTimers();
		platform.isMobile = true;
		const marker = new BulkAttemptMarker("embedding", storage);
		marker.markAttempt();
		marker.markAttempt(); // two crashed attempts → 4× base delay

		const work = vi.fn(async () => {});
		scheduleBulkRun("Test", marker, work);

		await vi.advanceTimersByTimeAsync(MOBILE_BULK_BASE_DELAY_MS * 4 - 1);
		expect(work).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(work).toHaveBeenCalledTimes(1);
	});

	it("starts at once on desktop", async () => {
		vi.useFakeTimers();
		platform.isMobile = false;
		const marker = new BulkAttemptMarker("embedding", storage);
		marker.markAttempt();
		const work = vi.fn(async () => {});
		scheduleBulkRun("Test", marker, work);
		await vi.advanceTimersByTimeAsync(0);
		expect(work).toHaveBeenCalledTimes(1);
	});

	it("runs scheduled work one after another, and a failing run does not block the next", async () => {
		vi.useFakeTimers();
		platform.isMobile = false;
		const marker = new BulkAttemptMarker("embedding", storage);
		const order: string[] = [];
		let releaseFirst: (() => void) | null = null;
		// Both indexers schedule on the same tick, as they do at layout-ready.
		scheduleBulkRun(
			"Lexical",
			marker,
			() =>
				new Promise<void>((resolve) => {
					order.push("lexical:start");
					releaseFirst = () => {
						order.push("lexical:end");
						resolve();
					};
				}),
		);
		scheduleBulkRun("Embedding", marker, async () => {
			order.push("embedding");
		});
		// Each run yields through a timer before starting, hence the small advances.
		await vi.advanceTimersByTimeAsync(10);
		expect(order).toEqual(["lexical:start"]);
		if (!releaseFirst) throw new Error("first run never started");
		(releaseFirst as () => void)();
		await vi.advanceTimersByTimeAsync(10);
		expect(order).toEqual(["lexical:start", "lexical:end", "embedding"]);

		scheduleBulkRun("Broken", marker, async () => {
			throw new Error("boom");
		});
		scheduleBulkRun("Next", marker, async () => {
			order.push("next");
		});
		await vi.advanceTimersByTimeAsync(10);
		expect(order.at(-1)).toBe("next");
	});

	it("keeps scheduling order when a later run has the shorter backoff", async () => {
		vi.useFakeTimers();
		platform.isMobile = true;
		const lexical = new BulkAttemptMarker("lexical", storage);
		lexical.markAttempt(); // crashed once: 2× the base delay
		const embedding = new BulkAttemptMarker("embedding", storage); // clean: 1×
		const order: string[] = [];
		scheduleBulkRun("Lexical", lexical, async () => {
			order.push("lexical");
		});
		scheduleBulkRun("Embedding", embedding, async () => {
			order.push("embedding");
		});

		// The embedding run's own delay has elapsed, but it is behind the lexical run.
		await vi.advanceTimersByTimeAsync(MOBILE_BULK_BASE_DELAY_MS + 10);
		expect(order).toEqual([]);
		await vi.advanceTimersByTimeAsync(MOBILE_BULK_BASE_DELAY_MS);
		expect(order).toEqual(["lexical", "embedding"]);
	});
});

describe("orderForBulkIndexing", () => {
	it("moves binary-extraction files (PDFs) after text files, keeping relative order", () => {
		const file = (path: string, extension: string) => ({ path, extension }) as never;
		const ordered = orderForBulkIndexing([
			file("a.pdf", "pdf"),
			file("b.md", "md"),
			file("c.pdf", "pdf"),
			file("d.md", "md"),
		]);
		expect(ordered.map((f: { path: string }) => f.path)).toEqual(["b.md", "d.md", "a.pdf", "c.pdf"]);
	});
});
