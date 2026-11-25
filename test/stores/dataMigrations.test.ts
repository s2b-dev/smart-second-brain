import { describe, expect, it } from "vitest";
import "../__mocks__/obsidian";
import { CURRENT_SCHEMA_VERSION, runMigrations } from "../../src/stores/dataMigrations";
import type { PluginData } from "../../src/types/plugin";

describe("dataMigrations", () => {
	it("v12 → v13 drops stdio MCP servers and keeps HTTP ones", () => {
		const data = {
			schemaVersion: 12,
			agents: {
				a1: {
					mcpServers: {
						local: { displayName: "local", transport: "stdio", command: "npx", args: [], enabled: true },
						remote: {
							displayName: "remote",
							transport: "http",
							url: "http://localhost:3000/mcp",
							enabled: true,
						},
					},
				},
				a2: {},
			},
		} as unknown as PluginData;

		runMigrations(data);

		expect(data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(Object.keys(data.agents.a1.mcpServers)).toEqual(["remote"]);
		expect(data.agents.a2.mcpServers).toBeUndefined();
	});

	// The stored false was the old seed, not a choice, so it is flipped rather than kept.
	it("v13 → v14 switches manage_skills on for every agent that has it", () => {
		const data = {
			schemaVersion: 13,
			agents: {
				a1: { toolsConfig: { manage_skills: { enabled: false, name: "manage_skills" } } },
				a2: { toolsConfig: { manage_skills: { enabled: true, name: "manage_skills" } } },
				a3: { toolsConfig: {} },
				a4: {},
			},
		} as unknown as PluginData;

		runMigrations(data);

		expect(data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(data.agents.a1.toolsConfig.manage_skills).toEqual({ enabled: true, name: "manage_skills" });
		expect(data.agents.a2.toolsConfig.manage_skills.enabled).toBe(true);
		expect(data.agents.a3.toolsConfig.manage_skills).toBeUndefined();
		expect(data.agents.a4.toolsConfig).toBeUndefined();
	});

	// Custom base URLs became "used as given"; saved ones keep resolving where they did.
	it("v14 → v15 pins the old /v1 suffix on saved Custom base URLs", () => {
		const custom = (baseUrl?: string) => ({
			auth: { values: baseUrl === undefined ? {} : { baseUrl }, secretIds: {} },
		});
		const data = {
			schemaVersion: 14,
			providerMeta: {
				gateway: { templateId: "openai-compatible", displayName: "Gateway" },
				slash: { templateId: "openai-compatible", displayName: "Slash" },
				v1: { templateId: "openai-compatible", displayName: "V1" },
				host: { templateId: "openai-compatible", displayName: "Host" },
				zai: { templateId: "openai-compatible", displayName: "Z" },
				empty: { templateId: "openai-compatible", displayName: "Empty" },
				ollama: { templateId: "ollama", displayName: "Ollama" },
			},
			providerConfig: {
				gateway: custom("https://gateway.example/openai"),
				slash: custom("https://proxy.example/litellm/"),
				v1: custom("https://api.example.com/v1"),
				host: custom("http://localhost:8000"),
				zai: custom("https://api.z.ai/api/paas/v4"),
				empty: custom(),
				ollama: custom("http://localhost:11434/api"),
			},
		} as unknown as PluginData;

		runMigrations(data);

		const url = (id: string) => data.providerConfig[id].auth.values.baseUrl;
		expect(data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(url("gateway")).toBe("https://gateway.example/openai/v1");
		expect(url("slash")).toBe("https://proxy.example/litellm/v1");
		expect(url("v1")).toBe("https://api.example.com/v1");
		expect(url("host")).toBe("http://localhost:8000");
		expect(url("zai")).toBe("https://api.z.ai/api/paas/v4");
		expect(url("empty")).toBeUndefined();
		expect(url("ollama")).toBe("http://localhost:11434/api");
	});
});
