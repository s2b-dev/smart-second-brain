import { EV, type ServerEvent, parseServerEvent } from "./realtimeProtocol";

/**
 * Thin wrapper over a browser `WebSocket` for one Realtime session.
 *
 * Browser sockets cannot carry an `Authorization` header, so the key travels in the
 * `openai-insecure-api-key.<key>` subprotocol the API accepts for client-side use.
 * (Obsidian is a local desktop app and the key already lives on this machine; a
 * hosted product would mint an ephemeral client secret server-side instead.)
 *
 * No reconnect: the prototype tears the session down on any close and the user
 * starts it again.
 */

export interface WebSocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
	onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null;
}

export type SocketFactory = (url: string, protocols: string[]) => WebSocketLike;

export interface RealtimeClientOptions {
	model: string;
	apiKey: string;
	/** HTTP(S) API base, e.g. `https://api.openai.com/v1`. Converted to the socket scheme. */
	baseUrl?: string;
	connectTimeoutMs?: number;
	socketFactory?: SocketFactory;
}

export interface CloseInfo {
	code: number;
	reason: string;
	wasClean: boolean;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const WS_OPEN = 1;

export function buildRealtimeUrl(model: string, baseUrl = DEFAULT_BASE_URL): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	const socketBase = trimmed.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
	return `${socketBase}/realtime?model=${encodeURIComponent(model)}`;
}

export function buildSubprotocols(apiKey: string): string[] {
	return ["realtime", `openai-insecure-api-key.${apiKey}`];
}

export class RealtimeClient {
	private socket: WebSocketLike | null = null;
	private eventHandlers = new Set<(event: ServerEvent) => void>();
	private closeHandlers = new Set<(info: CloseInfo) => void>();
	private closedByUs = false;

	constructor(private readonly options: RealtimeClientOptions) {}

	get isOpen(): boolean {
		return this.socket?.readyState === WS_OPEN;
	}

	/** Open the socket and resolve once the server has acknowledged the session. */
	connect(): Promise<void> {
		if (this.socket) throw new Error("Realtime client is already connected.");
		const factory: SocketFactory =
			this.options.socketFactory ??
			((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
		const socket = factory(
			buildRealtimeUrl(this.options.model, this.options.baseUrl),
			buildSubprotocols(this.options.apiKey),
		);
		this.socket = socket;
		this.closedByUs = false;

		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				socket.close();
				reject(new Error("Timed out waiting for the realtime session to start."));
			}, this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				fn();
			};

			socket.onopen = () => {
				// Nothing to do: the session is usable only after `session.created`.
			};
			socket.onmessage = (ev) => {
				if (typeof ev.data !== "string") return;
				const event = parseServerEvent(ev.data);
				if (event.type === EV.sessionCreated) settle(resolve);
				if (event.type === EV.error && !settled) {
					settle(() => reject(new Error(event.error.message ?? "The realtime session was refused.")));
					return;
				}
				for (const handler of this.eventHandlers) handler(event);
			};
			socket.onerror = () => {
				settle(() => reject(new Error("Could not connect to the realtime API.")));
			};
			socket.onclose = (ev) => {
				settle(() =>
					reject(new Error(`The realtime connection closed before the session started (${ev.code}).`)),
				);
				this.socket = null;
				if (this.closedByUs) return;
				for (const handler of this.closeHandlers) handler(ev);
			};
		});
	}

	send(event: object): void {
		if (!this.socket || this.socket.readyState !== WS_OPEN) return;
		this.socket.send(JSON.stringify(event));
	}

	onEvent(handler: (event: ServerEvent) => void): () => void {
		this.eventHandlers.add(handler);
		return () => this.eventHandlers.delete(handler);
	}

	/** Fires only for closes the client did not initiate. */
	onClose(handler: (info: CloseInfo) => void): () => void {
		this.closeHandlers.add(handler);
		return () => this.closeHandlers.delete(handler);
	}

	close(): void {
		const socket = this.socket;
		if (!socket) return;
		this.closedByUs = true;
		this.socket = null;
		try {
			socket.close(1000, "voice mode stopped");
		} catch {
			// Already closed.
		}
	}
}
