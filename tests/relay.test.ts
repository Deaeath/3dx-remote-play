import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MESSAGE_LENGTH, Room, type RoomState } from "../phone/relay/room";

class FakeSocket {
  sent: string[] = [];
  closed: number | null = null;
  send(message: string) {
    this.sent.push(message);
  }
  close(code?: number) {
    this.closed = code ?? 1000;
  }
}

/** The Durable Object's hibernation API, enough to drive a room. */
class FakeState implements RoomState {
  sockets = new Map<FakeSocket, string[]>();
  autoResponse: unknown = null;
  acceptWebSocket(socket: FakeSocket, tags: string[]) {
    this.sockets.set(socket, tags);
  }
  getWebSockets(tag?: string) {
    return [...this.sockets].filter(([socket, tags]) => socket.closed === null && (!tag || tags.includes(tag))).map(([socket]) => socket);
  }
  getTags(socket: FakeSocket) {
    return this.sockets.get(socket) ?? [];
  }
  setWebSocketAutoResponse(pair: unknown) {
    this.autoResponse = pair;
  }
}

function upgrade(role: string | null, headers: Record<string, string> = { Upgrade: "websocket" }) {
  const query = role ? `?role=${role}` : "";
  return new Request(`https://play.example/ws/room${query}`, { headers });
}

let state: FakeState;
let room: Room;

async function join(role: "host" | "phone"): Promise<FakeSocket> {
  await room.fetch(upgrade(role));
  return state.getWebSockets(role)[0] as FakeSocket;
}

const lastNotice = (socket: FakeSocket) => JSON.parse(socket.sent.at(-1) ?? "null") as unknown;

beforeEach(() => {
  vi.stubGlobal("WebSocketRequestResponsePair", class {
    constructor(
      public request: string,
      public response: string,
    ) {}
  });
  vi.stubGlobal("WebSocketPair", class {
    0 = new FakeSocket();
    1 = new FakeSocket();
  });
  // Only a Worker may answer 101; the platform's Response refuses it elsewhere.
  vi.stubGlobal("Response", class {
    status: number;
    constructor(_body: unknown, init?: { status?: number }) {
      this.status = init?.status ?? 200;
    }
  });
  state = new FakeState();
  room = new Room(state);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Remote Play relay room", () => {
  it("answers keep-alive pings at the edge, without waking", () => {
    expect(state.autoResponse).toMatchObject({ request: "ping", response: "pong" });
  });

  it("carries messages between the PC and the phone", async () => {
    const host = await join("host");
    const phone = await join("phone");
    room.webSocketMessage(phone, "sealed-offer");
    room.webSocketMessage(host, "sealed-answer");
    expect(host.sent).toContain("sealed-offer");
    expect(phone.sent).toContain("sealed-answer");
  });

  it("never echoes a message to its sender", async () => {
    const host = await join("host");
    await join("phone");
    room.webSocketMessage(host, "sealed-answer");
    expect(host.sent).not.toContain("sealed-answer");
  });

  it("tells both sides who is here", async () => {
    const host = await join("host");
    expect(lastNotice(host)).toEqual({ relay: "peers", host: true, phone: false });
    const phone = await join("phone");
    expect(lastNotice(host)).toEqual({ relay: "peers", host: true, phone: true });
    expect(lastNotice(phone)).toEqual({ relay: "peers", host: true, phone: true });
  });

  it("tells the phone when the PC goes away", async () => {
    const host = await join("host");
    const phone = await join("phone");
    host.closed = 1006;
    room.webSocketClose(host);
    expect(lastNotice(phone)).toEqual({ relay: "peers", host: false, phone: true });
  });

  it("lets a reconnect replace a socket the network dropped", async () => {
    const first = await join("phone");
    await room.fetch(upgrade("phone"));
    expect(first.closed).toBe(4000);
    expect(state.getWebSockets("phone")).toHaveLength(1);
  });

  it("drops binary and oversized messages", async () => {
    const host = await join("host");
    const phone = await join("phone");
    const before = host.sent.length;
    room.webSocketMessage(phone, new ArrayBuffer(8));
    room.webSocketMessage(phone, "x".repeat(MAX_MESSAGE_LENGTH + 1));
    expect(host.sent).toHaveLength(before);
  });

  it("refuses anything but a websocket with a known role", async () => {
    expect((await room.fetch(upgrade(null))).status).toBe(400);
    expect((await room.fetch(upgrade("admin"))).status).toBe(400);
    expect((await room.fetch(upgrade("host", {}))).status).toBe(426);
    expect(state.getWebSockets()).toHaveLength(0);
  });
});
