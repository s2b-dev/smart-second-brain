import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
import { compressedAssets } from "./src/bundling/compressedAssets";

export default defineConfig({
	// The same compressed-asset plugin as the build, so tests decode what the plugin ships.
	plugins: [
		compressedAssets({ localesDir: new URL("./src/i18n/locales", import.meta.url).pathname }),
		svelte({ hot: false }),
	],
	test: {
		// Environment
		environment: "jsdom",

		// Test file patterns
		include: ["test/**/*.{test,spec}.ts"],

		// Setup files
		setupFiles: ["./test/setup.ts"],

		// Coverage configuration
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["src/providers/**/*.ts"],
			exclude: ["test/**/*.ts"],
		},

		// Vitest hands node_modules imports to Node directly, past every plugin; a
		// `?deflate` import of a vendored library must go through compressedAssets instead.
		server: { deps: { inline: [/plotly\.js-gl3d-dist-min/] } },

		// Global test timeout
		testTimeout: 10000,

		// Run tests in sequence for now (can parallelize later)
		pool: "forks",

		// Mock reset between tests
		mockReset: true,

		// Isolate each test file to prevent mock leakage
		fileParallelism: false,
		isolate: true,
	},

	// Resolve aliases (match your existing vite config if any)
	resolve: {
		// Resolve Svelte to its client build so component tests can `mount()` under jsdom;
		// without this Vitest picks the server entry, where `mount` throws.
		conditions: ["browser"],
		alias: {
			// Mock obsidian for tests - the module is only available at runtime in Obsidian
			obsidian: new URL("./test/__mocks__/obsidian.ts", import.meta.url).pathname,
			electron: new URL("./test/__mocks__/electron.ts", import.meta.url).pathname,
			// Mock SAP AI SDK - optional dependency
			"@sap-ai-sdk/langchain": new URL("./test/__mocks__/sap-ai-sdk.ts", import.meta.url).pathname,
		},
	},
});
