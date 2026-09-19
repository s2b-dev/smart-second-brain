import { describe, expect, it } from "vitest";
import "../__mocks__/obsidian";
import { CURRENT_SCHEMA_VERSION, runMigrations } from "../../src/stores/dataMigrations";
import { DEFAULT_VOICE_SETTINGS } from "../../src/stores/voiceDefaults";
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

	it("v13 → v14 seeds the voice settings block and leaves an existing one alone", () => {
		const fresh = { schemaVersion: 13, agents: {} } as unknown as PluginData;
		runMigrations(fresh);
		expect(fresh.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(fresh.voice).toEqual(DEFAULT_VOICE_SETTINGS);
		expect(fresh.voice).not.toBe(DEFAULT_VOICE_SETTINGS);

		const custom = { enabled: true, model: "gpt-realtime-mini", voice: "cedar", turnDetection: "server_vad" };
		const kept = { schemaVersion: 13, agents: {}, voice: { ...custom } } as unknown as PluginData;
		runMigrations(kept);
		expect(kept.voice).toEqual(custom);
	});
});
