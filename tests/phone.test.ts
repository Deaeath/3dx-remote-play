// @vitest-environment jsdom
//
// The real phone page, with the network and WebRTC replaced. These are the ways
// a phone can sit on "Connecting" with nothing happening.

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_REPLACED_CODE, createRoom, createSecret, seal, signalKey, unseal, type PlayCredential, type SignalMessage } from "../shared/remotePlay";

const credential: PlayCredential = { room: createRoom(), secret: createSecret() };
const savedCredential = { ...credential, passkey: "saved-passkey" };
const PROOF = { credentialId: "saved-passkey", authenticatorData: "a", clientDataJSON: "c", signature: "s" };

const passkeys = vi.hoisted(() => ({
  canUsePasskeys: vi.fn(async () => true),
  makePasskey: vi.fn(),
  provePasskey: vi.fn(),
}));
vi.mock("../phone/web/passkeys", () => passkeys);
const OPEN = 1;
const OFFER_SDP = "v=0\r\na=candidate:1 1 udp 2122260223 abc.local 5000 typ host\r\na=candidate:2 1 udp 1686052607 203.0.113.9 6000 typ srflx raddr 0.0.0.0 rport 0\r\n";
const ANSWER_SDP = "v=0\r\na=candidate:1 1 udp 1686052607 198.51.100.7 7000 typ srflx raddr 0.0.0.0 rport 0\r\n";

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = OPEN;
  readyState = OPEN;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(message: string) {
    this.sent.push(message);
  }
  close() {
    this.closed = true;
  }
  /** What the relay says as soon as anyone joins. */
  hostIsHere() {
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ relay: "peers", host: true, phone: true }) });
  }
}

class FakeChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  send(message: string) {
    this.sent.push(message);
  }
  close() {}
}

class FakePeer {
  static all: FakePeer[] = [];
  iceGatheringState = "complete";
  iceConnectionState = "new";
  connectionState = "new";
  localDescription = { sdp: OFFER_SDP };
  remote: string[] = [];
  channel = new FakeChannel();
  closed = false;
  ontrack: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  constructor() {
    FakePeer.all.push(this);
  }
  addTransceiver() {}
  createDataChannel() {
    return this.channel;
  }
  addEventListener() {}
  async createOffer() {
    return { type: "offer", sdp: OFFER_SDP };
  }
  async setLocalDescription() {}
  async setRemoteDescription({ sdp }: { sdp: string }) {
    this.remote.push(sdp);
  }
  async getStats() {
    return new Map();
  }
  close() {
    this.closed = true;
  }
}

function panelTitle(): string {
  return document.getElementById("panel-title")?.textContent ?? "";
}

function panelText(): string {
  return document.getElementById("panel-text")?.textContent ?? "";
}

function detail(): string {
  return document.getElementById("panel-detail")?.textContent ?? "";
}

function click(id: string): void {
  (document.getElementById(id) as HTMLElement).click();
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const key = () => signalKey(credential);

/** Waits are armed when they start, so the clock has to be fake from the first step. */
async function onFakeClock(steps: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    await steps();
  } finally {
    vi.useRealTimers();
  }
}

async function offerFrom(socket: FakeSocket, count = 1): Promise<Extract<SignalMessage, { t: "offer" }>> {
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThanOrEqual(count));
  const text = socket.sent[count - 1] ?? "";
  const message = await unseal(await key(), "phone", text);
  if (message?.t !== "offer") throw new Error("not an offer");
  return message;
}

async function answer(socket: FakeSocket, to?: number): Promise<void> {
  socket.onmessage?.({ data: await seal(await key(), "host", { t: "answer", sdp: ANSWER_SDP, to }) });
}

/** The phone tapped Start and has got as far as sending its offer. */
async function startedAndOffered() {
  click("panel-action");
  const socket = await nextSocket();
  socket.hostIsHere();
  const offer = await offerFrom(socket);
  return { socket, offer, peer: FakePeer.all.at(-1) as FakePeer };
}

async function nextSocket(): Promise<FakeSocket> {
  const before = socketsSeen;
  await vi.waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(before));
  socketsSeen = FakeSocket.all.length;
  return FakeSocket.all.at(-1) as FakeSocket;
}

let socketsSeen = 0;

/** Every test begins on the Start panel, whatever the one before left behind. */
function backToStart(): void {
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  socketsSeen = FakeSocket.all.length;
}

beforeAll(async () => {
  const body = /<body>([\s\S]*)<\/body>/.exec(readFileSync("phone/web/index.html", "utf8"))?.[1] ?? "";
  document.body.innerHTML = body;
  localStorage.setItem("3dx-play:v1", JSON.stringify(savedCredential));
  vi.stubGlobal("__PAGE_VERSION__", "test");
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.stubGlobal("MediaStream", class {
    addTrack() {}
    removeTrack() {}
    getTracks() {
      return [];
    }
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ iceServers: [{ urls: ["stun:example.test:3478"] }] }) })));
  window.HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  await import("../phone/web/main");
});

beforeEach(() => backToStart());

describe("the phone page", () => {
  it("shows its version", () => {
    expect(document.getElementById("page-version")?.textContent).toBe("Version test");
  });
});

describe("the phone page while connecting", () => {
  it("says where it's up to, without any address", async () => {
    const { socket, offer } = await startedAndOffered();
    expect(panelTitle()).toBe("Connecting");
    expect(detail()).toContain("waiting for the PC's answer");
    expect(detail()).toContain("phone mdns, srflx");
    await answer(socket, offer.at);
    await vi.waitFor(() => expect(detail()).toContain("finding a path"));
    expect(detail()).toContain("PC srflx");
    expect(detail()).not.toMatch(/\d+\.\d+\.\d+\.\d+|abc\.local/);
  });

  it("tells the PC what kind of page it is", async () => {
    const { offer } = await startedAndOffered();
    expect(offer.note).toContain("page test");
    expect(offer.note).toContain("browser");
  });

  it("gives up on a path that never opens, says why, and tries again", async () => {
    await onFakeClock(async () => {
      const { socket, offer, peer } = await startedAndOffered();
      await answer(socket, offer.at);
      await vi.waitFor(() => expect(peer.remote).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(24_000);
      expect(peer.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(peer.closed).toBe(true);
      expect(socket.closed).toBe(true);
      expect(panelText()).toContain("can't reach each other");
      await vi.advanceTimersByTimeAsync(2000);
      const next = await nextSocket();
      next.hostIsHere();
      const again = await offerFrom(next);
      expect(again.note).toContain("path failed");
      expect(again.note).toContain("1 failed before");
    });
  });

  it("says so when the PC never answers", async () => {
    await onFakeClock(async () => {
      const { peer } = await startedAndOffered();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(peer.closed).toBe(true);
      expect(panelText()).toContain("isn't answering");
    });
  });

  it("gives up when the relay never says who's there", async () => {
    await onFakeClock(async () => {
      click("panel-action");
      const socket = await nextSocket();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(socket.closed).toBe(true);
      expect(panelText()).toContain("can't reach the internet");
    });
  });

  it("forgets the last failure when the phone starts again by hand", async () => {
    await onFakeClock(async () => {
      await startedAndOffered();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(panelText()).toContain("isn't answering");
      backToStart();
      click("panel-action");
      expect(panelText()).toBe("Reaching your PC...");
    });
  });

  it("gives up when ICE fails, even if the connection state hasn't caught up", async () => {
    const { socket, offer, peer } = await startedAndOffered();
    await answer(socket, offer.at);
    await vi.waitFor(() => expect(peer.remote).toHaveLength(1));
    peer.iceConnectionState = "failed";
    peer.oniceconnectionstatechange?.();
    expect(peer.closed).toBe(true);
    expect(panelText()).toContain("can't reach each other");
  });

  it("ignores a slow PC's answer to the last attempt", async () => {
    const { socket, offer, peer } = await startedAndOffered();
    await answer(socket, offer.at - 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(peer.remote).toHaveLength(0);
    await answer(socket, offer.at);
    await vi.waitFor(() => expect(peer.remote).toHaveLength(1));
  });

  it("still takes an answer from an older PC app, which doesn't say which offer it's for", async () => {
    const { socket, peer } = await startedAndOffered();
    await answer(socket);
    await vi.waitFor(() => expect(peer.remote).toHaveLength(1));
  });

  it("starts again when iOS brings the page back from the background", async () => {
    const { socket, peer } = await startedAndOffered();
    setVisibility("hidden");
    expect(socket.closed).toBe(false);
    setVisibility("visible");
    expect(peer.closed).toBe(true);
    expect(socket.closed).toBe(true);
    const next = await nextSocket();
    next.hostIsHere();
    const again = await offerFrom(next);
    expect(again.note).toContain("came back from the background");
  });

  it("reconnects after being put away with its connections closed", async () => {
    const { socket } = await startedAndOffered();
    window.dispatchEvent(new Event("pagehide"));
    expect(socket.closed).toBe(true);
    const restored = new Event("pageshow") as Event & { persisted: boolean };
    restored.persisted = true;
    window.dispatchEvent(restored);
    await nextSocket();
    expect(panelTitle()).toBe("Connecting");
  });

  it("leaves a page alone that hasn't been started", async () => {
    const before = FakeSocket.all.length;
    const fresh = new Event("pageshow") as Event & { persisted: boolean };
    fresh.persisted = false;
    window.dispatchEvent(fresh);
    setVisibility("visible");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(FakeSocket.all).toHaveLength(before);
  });

  it("stops rather than fights when another copy of the page takes over", async () => {
    await onFakeClock(async () => {
      const { socket, peer } = await startedAndOffered();
      socket.onclose?.({ code: RELAY_REPLACED_CODE });
      expect(peer.closed).toBe(true);
      expect(panelTitle()).toBe("Playing somewhere else");
      const before = FakeSocket.all.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeSocket.all).toHaveLength(before);
      click("panel-action");
      await nextSocket();
      expect(panelTitle()).toBe("Connecting");
    });
  });

  it("retries when the relay connection is simply lost", async () => {
    await onFakeClock(async () => {
      const { socket } = await startedAndOffered();
      socket.onclose?.({ code: 1006 });
      await vi.advanceTimersByTimeAsync(2000);
      await nextSocket();
      expect(panelTitle()).toBe("Connecting");
    });
  });

  it("notices a relay connection that went quiet without closing", async () => {
    await onFakeClock(async () => {
      click("panel-action");
      const socket = await nextSocket();
      socket.onopen?.();
      // Waiting for a PC that's off, which can go on for hours.
      socket.onmessage?.({ data: JSON.stringify({ relay: "peers", host: false, phone: true }) });
      expect(panelTitle()).toBe("Your PC is offline");

      await vi.advanceTimersByTimeAsync(25_000);
      expect(socket.sent).toContain("ping");
      socket.onmessage?.({ data: "pong" });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(socket.closed).toBe(false);

      await vi.advanceTimersByTimeAsync(25_000);
      expect(socket.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      await nextSocket();
    });
  });

  it("shows the picture is coming as soon as it's connected, not a black screen", async () => {
    const { socket, offer, peer } = await startedAndOffered();
    await answer(socket, offer.at);
    await vi.waitFor(() => expect(peer.remote).toHaveLength(1));
    peer.channel.onopen?.();
    expect(document.body.classList.contains("live")).toBe(true);
    expect(panelTitle()).toBe("Starting the picture");
    expect(detail()).toBe("");
    peer.channel.onmessage?.({ data: JSON.stringify({ t: "state", game: "front", video: true, locked: false, canLaunch: true }) });
    expect(document.getElementById("panel")?.hidden).toBe(true);
  });
});

describe("the phone page and its passkey", () => {
  it("signs when the PC challenges, then sends the same offer with the proof", async () => {
    passkeys.provePasskey.mockResolvedValueOnce(PROOF);
    const { socket, offer } = await startedAndOffered();
    expect(offer.proof).toBeUndefined();
    socket.onmessage?.({ data: await seal(await key(), "host", { t: "challenge", nonce: "n1" }) });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    const signed = await offerFrom(socket, 2);
    expect(passkeys.provePasskey).toHaveBeenLastCalledWith("saved-passkey", "n1", OFFER_SDP);
    expect(signed.proof).toEqual(PROOF);
    expect(signed.sdp).toBe(offer.sdp);
  });

  it("offers an Unlock button when the phone wants a tap first, and it does the job", async () => {
    passkeys.provePasskey.mockRejectedValueOnce(new DOMException("needs a tap", "NotAllowedError"));
    const { socket } = await startedAndOffered();
    socket.onmessage?.({ data: await seal(await key(), "host", { t: "challenge", nonce: "n2" }) });
    await vi.waitFor(() => expect(panelTitle()).toBe("Unlock to play"));
    expect(socket.sent).toHaveLength(1);
    passkeys.provePasskey.mockResolvedValueOnce(PROOF);
    click("panel-action");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect((await offerFrom(socket, 2)).proof).toEqual(PROOF);
  });

  it("gives up with a plain message when the PC keeps refusing the passkey", async () => {
    passkeys.provePasskey.mockResolvedValue(PROOF);
    const { socket } = await startedAndOffered();
    const challenge = async (nonce: string) => socket.onmessage?.({ data: await seal(await key(), "host", { t: "challenge", nonce }) });
    await challenge("n3");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    await challenge("n4");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
    await challenge("n5");
    await vi.waitFor(() => expect(panelTitle()).toBe("Your PC doesn't know this phone"));
    passkeys.provePasskey.mockReset();
  });

  it("comes back without the passkey after a drop, and never stores the way back", async () => {
    const { socket, offer, peer } = await startedAndOffered();
    await answer(socket, offer.at);
    await vi.waitFor(() => expect(peer.remote).toHaveLength(1));
    peer.channel.onopen?.();
    peer.channel.onmessage?.({ data: JSON.stringify({ t: "resume", token: "come-back" }) });
    expect(JSON.stringify({ ...localStorage })).not.toContain("come-back");
    const seen = FakeSocket.all.length;
    peer.channel.onclose?.();
    await vi.waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(seen), { timeout: 4000 });
    const next = await nextSocket();
    next.hostIsHere();
    expect((await offerFrom(next)).resume).toBe("come-back");
  });

  it("wants the passkey again after a reload", async () => {
    const { offer } = await startedAndOffered();
    expect(offer.resume).toBeUndefined();
  });

  it("asks a phone paired before passkeys to pair again", () => {
    localStorage.setItem("3dx-play:v1", JSON.stringify(credential));
    backToStart();
    expect(panelTitle()).toBe("Pair this phone again");
    localStorage.setItem("3dx-play:v1", JSON.stringify(savedCredential));
    backToStart();
  });
});

describe("the phone page pairing", () => {
  const paired = { t: "pair", room: createRoom(), secret: createSecret(), challenge: "c1" };

  async function liveOnLink() {
    const { socket, offer, peer } = await startedAndOffered();
    await answer(socket, offer.at);
    await vi.waitFor(() => expect(peer.remote).toHaveLength(1));
    peer.channel.readyState = "open";
    peer.channel.onopen?.();
    peer.channel.onmessage?.({ data: JSON.stringify(paired) });
    return peer;
  }

  afterEach(() => {
    localStorage.setItem("3dx-play:v1", JSON.stringify(savedCredential));
  });

  it("asks for a tap, makes the passkey, and only then keeps the new key", async () => {
    const peer = await liveOnLink();
    expect(panelTitle()).toBe("Secure this phone");
    expect(JSON.parse(localStorage.getItem("3dx-play:v1") ?? "{}").room).toBe(savedCredential.room);
    passkeys.canUsePasskeys.mockResolvedValueOnce(true);
    passkeys.makePasskey.mockResolvedValueOnce({ credentialId: "new-passkey", publicKey: "p", authenticatorData: "a", clientDataJSON: "c" });
    click("panel-action");
    await vi.waitFor(() => expect(peer.channel.sent.length).toBeGreaterThan(0));
    expect(passkeys.makePasskey).toHaveBeenCalledWith("c1");
    expect(JSON.parse(localStorage.getItem("3dx-play:v1") ?? "{}")).toMatchObject({ room: paired.room, secret: paired.secret, passkey: "new-passkey" });
    expect(JSON.parse(peer.channel.sent.at(-1) ?? "{}")).toMatchObject({ t: "paired", passkey: { credentialId: "new-passkey" } });
  });

  it("says what to do on a phone with no screen lock, and keeps nothing", async () => {
    await liveOnLink();
    passkeys.canUsePasskeys.mockResolvedValueOnce(false);
    click("panel-action");
    await vi.waitFor(() => expect(panelTitle()).toBe("Set a passcode first"));
    expect(JSON.parse(localStorage.getItem("3dx-play:v1") ?? "{}").room).toBe(savedCredential.room);
  });

  it("lets a cancelled Face ID be tried again, and keeps nothing", async () => {
    await liveOnLink();
    passkeys.canUsePasskeys.mockResolvedValueOnce(true);
    passkeys.makePasskey.mockRejectedValueOnce(new Error("cancelled"));
    click("panel-action");
    await vi.waitFor(() => expect(panelText()).toContain("didn't go through"));
    expect(JSON.parse(localStorage.getItem("3dx-play:v1") ?? "{}").room).toBe(savedCredential.room);
  });
});

describe("the phone page hiding the game", () => {
  async function livePeer() {
    const { socket, offer, peer } = await startedAndOffered();
    await answer(socket, offer.at);
    await vi.waitFor(() => expect(peer.remote).toHaveLength(1));
    peer.channel.readyState = "open";
    peer.channel.onopen?.();
    return peer;
  }

  it("asks the PC to hide it", async () => {
    const peer = await livePeer();
    click("hide-button");
    expect(JSON.parse(peer.channel.sent.at(-1) ?? "{}")).toEqual({ t: "minimize" });
  });

  it("says it's hidden and offers to bring it back", async () => {
    const peer = await livePeer();
    peer.channel.onmessage?.({ data: JSON.stringify({ t: "state", game: "minimized", video: true, locked: false, canLaunch: true }) });
    expect(panelTitle()).toBe("3DXChat is hidden");
    click("panel-action");
    expect(JSON.parse(peer.channel.sent.at(-1) ?? "{}")).toEqual({ t: "focus" });
    peer.channel.onmessage?.({ data: JSON.stringify({ t: "state", game: "front", video: true, locked: false, canLaunch: true }) });
    expect(document.getElementById("panel")?.hidden).toBe(true);
  });
});
