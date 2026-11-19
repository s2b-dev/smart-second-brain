import { ContextOverflowError, ModelRefusalError } from "@langchain/core/errors";
import { HumanMessage } from "@langchain/core/messages";
import { createAgent, modelRefusalMiddleware } from "langchain";
import { describe, expect, it } from "vitest";
import { createTransportedChatAnthropic } from "../../src/providers/chatProviders";
import { extractErrorMessage } from "../../src/utils/errorMessage";

/** Answers every Messages request with an Anthropic refusal. */
function refusingAnthropicFetch() {
	return (async () =>
		new Response(
			JSON.stringify({
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "claude-test",
				content: [],
				stop_reason: "refusal",
				stop_details: { category: "cyber", explanation: "This request asks for working malware." },
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		)) as typeof fetch;
}

/** The same refusal as a Messages stream: partial text, then `stop_reason: "refusal"`. */
function refusingAnthropicStreamFetch() {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "claude-test",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Sure, here" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: {
				stop_reason: "refusal",
				stop_sequence: null,
				stop_details: { category: "cyber", explanation: "This request asks for working malware." },
			},
			usage: { output_tokens: 3 },
		},
		{ type: "message_stop" },
	];
	const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
	return (async () =>
		new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
}

describe("model refusals", () => {
	it("are detected on a streamed response too", async () => {
		const model = createTransportedChatAnthropic("anthropic", {
			model: "claude-test",
			apiKey: "test-key",
			streaming: true,
			clientOptions: { fetch: refusingAnthropicStreamFetch() },
		});
		const agent = createAgent({ model, tools: [], middleware: [modelRefusalMiddleware()] });

		const error = await agent.invoke({ messages: [new HumanMessage("hi")] }).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(extractErrorMessage(error)).toContain("This request asks for working malware.");
	});

	it("fail the turn with the provider's explanation instead of an empty answer", async () => {
		const model = createTransportedChatAnthropic("anthropic", {
			model: "claude-test",
			apiKey: "test-key",
			streaming: false,
			clientOptions: { fetch: refusingAnthropicFetch() },
		});
		const agent = createAgent({ model, tools: [], middleware: [modelRefusalMiddleware()] });

		const error = await agent.invoke({ messages: [new HumanMessage("hi")] }).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(error).toBeDefined();
		expect(extractErrorMessage(error)).toBe(
			[
				"The model declined to answer this request.",
				"This request asks for working malware.",
				"Rephrasing the request, or switching to another model, may help.",
			].join("\n"),
		);
	});
});

describe("extractErrorMessage for typed LangChain errors", () => {
	it("describes a refusal without an explanation", () => {
		const error = ModelRefusalError.fromRefusal({ type: "refusal", refusal: "" } as never);
		expect(extractErrorMessage(new Error("wrapped", { cause: error }))).toBe(
			"The model declined to answer this request.\nRephrasing the request, or switching to another model, may help.",
		);
	});

	it("explains a context overflow and keeps the provider's detail", () => {
		const providerError = new Error("400 prompt is too long: 210000 tokens > 200000 maximum");
		const error = ContextOverflowError.fromError(providerError);
		expect(extractErrorMessage(error)).toBe(
			[
				"This chat no longer fits in the model's context window.",
				"Start a new chat, or check the context window configured for this model.",
				"400 prompt is too long: 210000 tokens > 200000 maximum",
			].join("\n"),
		);
	});
});
