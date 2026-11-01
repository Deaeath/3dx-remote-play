import { describe, expect, it } from "vitest";
import {
  PLAY_ORIGIN,
  createRoom,
  createSecret,
  credentialToUse,
  isCredential,
  isFreshOffer,
  linkFor,
  parseLinkFragment,
  parseRelayNotice,
  routeKinds,
  seal,
  signalKey,
  unseal,
  type SignalMessage,
} from "../shared/remotePlay";

const credential = () => ({ room: createRoom(), secret: createSecret() });
const offer: SignalMessage = { t: "offer", sdp: "v=0", at: 1000, name: "iPhone" };

describe("the routes in an SDP", () => {
  const line = (address: string, kind: string) => `a=candidate:1 1 udp 2122260223 ${address} 5000 typ ${kind} generation 0`;

  it("names the kinds and never an address", () => {
    const sdp = ["v=0", line("abc.local", "host"), line("192.168.1.5", "host"), line("203.0.113.9", "srflx"), line("198.51.100.7", "relay"), ""].join("\r\n");
    expect(routeKinds(sdp)).toBe("host, mdns, relay, srflx");
  });

  it("says so when there are none", () => {
    expect(routeKinds("v=0\r\nm=audio 9 X 111\r\n")).toBe("none");
  });

  it("isn't fooled by a line that only looks like a route", () => {
    expect(routeKinds("a=note:candidate typ srflx\r\n")).toBe("none");
  });
});

describe("Remote Play links", () => {
  it("round-trips a credential through the link's fragment", () => {
    const ours = credential();
    const link = linkFor(ours);
    expect(link.startsWith(`${PLAY_ORIGIN}/#`)).toBe(true);
    expect(parseLinkFragment(new URL(link).hash)).toEqual(ours);
  });

  it("keeps the secret out of what a server ever sees", () => {
    const ours = credential();
    const url = new URL(linkFor(ours));
    expect(`${url.origin}${url.pathname}${url.search}`).not.toContain(ours.secret);
    expect(`${url.origin}${url.pathname}${url.search}`).not.toContain(ours.room);
  });

  it("makes a different room and secret every time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => JSON.stringify(credential())));
    expect(seen.size).toBe(50);
    for (const value of seen) expect(isCredential(JSON.parse(value))).toBe(true);
  });

  it("lets a used-up link give way to the phone's own credential", () => {
    const link = credential();
    const own = { ...credential(), usedLink: link.room };
    expect(credentialToUse(link, own)).toBe(own);
    expect(credentialToUse(null, own)).toBe(own);
    expect(credentialToUse(link, null)).toBe(link);
    const newLink = credential();
    expect(credentialToUse(newLink, own)).toBe(newLink);
    expect(credentialToUse(null, null)).toBeNull();
  });

  it("refuses anything that isn't a link", () => {
    const { room, secret } = credential();
    for (const fragment of ["", "#", "#hello", `#${room}`, `#${secret}`, `#${room}.short`, `#ZZ${room.slice(2)}.${secret}`, `#${room}.${secret}.more`]) {
      expect(parseLinkFragment(fragment), fragment).toBeNull();
    }
  });
});

describe("Remote Play signalling", () => {
  it("opens with the same secret", async () => {
    const ours = credential();
    const key = await signalKey(ours);
    expect(await unseal(key, "phone", await seal(key, "phone", offer))).toEqual(offer);
  });

  it("hides the message from the relay", async () => {
    const key = await signalKey(credential());
    const sealed = await seal(key, "phone", { ...offer, sdp: "a=candidate:my-home-address", name: "iPhone" });
    expect(sealed).not.toContain("candidate");
    expect(sealed).not.toContain("iPhone");
  });

  it("won't open under another secret or room", async () => {
    const ours = credential();
    const sealed = await seal(await signalKey(ours), "phone", offer);
    expect(await unseal(await signalKey({ ...ours, secret: createSecret() }), "phone", sealed)).toBeNull();
    expect(await unseal(await signalKey({ ...ours, room: createRoom() }), "phone", sealed)).toBeNull();
  });

  it("won't let a message be bounced back at its sender", async () => {
    const key = await signalKey(credential());
    expect(await unseal(key, "host", await seal(key, "phone", offer))).toBeNull();
  });

  it("notices tampering", async () => {
    const key = await signalKey(credential());
    const sealed = JSON.parse(await seal(key, "phone", offer)) as { iv: string; ct: string };
    const flipped = `${sealed.ct.slice(0, 8)}${sealed.ct[8] === "A" ? "B" : "A"}${sealed.ct.slice(9)}`;
    expect(await unseal(key, "phone", JSON.stringify({ ...sealed, ct: flipped }))).toBeNull();
  });

  it("treats junk from the relay as nothing", async () => {
    const key = await signalKey(credential());
    for (const junk of ["", "not json", "{}", '{"iv":"AAAA","ct":"AAAA"}', "null"]) {
      expect(await unseal(key, "phone", junk), junk).toBeNull();
    }
  });

  it("uses a fresh nonce for every message", async () => {
    const key = await signalKey(credential());
    const ivs = new Set<string>();
    for (let i = 0; i < 20; i += 1) ivs.add((JSON.parse(await seal(key, "phone", offer)) as { iv: string }).iv);
    expect(ivs.size).toBe(20);
  });

  it("only takes recent offers", () => {
    expect(isFreshOffer(1_000_000, 1_000_000 + 60_000)).toBe(true);
    expect(isFreshOffer(1_000_000, 1_000_000 + 10 * 60_000)).toBe(false);
    expect(isFreshOffer(1_000_000 + 10 * 60_000, 1_000_000)).toBe(false);
  });

  it("reads the relay's notices and nothing else", () => {
    expect(parseRelayNotice('{"relay":"peers","host":true,"phone":false}')).toEqual({ relay: "peers", host: true, phone: false });
    expect(parseRelayNotice('{"relay":"denied"}')).toEqual({ relay: "denied" });
    expect(parseRelayNotice('{"iv":"a","ct":"b"}')).toBeNull();
    expect(parseRelayNotice("pong")).toBeNull();
  });
});
