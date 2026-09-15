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
});
