import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { DEFAULT_TOOLS_CONFIG } from "./builtInToolDefaults";
import { formatExecutionResult, type JavaScriptExecutionResult } from "./executeJavaScriptShared";
import type { ExecuteJavaScriptWorkerRequest, ExecuteJavaScriptWorkerResponse } from "./executeJavaScriptWorker";
import ExecuteJavaScriptWorkerConstructor from "./executeJavaScriptWorker?worker&inline";
import { resolveToolAgent } from "./toolAgentContext";

const EXECUTION_TIMEOUT_MS = 3_000;

async function executeInWorker(code: string, input?: unknown): Promise<JavaScriptExecutionResult> {
	if (typeof Worker === "undefined") {
		throw new Error("Web Workers are not available in this environment.");
	}

	const worker = new ExecuteJavaScriptWorkerConstructor({ name: "s2b-js-exec" });

	return await new Promise<JavaScriptExecutionResult>((resolve, reject) => {
		let settled = false;

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeoutId);
			worker.terminate();
			callback();
		};

		const timeoutId = window.setTimeout(() => {
			finish(() => reject(new Error(`JavaScript execution timed out after ${EXECUTION_TIMEOUT_MS}ms.`)));
		}, EXECUTION_TIMEOUT_MS);

		worker.onmessage = (event: MessageEvent<ExecuteJavaScriptWorkerResponse>) => {
			const message = event.data;
			finish(() => {
				if (message.type === "error") {
					reject(new Error(message.error));
					return;
				}
				resolve(message.result);
			});
		};

		worker.onerror = (event) => {
			const errorMessage = event.message || "Worker execution failed.";
			finish(() => reject(new Error(errorMessage)));
		};

		const request: ExecuteJavaScriptWorkerRequest = {
			id: 1,
			type: "execute",
			code,
			input,
		};

		worker.postMessage(request);
	});
}

export function createExecuteJavaScriptTool(agentId = "") {
	const getToolConfig = () => resolveToolAgent(agentId).toolsConfig.execute_javascript;
	const defaultToolConfig = DEFAULT_TOOLS_CONFIG.execute_javascript;

	return tool(
		async ({ code, input }: { code: string; input?: unknown }): Promise<string> => {
			try {
				const result = await executeInWorker(code, input);
				return formatExecutionResult(result);
			} catch (error) {
				return `JavaScript execution failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
		{
			name: getToolConfig()?.name ?? defaultToolConfig.name,
			description: getToolConfig()?.description ?? defaultToolConfig.description,
			schema: z.object({
				code: z
					.string()
					.min(1)
					.describe(
						"JavaScript source to execute. Use `input` for structured data, `return` for the final value, and `console.log` for intermediate output.",
					),
				input: z
					.unknown()
					.optional()
					.describe("Optional JSON-serializable input exposed to the code as `input`."),
			}),
		},
	);
}
