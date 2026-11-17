import { describe, it, expect, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";

const runMetadata = vi.hoisted(() => ({ current: undefined as Record<string, unknown> | undefined }));
vi.mock("@langchain/langgraph", async (importOriginal) => ({
	...(await importOriginal<typeof import("@langchain/langgraph")>()),
	getConfig: () => ({ metadata: runMetadata.current }),
}));

import {
	createGenerationMetadataMiddleware,
	readGenerationMetadata,
	stampGenerationMetadata,
} from "../../src/agent/generationMetadata";

const RUN = { agent_id: "agent-1", agent_name: "My Agent", model_provider: "openai", model: "gpt-4" };

describe("generation metadata", () => {
	it("reads the run's agent and model from config metadata", () => {
		expect(readGenerationMetadata(RUN)).toEqual({
			agentId: "agent-1",
			agentName: "My Agent",
			provider: "openai",
			model: "gpt-4",
		});
		expect(readGenerationMetadata(undefined)).toEqual({});
	});

	it("records the agent and fills in provider/model the provider didn't report", () => {
		const message = new AIMessage({ content: "Hi", response_metadata: { model: "gpt-4o-2024-08-06" } });
		stampGenerationMetadata(message, readGenerationMetadata(RUN));
		expect(message.response_metadata).toEqual({
			agent_id: "agent-1",
			agent_name: "My Agent",
			model_provider: "openai",
			model: "gpt-4o-2024-08-06",
		});
	});

	it("stamps the model's reply before it is returned to the graph", async () => {
		runMetadata.current = RUN;
		const middleware = createGenerationMetadataMiddleware() as unknown as {
			wrapModelCall: (request: unknown, handler: (request: unknown) => Promise<unknown>) => Promise<unknown>;
		};
		const reply = new AIMessage({ content: "The answer" });

		const result = await middleware.wrapModelCall({}, async () => reply);

		expect(result).toBe(reply);
		expect(reply.response_metadata).toMatchObject({ agent_id: "agent-1", model_provider: "openai" });
	});

	it("leaves the reply untouched outside a run with metadata", async () => {
		runMetadata.current = undefined;
		const middleware = createGenerationMetadataMiddleware() as unknown as {
			wrapModelCall: (request: unknown, handler: (request: unknown) => Promise<unknown>) => Promise<unknown>;
		};
		const reply = new AIMessage({ content: "The answer" });

		await middleware.wrapModelCall({}, async () => reply);

		expect(reply.response_metadata).toEqual({});
	});
});
