// remote-play/functions/ws/[room].ts
//
// The relay's front door: a websocket for a room goes to that room's object.

interface RoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

interface RoomContext {
  request: Request;
  env: { ROOMS: RoomNamespace };
  params: { room: string };
}

export function onRequestGet({ request, env, params }: RoomContext): Promise<Response> | Response {
  if (!/^[0-9a-f]{32}$/.test(params.room)) return new Response("unknown room", { status: 404 });
  return env.ROOMS.get(env.ROOMS.idFromName(params.room)).fetch(request);
}
