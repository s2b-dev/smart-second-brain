import { describe, expect, it, vi } from "vitest";
import {
	RealtimeClient,
	type WebSocketLike,
	buildRealtimeUrl,
	buildSubprotocols,
} from "../../src/voice/realtimeClient";

class FakeSocket implements WebSocketLike {
	readyState = 0;
	sent: string[] = [];
	closed: { code?: number; reason?: string } | null = null;
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;

	send(data: string) {
		this.sent.push(data);
	}
	close(code?: number, reason?: string) {
		this.closed = { code, reason };
		this.readyState = 3;
		this.onclose?.({ code: code ?? 1000, reason: reason ?? "", wasClean: true });
	}
	open() {
		this.readyState = 1;
		this.onopen?.({});
	}
	emit(event: object) {
		this.onmessage?.({ data: JSON.stringify(event) });
	}
}

function makeClient(overrides: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
	const socket = new FakeSocket();
	const client = new RealtimeClient({
		model: "gpt-realtime",
		apiKey: "sk-test",
		socketFactory: () => socket,
		connectTimeoutMs: 50,
		...overrides,
	});
	return { socket, client };
}

describe("realtime URL + auth", () => {
	it("derives the socket URL from the HTTP base and encodes the model", () => {
		expect(buildRealtimeUrl("gpt-realtime")).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime");
		expect(buildRealtimeUrl("a/b", "http://localhost:8080/v1/")).toBe(
			"ws://localhost:8080/v1/realtime?model=a%2Fb",
		);
	});

	it("carries the key in the insecure-api-key subprotocol", () => {
		expect(buildSubprotocols("sk-x")).toEqual(["realtime", "openai-insecure-api-key.sk-x"]);
	});
});

describe("RealtimeClient", () => {
	it("resolves connect on session.created and dispatches later events", async () => {
		const { socket, client } = makeClient();
		const seen: string[] = [];
		client.onEvent((ev) => seen.push(ev.type));

		const connecting = client.connect();
		socket.open();
		socket.emit({ type: "session.created", session: {} });
		await connecting;

		socket.emit({ type: "response.created", response: { id: "r1" } });
		socket.emit({ type: "something.else" });
		expect(seen).toEqual(["session.created", "response.created", "unknown"]);
		expect(client.isOpen).toBe(true);
	});

	it("rejects when the server answers with an error before the session starts", async () => {
		const { socket, client } = makeClient();
		const connecting = client.connect();
		socket.open();
		socket.emit({ type: "error", error: { message: "bad key" } });
		await expect(connecting).rejects.toThrow("bad key");
	});

	it("rejects when the socket closes before the session starts", async () => {
		const { socket, client } = makeClient();
		const connecting = client.connect();
		socket.close(1008, "policy");
		await expect(connecting).rejects.toThrow("1008");
	});

	it("rejects on timeout and closes the socket", async () => {
		vi.useFakeTimers();
		try {
			const { socket, client } = makeClient();
			const connecting = client.connect();
			vi.advanceTimersByTime(60);
			await expect(connecting).rejects.toThrow("Timed out");
			expect(socket.closed).not.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("serialises sends while open and drops them otherwise", async () => {
		const { socket, client } = makeClient();
		client.send({ type: "early" });
		expect(socket.sent).toEqual([]);
		const connecting = client.connect();
		socket.open();
		socket.emit({ type: "session.created" });
		await connecting;
		client.send({ type: "response.create" });
		expect(socket.sent).toEqual(['{"type":"response.create"}']);
	});

	it("reports unexpected closes but not the ones it initiated", async () => {
		const { socket, client } = makeClient();
		const closes: number[] = [];
		client.onClose((info) => closes.push(info.code));
		const connecting = client.connect();
		socket.open();
		socket.emit({ type: "session.created" });
		await connecting;

		client.close();
		expect(closes).toEqual([]);
		expect(socket.closed?.code).toBe(1000);

		const second = makeClient();
		second.client.onClose((info) => closes.push(info.code));
		const c2 = second.client.connect();
		second.socket.open();
		second.socket.emit({ type: "session.created" });
		await c2;
		second.socket.close(1011, "server went away");
		expect(closes).toEqual([1011]);
	});
});
