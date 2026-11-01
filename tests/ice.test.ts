import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../phone/functions/ice";

interface IceBody {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
}

const TURN_URLS = [
  "stun:stun.cloudflare.com:3478",
  "stun:stun.cloudflare.com:53",
  "turn:turn.cloudflare.com:3478?transport=udp",
  "turn:turn.cloudflare.com:53?transport=udp",
  "turn:turn.cloudflare.com:3478?transport=tcp",
  "turns:turn.cloudflare.com:5349?transport=tcp",
  "turns:turn.cloudflare.com:443?transport=tcp",
];

const KEYS = { TURN_KEY_ID: "id", TURN_KEY_TOKEN: "token" };

async function servers(env: Parameters<typeof onRequestGet>[0]["env"]): Promise<IceBody["iceServers"]> {
  const response = await onRequestGet({ env });
  return ((await response.json()) as IceBody).iceServers;
}

function cloudflareAnswers(iceServers: unknown, status = 201): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ iceServers }), { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe("the servers the page and the app are told to use", () => {
  it("is STUN alone until a TURN key is set", async () => {
    expect(await servers({})).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  });

  it("adds Cloudflare's TURN servers, keeping their credentials", async () => {
    cloudflareAnswers({ urls: TURN_URLS, username: "u", credential: "c" });
    const [, turn] = await servers(KEYS);
    expect(turn.username).toBe("u");
    expect(turn.credential).toBe("c");
    expect(turn.urls).toContain("turns:turn.cloudflare.com:443?transport=tcp");
  });

  it("leaves out port 53, and only port 53", async () => {
    cloudflareAnswers([{ urls: TURN_URLS, username: "u", credential: "c" }]);
    const [, turn] = await servers(KEYS);
    expect(turn.urls).toHaveLength(TURN_URLS.length - 2);
    expect(turn.urls).not.toContain("turn:turn.cloudflare.com:53?transport=udp");
    expect(turn.urls).not.toContain("stun:stun.cloudflare.com:53");
  });

  it("falls back on STUN if Cloudflare refuses", async () => {
    cloudflareAnswers(null, 403);
    expect(await servers(KEYS)).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  });
});
