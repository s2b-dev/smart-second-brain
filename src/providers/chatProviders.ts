import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
	AIMessage,
	AIMessageChunk,
	type BaseMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";
import { createAiProviderFetch, createBufferedAiProviderFetch } from "../lib/aiTransport";
import { createObsidianFetch } from "../lib/obsidianFetch";
import { isConnectionRefusedError, isRequestTimeoutError } from "../lib/transportErrors";
import { AsyncCaller } from "@langchain/core/utils/async_caller";
import { Logger } from "../utils/logging";
import { ChatOpenAIResponses, type ChatOpenAIResponsesConfig } from "./langchainOpenAIResponses";
import { createMistralFetch } from "./mistralTransport";

function parseToolArgs(args: unknown): Record<string, unknown> {
	if (typeof args === "string") {
		try {
			return JSON.parse(args) as Record<string, unknown>;
		} catch {
			return {};
		}
	}
	if (args && typeof args === "object" && !Array.isArray(args)) {
		return args as Record<string, unknown>;
	}
	return {};
}

function parseAdditionalToolCalls(
	additionalKwargs: unknown,
): { id: string; name: string; args: Record<string, unknown> }[] | undefined {
	if (!additionalKwargs || typeof additionalKwargs !== "object" || Array.isArray(additionalKwargs)) {
		return undefined;
	}

	const rawToolCalls = (additionalKwargs as { tool_calls?: unknown }).tool_calls;
	if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
		return undefined;
	}

	return rawToolCalls
		.filter((tc): tc is Record<string, unknown> => tc && typeof tc === "object")
		.map((tc) => {
			const functionPayload =
				tc.function && typeof tc.function === "object" ? (tc.function as Record<string, unknown>) : undefined;

			return {
				id: typeof tc.id === "string" ? tc.id : "",
				name:
					typeof tc.name === "string"
						? tc.name
						: typeof functionPayload?.name === "string"
							? functionPayload.name
							: "",
				args: parseToolArgs(tc.args ?? tc.arguments ?? functionPayload?.arguments),
			};
		})
		.filter((tc) => tc.id || tc.name);
}

function normalizeToolCallMessage<TMessage>(message: TMessage): TMessage {
	if (!message || typeof message !== "object") {
		return message;
	}

	const baseMessage = message as unknown as BaseMessage & {
		tool_calls?: unknown;
		additional_kwargs?: unknown;
		response_metadata?: unknown;
	};
	const messageType = typeof baseMessage.type === "string" ? baseMessage.type : undefined;
	if (messageType !== "generic") {
		return message;
	}

	const toolCalls = parseAdditionalToolCalls(baseMessage.additional_kwargs);
	if (!toolCalls?.length) {
		return message;
	}

	const payload = {
		content: toolCalls.length > 0 ? "" : baseMessage.content,
		id: baseMessage.id,
		tool_calls: toolCalls,
		additional_kwargs:
			baseMessage.additional_kwargs && typeof baseMessage.additional_kwargs === "object"
				? (() => {
						const nextAdditionalKwargs = {
							...(baseMessage.additional_kwargs as Record<string, unknown>),
						};
						nextAdditionalKwargs.tool_calls = undefined;
						return nextAdditionalKwargs;
					})()
				: {},
		response_metadata:
			baseMessage.response_metadata && typeof baseMessage.response_metadata === "object"
				? { ...(baseMessage.response_metadata as Record<string, unknown>) }
				: {},
	};

	if (typeof (message as { concat?: unknown }).concat === "function") {
		return new AIMessageChunk(payload) as TMessage;
	}

	return new AIMessage(payload) as TMessage;
}

/**
 * Guarantees the model result is a genuine `@langchain/core` message.
 *
 * LangChain's agent runtime validates model output with `AIMessage.isInstance`,
 * which requires the brand symbol AND `type === "ai"`. Some OpenAI-compatible
 * endpoints (e.g. OpenRouter) return payloads that `ChatOpenAI` turns into an
 * object that fails this check, surfacing as
 * `expected AIMessage or Command, got object` inside subagent middleware. When
 * that happens we rebuild a real `AIMessage`/`AIMessageChunk` from the
 * message-shaped fields so the agent loop can proceed instead of crashing.
 */
function coerceModelResult<TMessage>(message: TMessage): TMessage {
	if (!message || typeof message !== "object") {
		return message;
	}
	// Already a valid core AIMessage / AIMessageChunk — leave untouched.
	// Use AIMessage.isInstance (brand + type check) rather than isAIMessage,
	// which calls `_getType()` and would throw on a plain object.
	if (AIMessage.isInstance(message as never)) {
		return message;
	}

	const candidate = message as unknown as {
		content?: unknown;
		id?: unknown;
		tool_calls?: unknown;
		additional_kwargs?: unknown;
		response_metadata?: unknown;
		concat?: unknown;
	};
	// Only coerce things that look like a chat message (have a content field).
	if (!("content" in candidate)) {
		return message;
	}

	Logger.debug("chatProviders.coerceModelResult: rebuilding non-AIMessage model result", {
		keys: Object.keys(candidate),
		hasConcat: typeof candidate.concat === "function",
	});

	const payload = {
		content: (candidate.content as never) ?? "",
		id: typeof candidate.id === "string" ? candidate.id : undefined,
		tool_calls: Array.isArray(candidate.tool_calls) ? (candidate.tool_calls as never) : [],
		additional_kwargs:
			candidate.additional_kwargs && typeof candidate.additional_kwargs === "object"
				? (candidate.additional_kwargs as Record<string, unknown>)
				: {},
		response_metadata:
			candidate.response_metadata && typeof candidate.response_metadata === "object"
				? (candidate.response_metadata as Record<string, unknown>)
				: {},
	};

	return typeof candidate.concat === "function"
		? (new AIMessageChunk(payload) as TMessage)
		: (new AIMessage(payload) as TMessage);
}

function normalizeInputMessage<TMessage>(message: TMessage): TMessage {
	if (!message || typeof message !== "object") {
		return message;
	}

	const normalizedGeneric = normalizeToolCallMessage(message);
	if (!normalizedGeneric || typeof normalizedGeneric !== "object") {
		return normalizedGeneric;
	}

	const baseMessage = normalizedGeneric as unknown as BaseMessage & {
		tool_calls?: unknown;
		tool_call_id?: unknown;
		additional_kwargs?: unknown;
		response_metadata?: unknown;
	};
	const messageType = typeof baseMessage.type === "string" ? baseMessage.type : undefined;
	const additionalKwargs =
		baseMessage.additional_kwargs && typeof baseMessage.additional_kwargs === "object"
			? { ...(baseMessage.additional_kwargs as Record<string, unknown>) }
			: {};
	const responseMetadata =
		baseMessage.response_metadata && typeof baseMessage.response_metadata === "object"
			? { ...(baseMessage.response_metadata as Record<string, unknown>) }
			: {};

	switch (messageType) {
		case "ai_chunk":
		case "AIMessageChunk": {
			return new AIMessage({
				content: baseMessage.content,
				id: baseMessage.id,
				tool_calls: Array.isArray(baseMessage.tool_calls) ? baseMessage.tool_calls : [],
				additional_kwargs: additionalKwargs,
				response_metadata: responseMetadata,
			}) as TMessage;
		}
		case "tool": {
			return new ToolMessage({
				content: baseMessage.content,
				id: baseMessage.id,
				tool_call_id: typeof baseMessage.tool_call_id === "string" ? baseMessage.tool_call_id : "",
				additional_kwargs: additionalKwargs,
				response_metadata: responseMetadata,
			}) as TMessage;
		}
		case "human": {
			return new HumanMessage({
				content: baseMessage.content,
				id: baseMessage.id,
				additional_kwargs: additionalKwargs,
				response_metadata: responseMetadata,
			}) as TMessage;
		}
		case "system": {
			return new SystemMessage({
				content: baseMessage.content,
				id: baseMessage.id,
				additional_kwargs: additionalKwargs,
				response_metadata: responseMetadata,
			}) as TMessage;
		}
		default:
			return normalizedGeneric;
	}
}

function normalizeInputPayload<TInput>(input: TInput): TInput {
	if (Array.isArray(input)) {
		return input.map((entry) => normalizeInputPayload(entry)) as TInput;
	}

	return normalizeInputMessage(input);
}

function wrapAsyncIterable<T>(iterable: AsyncIterable<T>, normalize: (value: T) => T): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator]: async function* () {
			for await (const value of iterable) {
				yield normalize(value);
			}
		},
	};
}

/**
 * Wraps a chat model in a Proxy that normalizes message I/O and guarantees the
 * model result is a genuine core message. Exported for testing the coercion of
 * non-branded results (see the OpenRouter/subagent regression).
 */
export function createNormalizedChatModel<TModel extends BaseChatModel>(model: TModel): TModel {
	return new Proxy(model, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);

			if (prop === "bindTools" && typeof value === "function") {
				return (...args: unknown[]) => createNormalizedChatModel(value.apply(target, args) as TModel);
			}

			if (prop === "withConfig" && typeof value === "function") {
				return (...args: unknown[]) => createNormalizedChatModel(value.apply(target, args) as TModel);
			}

			if (prop === "invoke" && typeof value === "function") {
				return async (...args: unknown[]) => {
					const normalizedArgs = args.length > 0 ? [normalizeInputPayload(args[0]), ...args.slice(1)] : args;
					return coerceModelResult(normalizeToolCallMessage(await value.apply(target, normalizedArgs)));
				};
			}

			if (prop === "stream" && typeof value === "function") {
				return async (...args: unknown[]) => {
					const normalizedArgs = args.length > 0 ? [normalizeInputPayload(args[0]), ...args.slice(1)] : args;
					return wrapAsyncIterable(await value.apply(target, normalizedArgs), (chunk) =>
						coerceModelResult(normalizeToolCallMessage(chunk)),
					);
				};
			}

			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export function createTransportedChatOpenAI(
	providerId: string,
	config: ConstructorParameters<typeof ChatOpenAI>[0],
): ChatOpenAI {
	const baseConfig = config ?? {};
	const nextConfig = {
		...baseConfig,
		configuration: {
			...(baseConfig.configuration ?? {}),
			fetch: baseConfig.configuration?.fetch ?? createAiProviderFetch(providerId),
		},
	};

	return createNormalizedChatModel(new ChatOpenAI(nextConfig));
}

/**
 * Subagent variant of {@link createTransportedChatOpenAI}: buffered `requestUrl`
 * transport + `disableStreaming: true`. Subagents are invoked non-streaming (via the
 * deepagents `task` tool), and the endpoints used here return an empty body for a
 * non-streaming request over Electron's `net.fetch`. Both pieces are required — the
 * flag makes LangChain take the non-streaming path, the buffered fetch returns a body.
 */
export function createBufferedTransportedChatOpenAI(
	providerId: string,
	config: ConstructorParameters<typeof ChatOpenAI>[0],
): ChatOpenAI {
	const baseConfig = config ?? {};
	const nextConfig = {
		...baseConfig,
		disableStreaming: true,
		configuration: {
			...(baseConfig.configuration ?? {}),
			fetch: baseConfig.configuration?.fetch ?? createBufferedAiProviderFetch(providerId),
		},
	};

	return createNormalizedChatModel(new ChatOpenAI(nextConfig));
}

export function createTransportedChatOpenAIResponses(
	providerId: string,
	config: ChatOpenAIResponsesConfig,
): BaseChatModel {
	const baseConfig = config ?? {};
	const nextConfig = {
		...baseConfig,
		configuration: {
			...(baseConfig.configuration ?? {}),
			fetch: baseConfig.configuration?.fetch ?? createAiProviderFetch(providerId),
		},
	};

	return createNormalizedChatModel(new ChatOpenAIResponses(nextConfig));
}

export function createTransportedChatAnthropic(
	providerId: string,
	config: ConstructorParameters<typeof ChatAnthropic>[0],
): ChatAnthropic {
	const baseConfig = config ?? {};
	const nextConfig = {
		...baseConfig,
		clientOptions: {
			...(baseConfig.clientOptions ?? {}),
			fetch: baseConfig.clientOptions?.fetch ?? createAiProviderFetch(providerId),
		},
	};

	return createNormalizedChatModel(new ChatAnthropic(nextConfig));
}

/** Subagent variant of {@link createTransportedChatAnthropic}: buffered transport + non-streaming. */
export function createBufferedTransportedChatAnthropic(
	providerId: string,
	config: ConstructorParameters<typeof ChatAnthropic>[0],
): ChatAnthropic {
	const baseConfig = config ?? {};
	const nextConfig = {
		...baseConfig,
		streaming: false,
		clientOptions: {
			...(baseConfig.clientOptions ?? {}),
			fetch: baseConfig.clientOptions?.fetch ?? createBufferedAiProviderFetch(providerId),
		},
	};

	return createNormalizedChatModel(new ChatAnthropic(nextConfig));
}

export function createTransportedChatOllama(
	providerId: string,
	config: ConstructorParameters<typeof ChatOllama>[0],
): ChatOllama {
	const baseConfig = config ?? {};
	return createNormalizedChatModel(
		new ChatOllama({
			...baseConfig,
			fetch: baseConfig.fetch ?? createAiProviderFetch(providerId),
		}),
	);
}

export function createTransportedOpenAIEmbeddings(
	config: ConstructorParameters<typeof OpenAIEmbeddings>[0],
): OpenAIEmbeddings {
	const baseConfig = config ?? {};
	const configuration = (baseConfig.configuration as Record<string, unknown>) ?? {};
	return new OpenAIEmbeddings({
		onFailedAttempt: embedFailedAttempt,
		...baseConfig,
		configuration: {
			...configuration,
			fetch: (configuration.fetch as typeof fetch | undefined) ?? createObsidianFetch(),
		},
	});
}

/**
 * LangChain's own retry rules (no retry on 4xx, on cancellation, on exhausted
 * quota; rate-limit waits honoured), taken from a caller built with no
 * override. The handler is not exported by itself, and restating its rules
 * here would drift from them.
 */
const defaultFailedAttempt = new (class extends AsyncCaller {
	/** The handler is `protected`; a subclass is the sanctioned way to read it. */
	get failedAttempt(): (error: unknown) => void {
		return this.onFailedAttempt ?? (() => {});
	}
})({}).failedAttempt;

/**
 * Retry policy for embedding calls, on top of LangChain's default.
 *
 * Every embedding call runs through LangChain's `AsyncCaller`, which retries
 * six times with exponential backoff (roughly one to two minutes in total)
 * before the failure reaches the indexer. Three failures must not spend that
 * budget:
 *
 * - **A host that is not there.** A refused connection or an unresolvable
 *   address is not a blip that backoff waits out; a stopped local server stays
 *   stopped until the user starts it. With the default policy the bulk indexer
 *   waited a minute per batch, then — because the failure was not recognised
 *   as transport-level either — another minute per *entry* of that batch. Seen
 *   live: a build sat at 375/378 for the better part of half an hour against
 *   an oMLX that had not been started.
 * - **A timed-out request.** Each attempt has already waited the fetch-level
 *   timeout (60 s); six retries of it is six minutes per call.
 * - **A 4xx the default handler cannot see.** It reads the status from
 *   `status` / `statusCode` / `response.status`, and the Ollama client's
 *   `ResponseError` carries it as `status_code`. So a permanent rejection —
 *   "the input length exceeds the context length", HTTP 400 — was retried six
 *   times: 7 requests and ~85 s of idle GPU per call, repeated by the bulk
 *   indexer for every entry of the failed batch (#485).
 *
 * Everything else — a 5xx under load, a reset, a rate limit with its
 * retry-after hint — is a blip worth the default backoff, and is left to the
 * default rules by delegation, not restatement. (The indexer then gives a
 * batch that still failed one more try before it stops the run, so a blip
 * never drops notes from a build that reports success.)
 */
export function embedFailedAttempt(error: unknown): void {
	if (typeof error !== "object" || error === null) return;
	// p-retry hands this hook the thrown Error; rethrowing it aborts the retries.
	if (isConnectionRefusedError(error) || isRequestTimeoutError(error)) throw error as Error;
	const { status_code: statusCode } = error as { status_code?: unknown };
	if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) throw error as Error;
	defaultFailedAttempt(error);
}

export function createTransportedOllamaEmbeddings(
	config: ConstructorParameters<typeof OllamaEmbeddings>[0],
): OllamaEmbeddings {
	const baseConfig = config ?? {};
	return new OllamaEmbeddings({
		onFailedAttempt: embedFailedAttempt,
		...baseConfig,
		fetch: baseConfig.fetch ?? createObsidianFetch(),
	});
}

/**
 * `ChatOpenAI` against Mistral's OpenAI-compatible API, with requests and responses
 * adapted to it (see `mistralTransport.ts`). `streamUsage: false` keeps
 * `stream_options` out of the request; Mistral reports usage on the last chunk anyway.
 */
export function createTransportedChatMistral(
	providerId: string,
	config: ConstructorParameters<typeof ChatOpenAI>[0],
): ChatOpenAI {
	return createTransportedChatOpenAI(providerId, {
		...config,
		streamUsage: false,
		configuration: {
			...(config?.configuration ?? {}),
			fetch: createMistralFetch(createAiProviderFetch(providerId)),
		},
	});
}

/** Subagent variant of {@link createTransportedChatMistral}: buffered transport + non-streaming. */
export function createBufferedTransportedChatMistral(
	providerId: string,
	config: ConstructorParameters<typeof ChatOpenAI>[0],
): ChatOpenAI {
	return createBufferedTransportedChatOpenAI(providerId, {
		...config,
		streamUsage: false,
		configuration: {
			...(config?.configuration ?? {}),
			fetch: createMistralFetch(createBufferedAiProviderFetch(providerId)),
		},
	});
}

/**
 * Characters of text per Mistral embedding request. Mistral caps a request at about
 * 16k tokens *in total* and answers anything larger with 400 "Too many tokens overall,
 * split into more batches", which the indexer can't recover from by itself (it splits
 * only on timeouts). 24k characters stays under the cap down to 1.5 characters per
 * token, which covers code and non-Latin scripts, while a batch of short chunks still
 * goes out in one request.
 */
export const MISTRAL_EMBED_REQUEST_CHARS = 24_000;

/** Splits `texts` into consecutive groups of at most `maxCount` texts and `maxChars` characters (never empty). */
export function packBySize(texts: string[], maxCount: number, maxChars: number): string[][] {
	const groups: string[][] = [];
	let start = 0;
	while (start < texts.length) {
		let end = start;
		let chars = 0;
		while (end < texts.length && end - start < maxCount) {
			chars += texts[end].length;
			if (end > start && chars > maxChars) break;
			end++;
		}
		groups.push(texts.slice(start, end));
		start = end;
	}
	return groups;
}

/** `OpenAIEmbeddings` that packs Mistral requests by size, not only by count. */
class SizeBoundMistralEmbeddings extends OpenAIEmbeddings {
	override async embedDocuments(texts: string[]): Promise<number[][]> {
		const vectors: number[][] = [];
		for (const group of packBySize(texts, this.batchSize, MISTRAL_EMBED_REQUEST_CHARS)) {
			vectors.push(...(await super.embedDocuments(group)));
		}
		return vectors;
	}
}

export function createTransportedMistralEmbeddings(
	config: ConstructorParameters<typeof OpenAIEmbeddings>[0],
): OpenAIEmbeddings {
	const baseConfig = config ?? {};
	return new SizeBoundMistralEmbeddings({
		onFailedAttempt: embedFailedAttempt,
		// The OpenAI SDK asks for base64 by default; Mistral answers floats when asked.
		encodingFormat: "float",
		...baseConfig,
		configuration: { ...(baseConfig.configuration ?? {}), fetch: createObsidianFetch() },
	});
}
