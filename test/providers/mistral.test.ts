/**
 * Mistral provider: catalogue → model lists and metadata, the request/response adapter
 * for Mistral's strict OpenAI-compatible API, and key validation / discovery.
 */

import { requestUrl } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { hydrateChatModel, hydrateEmbeddingModel } from "../../src/lib/modelMetadataNormalizer";
import { MISTRAL_EMBED_REQUEST_CHARS, packBySize } from "../../src/providers/chatProviders";
import { mistralProvider } from "../../src/providers/mistral";
import { populateMistralCache } from "../../src/providers/mistralModels";
import {
	createMistralFetch,
	flattenMistralChoices,
	toMistralChatRequest,
	toMistralToolCallId,
} from "../../src/providers/mistralTransport";

const CATALOG = [
	{
		id: "mistral-medium-latest",
		capabilities: { completion_chat: true, function_calling: true, vision: true },
		max_context_length: 131072,
	},
	{
		id: "codestral-latest",
		capabilities: { completion_chat: true, function_calling: true, vision: false },
		max_context_length: 256000,
	},
	// Chats, but without tool calling: the agent can't use it.
	{ id: "mistral-saba-latest", capabilities: { completion_chat: true, function_calling: false } },
	{
		id: "mistral-embed",
		capabilities: { completion_chat: false, function_calling: false },
		max_context_length: 8192,
	},
	{ id: "codestral-embed", capabilities: { completion_chat: false } },
	// Neither chat nor embedding.
	{ id: "mistral-moderation-latest", capabilities: { completion_chat: false } },
	// Retired.
	{
		id: "open-mistral-7b",
		capabilities: { completion_chat: true, function_calling: true },
		deprecation: "2025-03-30T12:00:00Z",
	},
];

const NOW = Date.parse("2026-11-23T00:00:00Z");

describe("populateMistralCache", () => {
	it("splits tool-capable chat models from embedding models and drops retired ones", () => {
		expect(populateMistralCache("mistral-eu", CATALOG, NOW)).toEqual({
			chat: ["codestral-latest", "mistral-medium-latest"],
			embedding: ["codestral-embed", "mistral-embed"],
		});
	});

	it("feeds context window and capabilities into hydration for that instance", () => {
		populateMistralCache("mistral-eu", CATALOG, NOW);
		const medium = hydrateChatModel("mistral-eu", "mistral-medium-latest", { templateId: "mistral" });
		expect(medium.contextWindow).toBe(131072);
		expect(medium.capabilities.vision).toBe(true);
		expect(medium.capabilities.toolCalls).toBe(true);
		expect(hydrateChatModel("mistral-eu", "codestral-latest", { templateId: "mistral" }).capabilities.vision).toBe(
			false,
		);
		expect(hydrateEmbeddingModel("mistral-eu", "mistral-embed", { templateId: "mistral" }).maxInputTokens).toBe(
			8192,
		);
	});

	it("keeps each instance's catalogue apart", () => {
		populateMistralCache("mistral-eu", CATALOG, NOW);
		expect(
			hydrateChatModel("mistral-other", "mistral-medium-latest", { templateId: "mistral" }).contextWindow,
		).toBe(undefined);
	});
});

describe("toMistralToolCallId", () => {
	it("keeps ids Mistral already accepts", () => {
		expect(toMistralToolCallId("aB3dE5gH9")).toBe("aB3dE5gH9");
	});

	it("maps foreign ids to stable, distinct nine-character alphanumerics", () => {
		const a = toMistralToolCallId("call_5019f900a247472bacde0b82");
		const b = toMistralToolCallId("toolu_01VpEm654HvfMoRcrE3Hgdc6");
		expect(a).toMatch(/^[a-zA-Z0-9]{9}$/);
		expect(b).toMatch(/^[a-zA-Z0-9]{9}$/);
		expect(a).not.toBe(b);
		expect(toMistralToolCallId("call_5019f900a247472bacde0b82")).toBe(a);
	});
});

describe("toMistralChatRequest", () => {
	const request = toMistralChatRequest({
		model: "mistral-medium-latest",
		stream: true,
		stream_options: { include_usage: true },
		store: false,
		max_completion_tokens: 512,
		messages: [
			{ role: "system", content: [{ type: "text", text: "Be brief." }] },
			{
				role: "user",
				content: [
					{ type: "text", text: "What is in these?", s2b_attachment: true },
					{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
					{ type: "file", file: { filename: "paper.pdf", file_data: "data:application/pdf;base64,AAAA" } },
				],
			},
			{
				role: "assistant",
				name: "model",
				content: [{ type: "thinking", thinking: "…" }],
				reasoning_content: "hidden",
				tool_calls: [
					{
						id: "toolu_01VpEm654HvfMoRcrE3Hgdc6",
						type: "function",
						function: { name: "search", arguments: "{}" },
					},
				],
			},
			{ role: "tool", tool_call_id: "toolu_01VpEm654HvfMoRcrE3Hgdc6", content: "result" },
		],
	});

	it("keeps only fields Mistral defines and renames the OpenAI ones", () => {
		expect(Object.keys(request).sort()).toEqual(["max_tokens", "messages", "model", "stream"]);
		expect(request.max_tokens).toBe(512);
	});

	it("reduces content to blocks Mistral accepts", () => {
		const [system, user, assistant] = request.messages as Record<string, unknown>[];
		expect(system.content).toBe("Be brief.");
		expect(user.content).toEqual([
			{ type: "text", text: "What is in these?" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
			{
				type: "text",
				text: '[Attachment "paper.pdf" was not sent: Mistral models can\'t read this file type directly.]',
			},
		]);
		expect(assistant).not.toHaveProperty("name");
		expect(assistant).not.toHaveProperty("reasoning_content");
		expect(assistant.content).toBe("");
	});

	it("gives a foreign tool call and its result the same Mistral id", () => {
		const [, , assistant, tool] = request.messages as Record<string, unknown>[];
		const callId = (assistant.tool_calls as Array<{ id: string }>)[0].id;
		expect(callId).toMatch(/^[a-zA-Z0-9]{9}$/);
		expect(tool.tool_call_id).toBe(callId);
	});
});

describe("flattenMistralChoices", () => {
	it("turns reasoning-model content chunks into text plus reasoning_content", () => {
		const payload = flattenMistralChoices({
			choices: [
				{
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: [{ type: "text", text: "Let me think." }] },
							{ type: "text", text: "Answer." },
						],
					},
				},
			],
		});
		const message = (payload.choices as Array<{ message: Record<string, unknown> }>)[0].message;
		expect(message.content).toBe("Answer.");
		expect(message.reasoning_content).toBe("Let me think.");
	});
});

describe("createMistralFetch", () => {
	it("adapts chat-completion requests and rewrites streamed chunks", async () => {
		const chunk = { choices: [{ index: 0, delta: { content: [{ type: "text", text: "Hi" }] } }] };
		const inner = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const response = await createMistralFetch(inner)("https://api.mistral.ai/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "m", stream: true, stream_options: { include_usage: true }, messages: [] }),
		});
		const sent = JSON.parse(String(inner.mock.calls[0][1]?.body));
		expect(sent).not.toHaveProperty("stream_options");
		const text = await response.text();
		expect(text).toContain('"content":"Hi"');
		expect(text).toContain("data: [DONE]");
	});

	it("passes other requests through untouched", async () => {
		const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"));
		const init = { method: "POST", body: JSON.stringify({ model: "mistral-embed", input: ["a"] }) };
		await createMistralFetch(inner)("https://api.mistral.ai/v1/embeddings", init);
		expect(inner).toHaveBeenCalledWith("https://api.mistral.ai/v1/embeddings", init);
	});
});

describe("packBySize", () => {
	it("bounds embedding requests by count and by characters", () => {
		const long = "x".repeat(MISTRAL_EMBED_REQUEST_CHARS / 2 + 1);
		expect(packBySize(["a", "b", "c"], 2, MISTRAL_EMBED_REQUEST_CHARS)).toEqual([["a", "b"], ["c"]]);
		expect(packBySize([long, long, "a"], 50, MISTRAL_EMBED_REQUEST_CHARS)).toEqual([[long], [long, "a"]]);
		// An oversized text still goes out, alone.
		const huge = "x".repeat(MISTRAL_EMBED_REQUEST_CHARS * 2);
		expect(packBySize([huge, "a"], 50, MISTRAL_EMBED_REQUEST_CHARS)).toEqual([[huge], ["a"]]);
	});
});

describe("mistralProvider", () => {
	const ok = (json: unknown) => ({ status: 200, json, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0) });

	it("validates a key against /v1/models", async () => {
		vi.mocked(requestUrl).mockResolvedValue(ok({ data: [] }) as never);
		expect(await mistralProvider.validateAuth({ apiKey: "key" })).toEqual({ valid: true });
		expect(vi.mocked(requestUrl).mock.calls[0][0]).toMatchObject({
			url: "https://api.mistral.ai/v1/models",
			headers: { Authorization: "Bearer key" },
		});
	});

	it("reports a rejected key", async () => {
		vi.mocked(requestUrl).mockResolvedValue({ ...ok({}), status: 401 } as never);
		const result = await mistralProvider.validateAuth({ apiKey: "bad" });
		expect(result.valid).toBe(false);
	});

	it("requires a key", async () => {
		expect((await mistralProvider.validateAuth({})).valid).toBe(false);
		expect(requestUrl).not.toHaveBeenCalled();
	});

	it("discovers chat and embedding models separately", async () => {
		vi.mocked(requestUrl).mockResolvedValue(ok({ data: CATALOG }) as never);
		expect(await mistralProvider.discoverModels({ apiKey: "key" })).toContain("mistral-medium-latest");
		expect(await mistralProvider.discoverEmbeddingModels?.({ apiKey: "key" })).toEqual([
			"codestral-embed",
			"mistral-embed",
		]);
	});

	it("builds chat and embedding clients pointed at La Plateforme", () => {
		expect(mistralProvider.createChatInstance({ apiKey: "key" }, "mistral-medium-latest")).toBeDefined();
		expect(mistralProvider.createEmbeddingInstance({ apiKey: "key" }, "mistral-embed")).toBeDefined();
	});
});
