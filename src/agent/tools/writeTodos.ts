import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { BUILT_IN_TOOL_DEFAULTS } from "./builtInToolDefaults";
import { resolveToolAgent } from "./toolAgentContext";
import { TODO_STATUSES, type TodoItem } from "../../utils/todoList";

const todoSchema = z.object({
	todos: z
		.array(
			z.object({
				content: z.string().describe("The step, as a short imperative phrase."),
				status: z.enum(TODO_STATUSES).describe("pending, in_progress (at most one), or completed."),
			}),
		)
		.describe("The whole list, in order. Every call replaces the previous list."),
});

/**
 * The agent's visible task list. The tool holds no state: each call carries the whole
 * list, and the chat derives what it shows from the latest call on the active branch
 * (`latestTodos` in `utils/todoList.ts`), so the list follows edits, regenerations and
 * branch switches exactly as the transcript does. The model sees its own last call in the
 * history, which is all the memory the list needs.
 */
export function createWriteTodosTool(agentId = "") {
	const toolConfig = resolveToolAgent(agentId).toolsConfig.write_todos;
	const fallback = BUILT_IN_TOOL_DEFAULTS.write_todos.config;

	return tool(
		async ({ todos }: { todos: TodoItem[] }): Promise<string> => {
			const done = todos.filter((t) => t.status === "completed").length;
			const current = todos.find((t) => t.status === "in_progress");
			const progress = `${done} of ${todos.length} completed`;
			return current
				? `Task list updated: ${progress}; in progress: ${current.content}`
				: `Task list updated: ${progress}.`;
		},
		{
			name: toolConfig?.name ?? fallback.name,
			description: toolConfig?.description ?? fallback.description,
			schema: todoSchema,
		},
	);
}
