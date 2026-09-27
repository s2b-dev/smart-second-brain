import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [svelte({ hot: false })],
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
