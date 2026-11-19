import { type BaseMessage, SystemMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

/**
 * Anthropic prompt caching for every agent run.
 *
 * Each turn re-sends the whole system prompt (agent note, vault overview,
 * `# Skills` block) and the full chat history, and an agentic turn re-sends it
 * again on every tool-loop step. With caching, the unchanged prefix is billed at
 * 10% of the input price (writes at 125%) and is served faster.
 *
 * Breakpoints are set per content block, on the system prompt and on the newest
 * message, rather than with LangChain's `anthropicPromptCachingMiddleware`. That
 * one sets Anthropic's top-level `cache_control` ("automatic caching"), which
 * only the first-party API honours: Bedrock, and gateways in front of it such as
 * the LiteLLM proxies people point the Anthropic provider's base URL at, accept
 * the field and silently cache nothing (verified live). Block-level breakpoints
 * work on both.
 *
 * Two breakpoints are enough. The one on the system prompt caches it across
 * chats; the one on the newest message caches the whole conversation so far, and
 * the next request finds that entry because Anthropic looks back up to 20 blocks
 * from each breakpoint for an earlier cached prefix.
 *
 * Only `ChatAnthropic` is touched (our proxied instance from
 * `createTransportedChatAnthropic` still reports that name). Every other provider
 * gets the request unchanged: OpenAI caches automatically, and Claude via
 * OpenRouter is not a `ChatAnthropic`.
 */

/** 5-minute TTL: most repeated tokens come from the tool loop inside one turn, and a 1-hour write costs twice the base price. */
const BREAKPOINT = { type: "ephemeral" } as const;

/** Block types Anthropic does not let a breakpoint sit on. */
const UNCACHEABLE_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

type Block = Record<string, unknown> & { type?: unknown };

/**
 * `content` with a breakpoint on its last cacheable block, as a new array (the
 * stored message is never mutated). `null` when there is nothing to mark.
 */
export function withCacheBreakpoint(content: unknown): Block[] | null {
	if (typeof content === "string") {
		return content.length > 0 ? [{ type: "text", text: content, cache_control: BREAKPOINT }] : null;
	}
	if (!Array.isArray(content)) return null;
	const blocks = content.map((block) =>
		typeof block === "string" ? { type: "text", text: block } : { ...(block as Block) },
	);
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i] as Block;
		if (typeof block.type === "string" && UNCACHEABLE_BLOCK_TYPES.has(block.type)) continue;
		if (block.type === "text" && !block.text) continue;
		blocks[i] = { ...block, cache_control: BREAKPOINT };
		return blocks;
	}
	return null;
}

/** A copy of `message` with a breakpoint on its content, or the message itself when nothing can be marked. */
function markMessage<T extends BaseMessage>(message: T): T {
	const content = withCacheBreakpoint(message.content);
	if (!content) return message;
	// Same class and fields (ids, tool calls, metadata), new content. The copy only
	// lives in this request; the checkpointed message keeps its plain content.
	return Object.assign(Object.create(Object.getPrototypeOf(message)), message, { content }) as T;
}

function isAnthropicModel(model: unknown): boolean {
	return (model as { getName?: () => string } | undefined)?.getName?.() === "ChatAnthropic";
}

export function createPromptCachingMiddleware() {
	return createMiddleware({
		name: "S2BPromptCaching",
		wrapModelCall: (request, handler) => {
			if (!isAnthropicModel(request.model)) return handler(request);

			const messages = [...request.messages];
			const last = messages.at(-1);
			if (last) messages[messages.length - 1] = markMessage(last);

			const systemContent = withCacheBreakpoint(request.systemMessage?.content);
			return handler({
				...request,
				messages,
				...(systemContent ? { systemMessage: new SystemMessage({ content: systemContent as never }) } : {}),
			});
		},
	});
}
