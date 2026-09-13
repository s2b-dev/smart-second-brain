/**
 * Cross-platform `AsyncLocalStorage`.
 *
 * On desktop (Electron renderer) this is a small port of Node 22's own
 * `async_hooks`-based `AsyncLocalStorage`: a `createHook` that copies each
 * store from the triggering async resource onto every new one, keyed by a
 * per-instance symbol on the resource. The `async_hooks` module is resolved
 * lazily via Electron's `require` so this module never statically imports
 * `node:async_hooks` — a static import would fail to resolve at module-eval
 * time in Obsidian's mobile WebView and crash plugin load.
 *
 * We deliberately do NOT hand out Node's own `AsyncLocalStorage` class. From
 * Node 24 (Electron 40+; Obsidian installer 1.13.x ships Electron 43) that
 * class is backed by `AsyncContextFrame`, which keeps the current frame in
 * V8's continuation-preserved embedder data slot. In a renderer, Blink's
 * task-attribution scheduler stores its own C++ heap object in that same slot
 * for interaction-attributed tasks (the soft-navigation heuristics: a click on
 * Send qualifies), and Node reads the slot back without a type check. The
 * first `getStore()` inside such a task therefore hands JavaScript a non-JS
 * heap object and V8 aborts the renderer — the "window goes white on the first
 * chat send" crashes in #478 and #481, hit from LangGraph's config lookup.
 * The hooks-based implementation never touches that slot and is exactly what
 * Node 22 ran underneath, so behaviour on older Electron is unchanged.
 *
 * On mobile (no `node:async_hooks`) we fall back to a synchronous shim. It
 * preserves `run(store, fn)` scoping for synchronous and awaited call chains by
 * keeping a stack of active stores. This is sufficient for our usage — the AI
 * transport context and the LangGraph config singleton are read within the
 * synchronous portion of a run — but it does NOT isolate truly concurrent async
 * tasks the way the hooks-based version does. Mobile agent flows are single-run
 * from the UI, so this trade-off is acceptable.
 */

export interface AsyncLocalStorageLike<T> {
	run<R>(store: T, fn: () => R): R;
	getStore(): T | undefined;
	enterWith(store: T): void;
}

/** Synchronous fallback used when `node:async_hooks` is unavailable (mobile). */
export class SyncAsyncLocalStorage<T> implements AsyncLocalStorageLike<T> {
	private stack: T[] = [];
	private entered: T | undefined;

	run<R>(store: T, fn: () => R): R {
		this.stack.push(store);
		try {
			return fn();
		} finally {
			this.stack.pop();
		}
	}

	getStore(): T | undefined {
		if (this.stack.length > 0) return this.stack[this.stack.length - 1];
		return this.entered;
	}

	enterWith(store: T): void {
		this.entered = store;
	}
}

/** The two `async_hooks` primitives the hooks-based implementation needs. */
interface AsyncHooksPrimitives {
	createHook(callbacks: {
		init(asyncId: number, type: string, triggerAsyncId: number, resource: object): void;
	}): { enable(): void; disable(): void };
	executionAsyncResource(): object;
}

/** Async resources carry one slot per storage instance, keyed by its symbol. */
type StoreCarrier = Record<symbol, unknown>;

function asAsyncHooks(candidate: unknown): AsyncHooksPrimitives | null {
	const mod = candidate as Partial<AsyncHooksPrimitives> | null | undefined;
	if (typeof mod?.createHook === "function" && typeof mod.executionAsyncResource === "function") {
		return mod as AsyncHooksPrimitives;
	}
	return null;
}

/** Resolve `node:async_hooks` (`createHook` + `executionAsyncResource`), or null. */
function tryRequireAsyncHooks(): AsyncHooksPrimitives | null {
	// Electron renderer (Obsidian desktop) exposes CommonJS `require`.
	try {
		const req = (globalThis as { require?: (id: string) => unknown }).require;
		if (typeof req === "function") {
			const mod = asAsyncHooks(req("async_hooks"));
			if (mod) return mod;
		}
	} catch {
		// fall through
	}
	// Plain Node (e.g. Vitest) has no global `require` under ESM, but exposes the
	// synchronous builtin accessor `process.getBuiltinModule` (Node 20.16+).
	try {
		const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
		if (typeof proc?.getBuiltinModule === "function") {
			const mod = asAsyncHooks(proc.getBuiltinModule("async_hooks"));
			if (mod) return mod;
		}
	} catch {
		// fall through
	}
	return null;
}

const asyncHooks = tryRequireAsyncHooks();

/** True when the `async_hooks`-backed implementation is in use (desktop). */
export const hasAsyncHooksAsyncLocalStorage = asyncHooks !== null;

/**
 * Every enabled instance, so the single shared hook can propagate all of their
 * stores in one pass. Mirrors Node 22's module-level `storageList`.
 */
const enabledStorages: HooksAsyncLocalStorage<unknown>[] = [];
let propagationHook: { enable(): void; disable(): void } | null = null;

/**
 * Port of Node 22's `lib/internal/async_local_storage/async_hooks.js`, minus
 * `exit`/`disable`/`bind`/`snapshot`, which nothing here uses.
 */
class HooksAsyncLocalStorage<T> implements AsyncLocalStorageLike<T> {
	private readonly key = Symbol("s2b:asyncLocalStorage");
	private enabled = false;

	constructor(private readonly hooks: AsyncHooksPrimitives) {}

	private enable(): void {
		if (this.enabled) return;
		this.enabled = true;
		enabledStorages.push(this as HooksAsyncLocalStorage<unknown>);
		if (!propagationHook) {
			const { executionAsyncResource } = this.hooks;
			propagationHook = this.hooks.createHook({
				init(_asyncId, _type, _triggerAsyncId, resource) {
					// `executionAsyncResource()` is always a non-null object.
					const current = executionAsyncResource() as StoreCarrier;
					const target = resource as StoreCarrier;
					for (const storage of enabledStorages) {
						target[storage.key] = current[storage.key];
					}
				},
			});
			propagationHook.enable();
		}
	}

	run<R>(store: T, fn: () => R): R {
		// Avoid touching the resource if the store is already active.
		if (Object.is(store, this.getStore())) return fn();

		this.enable();
		const resource = this.hooks.executionAsyncResource() as StoreCarrier;
		const previous = resource[this.key];
		resource[this.key] = store;
		try {
			return fn();
		} finally {
			resource[this.key] = previous;
		}
	}

	getStore(): T | undefined {
		if (!this.enabled) return undefined;
		return (this.hooks.executionAsyncResource() as StoreCarrier)[this.key] as T | undefined;
	}

	enterWith(store: T): void {
		this.enable();
		(this.hooks.executionAsyncResource() as StoreCarrier)[this.key] = store;
	}
}

/**
 * Construct an `AsyncLocalStorage`: `async_hooks`-backed on desktop,
 * synchronous shim on mobile. Callers get a consistent
 * `run`/`getStore`/`enterWith` surface.
 */
export function createAsyncLocalStorage<T>(): AsyncLocalStorageLike<T> {
	if (asyncHooks) return new HooksAsyncLocalStorage<T>(asyncHooks);
	return new SyncAsyncLocalStorage<T>();
}
