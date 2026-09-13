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
import { Logger } from "../utils/logging";
import { ChatOpenAIResponses, type ChatOpenAIResponsesConfig } from "./langchainOpenAIResponses";

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
		...baseConfig,
		configuration: {
			...configuration,
			fetch: (configuration.fetch as typeof fetch | undefined) ?? createObsidianFetch(),
		},
	});
}

/**
 * Retry policy for Ollama embedding calls.
 *
 * LangChain's default handler skips retries for 4xx responses, but it reads
 * the status from `status` / `statusCode` / `response.status`, and the Ollama
 * client's `ResponseError` carries it as `status_code`. So a permanent
 * rejection — "the input length exceeds the context length", HTTP 400 — was
 * retried six times with exponential backoff: 7 requests and ~85 s of idle GPU
 * per call, and the bulk indexer then repeats that for every entry of the
 * failed batch (#485). Replacing the handler drops the default's other rules,
 * so the one that matters is restated here: a cancellation is never retried.
 * Everything else (transport failures, 5xx) keeps the default retry budget.
 */
export function ollamaEmbedFailedAttempt(error: unknown): void {
	if (typeof error !== "object" || error === null) return;
	const {
		name,
		message,
		status_code: statusCode,
	} = error as {
		name?: unknown;
		message?: unknown;
		status_code?: unknown;
	};
	if (name === "AbortError" || (typeof message === "string" && message.startsWith("Cancel"))) throw error;
	if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) throw error;
}

export function createTransportedOllamaEmbeddings(
	config: ConstructorParameters<typeof OllamaEmbeddings>[0],
): OllamaEmbeddings {
	const baseConfig = config ?? {};
	return new OllamaEmbeddings({
		onFailedAttempt: ollamaEmbedFailedAttempt,
		...baseConfig,
		fetch: baseConfig.fetch ?? createObsidianFetch(),
	});
}
