// remote-play/functions/ice.ts
//
// The servers WebRTC uses to find a way between PC and phone. STUN alone
// connects most networks. Some mobile carriers need a TURN relay as well: set
// the TURN_KEY_ID and TURN_KEY_TOKEN secrets on the Pages project and short-lived
// Cloudflare TURN credentials are handed out here. Media stays encrypted end to
// end either way.

interface IceContext {
  env: { TURN_KEY_ID?: string; TURN_KEY_TOKEN?: string };
}

const STUN = { urls: ["stun:stun.cloudflare.com:3478"] };
const TURN_TTL_SECONDS = 6 * 60 * 60;

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  // The PC app calls this from its own origin.
  "Access-Control-Allow-Origin": "*",
};

async function turnServers(env: IceContext["env"]): Promise<unknown> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return null;
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TURN_KEY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { iceServers?: unknown };
  return body.iceServers ?? null;
}

/** Cloudflare also lists port 53, which browsers won't use. */
function withoutPort53(server: { urls?: string | string[] }): unknown {
  return { ...server, urls: [server.urls ?? []].flat().filter((url) => !/:53(\?|$)/.test(url)) };
}

export async function onRequestGet({ env }: IceContext): Promise<Response> {
  const turn = await turnServers(env).catch(() => null);
  const iceServers = turn === null ? [STUN] : [STUN, ...(Array.isArray(turn) ? turn : [turn]).map(withoutPort53)];
  return new Response(JSON.stringify({ iceServers }), { headers: HEADERS });
}
