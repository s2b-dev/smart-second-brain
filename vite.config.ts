// vite.config.ts
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { compressedAssets } from "./src/bundling/compressedAssets";
import { builtinRequireRouterPrelude } from "./src/lib/builtinRequireRouter";
import { defineConfig, type Plugin } from "vite";
import { copyFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { builtinModules } from "node:module";

// Anchor all file paths to this config file's directory, NOT process.cwd():
// builds must work identically from the main checkout and from any git
// worktree (parallel agent slots), regardless of the caller's CWD.
const configDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Route bundled Node-builtin requires through Obsidian's working `require`.
 *
 * Obsidian injects a CJS `require` into plugin bundles that returns `null` for
 * every Node builtin (`fs`, `process`, `child_process`, `node:*`) — only
 * `obsidian`/`electron`/CodeMirror resolve. The renderer's `window.require`,
 * however, resolves builtins fine (it's Electron's real require). Bundled
 * dependencies (e.g. the MCP SDK) call the injected `require("node:process")`
 * at module top and then read `.platform` on the null result, which crashes the
 * whole plugin at load — on desktop AND mobile.
 *
 * This output transform rewrites every emitted `require("<builtin>")` to
 * `require$builtin("<builtin>")`, backed by a prelude that prefers
 * `window.require`/`globalThis.require` (both work) and falls back to the
 * injected `require`. On mobile, where no Node require exists at all, the helper
 * returns an empty object so module-eval doesn't throw; code that actually needs
 * a builtin still guards/degrades (Node features are desktop-only). The few
 * builtins that bundled deps *use* at module top-level (`events`, `util`,
 * `async_hooks`) get working shims instead; the helper's source and the reasons
 * live in `src/lib/builtinRequireRouter.ts`, where a unit test evaluates it.
 */
const EVENTS_POLYFILL_SRC = readFileSync(resolve(configDir, "node_modules/events/events.js"), "utf8");

function routeBuiltinRequiresThroughWindow() {
	const builtinSet = new Set<string>();
	for (const m of builtinModules) {
		const bare = m.replace(/^node:/, "");
		builtinSet.add(bare);
		builtinSet.add(`node:${bare}`);
	}
	const prelude = builtinRequireRouterPrelude(EVENTS_POLYFILL_SRC);
	return {
		name: "route-builtin-requires-through-window",
		renderChunk(code: string) {
			let changed = false;
			const rewritten = code.replace(/\brequire\((["'])([^"']+)\1\)/g, (match, quote, id) => {
				if (builtinSet.has(id)) {
					changed = true;
					return `require$builtin(${quote}${id}${quote})`;
				}
				return match;
			});
			if (!changed) return null;
			return { code: prelude + rewritten, map: null };
		},
	};
}

/**
 * Some bundled deps read the Node `process` global at module-eval time
 * (`process.env`, `process.platform`, `process.version`, `process.cwd()`, …).
 * Electron's renderer (desktop, and the desktop mobile-emulator) provides it,
 * but iOS/Android WebKit has no `process` at all — the bare reference throws
 * `ReferenceError: Can't find variable: process` and crashes plugin load.
 *
 * Injected as the output `banner` so it runs before any bundled code, after
 * minification (a renderChunk-prepended shim gets dropped by the later minify
 * pass). Installs a minimal shim ONLY when `process` is absent, so the real Node
 * `process` on desktop is left untouched. `nextTick` falls back to a microtask.
 */
const PROCESS_SHIM =
	"(function(){try{if(typeof process!=='undefined'&&process)return;}catch(e){}" +
	"var noop=function(){};var g=(typeof globalThis!=='undefined')?globalThis:(typeof self!=='undefined'?self:this);" +
	"g.process={env:{},argv:[],platform:'',arch:'',version:'',versions:{},browser:true," +
	"cwd:function(){return '/';},nextTick:function(f){var a=Array.prototype.slice.call(arguments,1);Promise.resolve().then(function(){f.apply(null,a);});}," +
	"on:noop,off:noop,once:noop,emit:noop,addListener:noop,removeListener:noop," +
	"stdout:{write:noop,isTTY:false},stderr:{write:noop,isTTY:false}};})();";

const BANNER = PROCESS_SHIM;

/**
 * Dependency modules swapped for shims in `src/lib/shims/`, matched on the
 * RESOLVED file path (so a relative `./skills.mjs` inside one package cannot be
 * confused with another's). Together these keep two capabilities out of the
 * bundle that the plugin never uses but Obsidian's plugin review flags:
 *
 * - process spawning (`child_process`): the MCP SDK's stdio transport. (The
 *   Anthropic SDK's local agent toolset used to need a shim too; since
 *   @anthropic-ai/sdk 0.120 the package maps it to a browser stub itself, and
 *   the forbidden-pattern scan below is what keeps that honest.)
 * - dynamic code execution (`new Function`): the MCP SDK's ajv validator
 *   (replaced by the SDK's own cfworker provider) and Pixi's code generators
 *   (replaced at runtime by `pixi.js/unsafe-eval`, imported in pixiRenderer.ts).
 *
 * Each shim's header says what it replaces and why.
 */
const MODULE_SHIMS: Array<[pattern: RegExp, shim: string]> = [
	[/\/@modelcontextprotocol\/sdk\/dist\/esm\/client\/stdio\.js$/, "src/lib/shims/mcpStdioTransport.ts"],
	[/\/@modelcontextprotocol\/sdk\/dist\/esm\/validation\/ajv-provider\.js$/, "src/lib/shims/mcpJsonSchemaValidator.ts"],
	[
		/\/pixi\.js\/lib\/.*\/(unsafeEvalSupported|createUboSyncFunction|compileBufferSync|GenerateShaderSyncCode|generateUniformsSync|generateParticleUpdateFunction)\.mjs$/,
		"src/lib/shims/pixiNoEval.ts",
	],
];

/**
 * Patterns that must not survive into the production bundle. Checked after
 * minification, so comments (which mention these names freely) are gone and
 * only live code and string literals remain. A hit fails the build — that is
 * the point: a dependency moving a file out from under {@link MODULE_SHIMS}
 * must surface as a red build, not as a quietly restored capability.
 */
const FORBIDDEN_BUNDLE_PATTERNS: Array<[label: string, pattern: RegExp]> = [
	["child_process", /child_process/],
	["spawn()", /\.spawn\(/],
	["execFile", /execFile/],
	["new Function()", /new Function\(/],
	["eval()", /[^\w.$]eval\(/],
];

function shimModules(isProduction: boolean): Plugin {
	const applied = new Set<number>();
	return {
		name: "shim-modules",
		enforce: "pre",
		async resolveId(source, importer, options) {
			const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
			if (!resolved) return null;
			for (const [index, [pattern, shim]] of MODULE_SHIMS.entries()) {
				if (pattern.test(resolved.id)) {
					applied.add(index);
					return resolve(configDir, shim);
				}
			}
			return null;
		},
		generateBundle(_options, bundle) {
			const missing = MODULE_SHIMS.filter((_, index) => !applied.has(index)).map(([pattern]) => String(pattern));
			if (missing.length > 0) {
				throw new Error(
					`shim-modules: no dependency module matched ${missing.join(", ")} — did a package move the file? ` +
						"Update MODULE_SHIMS in vite.config.ts.",
				);
			}
			if (!isProduction) return;
			for (const output of Object.values(bundle)) {
				if (output.type !== "chunk") continue;
				for (const [label, pattern] of FORBIDDEN_BUNDLE_PATTERNS) {
					const match = pattern.exec(output.code);
					if (!match) continue;
					const at = Math.max(0, match.index - 80);
					throw new Error(
						`shim-modules: production bundle ${output.fileName} still contains ${label} near: ` +
							`…${output.code.slice(at, match.index + 80)}…`,
					);
				}
			}
		},
		transform(code, id) {
			// @langchain/mcp-adapters keeps the stdio option schema (never reachable
			// here) and its description names `child_process.spawn` — a literal that
			// reads as shell access to a bundle scan. Reword the doc string only.
			// Matched on the module token alone — the surrounding prose (and its
			// apostrophe) has already changed once between adapter versions.
			if (!id.endsWith("/@langchain/mcp-adapters/dist/types.js")) return null;
			const reworded = code.replaceAll("`child_process.spawn`", "process spawning").replaceAll("child_process", "child process");
			return reworded === code ? null : { code: reworded, map: null };
		},
	};
}

const setOutDir = (mode: string) => {
	switch (mode) {
		case "development":
			return resolve(configDir, "build/smart-second-brain");
		case "production":
			return resolve(configDir, "build/prod");
		default:
			console.warn(`Unexpected mode: "${mode}". Defaulting to development output directory.`);
			return resolve(configDir, "build/smart-second-brain");
	}
};

export default defineConfig(({ mode }) => {
	const isDevelopment = mode === "development";

	return {
		plugins: [
			shimModules(!isDevelopment),
			compressedAssets({ localesDir: resolve(configDir, "src/i18n/locales") }),
			svelte({
				preprocess: vitePreprocess(),
				onwarn: (warning, handler) => {
					if (warning.code && warning.code.startsWith("a11y")) return;
					handler(warning);
				},
			}),
			{
				name: "copy-manifest",
				closeBundle() {
					const outDir = setOutDir(mode);
					copyFileSync(resolve(configDir, "manifest.json"), resolve(outDir, "manifest.json"));
				},
			},
		],
		define: {
			"import.meta.env.DEV": isDevelopment,
			"import.meta.env.PROD": !isDevelopment,
			"import.meta.env.MODE": JSON.stringify(mode),
		},
		build: {
			lib: {
				entry: "src/main.ts",
				formats: ["cjs"],
				fileName: () => "main.js",
			},
			rollupOptions: {
				plugins: [routeBuiltinRequiresThroughWindow()],
				output: {
					entryFileNames: "main.js",
					assetFileNames: "styles.css",
					sourcemapBaseUrl: pathToFileURL(`${setOutDir(mode)}/`).toString(),
					manualChunks: undefined,
					inlineDynamicImports: true,
						// Runs before all bundled code (survives minification): the
						// `process` shim for mobile WebKit, which has no such global.
						banner: BANNER,
				},
				external: [
					"obsidian",
					"electron",
					"@codemirror/autocomplete",
					"@codemirror/collab",
					"@codemirror/commands",
					"@codemirror/language",
					"@codemirror/lint",
					"@codemirror/search",
					"@codemirror/state",
					"@codemirror/view",
					"@lezer/common",
					"@lezer/highlight",
					"@lezer/lr",
					"@sap-ai-sdk/langchain", // Optional dependency for SAP AI Core provider
					...builtinModules,
					...builtinModules.map((m) => `node:${m}`),
				],
			},
			outDir: setOutDir(mode),
			emptyOutDir: mode === "production",
			sourcemap: isDevelopment,
		},
		css: {
			devSourcemap: isDevelopment,
		},
	};
});
