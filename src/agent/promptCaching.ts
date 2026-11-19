import { anthropicPromptCachingMiddleware } from "langchain";

/**
 * Anthropic prompt caching for every agent run.
 *
 * Each turn re-sends the whole system prompt (agent note + `# Skills` block) and
 * the full chat history, and an agentic turn re-sends it again on every tool-loop
 * step. With caching, the unchanged prefix is billed at 10% of the input price
 * (writes at 125%) and is served faster. The middleware sets Anthropic's top-level
 * `cache_control`, which places the breakpoint on the last cacheable block, so the
 * cached prefix grows with the conversation.
 *
 * It only acts on `ChatAnthropic` (our proxied instance from
 * `createTransportedChatAnthropic` still reports that name) and is a silent no-op
 * for every other provider: OpenAI caches automatically, and Claude via
 * OpenRouter is not a `ChatAnthropic`.
 *
 * TTL stays at the 5-minute default: the tool loop within one turn is where most
 * repeated prefix tokens are, and a 1-hour write costs twice the base price.
 */
export function createPromptCachingMiddleware() {
	return anthropicPromptCachingMiddleware({ ttl: "5m", unsupportedModelBehavior: "ignore" });
}
