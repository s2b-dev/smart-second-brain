import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { Logger } from "../utils/logging";
import { createAsyncLocalStorage, hasAsyncHooksAsyncLocalStorage } from "./asyncLocalStorage";

/**
 * Wires LangChain-core's global AsyncLocalStorage singleton to our
 * `async_hooks`-backed instance (see `asyncLocalStorage.ts` for why it is
 * never Node's own `AsyncLocalStorage` class).
 *
 * Why this is needed:
 * LangGraph threads the active `RunnableConfig` through nested runs via
 * `AsyncLocalStorageProviderSingleton`. Helpers like `getCurrentTaskInput()`,
 * `getStore()`, and `getWriter()` read config from it. deepagents' `task` tool
 * calls `getCurrentTaskInput()` **without** passing config
 * (`node_modules/deepagents/dist/langsmith-DjCMSywL.js`), so it depends entirely
 * on the singleton being backed by a working AsyncLocalStorage.
 *
 * LangChain only initializes that singleton as a side effect of importing
 * `@langchain/core/context`, which our bundle never imports (and the browser
 * build path deliberately does not, since browsers lack `node:async_hooks`).
 * Left uninitialized, the singleton falls back to `MockAsyncLocalStorage`, whose
 * `getStore()` returns `undefined` — so `getCurrentTaskInput()` throws:
 *
 *   "Config not retrievable. This is likely because you are running in an
 *    environment without support for AsyncLocalStorage."
 *
 * This surfaced as a subagent-delegation failure: the parent agent runs fine
 * (its config is passed explicitly), but the `task` tool's ALS-only lookup
 * throws when it tries to build the subagent's state.
 *
 * Obsidian desktop runs in Electron's renderer where `node:async_hooks` IS
 * available. On mobile there is no `node:async_hooks`, so
 * `createAsyncLocalStorage()` returns a synchronous shim that still satisfies
 * the singleton's `getStore()`/`run()` contract for the single-run agent flows
 * the mobile UI drives.
 *
 * `initializeGlobalInstance` is a no-op if some other code already set an
 * instance, so importing this module is idempotent and safe to run first.
 */
export function initLangGraphAsyncContext(): void {
	try {
		// The singleton accepts a duck-typed ALS; our shim matches its run/getStore surface.
		AsyncLocalStorageProviderSingleton.initializeGlobalInstance(createAsyncLocalStorage<unknown>());
		if (!hasAsyncHooksAsyncLocalStorage) {
			Logger.info("langgraphContext: using synchronous AsyncLocalStorage shim (no node:async_hooks)");
		}
	} catch (error) {
		// Never let this crash plugin startup — the worst case without it is the
		// pre-existing "Config not retrievable" error on subagent delegation.
		Logger.warn("langgraphContext: failed to initialize AsyncLocalStorage singleton", error);
	}
}

// Initialize on import so the singleton is wired before any LangChain/LangGraph
// code runs. Imported for side effect at the top of the plugin entrypoint.
initLangGraphAsyncContext();
