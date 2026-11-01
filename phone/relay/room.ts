// remote-play/relay/room.ts
//
// One Remote Play room: at most one PC and one phone, and whatever one side
// sends goes to the other unread. Security doesn't rest on anything here. The
// messages are sealed end to end (shared/remotePlay.ts), so this only has to
// be cheap and small. WebSockets hibernate between messages, so a PC waiting
// all day for its phone costs next to nothing.

import { RELAY_REPLACED_CODE } from "../../shared/remotePlay";

interface RelaySocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

export interface RoomState {
  acceptWebSocket(socket: RelaySocket, tags: string[]): void;
  getWebSockets(tag?: string): RelaySocket[];
  getTags(socket: RelaySocket): string[];
  setWebSocketAutoResponse(pair: unknown): void;
}

declare const WebSocketPair: { new (): { 0: RelaySocket; 1: RelaySocket } };
declare const WebSocketRequestResponsePair: { new (request: string, response: string): unknown };

type Role = "host" | "phone";

/** Sealed SDP with its candidates fits well inside this. */
export const MAX_MESSAGE_LENGTH = 32 * 1024;

function otherRole(role: string): Role {
  return role === "host" ? "phone" : "host";
}

export class Room {
  private readonly state: RoomState;

  constructor(state: RoomState) {
    this.state = state;
    // Answered at the edge, without waking this object.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get("role");
    if (role !== "host" && role !== "phone") return new Response("unknown role", { status: 400 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected a websocket", { status: 426 });

    // A reconnect takes over from a socket the network dropped silently.
    for (const stale of this.state.getWebSockets(role)) stale.close(RELAY_REPLACED_CODE, "replaced");

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [role]);
    this.announce();
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  webSocketMessage(socket: RelaySocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > MAX_MESSAGE_LENGTH) return;
    const [role] = this.state.getTags(socket);
    for (const peer of this.state.getWebSockets(otherRole(role))) peer.send(message);
  }

  webSocketClose(socket: RelaySocket): void {
    this.announce(socket);
  }

  webSocketError(socket: RelaySocket): void {
    this.announce(socket);
  }

  /** Tell both sides who is here, so the phone can say the PC is offline. */
  private announce(leaving?: RelaySocket): void {
    const present = (role: Role) => this.state.getWebSockets(role).some((socket) => socket !== leaving);
    const notice = JSON.stringify({ relay: "peers", host: present("host"), phone: present("phone") });
    for (const socket of this.state.getWebSockets()) {
      if (socket === leaving) continue;
      try {
        socket.send(notice);
      } catch {
        // Already closing; its own close event will follow.
      }
    }
  }
}
