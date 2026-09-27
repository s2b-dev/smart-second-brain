import { flushSync } from "svelte";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("../__mocks__/obsidian"));

const agents = { "default-agent": { id: "default-agent", name: "S2B Agent" } };
import { installAgentPathSource } from "../../src/utils/agentPathSource";
installAgentPathSource({
	agentFolder: () => "Agents",
	agentName: (agentId) => agents[agentId as keyof typeof agents]?.name,
});
vi.mock("../../src/stores/dataStore.svelte", () => ({
	getData: () => ({ agentFolder: "Agents", agents }),
}));

import { PromptFilesService, serializePromptFile } from "../../src/agent/promptFiles";
import { AGENT_PROMPT_VERSION, DEFAULT_AGENT_PROMPT } from "../../src/agent/prompts";
import { computeStaleGuidance } from "../../src/stores/staleGuidance";
import type { AgentsConfig } from "../../src/types/plugin";
import { agentDefinitionPath } from "../../src/utils/agentPaths";
import { makeVaultFake } from "./promptFilesVaultFake";

// The update notice is a `$derived` over the prompt-file cache. With a plain Map, accepting
// the default in the diff modal wrote the note but never re-ran the derived, so the notice
// stayed up until reload — and clicking it again opened a diff with nothing to show.
describe("PromptFilesService cache reactivity", () => {
	it("clears the stale-prompt notice as soon as the default is written", async () => {
		const path = agentDefinitionPath("default-agent");
		// A customization written against an older default: the drift notice is owed.
		const fake = makeVaultFake({ [path]: serializePromptFile("my own prompt", AGENT_PROMPT_VERSION - 1) });
		const service = new PromptFilesService({ vault: fake.vault, fileManager: fake.fileManager } as never);
		await service.refresh(agents as unknown as AgentsConfig);

		let staleCount = -1;
		const cleanup = $effect.root(() => {
			const stale = $derived(computeStaleGuidance(agents as unknown as AgentsConfig, service.reader, []));
			$effect(() => {
				staleCount = stale.length;
			});
		});
		flushSync();
		expect(staleCount).toBe(1);

		await service.writeAgentPrompt("default-agent", DEFAULT_AGENT_PROMPT);
		flushSync();
		expect(staleCount).toBe(0);

		cleanup();
	});
});
