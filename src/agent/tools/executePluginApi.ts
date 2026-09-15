import type { App } from "obsidian";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
	executeJavaScriptSnippetWithScope,
	formatExecutionResult,
	MAX_OUTPUT_CHARS,
	truncateOutput,
} from "./executeJavaScriptShared";
import { resolvePluginApi, toRuntimeToolName } from "../integrations/pluginIntegrations";

const EXECUTION_TIMEOUT_MS = 5_000;

/**
 * Creates a per-plugin code-exec tool that runs a JavaScript snippet on the
 * **main thread** with the target plugin's public `api` object (and `app`) in
 * scope. This is the only way to reach `app.plugins.plugins[...].api` — a worker
 * has no `app` — so it runs unsandboxed. Safety comes from the per-plugin
 * approval gate (the tool is only bound when the user enables the integration),
 * a timeout on awaited work, output truncation, and error-to-string. This is NOT
 * a sandbox: a call into a plugin's api can do anything that plugin can.
 *
 * **The timeout bounds waiting, not execution.** It is a `Promise.race`, which
 * settles the wrapper but cannot cancel what is already running — there is no way
 * to interrupt a main-thread call. So it covers a snippet that *awaits* too long
 * (a slow api call), and does nothing for one that blocks synchronously: a
 * `while (true) {}` freezes Obsidian's UI and the race never gets a turn to run.
 * Escaping that needs a worker, which cannot reach `app` — the constraint this
 * tool exists to work around. The per-plugin approval gate is what actually
 * carries the risk here; treat the timeout as a courtesy, not a control.
 */
export function createPluginApiExecTool(app: App, pluginId: string, displayName: string) {
	const execFn = async ({ code, input }: { code: string; input?: unknown }): Promise<string> => {
		// Re-resolve at call time — the plugin may have reloaded since bind.
		// @ts-ignore - Obsidian plugin API (not in official types)
		const plugin = app.plugins?.plugins?.[pluginId];
		if (!plugin) {
			return `Error: the "${displayName}" plugin (${pluginId}) is not enabled or installed. Ask the user to enable it.`;
		}

		// Prefer `.api`, fall back to `.apiV1` (e.g. the Tasks plugin exposes `apiV1`).
		const api = resolvePluginApi(app, pluginId);
		if (api === null) {
			return `Error: the "${displayName}" plugin does not expose an "api" object, so it cannot be scripted.`;
		}

		try {
			const timeout = new Promise<never>((_, reject) => {
				window.setTimeout(
					() => reject(new Error(`Execution timed out after ${EXECUTION_TIMEOUT_MS}ms.`)),
					EXECUTION_TIMEOUT_MS,
				);
			});
			const result = await Promise.race([
				executeJavaScriptSnippetWithScope({ code, input }, { api, app }),
				timeout,
			]);
			return truncateOutput(formatExecutionResult(result), MAX_OUTPUT_CHARS);
		} catch (error) {
			return `Error executing against ${displayName} API: ${error instanceof Error ? error.message : String(error)}`;
		}
	};

	return tool(execFn, {
		name: toRuntimeToolName(pluginId),
		description: `Run JavaScript against the "${displayName}" plugin's public API on the main thread. The plugin's api object is in scope as \`api\`, and the Obsidian \`app\` is available. Use \`return\` for the final value and \`console.log\` for intermediate output. Awaited work times out after ${EXECUTION_TIMEOUT_MS}ms, but the timeout CANNOT interrupt synchronous code — an unbounded loop will freeze the app, so always bound your iteration. This is not sandboxed, so keep snippets simple and read-only unless the user asked otherwise. Load the "${displayName}" skill (if available) to learn the API's shape before calling it.`,
		schema: z.object({
			code: z
				.string()
				.min(1)
				.describe(
					`JavaScript to execute against the ${displayName} plugin. \`api\` and \`app\` are in scope; use \`input\` for structured data and \`return\` for the final value.`,
				),
			input: z.unknown().optional().describe("Optional JSON-serializable input exposed to the code as `input`."),
		}),
	});
}
