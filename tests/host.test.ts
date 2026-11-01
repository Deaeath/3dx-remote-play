import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSecret,
  seal,
  signalKey,
  unseal,
  type PlayCredential,
  type SignalMessage,
} from "../shared/remotePlay";
import {
  LINK_LIFETIME_MS,
  RemotePlayHost,
  acceptedCredentials,
  gamePhase,
  newPairing,
  pairingLink,
  tuneOffer,
  type HostDeps,
  type HostSnapshot,
  type NativeGameState,
  type RemotePairing,
} from "../src/host";

class FakeChannel {
  readyState = "open";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(message: string) {
    this.sent.push(message);
  }
  events() {
    return this.sent.map((text) => JSON.parse(text) as { t: string; room?: string; secret?: string; game?: string; video?: boolean });
  }
}

function fakeTransceiver(kind: "video" | "audio") {
  return {
    direction: "recvonly",
    receiver: { track: { kind } },
    sender: {
      replaceTrack: vi.fn(async () => undefined),
      getParameters: () => ({ encodings: [{}] }),
      setParameters: vi.fn(async () => undefined),
    },
  };
}

class FakePeer {
  video = fakeTransceiver("video");
  audio = fakeTransceiver("audio");
  iceGatheringState = "complete";
  connectionState = "new";
  localDescription = { sdp: "host-answer-sdp" };
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  remote: string | null = null;
  closed = false;
  async setRemoteDescription({ sdp }: { sdp: string }) {
    this.remote = sdp;
  }
  async setLocalDescription() {}
  async createAnswer() {
    return { type: "answer" };
  }
  async getStats() {
    return new Map();
  }
  getTransceivers() {
    return [this.video, this.audio];
  }
  addEventListener() {}
  close() {
    this.closed = true;
  }
}

class FakeSocket {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {}
  send(message: string) {
    this.sent.push(message);
  }
  close() {
    this.closed = true;
  }
}

function fakeStream() {
  const track = { kind: "video", readyState: "live", contentHint: "", stop: vi.fn() };
  return {
    track,
    stream: { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream,
  };
}

const WAIT = { timeout: 4000, interval: 5 };

const flush = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function harness(pairing: RemotePairing | null, game: Partial<NativeGameState> = {}) {
  const sockets: FakeSocket[] = [];
  const peers: FakePeer[] = [];
  const snapshots: HostSnapshot[] = [];
  const connected: string[] = [];
  const saved: RemotePairing[] = [];
  const captured = fakeStream();
  const native: NativeGameState = { running: true, responding: true, front: true, locked: false, canLaunch: true, ...game };
  const deps = {
    loadPairing: vi.fn(async () => (pairing ? JSON.stringify(pairing) : null)),
    savePairing: vi.fn(async (json: string) => void saved.push(JSON.parse(json) as RemotePairing)),
    gameState: vi.fn(async () => native),
    focusGame: vi.fn(async () => undefined),
    launchGame: vi.fn(async () => undefined),
    input: vi.fn(async () => undefined),
    releaseInput: vi.fn(async () => undefined),
    keepAwake: vi.fn(async () => undefined),
    captureGame: vi.fn(async () => captured.stream),
    startAudio: vi.fn(async () => vi.fn()),
    loadIceServers: vi.fn(async () => []),
    createSocket: (url: string) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    createPeer: () => {
      const peer = new FakePeer();
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    log: vi.fn(),
  } satisfies HostDeps;
  const host = new RemotePlayHost(deps, (snapshot) => snapshots.push(snapshot), (name) => connected.push(name));
  return { host, deps, sockets, peers, snapshots, connected, saved, native, captured };
}

type Harness = ReturnType<typeof harness>;

const pairingWith = (extra: Partial<RemotePairing> = {}): RemotePairing => ({ ...newPairing(true), ...extra });

async function sendOffer(socket: FakeSocket, credential: PlayCredential, overrides: Partial<Extract<SignalMessage, { t: "offer" }>> = {}) {
  const message: SignalMessage = { t: "offer", sdp: "phone-offer-sdp", at: Date.now(), name: "iPhone", ...overrides };
  const before = socket.sent.length;
  socket.onmessage?.({ data: await seal(await signalKey(credential), "phone", message) });
  // Every offer gets a reply. The crypto runs off the event loop, so wait for it.
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(before), WAIT);
}

async function online(setup: Harness): Promise<FakeSocket> {
  await setup.host.start();
  const socket = setup.sockets[0];
  socket.onopen?.();
  return socket;
}

async function connectPhone(setup: Harness, socket: FakeSocket, credential: PlayCredential): Promise<FakeChannel> {
  await sendOffer(socket, credential);
  const channel = new FakeChannel();
  setup.peers.at(-1)?.ondatachannel?.({ channel });
  await vi.waitFor(() => expect(channel.events().some((event) => event.t === "state")).toBe(true), WAIT);
  return channel;
}

const linkCredential = (pairing: RemotePairing): PlayCredential => ({ room: pairing.room, secret: pairing.linkSecret ?? "" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Remote Play pairing state", () => {
  it("offers the link only until it expires", () => {
    const pairing = newPairing(true, 1000);
    expect(pairingLink(pairing, 1000)).toContain(pairing.room);
    expect(pairingLink(pairing, 1000 + LINK_LIFETIME_MS + 1)).toBeNull();
  });

  it("accepts the paired phone's secret and an unexpired link", () => {
    const pairing = { ...newPairing(true, 1000), deviceSecret: createSecret() };
    expect(acceptedCredentials(pairing, 1000).map((c) => c.viaLink)).toEqual([false, true]);
    expect(acceptedCredentials(pairing, 1000 + LINK_LIFETIME_MS + 1).map((c) => c.viaLink)).toEqual([false]);
  });

  it("names where the game is", () => {
    const game = { running: true, responding: true, front: true, locked: false, canLaunch: true };
    expect(gamePhase({ ...game, running: false, responding: false, front: false })).toBe("closed");
    expect(gamePhase({ ...game, responding: false })).toBe("frozen");
    expect(gamePhase({ ...game, front: false })).toBe("background");
    expect(gamePhase(game)).toBe("front");
  });
});

describe("the offer the PC answers", () => {
  const offer = [
    "v=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=rtpmap:111 opus/48000/2",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 97 102 103 45",
    "a=rtpmap:96 VP8/90000",
    "a=rtpmap:97 rtx/90000",
    "a=fmtp:97 apt=96",
    "a=rtpmap:102 H264/90000",
    "a=fmtp:102 packetization-mode=1;profile-level-id=42e01f",
    "a=rtpmap:103 rtx/90000",
    "a=fmtp:103 apt=102",
    "a=rtpmap:45 AV1/90000",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "",
  ].join("\r\n");

  it("puts H.264 first, because a sender uses the offer's first codec", () => {
    expect(tuneOffer(offer)).toContain("m=video 9 UDP/TLS/RTP/SAVPF 102 96 97 103 45\r\n");
  });

  it("keeps every other line and section", () => {
    const tuned = tuneOffer(offer);
    expect(tuned).toContain("m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n");
    expect(tuned).toContain("a=fmtp:97 apt=96\r\n");
    expect(tuned).toContain("a=fmtp:103 apt=102\r\n");
    expect(tuned).toContain("m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n");
    expect(tuned.endsWith("\r\n")).toBe(true);
  });

  it("starts high on every real codec, and never touches retransmission", () => {
    const tuned = tuneOffer(offer);
    expect(tuned).toContain("a=fmtp:102 packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=2500\r\n");
    expect(tuned).toContain("a=rtpmap:96 VP8/90000\r\na=fmtp:96 x-google-start-bitrate=2500\r\n");
    expect(tuned).toContain("a=rtpmap:45 AV1/90000\r\na=fmtp:45 x-google-start-bitrate=2500\r\n");
    expect(tuned).not.toContain("a=fmtp:97 apt=96;x-google");
  });

  it("leaves an offer with no H.264 in its order", () => {
    const noH264 = offer.replace("a=rtpmap:102 H264/90000", "a=rtpmap:102 VP9/90000");
    expect(tuneOffer(noH264)).toContain("m=video 9 UDP/TLS/RTP/SAVPF 96 97 102 103 45\r\n");
  });

  it("passes through anything without video", () => {
    expect(tuneOffer("v=0\r\nm=audio 9 X 111\r\n")).toBe("v=0\r\nm=audio 9 X 111\r\n");
  });
});

describe("Remote Play host", () => {
  it("stays off the network until it's turned on", async () => {
    const setup = harness(pairingWith({ enabled: false }));
    await setup.host.start();
    expect(setup.sockets).toHaveLength(0);
    expect(setup.deps.keepAwake).not.toHaveBeenCalledWith(true, expect.anything());
  });

  it("goes online when enabled, and remembers", async () => {
    const setup = harness(null);
    await setup.host.setEnabled(true);
    expect(setup.sockets[0].url).toContain(`/ws/${setup.saved[0].room}?role=host`);
    expect(setup.saved[0].enabled).toBe(true);
    expect(setup.deps.keepAwake).toHaveBeenCalledWith(true, false);
  });

  it("answers a phone holding the link, sealed", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    await sendOffer(socket, linkCredential(pairing));
    expect(setup.peers[0].remote).toBe("phone-offer-sdp");
    const answer = await unseal(await signalKey(linkCredential(pairing)), "host", socket.sent.at(-1) ?? "");
    expect(answer).toEqual({ t: "answer", sdp: "host-answer-sdp", to: expect.any(Number) });
    expect(setup.peers[0].video.direction).toBe("sendonly");
  });

  it("denies a wrong secret and starts nothing", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    await sendOffer(socket, { room: pairing.room, secret: createSecret() });
    expect(setup.peers).toHaveLength(0);
    expect(setup.deps.captureGame).not.toHaveBeenCalled();
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({ relay: "denied" });
  });

  it("quietly ignores a stale offer: a replay, or a phone with the wrong clock", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    const stale: SignalMessage = { t: "offer", sdp: "phone-offer-sdp", at: Date.now() - 10 * 60_000, name: "iPhone" };
    socket.onmessage?.({ data: await seal(await signalKey(linkCredential(pairing)), "phone", stale) });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(setup.peers).toHaveLength(0);
    expect(socket.sent).toHaveLength(0);
  });

  it("denies an expired link", async () => {
    const pairing = pairingWith({ linkExpiresAt: Date.now() - 1 });
    const setup = harness(pairing);
    const socket = await online(setup);
    await sendOffer(socket, linkCredential(pairing));
    expect(setup.peers).toHaveLength(0);
  });

  it("ignores the relay's own traffic and junk", async () => {
    const setup = harness(pairingWith());
    const socket = await online(setup);
    socket.onmessage?.({ data: '{"relay":"peers","host":true,"phone":true}' });
    socket.onmessage?.({ data: "pong" });
    await flush();
    expect(socket.sent).toHaveLength(0);
  });

  it("captures nothing until the direct connection is up", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    await sendOffer(socket, linkCredential(pairing));
    expect(setup.deps.captureGame).not.toHaveBeenCalled();
    setup.peers[0].ondatachannel?.({ channel: new FakeChannel() });
    await vi.waitFor(() => expect(setup.peers[0].video.sender.replaceTrack).toHaveBeenCalledWith(setup.captured.track), WAIT);
    expect(setup.deps.captureGame).toHaveBeenCalledTimes(1);
    expect(setup.connected).toEqual(["iPhone"]);
  });

  it("moves to a room and secret only this phone has, and the link is dead", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    const channel = await connectPhone(setup, socket, linkCredential(pairing));

    const pair = channel.events().find((event) => event.t === "pair");
    expect(pair?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair?.room).toMatch(/^[0-9a-f]{32}$/);
    expect(pair?.room).not.toBe(pairing.room);
    expect(setup.saved).toHaveLength(0);

    channel.onmessage?.({ data: '{"t":"paired"}' });
    await flush();
    expect(setup.saved.at(-1)).toMatchObject({ room: pair?.room, linkSecret: null, linkExpiresAt: null, deviceSecret: pair?.secret, deviceName: "iPhone" });

    // The PC left the link's room, so the old link reaches nobody.
    expect(socket.closed).toBe(true);
    const next = setup.sockets.at(-1) as FakeSocket;
    expect(next.url).toContain(`/ws/${pair?.room}?role=host`);
    // The running session is direct, and survives the move.
    expect(setup.peers[0].closed).toBe(false);
    next.onopen?.();

    setup.host.endSession();
    await sendOffer(next, linkCredential(pairing));
    expect(JSON.parse(next.sent.at(-1) ?? "{}")).toEqual({ relay: "denied" });
    expect(setup.peers).toHaveLength(1);

    await sendOffer(next, { room: pair?.room ?? "", secret: pair?.secret ?? "" });
    expect(setup.peers).toHaveLength(2);
  });

  it("keeps the link alive if the phone never confirms pairing", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    await connectPhone(setup, socket, linkCredential(pairing));
    setup.host.endSession();
    expect(setup.saved).toHaveLength(0);
    await sendOffer(socket, linkCredential(pairing));
    expect(setup.peers).toHaveLength(2);
  });

  it("doesn't pair again for a phone that's already paired", async () => {
    const deviceSecret = createSecret();
    const pairing = pairingWith({ linkSecret: null, linkExpiresAt: null, deviceSecret });
    const setup = harness(pairing);
    const socket = await online(setup);
    const channel = await connectPhone(setup, socket, { room: pairing.room, secret: deviceSecret });
    expect(channel.events().some((event) => event.t === "pair")).toBe(false);
  });

  it("passes on only game input", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    const channel = await connectPhone(setup, socket, linkCredential(pairing));
    channel.onmessage?.({ data: '{"t":"tap","x":0.5,"y":0.5}' });
    channel.onmessage?.({ data: '{"t":"shell","command":"calc"}' });
    channel.onmessage?.({ data: "not json" });
    await flush();
    expect(setup.deps.input).toHaveBeenCalledTimes(1);
    expect(setup.deps.input).toHaveBeenCalledWith({ t: "tap", x: 0.5, y: 0.5 });
  });

  it("does what the phone's buttons ask", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    const channel = await connectPhone(setup, socket, linkCredential(pairing));
    setup.deps.focusGame.mockClear();
    channel.onmessage?.({ data: '{"t":"focus"}' });
    channel.onmessage?.({ data: '{"t":"launch"}' });
    await flush();
    expect(setup.deps.focusGame).toHaveBeenCalledTimes(1);
    expect(setup.deps.launchGame).toHaveBeenCalledTimes(1);
  });

  it("brings the game forward when a phone connects", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    await connectPhone(setup, socket, linkCredential(pairing));
    expect(setup.deps.focusGame).toHaveBeenCalled();
    expect(setup.deps.keepAwake).toHaveBeenCalledWith(true, true);
  });

  it("tells the phone the game is closed instead of capturing", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing, { running: false, front: false });
    const socket = await online(setup);
    const channel = await connectPhone(setup, socket, linkCredential(pairing));
    expect(setup.deps.captureGame).not.toHaveBeenCalled();
    expect(channel.events().find((event) => event.t === "state")).toMatchObject({ game: "closed", video: false, canLaunch: true });
  });

  it("leaves a frozen game alone and says so", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing, { responding: false });
    const socket = await online(setup);
    const channel = await connectPhone(setup, socket, linkCredential(pairing));
    expect(setup.deps.captureGame).not.toHaveBeenCalled();
    expect(channel.events().find((event) => event.t === "state")).toMatchObject({ game: "frozen", video: false });
  });

  it("doesn't capture a locked PC", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing, { locked: true });
    const socket = await online(setup);
    const channel = await connectPhone(setup, socket, linkCredential(pairing));
    expect(setup.deps.captureGame).not.toHaveBeenCalled();
    expect(channel.events().find((event) => event.t === "state")).toMatchObject({ locked: true });
  });

  it("cleans up completely when a session ends", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    const channel = await connectPhone(setup, socket, linkCredential(pairing));
    channel.onclose?.();
    await flush();
    expect(setup.peers[0].closed).toBe(true);
    expect(setup.captured.track.stop).toHaveBeenCalled();
    expect(setup.deps.releaseInput).toHaveBeenCalled();
    expect(setup.deps.keepAwake).toHaveBeenLastCalledWith(true, false);
    expect(setup.host.snapshot().session).toBeNull();
  });

  it("ends the session when the connection fails", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    await connectPhone(setup, socket, linkCredential(pairing));
    setup.peers[0].connectionState = "failed";
    setup.peers[0].onconnectionstatechange?.();
    expect(setup.host.snapshot().session).toBeNull();
    expect(setup.deps.releaseInput).toHaveBeenCalled();
  });

  it("turning it off ends the session and leaves the relay", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    await connectPhone(setup, socket, linkCredential(pairing));
    await setup.host.setEnabled(false);
    expect(setup.peers[0].closed).toBe(true);
    expect(socket.closed).toBe(true);
    expect(setup.host.snapshot().relay).toBe("off");
    expect(setup.saved.at(-1)?.enabled).toBe(false);
    expect(setup.deps.keepAwake).toHaveBeenLastCalledWith(false, false);
  });

  it("a new link moves to a new room, so a forgotten phone can't get back in", async () => {
    const deviceSecret = createSecret();
    const pairing = pairingWith({ linkSecret: null, linkExpiresAt: null, deviceSecret, deviceName: "iPhone" });
    const setup = harness(pairing);
    const socket = await online(setup);
    await setup.host.newLink();
    const next = setup.saved.at(-1);
    expect(next?.room).not.toBe(pairing.room);
    expect(next?.deviceSecret).toBeNull();
    expect(next?.deviceName).toBeNull();
    expect(socket.closed).toBe(true);
    expect(setup.sockets.at(-1)?.url).toContain(next?.room ?? "");
  });

  it("reconnects to the relay after a drop, backing off", async () => {
    vi.useFakeTimers();
    const setup = harness(pairingWith());
    await setup.host.start();
    setup.sockets[0].onclose?.();
    expect(setup.host.snapshot().relay).toBe("connecting");
    await vi.advanceTimersByTimeAsync(2000);
    expect(setup.sockets).toHaveLength(2);
    setup.sockets[1].onclose?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(setup.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(setup.sockets).toHaveLength(3);
  });

  it("says which offer an answer is for, so a late one can't land on a newer attempt", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    const at = Date.now() - 1234;
    await sendOffer(socket, linkCredential(pairing), { at });
    const answer = await unseal(await signalKey(linkCredential(pairing)), "host", socket.sent.at(-1) ?? "");
    expect(answer).toMatchObject({ t: "answer", to: at });
  });

  it("answers only the newest of two quick offers", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    let release = () => {};
    setup.deps.loadIceServers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    const first: SignalMessage = { t: "offer", sdp: "first-offer", at: Date.now(), name: "iPhone" };
    socket.onmessage?.({ data: await seal(await signalKey(linkCredential(pairing)), "phone", first) });
    await vi.waitFor(() => expect(setup.deps.loadIceServers).toHaveBeenCalledTimes(1), WAIT);

    await sendOffer(socket, linkCredential(pairing), { sdp: "second-offer" });
    release();
    await flush();
    expect(setup.peers).toHaveLength(1);
    expect(setup.peers[0].remote).toBe("second-offer");
    expect(setup.peers[0].closed).toBe(false);
  });

  it("closes the connection for an offer it can't use, and carries on", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    const refuse = vi.spyOn(FakePeer.prototype, "setRemoteDescription").mockRejectedValueOnce(new Error("bad sdp"));
    const bad: SignalMessage = { t: "offer", sdp: "bad", at: Date.now(), name: "iPhone" };
    socket.onmessage?.({ data: await seal(await signalKey(linkCredential(pairing)), "phone", bad) });
    await vi.waitFor(() => expect(setup.peers[0]?.closed).toBe(true), WAIT);
    refuse.mockRestore();
    expect(setup.host.snapshot().session).toBeNull();
    await sendOffer(socket, linkCredential(pairing));
    expect(setup.host.snapshot().session).not.toBeNull();
  });

  it("stops the sound if the session ended while it was starting", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    const stopAudio = vi.fn();
    let audioReady = () => {};
    setup.deps.startAudio.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          audioReady = () => resolve(stopAudio as never);
        }),
    );
    const channel = await connectPhone(setup, socket, linkCredential(pairing));
    await vi.waitFor(() => expect(setup.deps.startAudio).toHaveBeenCalled(), WAIT);
    channel.onclose?.();
    expect(setup.host.snapshot().session).toBeNull();
    audioReady();
    await vi.waitFor(() => expect(stopAudio).toHaveBeenCalled(), WAIT);
  });

  it("starts no sound for a session that ended while the picture was being set up", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    await sendOffer(socket, linkCredential(pairing));
    let parametersSet = () => {};
    setup.peers[0].video.sender.setParameters.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          parametersSet = () => resolve(undefined);
        }),
    );
    const channel = new FakeChannel();
    setup.peers[0].ondatachannel?.({ channel });
    await vi.waitFor(() => expect(setup.peers[0].video.sender.setParameters).toHaveBeenCalled(), WAIT);
    channel.onclose?.();
    parametersSet();
    await flush();
    expect(setup.deps.startAudio).not.toHaveBeenCalled();
  });

  it("captures one at a time, even across sessions", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    const earlier = fakeStream();
    let captured = () => {};
    setup.deps.captureGame.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          captured = () => resolve(earlier.stream);
        }),
    );
    await connectPhone(setup, socket, linkCredential(pairing));
    await vi.waitFor(() => expect(setup.deps.captureGame).toHaveBeenCalledTimes(1), WAIT);

    // The phone comes back while the first capture is still going.
    await connectPhone(setup, socket, linkCredential(pairing));
    await flush();
    expect(setup.deps.captureGame).toHaveBeenCalledTimes(1);

    captured();
    await vi.waitFor(() => expect(earlier.track.stop).toHaveBeenCalled(), WAIT);
    // The new session's next check of the game picks it up.
    await vi.waitFor(() => expect(setup.deps.captureGame).toHaveBeenCalledTimes(2), WAIT);
    await vi.waitFor(() => expect(setup.peers[1].video.sender.replaceTrack).toHaveBeenCalledWith(setup.captured.track), WAIT);
  });

  it("tells the phone the game's state before the capture finishes", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    let captured = () => {};
    setup.deps.captureGame.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          captured = () => resolve(setup.captured.stream);
        }),
    );
    const channel = await connectPhone(setup, socket, linkCredential(pairing));
    expect(channel.events().find((event) => event.t === "state")).toMatchObject({ game: "front", video: false });
    captured();
    await vi.waitFor(() => expect(channel.events().filter((event) => event.t === "state").at(-1)).toMatchObject({ video: true }), WAIT);
  });

  it("doesn't keep polling for a session that ended on the way in", async () => {
    vi.useFakeTimers();
    const pairing = pairingWith();
    const setup = harness(pairing);
    await setup.host.start();
    const socket = setup.sockets[0];
    socket.onopen?.();
    const offer: SignalMessage = { t: "offer", sdp: "phone-offer-sdp", at: Date.now(), name: "iPhone" };
    socket.onmessage?.({ data: await seal(await signalKey(linkCredential(pairing)), "phone", offer) });
    await vi.waitFor(() => expect(setup.peers).toHaveLength(1));
    let focused = () => {};
    setup.deps.focusGame.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          focused = () => resolve(undefined);
        }),
    );
    setup.peers[0].ondatachannel?.({ channel: new FakeChannel() });
    setup.host.endSession();
    focused();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(setup.deps.gameState).not.toHaveBeenCalled();
  });

  it("logs each step, and no addresses", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    await sendOffer(socket, linkCredential(pairing), {
      sdp: "a=candidate:1 1 udp 2122260223 abc.local 5000 typ host\r\na=candidate:2 1 udp 1686052607 203.0.113.9 6000 typ srflx raddr 0.0.0.0 rport 0\r\n",
      note: "page 1.0.3; browser",
    });
    const channel = new FakeChannel();
    setup.peers[0].ondatachannel?.({ channel });
    await vi.waitFor(() => expect(setup.peers[0].video.sender.replaceTrack).toHaveBeenCalled(), WAIT);
    channel.onclose?.();
    const log = setup.deps.log.mock.calls.map(([line]) => line).join("\n");
    expect(log).toContain("offer from iPhone with the pairing link: routes mdns, srflx; page 1.0.3; browser");
    expect(log).toContain("relay server not set up");
    expect(log).toContain("connected after");
    expect(log).toContain("capture: got the game");
    expect(log).toContain("session over");
    expect(log).not.toContain("203.0.113.9");
    expect(log).not.toContain("abc.local");
  });

  it("logs what the phone reports, and takes it for nothing else", async () => {
    const pairing = pairingWith();
    const setup = harness(pairing);
    const socket = await online(setup);
    const channel = await connectPhone(setup, socket, linkCredential(pairing));
    channel.onmessage?.({ data: JSON.stringify({ t: "report", text: "picture 1920x1080" }) });
    channel.onmessage?.({ data: JSON.stringify({ t: "report", text: "x".repeat(5000) }) });
    channel.onmessage?.({ data: JSON.stringify({ t: "report", text: { not: "text" } }) });
    await flush();
    const lines = setup.deps.log.mock.calls.map(([line]) => line).filter((line) => line.startsWith("phone:"));
    expect(lines[0]).toBe("phone: picture 1920x1080");
    expect(lines[1].length).toBeLessThan(400);
    expect(lines).toHaveLength(2);
    expect(setup.deps.input).not.toHaveBeenCalled();
  });

  it("recovers when the saved pairing is unreadable", async () => {
    const setup = harness(null);
    setup.deps.loadPairing.mockResolvedValueOnce("not json");
    await setup.host.start();
    expect(setup.host.snapshot().pairing).toBeNull();
    expect(setup.sockets).toHaveLength(0);
  });
});
