import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { MAX_OPTIONS, MAX_QUESTIONS } from "../../utils/askQuestion";
import { PAUSES_FOR_USER } from "../toolInterrupts";
import { BUILT_IN_TOOL_DEFAULTS } from "./builtInToolDefaults";
import { resolveToolAgent } from "./toolAgentContext";

const askQuestionSchema = z.object({
	questions: z
		.array(
			z.object({
				question: z.string().describe("The full question, ending in a question mark."),
				header: z
					.string()
					.optional()
					.describe('One to three words naming what the question is about, e.g. "Folder" or "Date format".'),
				options: z
					.array(
						z.object({
							label: z.string().describe("The choice, in a few words."),
							description: z
								.string()
								.optional()
								.describe("One short line on what picking this choice means."),
						}),
					)
					.min(2)
					.max(MAX_OPTIONS)
					.describe(
						`2 to ${MAX_OPTIONS} distinct choices. Put the one you recommend first. Never add an "Other" choice: the user can always type their own answer.`,
					),
				multiSelect: z
					.boolean()
					.optional()
					.describe("true when several choices can apply at once. Default false: the user picks one."),
			}),
		)
		.min(1)
		.max(MAX_QUESTIONS)
		.describe(`1 to ${MAX_QUESTIONS} questions, shown to the user together.`),
});

/**
 * Lets the agent stop mid-turn and ask the user. The tool body never runs in a chat: the
 * human-in-the-loop middleware (see `toolInterrupts.ts`) pauses every call to a tool
 * marked {@link PAUSES_FOR_USER} before it executes, and the user's answer is written as
 * the tool result. The body only answers for a run with no one to ask.
 */
export function createAskQuestionTool(agentId = "") {
	const toolConfig = resolveToolAgent(agentId).toolsConfig.ask_question;
	const fallback = BUILT_IN_TOOL_DEFAULTS.ask_question.config;

	return tool(
		async (): Promise<string> =>
			"No user is available to answer in this run. Continue with your best judgement and state the assumption you made.",
		{
			name: toolConfig?.name ?? fallback.name,
			description: toolConfig?.description ?? fallback.description,
			schema: askQuestionSchema,
			metadata: { [PAUSES_FOR_USER]: true },
		},
	);
}
