import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinRequireRouterPrelude } from "../../src/lib/builtinRequireRouter";

type BuiltinRouter = (id: string) => Record<string, unknown>;

/**
 * Evaluate the prelude the way Obsidian mobile sees it: `window.require` is
 * either missing or returns `null` for every builtin, and the injected plugin
 * `require` does the same.
 */
function mobileRouter(windowRequire?: (id: string) => unknown): BuiltinRouter {
	const eventsSrc = readFileSync(resolve(__dirname, "../../node_modules/events/events.js"), "utf8");
	const prelude = builtinRequireRouterPrelude(eventsSrc);
	const fakeWindow = { require: windowRequire };
	const injectedRequire = () => null;
	// Shadow `globalThis` too: vitest runs in Node, whose real `require` must not leak in.
	const factory = new Function("window", "globalThis", "require", `${prelude}\nreturn require$builtin;`) as (
		w: unknown,
		g: unknown,
		r: unknown,
	) => BuiltinRouter;
	return factory(fakeWindow, {}, injectedRequire);
}

describe("builtin require router on mobile", () => {
	for (const [label, windowRequire] of [
		["no window.require", undefined],
		["window.require returning null", () => null],
	] as const) {
		describe(label, () => {
			const router = mobileRouter(windowRequire);

			it("hands back a real EventEmitter for events", () => {
				for (const id of ["events", "node:events"]) {
					const { EventEmitter } = router(id) as { EventEmitter: new () => { on: unknown } };
					expect(typeof new EventEmitter().on).toBe("function");
				}
			});

			it("hands back a util whose promisify does not throw at call time", () => {
				for (const id of ["util", "node:util"]) {
					const { promisify } = router(id) as { promisify: (fn: unknown) => unknown };
					expect(typeof promisify(() => {})).toBe("function");
				}
			});

			// #563: langsmith's traceable module runs `new AsyncLocalStorage()` at module
			// top-level; `{}` here made plugin load fail on iOS.
			it("hands back a constructible AsyncLocalStorage for async_hooks", () => {
				for (const id of ["async_hooks", "node:async_hooks"]) {
					const { AsyncLocalStorage } = router(id) as {
						AsyncLocalStorage: new () => {
							run<R>(store: unknown, fn: (...args: unknown[]) => R, ...args: unknown[]): R;
							getStore(): unknown;
							enterWith(store: unknown): void;
							exit<R>(fn: () => R): R;
						};
					};
					const als = new AsyncLocalStorage();
					expect(als.getStore()).toBeUndefined();
					const inner = als.run("outer", () => [als.getStore(), als.run("inner", () => als.getStore())]);
					expect(inner).toEqual(["outer", "inner"]);
					expect(als.run("s", (a, b) => [a, b], 1, 2)).toEqual([1, 2]);
					expect(als.getStore()).toBeUndefined();
					als.enterWith("entered");
					expect(als.getStore()).toBe("entered");
					expect(als.run("scoped", () => als.exit(() => als.getStore()))).toBeUndefined();
					expect(als.getStore()).toBe("entered");
				}
			});

			it("returns an empty object for other builtins", () => {
				expect(router("node:fs")).toEqual({});
			});
		});
	}

	it("prefers a native module when one resolves", () => {
		const nativeAsyncHooks = { AsyncLocalStorage: class {} };
		const router = mobileRouter((id) => (id === "node:async_hooks" ? nativeAsyncHooks : null));
		expect(router("node:async_hooks")).toBe(nativeAsyncHooks);
	});
});
