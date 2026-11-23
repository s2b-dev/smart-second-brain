/**
 * Adapts `ChatOpenAI`'s chat-completions traffic to Mistral's OpenAI-compatible API.
 *
 * The API speaks the OpenAI wire format but validates far more strictly, and a request
 * it doesn't like fails outright (422 "Extra inputs are not permitted", or 400):
 *
 * - **Unknown fields.** Any request, message or content-block field Mistral doesn't
 *   define is refused: `stream_options`, the plugin's own markers on text blocks
 *   (`s2b_attachment`), replayed reasoning. Requests are rebuilt from the fields Mistral
 *   defines (the lists below follow the official SDK's request schemas).
 * - **Tool-call ids.** Mistral accepts only nine alphanumerics. Its own ids already are;
 *   ids minted by another provider earlier in the thread (`call_…`, `toolu_…`) are
 *   mapped to a stable nine-character hash, the same on the call and on its result.
 * - **Content blocks.** Only `text` and `image_url` (images from the user). A PDF
 *   `file` block from a turn that ran on another provider becomes a short note.
 *
 * And on the way back, reasoning models (Magistral) answer with `content` as an array
 * of `text` and `thinking` chunks, which `ChatOpenAI` drops as "non-string content".
 * Responses are rewritten so `content` is the text and the thinking travels as
 * `reasoning_content`, the field `ChatOpenAI` already reads for reasoning.
 *
 * {@link createMistralFetch} wraps the plugin's AI transport, so the streaming fallback
 * and buffered subagent paths apply unchanged.
 */

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;

/** Top-level chat-completion fields Mistral defines (wire names). */
const REQUEST_FIELDS = new Set([
	"model",
	"messages",
	"temperature",
	"top_p",
	"max_tokens",
	"stream",
	"stop",
	"random_seed",
	"response_format",
	"tools",
	"tool_choice",
	"presence_penalty",
	"frequency_penalty",
	"n",
	"prediction",
	"parallel_tool_calls",
	"prompt_mode",
	"reasoning_effort",
	"safe_prompt",
	"metadata",
]);

/** OpenAI field names Mistral knows under another name. */
const RENAMED_FIELDS: Record<string, string> = {
	max_completion_tokens: "max_tokens",
	seed: "random_seed",
};

/** Message fields Mistral defines, per role. */
const MESSAGE_FIELDS: Record<string, ReadonlySet<string>> = {
	system: new Set(["role", "content"]),
	user: new Set(["role", "content"]),
	assistant: new Set(["role", "content", "tool_calls", "prefix"]),
	tool: new Set(["role", "content", "tool_call_id", "name"]),
};

const MISTRAL_TOOL_CALL_ID = /^[a-zA-Z0-9]{9}$/;
const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * A tool-call id Mistral accepts: the id itself when it already is one, otherwise a
 * 53-bit hash of it in base 62 (nine characters). Deterministic, so a call and its
 * result map to the same id on every request.
 */
export function toMistralToolCallId(id: string): string {
	if (MISTRAL_TOOL_CALL_ID.test(id)) return id;
	// cyrb53: two 32-bit FNV-style lanes folded into 53 bits.
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < id.length; i++) {
		const ch = id.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	let hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
	let out = "";
	for (let i = 0; i < 9; i++) {
		out = BASE62[hash % 62] + out;
		hash = Math.floor(hash / 62);
	}
	return out;
}

function fileName(block: Json): string {
	const file = block.file as { filename?: unknown } | undefined;
	return typeof file?.filename === "string" ? file.filename : "file";
}

function toMistralContent(content: unknown, role: string): unknown {
	if (!Array.isArray(content)) return content ?? "";
	const blocks: Json[] = [];
	for (const block of content as Json[]) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image_url" && block.image_url) {
			blocks.push(
				role === "user"
					? { type: "image_url", image_url: block.image_url }
					: { type: "text", text: "[An image was attached here.]" },
			);
		} else if (block.type === "file") {
			blocks.push({
				type: "text",
				text: `[Attachment "${fileName(block)}" was not sent: Mistral models can't read this file type directly.]`,
			});
		}
		// Anything else (reasoning, thinking, provider-specific blocks) is not replayed.
	}
	if (blocks.length === 0) return "";
	// System and tool messages read most reliably as plain text.
	if (role !== "user" && blocks.every((b) => b.type === "text")) return blocks.map((b) => b.text).join("\n\n");
	return blocks;
}

function toMistralToolCall(call: Json): Json {
	const fn = (call.function ?? {}) as Json;
	return {
		id: toMistralToolCallId(typeof call.id === "string" ? call.id : ""),
		type: "function",
		function: { name: fn.name, arguments: typeof fn.arguments === "string" ? fn.arguments : "{}" },
	};
}

function toMistralMessage(message: Json): Json {
	const role = typeof message.role === "string" ? message.role : "user";
	const allowed = MESSAGE_FIELDS[role] ?? MESSAGE_FIELDS.user;
	const out: Json = {};
	for (const [key, value] of Object.entries(message)) {
		if (!allowed.has(key) || value === undefined || value === null) continue;
		if (key === "tool_calls") {
			if (Array.isArray(value) && value.length > 0) out.tool_calls = (value as Json[]).map(toMistralToolCall);
		} else if (key === "tool_call_id") {
			out.tool_call_id = toMistralToolCallId(String(value));
		} else {
			out[key] = value;
		}
	}
	out.content = toMistralContent(message.content, role);
	return out;
}

/** Rebuilds a chat-completion request body from the fields Mistral accepts. */
export function toMistralChatRequest(body: Json): Json {
	const out: Json = {};
	for (const [key, value] of Object.entries(body)) {
		const name = RENAMED_FIELDS[key] ?? key;
		if (REQUEST_FIELDS.has(name) && value !== undefined && value !== null) out[name] = value;
	}
	if (Array.isArray(body.messages)) out.messages = (body.messages as Json[]).map(toMistralMessage);
	return out;
}

/** Splits a Mistral content-chunk array into its text and its thinking. */
function splitContentChunks(content: unknown[]): { text: string; thinking: string } {
	let text = "";
	let thinking = "";
	const textOf = (chunks: unknown): string =>
		Array.isArray(chunks)
			? chunks.map((c) => (typeof (c as Json)?.text === "string" ? ((c as Json).text as string) : "")).join("")
			: "";
	for (const chunk of content as Json[]) {
		if (chunk?.type === "text" && typeof chunk.text === "string") text += chunk.text;
		else if (chunk?.type === "thinking") thinking += textOf(chunk.thinking);
	}
	return { text, thinking };
}

/** Rewrites array `content` in a message or delta to string content + `reasoning_content`. */
function flattenContent(message: Json | undefined): void {
	if (!message || !Array.isArray(message.content)) return;
	const { text, thinking } = splitContentChunks(message.content);
	message.content = text;
	if (thinking) message.reasoning_content = thinking;
}

/** Applies {@link flattenContent} to every choice of a completion or stream chunk. */
export function flattenMistralChoices(payload: Json): Json {
	const choices = payload.choices;
	if (Array.isArray(choices)) {
		for (const choice of choices as Json[]) {
			flattenContent(choice?.message as Json | undefined);
			flattenContent(choice?.delta as Json | undefined);
		}
	}
	return payload;
}

/** Rewrites each `data:` event of an SSE body through {@link flattenMistralChoices}. */
function flattenEventStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffered = "";
	const rewriteLine = (line: string): string => {
		if (!line.startsWith("data:")) return line;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") return line;
		try {
			return `data: ${JSON.stringify(flattenMistralChoices(JSON.parse(data) as Json))}`;
		} catch {
			return line;
		}
	};
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffered += decoder.decode(chunk, { stream: true });
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				if (lines.length > 0) controller.enqueue(encoder.encode(`${lines.map(rewriteLine).join("\n")}\n`));
			},
			flush(controller) {
				buffered += decoder.decode();
				if (buffered) controller.enqueue(encoder.encode(rewriteLine(buffered)));
			},
		}),
	);
}

async function adaptResponse(response: Response): Promise<Response> {
	if (!response.ok || !response.body) return response;
	const contentType = response.headers.get("content-type") ?? "";
	// The rewritten body has its own length, and arrives already decoded.
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	const init = { status: response.status, statusText: response.statusText, headers };
	if (contentType.includes("text/event-stream")) {
		return new Response(flattenEventStream(response.body), init);
	}
	const text = await response.text();
	try {
		return new Response(JSON.stringify(flattenMistralChoices(JSON.parse(text) as Json)), init);
	} catch {
		return new Response(text, init);
	}
}

/**
 * Wraps a plugin fetch so chat-completion requests and responses are adapted to
 * Mistral (see the module comment). Every other request passes through untouched.
 */
export function createMistralFetch(fetchImpl: Fetch): Fetch {
	return async (input, init) => {
		const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input);
		if (!url.includes("/chat/completions") || typeof init?.body !== "string") {
			return fetchImpl(input, init);
		}
		let body: Json;
		try {
			body = JSON.parse(init.body) as Json;
		} catch {
			return fetchImpl(input, init);
		}
		const response = await fetchImpl(input, { ...init, body: JSON.stringify(toMistralChatRequest(body)) });
		return adaptResponse(response);
	};
}
