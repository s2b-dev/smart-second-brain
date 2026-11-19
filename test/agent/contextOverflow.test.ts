import { ContextOverflowError } from "@langchain/core/errors";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, summarizationMiddleware } from "langchain";
import { describe, expect, it } from "vitest";
import { createContextOverflowRecoveryMiddleware, isContextOverflowError } from "../../src/agent/contextOverflow";
import { SUMMARY_PREFIX, guardSummarizationFailure } from "../../src/agent/summarization";
import { createDeltaMessagesStateSchema } from "../../src/agent/threadReplay";
import { countMessageTokens } from "../../src/utils/tokenEstimator";

/** A chat model whose reply (or thrown error) is decided per call from the messages it receives. */
class ScriptedChat extends BaseChatModel {
	readonly calls: BaseMessage[][] = [];
	constructor(private readonly respond: (messages: BaseMessage[]) => AIMessage) {
		super({});
	}
	_llmType() {
		return "scripted";
	}
	// createAgent binds the (empty) tool list; there is nothing to bind.
	bindTools() {
		return this as never;
	}
	async _generate(messages: BaseMessage[]): Promise<ChatResult> {
		this.calls.push(messages);
		const message = this.respond(messages);
		return { generations: [{ text: String(message.content), message }] };
	}
}

/** Overflows whenever it receives more than `limit` non-system messages. */
function overflowingModel(limit: number) {
	return new ScriptedChat((messages) => {
		const conversation = messages.filter((m) => m.type !== "system");
		if (conversation.length > limit) {
			throw new ContextOverflowError("prompt is too long: 210000 tokens > 200000 maximum");
		}
		return new AIMessage("answer");
	});
}

function longHistory(turns: number): BaseMessage[] {
	const filler = "x".repeat(400);
	const messages: BaseMessage[] = [];
	for (let i = 0; i < turns; i++) {
		messages.push(new HumanMessage({ id: `h${i}`, content: `question ${i} ${filler}` }));
		messages.push(new AIMessage({ id: `a${i}`, content: `reply ${i} ${filler}` }));
	}
	messages.push(new HumanMessage({ id: "last", content: "final question" }));
	return messages;
}

/** The slice of the agent the tests use; the `as never` state schema erases its real type. */
interface TestAgent {
	invoke(input: { messages: BaseMessage[] }, config: unknown): Promise<{ messages: BaseMessage[] }>;
	getState(config: unknown): Promise<{ values: unknown }>;
}

function buildAgent(model: BaseChatModel, summaryModel: BaseChatModel): TestAgent {
	// Mirrors `Agent.buildSummarizationMiddleware`, with a proactive trigger the
	// test never reaches, so only the overflow path can summarize.
	const summarizer = guardSummarizationFailure(
		summarizationMiddleware({
			model: summaryModel,
			trigger: { tokens: 1_000_000_000 },
			keep: { messages: 12 },
			summaryPrefix: SUMMARY_PREFIX,
			tokenCounter: countMessageTokens,
		}),
	);
	const agent = createAgent({
		model,
		tools: [],
		systemPrompt: "You are a test agent.",
		checkpointer: new MemorySaver(),
		stateSchema: createDeltaMessagesStateSchema() as never,
		middleware: [
			summarizer,
			createContextOverflowRecoveryMiddleware({ summarizer: summarizer.beforeModel as never, keepTokens: 300 }),
		] as never,
	});
	return agent as unknown as TestAgent;
}

const config = { configurable: { thread_id: "t1" } };

describe("isContextOverflowError", () => {
	it("finds a ContextOverflowError anywhere in the cause chain", () => {
		expect(isContextOverflowError(new ContextOverflowError())).toBe(true);
		expect(isContextOverflowError(new Error("wrapper", { cause: new ContextOverflowError() }))).toBe(true);
		expect(isContextOverflowError(new Error("prompt is too long"))).toBe(false);
		expect(isContextOverflowError(undefined)).toBe(false);
	});
});

describe("createContextOverflowRecoveryMiddleware", () => {
	it("summarizes, retries once, and persists the shortened history with the reply", async () => {
		const model = overflowingModel(8);
		const summaryModel = new ScriptedChat(() => new AIMessage("the summary"));
		const agent = buildAgent(model, summaryModel);

		const result = await agent.invoke({ messages: longHistory(10) }, config);

		// First call overflowed, the retry succeeded.
		expect(model.calls).toHaveLength(2);
		expect(summaryModel.calls).toHaveLength(1);
		const retried = model.calls[1]?.filter((m) => m.type !== "system") ?? [];
		expect(retried.length).toBeLessThanOrEqual(8);
		expect(String(retried[0]?.content)).toBe(`${SUMMARY_PREFIX}\n\nthe summary`);

		const assertHistory = (messages: BaseMessage[]) => {
			expect(String(messages[0]?.content)).toBe(`${SUMMARY_PREFIX}\n\nthe summary`);
			expect(messages.at(-2)?.id).toBe("last");
			expect(messages.at(-1)?.content).toBe("answer");
			expect(messages.length).toBeLessThanOrEqual(9);
		};
		assertHistory(result.messages);
		// The checkpoint holds the same shortened history, so the next turn starts from it.
		const saved = await agent.getState(config);
		assertHistory((saved.values as { messages: BaseMessage[] }).messages);
	});

	it("lets the overflow through when the retry overflows too", async () => {
		const model = overflowingModel(0);
		const summaryModel = new ScriptedChat(() => new AIMessage("the summary"));
		const agent = buildAgent(model, summaryModel);

		await expect(agent.invoke({ messages: longHistory(10) }, config)).rejects.toSatisfy(isContextOverflowError);
		expect(model.calls).toHaveLength(2);
	});

	it("lets the overflow through without retrying when the summary fails", async () => {
		const model = overflowingModel(8);
		const summaryModel = new ScriptedChat(() => {
			throw new Error("summary model down");
		});
		const agent = buildAgent(model, summaryModel);

		await expect(agent.invoke({ messages: longHistory(10) }, config)).rejects.toSatisfy(isContextOverflowError);
		expect(model.calls).toHaveLength(1);
	});

	it("does not touch other errors", async () => {
		const model = new ScriptedChat(() => {
			throw new Error("401 invalid api key");
		});
		const summaryModel = new ScriptedChat(() => new AIMessage("the summary"));
		const agent = buildAgent(model, summaryModel);

		await expect(agent.invoke({ messages: longHistory(10) }, config)).rejects.toThrow("401 invalid api key");
		expect(model.calls).toHaveLength(1);
		expect(summaryModel.calls).toHaveLength(0);
	});
});
