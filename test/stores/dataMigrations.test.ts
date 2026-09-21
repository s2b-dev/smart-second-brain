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

	it("v14 → v15 seeds the voice settings block and fills keys a stored one lacks", () => {
		const fresh = { schemaVersion: 14, agents: {} } as unknown as PluginData;
		runMigrations(fresh);
		expect(fresh.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(fresh.voice).toEqual(DEFAULT_VOICE_SETTINGS);
		expect(fresh.voice).not.toBe(DEFAULT_VOICE_SETTINGS);

		const partial = {
			schemaVersion: 14,
			agents: {},
			voice: { enabled: true, model: "gpt-realtime-mini", voice: "cedar", turnDetection: "server_vad" },
		} as unknown as PluginData;
		runMigrations(partial);
		expect(partial.voice).toEqual({
			enabled: true,
			model: "gpt-realtime-mini",
			voice: "cedar",
			turnDetection: "server_vad",
			orbStyle: DEFAULT_VOICE_SETTINGS.orbStyle,
		});
	});
});
