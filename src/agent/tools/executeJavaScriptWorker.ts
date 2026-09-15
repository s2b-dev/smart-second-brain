import { executeJavaScriptSnippet, type JavaScriptExecutionResult } from "./executeJavaScriptShared";

export interface ExecuteJavaScriptWorkerRequest {
	id: number;
	type: "execute";
	code: string;
	input?: unknown;
}

export type ExecuteJavaScriptWorkerResponse =
	| {
			id: number;
			type: "result";
			result: JavaScriptExecutionResult;
	  }
	| {
			id: number;
			type: "error";
			error: string;
	  };

self.onmessage = async (event: MessageEvent<ExecuteJavaScriptWorkerRequest>) => {
	const message = event.data;

	try {
		const result = await executeJavaScriptSnippet({
			code: message.code,
			input: message.input,
		});

		const response: ExecuteJavaScriptWorkerResponse = {
			id: message.id,
			type: "result",
			result,
		};
		self.postMessage(response);
	} catch (error) {
		const response: ExecuteJavaScriptWorkerResponse = {
			id: message.id,
			type: "error",
			error: error instanceof Error ? error.message : String(error),
		};
		self.postMessage(response);
	}
};
