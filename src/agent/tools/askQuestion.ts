import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { DEFAULT_TOOLS_CONFIG } from "./builtInToolDefaults";
import { resolveToolAgent } from "./toolAgentContext";
import { getPendingQuestionStore, type QuestionItem } from "../../stores/pendingQuestionStore.svelte";
import { genUUIDv7 } from "../../utils/uuid7Validator";
import { Logger } from "../../utils/logging";

const questionItemSchema = z.object({
	id: z
		.string()
		.optional()
		.describe("Optional unique identifier for this question (e.g. 'choice_format' or 'framework')"),
	question: z.string().describe("The question text to present to the user"),
	options: z.array(z.string()).min(2).describe("Selectable options for the user to choose from"),
	is_multi_select: z
		.boolean()
		.optional()
		.describe("Allow user to select multiple options. Default is false (single choice)."),
	allow_custom: z.boolean().optional().describe("Allow user to type in a custom write-in response. Default is true."),
});

export const askQuestionSchema = z.object({
	questions: z.array(questionItemSchema).min(1).describe("List of multiple-choice questions to ask the user"),
});

export type AskQuestionInput = z.infer<typeof askQuestionSchema>;

function getAskQuestionToolConfig(agentId: string) {
	const defaultConfig = DEFAULT_TOOLS_CONFIG.ask_question;
	if (!agentId) return defaultConfig;
	const agent = resolveToolAgent(agentId);
	return agent?.toolsConfig?.ask_question ?? defaultConfig;
}

function resolveThreadIdFromConfig(config: RunnableConfig | undefined): string {
	const threadId = config?.configurable?.thread_id;
	if (typeof threadId === "string" && threadId.length > 0) {
		return threadId;
	}
	return "default_thread";
}

export function createAskQuestionTool(agentId = "") {
	const toolConfig = getAskQuestionToolConfig(agentId);

	return tool(
		async ({ questions }: AskQuestionInput, config: RunnableConfig & { runId?: string }) => {
			const threadId = resolveThreadIdFromConfig(config);
			const toolCallId = (config as { toolCallId?: string })?.toolCallId ?? config?.runId ?? genUUIDv7();

			Logger.log("[ask_question] Prompting user with questions:", {
				threadId,
				toolCallId,
				count: questions.length,
			});

			const formattedQuestions: QuestionItem[] = questions.map((q, index) => ({
				id: q.id?.trim() || `q_${index + 1}`,
				question: q.question,
				options: q.options,
				isMultiSelect: q.is_multi_select ?? false,
				allowCustom: q.allow_custom ?? true,
			}));

			const store = getPendingQuestionStore();
			const answers = await store.ask(threadId, toolCallId, formattedQuestions, config?.signal);

			return JSON.stringify(
				{
					status: "answered",
					answers,
				},
				null,
				2,
			);
		},
		{
			name: toolConfig?.name ?? DEFAULT_TOOLS_CONFIG.ask_question.name,
			description: toolConfig?.description ?? DEFAULT_TOOLS_CONFIG.ask_question.description,
			schema: askQuestionSchema,
		},
	);
}
