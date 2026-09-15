/**
 * Build-time replacement for `@modelcontextprotocol/sdk/client/stdio.js`.
 *
 * The real module spawns a local process through `child_process`, which is the
 * one thing that gives an Obsidian plugin shell access — and the reason the
 * plugin review flags "Shell Execution". Smart Second Brain only speaks MCP over
 * HTTP, so `vite.config.ts` aliases the SDK's stdio transport to this file: the
 * bundle then contains no `child_process` at all, and a config that somehow still
 * names a stdio server fails loudly here instead of spawning anything.
 *
 * `@langchain/mcp-adapters` imports only `StdioClientTransport`; the other two
 * exports mirror the SDK's surface so the alias stays a drop-in.
 */

export const DEFAULT_INHERITED_ENV_VARS: string[] = [];

export function getDefaultEnvironment(): Record<string, string> {
	return {};
}

export class StdioClientTransport {
	constructor() {
		throw new Error(
			"MCP stdio transport is not available in Smart Second Brain — connect to the server over HTTP.",
		);
	}
}
