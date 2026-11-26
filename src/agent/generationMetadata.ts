import { AIMessage } from "@langchain/core/messages";
import { getConfig } from "@langchain/langgraph";
import { createMiddleware } from "langchain";

/**
 * Which agent and model produced a reply, stamped into the reply's
 * `response_metadata` so the chat can label each turn after a reload
 * (`chatTimeline.ts` reads `agent_id`, `agent_name`, `model_provider`, `model`).
 *
 * The values come from the run's `config.metadata` (`AgentManager.buildRunMetadata`).
 * They are stamped on the live message, before LangGraph stores it, because the
 * `messages` channel is persisted as per-step writes plus periodic snapshots of
 * the live state: a stamp applied to a stored copy afterwards would be missing
 * from every later snapshot.
 */
export interface GenerationMetadata {
	agentId?: string;
	agentName?: string;
	provider?: string;
	model?: string;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readGenerationMetadata(metadata: Record<string, unknown> | undefined): GenerationMetadata {
	return {
		agentId: readString(metadata, "agent_id"),
		agentName: readString(metadata, "agent_name"),
		provider: readString(metadata, "model_provider"),
		model: readString(metadata, "model"),
	};
}

/**
 * Stamp generation metadata onto an AI message, in place. The agent is always
 * recorded; provider and model only fill in what the provider didn't report.
 */
export function stampGenerationMetadata(message: AIMessage, generation: GenerationMetadata): void {
	if (!generation.agentId && !generation.agentName && !generation.provider && !generation.model) return;
	if (!message.response_metadata) message.response_metadata = {};
	const metadata = message.response_metadata as Record<string, unknown>;
	if (generation.agentId) metadata.agent_id = generation.agentId;
	if (generation.agentName) metadata.agent_name = generation.agentName;
	if (!readString(metadata, "model_provider") && generation.provider) metadata.model_provider = generation.provider;
	if (!readString(metadata, "model") && generation.model) metadata.model = generation.model;
}

function currentRunMetadata(): Record<string, unknown> | undefined {
	try {
		return getConfig()?.metadata;
	} catch {
		return undefined; // outside a graph run (tests calling the model directly)
	}
}

/** Stamps each model reply with the agent and model that produced it. */
export function createGenerationMetadataMiddleware() {
	return createMiddleware({
		name: "S2BGenerationMetadata",
		wrapModelCall: async (request, handler) => {
			// Read the run's metadata before awaiting: on mobile the AsyncLocalStorage
			// shim may no longer hold the run's config once the model call resolves.
			const generation = readGenerationMetadata(currentRunMetadata());
			const response = await handler(request);
			if (AIMessage.isInstance(response)) stampGenerationMetadata(response, generation);
			return response;
		},
	});
}
