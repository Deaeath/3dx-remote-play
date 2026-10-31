// remote-play/relay/worker.ts
//
// Hosts the Room Durable Object. This Worker has no public URL of its own
// (wrangler.toml): the Pages site in functions/ is the only way in.

export { Room } from "./room";

export default {
  fetch: () => new Response("not found", { status: 404 }),
};
