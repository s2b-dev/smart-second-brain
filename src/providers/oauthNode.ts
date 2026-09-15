/**
 * Node-backed helpers for the loopback-server OAuth flows (OpenRouter,
 * OpenAI Codex).
 *
 * These flows spin up a localhost HTTP server to catch the browser redirect,
 * which requires `node:http` — unavailable on Obsidian mobile. To keep the
 * provider modules loadable on mobile (a static `import "node:http"` throws at
 * module-eval time in the mobile WebView), `node:http` is resolved lazily via
 * Electron's `require` only when a sign-in is actually attempted. The UI gates
 * these sign-in paths as desktop-only, so mobile never reaches them; this is a
 * defense-in-depth fallback that fails with a clear message.
 */

/**
 * Type-only views of `node:http`. Expressed as `import()` type queries rather than
 * an `import type` declaration so nothing — not even a type-only statement — names
 * a Node builtin at the module top; the runtime module is reached only through
 * {@link requireNodeHttp}.
 */
export type NodeHttpServer = import("node:http").Server;
export type NodeHttpIncomingMessage = import("node:http").IncomingMessage;
export type NodeHttpServerResponse = import("node:http").ServerResponse;
type CreateServer = typeof import("node:http").createServer;

/** Lazily resolve `node:http`'s `createServer` via Electron's exposed require. */
export function requireNodeHttp(): CreateServer {
	const req = (window as { require?: (id: string) => unknown }).require;
	if (typeof req !== "function") {
		throw new Error("OAuth sign-in requires a desktop environment (node:http is unavailable).");
	}
	const http = req("http") as { createServer: CreateServer };
	return http.createServer;
}

/** base64url-encode an ArrayBuffer using web primitives (no Node Buffer). */
export function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
	return uint8ToBase64Url(new Uint8Array(buffer));
}

/** base64url-encode raw bytes. */
export function uint8ToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a base64url string to a UTF-8 string (inverse of the encoders above). */
export function base64UrlToString(input: string): string {
	const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder("utf-8").decode(bytes);
}
