/**
 * Source of the `require$builtin` helper that `vite.config.ts`'s
 * `routeBuiltinRequiresThroughWindow` prepends to the bundle, and to which it
 * rewrites every emitted `require("<builtin>")`.
 *
 * Build-time only: nothing in the plugin imports this module. It lives here
 * rather than inline in `vite.config.ts` so a unit test can evaluate the helper
 * the way iOS sees it (no Node `require` at all) and assert that every builtin a
 * bundled dependency touches at module-eval time still comes back usable.
 *
 * The helper prefers `window.require`/`globalThis.require` (Electron's real
 * require, which resolves builtins) over the injected plugin `require` (which
 * returns `null` for every builtin), and on mobile, where neither has Node
 * builtins, returns `{}` so module-eval does not throw. A few builtins need more
 * than `{}` because bundled code *uses* them at module top-level, which would
 * otherwise kill plugin load on iOS/Android before any of our code runs:
 *
 * - `events`: graphology does `class Graph extends events.EventEmitter {}`.
 *   `events` MUST be resolved to the polyfill BEFORE trusting a native result:
 *   mobile Obsidian *does* inject a `window.require`, but it returns `null` for
 *   builtins, and `null ?? {}` would still extend `undefined`.
 * - `util`: bundled SDK code does `util.promisify(child_process.execFile)`. The
 *   shim's `promisify` returns a function that rejects when invoked (these are
 *   desktop-only features, never called on mobile), so module-eval survives.
 * - `async_hooks`: langsmith's `traceable` module (pulled in by deepagents)
 *   does `initializeGlobalInstance(new AsyncLocalStorage())` at module top
 *   (#563). The shim is a synchronous store stack, the same semantics as
 *   `SyncAsyncLocalStorage` in `asyncLocalStorage.ts`, so it is a correct
 *   (if non-isolating) storage should it ever win the global slot. In practice
 *   our own `langgraphContext` init claims that slot earlier in the bundle and
 *   langsmith's instance is discarded.
 *
 * @param eventsPolyfillSrc Source of the `events` npm package's `events.js`.
 */
export function builtinRequireRouterPrelude(eventsPolyfillSrc: string): string {
	return [
		"const require$eventsPolyfill=(function(){var module={exports:{}};var exports=module.exports;",
		`(function(module,exports){${eventsPolyfillSrc}\n})(module,exports);`,
		"return module.exports;})();\n",
		"const require$utilShim=(function(){var mkErr=function(){return new Error('Node util not available on this platform');};",
		"return {promisify:function(fn){return function(){return Promise.reject(mkErr());};},",
		"inherits:function(ctor,superCtor){if(superCtor){ctor.super_=superCtor;ctor.prototype=Object.create(superCtor.prototype,{constructor:{value:ctor,enumerable:false,writable:true,configurable:true}});}},",
		"inspect:function(o){try{return String(o);}catch(e){return '';}},",
		"format:function(){return Array.prototype.join.call(arguments,' ');},",
		"deprecate:function(fn){return fn;},types:{},TextEncoder:(typeof TextEncoder!=='undefined'?TextEncoder:undefined),TextDecoder:(typeof TextDecoder!=='undefined'?TextDecoder:undefined)};})();\n",
		"const require$asyncHooksShim=(function(){",
		"class AsyncLocalStorage{constructor(){this._stack=[];this._entered=undefined;}",
		"run(store,fn,...args){this._stack.push(store);try{return fn(...args);}finally{this._stack.pop();}}",
		"getStore(){return this._stack.length>0?this._stack[this._stack.length-1]:this._entered;}",
		"enterWith(store){this._entered=store;}",
		"exit(fn,...args){const saved=this._stack;const entered=this._entered;this._stack=[];this._entered=undefined;try{return fn(...args);}finally{this._stack=saved;this._entered=entered;}}",
		"disable(){this._stack=[];this._entered=undefined;}}",
		"return {AsyncLocalStorage:AsyncLocalStorage};})();\n",
		"const require$builtin=(id)=>{",
		"const tryNative=()=>{try{const r=(typeof window!=='undefined'&&window.require)||(typeof globalThis!=='undefined'&&globalThis.require);if(typeof r==='function'){const m=r(id);if(m)return m;}}catch(e){}try{const m=require(id);if(m)return m;}catch(e){}return null;};",
		"if(id==='events'||id==='node:events'){const n=tryNative();return (n&&n.EventEmitter)?n:require$eventsPolyfill;}",
		"if(id==='util'||id==='node:util'){const n=tryNative();return (n&&typeof n.promisify==='function')?n:require$utilShim;}",
		"if(id==='async_hooks'||id==='node:async_hooks'){const n=tryNative();return (n&&typeof n.AsyncLocalStorage==='function')?n:require$asyncHooksShim;}",
		"return tryNative()??{};};\n",
	].join("");
}
