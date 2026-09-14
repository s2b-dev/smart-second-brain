import { AsyncLocalStorage as NodeAsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import {
	SyncAsyncLocalStorage,
	createAsyncLocalStorage,
	hasAsyncHooksAsyncLocalStorage,
} from "../../src/lib/asyncLocalStorage";

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Regression for #478 / #481: on Node 24 (Electron 40+, Obsidian installer
 * 1.13.x) Node's own `AsyncLocalStorage` keeps its frame in V8's
 * continuation-preserved embedder data, the slot Blink's task-attribution
 * scheduler also writes in a renderer. The first `getStore()` inside an
 * interaction-attributed task then aborts the renderer. The plugin therefore
 * ships its own `async_hooks`-based implementation and must never hand the
 * native class to LangChain.
 */
describe("asyncLocalStorage — desktop implementation", () => {
	it("uses the async_hooks primitives under Node, never Node's AsyncLocalStorage class", () => {
		expect(hasAsyncHooksAsyncLocalStorage).toBe(true);
		const storage = createAsyncLocalStorage<string>();
		expect(storage).not.toBeInstanceOf(NodeAsyncLocalStorage);
	});

	it("scopes a store to run() and restores the outer store afterwards", () => {
		const storage = createAsyncLocalStorage<string>();
		expect(storage.getStore()).toBeUndefined();
		const inner = storage.run("outer", () => {
			const seen = storage.run("inner", () => storage.getStore());
			return [seen, storage.getStore()];
		});
		expect(inner).toEqual(["inner", "outer"]);
		expect(storage.getStore()).toBeUndefined();
	});

	it("propagates the store across awaits, timers and nested runs", async () => {
		const storage = createAsyncLocalStorage<string>();
		const seen: Record<string, string | undefined> = {};
		await storage.run("A", async () => {
			seen.sync = storage.getStore();
			await null;
			seen.afterAwait = storage.getStore();
			await tick(2);
			seen.afterTimer = storage.getStore();
			await storage.run("B", async () => {
				await tick(1);
				seen.nested = storage.getStore();
			});
			seen.afterNested = storage.getStore();
		});
		seen.outside = storage.getStore();
		expect(seen).toEqual({
			sync: "A",
			afterAwait: "A",
			afterTimer: "A",
			nested: "B",
			afterNested: "A",
			outside: undefined,
		});
	});

	it("isolates concurrent runs from each other", async () => {
		const storage = createAsyncLocalStorage<string>();
		const [x, y] = await Promise.all([
			storage.run("X", async () => {
				await tick(6);
				return storage.getStore();
			}),
			storage.run("Y", async () => {
				await tick(1);
				return storage.getStore();
			}),
		]);
		expect([x, y]).toEqual(["X", "Y"]);
	});

	it("keeps instances independent of each other", () => {
		const a = createAsyncLocalStorage<number>();
		const b = createAsyncLocalStorage<number>();
		a.run(1, () => {
			expect(a.getStore()).toBe(1);
			expect(b.getStore()).toBeUndefined();
			b.run(2, () => {
				expect(a.getStore()).toBe(1);
				expect(b.getStore()).toBe(2);
			});
		});
	});

	it("enterWith() makes the store visible to later continuations of the same resource", async () => {
		const storage = createAsyncLocalStorage<string>();
		await storage.run("root", async () => {
			storage.enterWith("entered");
			expect(storage.getStore()).toBe("entered");
			await tick(1);
			expect(storage.getStore()).toBe("entered");
		});
	});
});

describe("asyncLocalStorage — synchronous mobile shim", () => {
	it("scopes run() with a stack and falls back to the entered store", () => {
		const storage = new SyncAsyncLocalStorage<string>();
		expect(storage.getStore()).toBeUndefined();
		storage.enterWith("entered");
		expect(storage.getStore()).toBe("entered");
		const seen = storage.run("outer", () => [storage.run("inner", () => storage.getStore()), storage.getStore()]);
		expect(seen).toEqual(["inner", "outer"]);
		expect(storage.getStore()).toBe("entered");
	});
});
