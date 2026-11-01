// src/host.ts
//
// The PC side of Remote Play, running in the app's window. It waits on the
// relay for a sealed offer, and only someone holding the secret can produce
// one. WebRTC is what the webview already does well (hardware encoding, NAT
// traversal, bitrate control), so all this has to do is wire it up.
//
// The rules that keep it safe, and where they're enforced:
//   - Nothing runs until the toggle is on, and no capture until a phone proves
//     it holds the secret and the direct connection is up.
//   - Only the game's window is captured: the captured handle has to be the
//     game's or the track is stopped at once (`captureGame`).
//   - A link pairs one phone once, then it's dead: the two move to a new room
//     that the link never showed (`beginPairing`).
//   - Input goes through src-tauri/src/remote_play.rs, which takes only game
//     keys and mouse moves, and only while the game is the front window.

import { Channel, invoke } from "@tauri-apps/api/core";
import {
  PLAY_ORIGIN,
  REMOTE_PLAY_INPUTS,
  createRoom,
  createSecret,
  isFreshOffer,
  linkFor,
  parseRelayNotice,
  routeKinds,
  seal,
  signalKey,
  unseal,
  type GamePhase,
  type HostEvent,
  type PhoneCommand,
  type PlayCredential,
  type PlayState,
  type SignalMessage,
} from "../shared/remotePlay";
import { verifyProof, verifyRegistration, type PairedPasskey, type PasskeyRegistration } from "../shared/passkey";

/** An unused link dies after this, so one left on screen doesn't stay a way in. */
export const LINK_LIFETIME_MS = 15 * 60_000;
const ICE_WAIT_MS = 2500;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 60_000;
const PING_MS = 25_000;
const STATE_POLL_MS = 2000;
const CAPTURE_TIMEOUT_MS = 8000;
const CAPTURE_RETRY_MS = 6000;
const ICE_CONFIG_WAIT_MS = 4000;
/** When to note what the video is doing: once it has had time to start, then now and then. */
const FIRST_VIDEO_LOG_MS = 5000;
const VIDEO_LOG_EVERY_MS = 30_000;
const MAX_REPORT_LENGTH = 300;
/** A good 1080p picture without eating a phone's data plan: about 2 GB an hour. */
const MAX_VIDEO_BITRATE = 5_000_000;
const START_VIDEO_KBPS = 2500;
/** How long a phone gets to sign a nonce. */
const NONCE_LIFETIME_MS = 5 * 60_000;
/** How long after a dropped connection a phone may come back without the passkey. */
const RESUME_LIFETIME_MS = 10 * 60_000;
/** Turning on and then showing the code shouldn't ask twice. */
const OWNER_CHECK_LASTS_MS = 2 * 60_000;
const ENDED_ON_THIS_PC = "ended on this PC";
/** How long after a phone leaves, with nobody at the PC, the game gets hidden. */
const AUTO_HIDE_AFTER_MS = 60_000;
/** Timers and Windows' idle clock don't tick quite together. */
const AUTO_HIDE_SLACK_MS = 1000;
const CRLF = "\r\n";
const VIDEO_CODECS = ["H264", "VP8", "VP9", "AV1"];
const MAX_FRAME_RATE = 60;
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNELS = 2;
const STUN = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

export interface RemotePairing {
  enabled: boolean;
  room: string;
  /** The link's secret, until a phone has used it. */
  linkSecret: string | null;
  linkExpiresAt: number | null;
  /** The paired phone's own secret. */
  deviceSecret: string | null;
  deviceName: string | null;
  /** The public half of the phone's passkey. A phone needs this and its secret. */
  devicePasskey: PairedPasskey | null;
  /** Hide the game once a phone has left and nobody's at the PC. On unless turned off. */
  autoHide?: boolean;
}

export interface NativeGameState {
  running: boolean;
  /** False while the game is hung. */
  responding: boolean;
  minimized: boolean;
  front: boolean;
  locked: boolean;
  canLaunch: boolean;
}

/** Everything the host needs from outside; tests replace it. */
export interface HostDeps {
  loadPairing(): Promise<string | null>;
  savePairing(json: string): Promise<void>;
  gameState(): Promise<NativeGameState>;
  focusGame(): Promise<void>;
  minimizeGame(): Promise<void>;
  /** How long since anyone or anything last used this PC's keyboard or mouse. */
  idleMs(): Promise<number>;
  launchGame(): Promise<void>;
  input(input: unknown): Promise<void>;
  releaseInput(): Promise<void>;
  keepAwake(system: boolean, display: boolean): Promise<void>;
  captureGame(): Promise<MediaStream>;
  startAudio(sender: RTCRtpSender): Promise<() => void>;
  loadIceServers(): Promise<RTCIceServer[]>;
  createSocket(url: string): WebSocket;
  createPeer(config: RTCConfiguration): RTCPeerConnection;
  /** A line for the log on this PC. Never an address or a secret. */
  log(line: string): void;
  /** Windows Hello: rejects, saying why, unless the owner of this PC confirms. */
  verifyOwner(): Promise<void>;
}

export interface HostSnapshot {
  pairing: RemotePairing | null;
  relay: "off" | "connecting" | "online";
  session: { name: string; live: boolean } | null;
}

export type HostListener = (snapshot: HostSnapshot) => void;
export type HostNotice = (phoneName: string) => void;

export function isPairing(value: unknown): value is RemotePairing {
  if (typeof value !== "object" || value === null) return false;
  const pairing = value as Partial<RemotePairing>;
  return typeof pairing.enabled === "boolean" && typeof pairing.room === "string";
}

export function newPairing(enabled: boolean, now = Date.now()): RemotePairing {
  return {
    enabled,
    room: createRoom(),
    linkSecret: createSecret(),
    linkExpiresAt: now + LINK_LIFETIME_MS,
    deviceSecret: null,
    deviceName: null,
    devicePasskey: null,
  };
}

export function pairingLink(pairing: RemotePairing | null, now = Date.now()): string | null {
  if (!pairing?.linkSecret || (pairing.linkExpiresAt ?? 0) <= now) return null;
  return linkFor({ room: pairing.room, secret: pairing.linkSecret });
}

/** The secrets a phone may be holding right now, the paired phone's first. */
export function acceptedCredentials(pairing: RemotePairing, now = Date.now()): (PlayCredential & { viaLink: boolean })[] {
  const accepted: (PlayCredential & { viaLink: boolean })[] = [];
  if (pairing.deviceSecret && pairing.devicePasskey) accepted.push({ room: pairing.room, secret: pairing.deviceSecret, viaLink: false });
  if (pairing.linkSecret && (pairing.linkExpiresAt ?? 0) > now) {
    accepted.push({ room: pairing.room, secret: pairing.linkSecret, viaLink: true });
  }
  return accepted;
}

export function gamePhase(state: NativeGameState): GamePhase {
  if (!state.running) return "closed";
  if (!state.responding) return "frozen";
  if (state.minimized) return "minimized";
  return state.front ? "front" : "background";
}

/**
 * The phone's offer, adjusted for what the PC is about to send. A sender uses
 * the first codec the offer lists, and only the offer can set the starting
 * bitrate, so both are edited here (setCodecPreferences does nothing for a
 * send-only transceiver). H.264 goes first because PC and phone both have
 * hardware for it, and starting high avoids opening on a blurry 270p picture.
 */
export function tuneOffer(sdp: string): string {
  const lines = sdp.split(CRLF);
  const start = lines.findIndex((line) => line.startsWith("m=video "));
  if (start < 0) return sdp;
  const nextMedia = lines.findIndex((line, index) => index > start && line.startsWith("m="));
  const end = nextMedia < 0 ? lines.length : nextMedia;

  const payloads = new Map<string, string>();
  for (const line of lines.slice(start, end)) {
    const match = /^a=rtpmap:(\d+) ([^/]+)\//.exec(line);
    if (match) payloads.set(match[1], match[2].toUpperCase());
  }
  const [media, port, proto, ...formats] = lines[start].split(" ");
  const h264 = formats.filter((format) => payloads.get(format) === "H264");
  const others = formats.filter((format) => payloads.get(format) !== "H264");

  const section = lines.slice(start + 1, end);
  for (const [payload, name] of payloads) {
    if (!VIDEO_CODECS.includes(name)) continue;
    const parameters = `x-google-start-bitrate=${START_VIDEO_KBPS}`;
    const fmtp = section.findIndex((line) => line.startsWith(`a=fmtp:${payload} `));
    if (fmtp >= 0) {
      section[fmtp] += `;${parameters}`;
    } else {
      section.splice(section.findIndex((line) => line.startsWith(`a=rtpmap:${payload} `)) + 1, 0, `a=fmtp:${payload} ${parameters}`);
    }
  }
  return [...lines.slice(0, start), [media, port, proto, ...h264, ...others].join(" "), ...section, ...lines.slice(end)].join(CRLF);
}

function iceGathered(peer: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (peer.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(resolve, ICE_WAIT_MS);
    peer.addEventListener("icegatheringstatechange", () => {
      if (peer.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function parseCommand(text: string): PhoneCommand | null {
  try {
    const value = JSON.parse(text) as { t?: unknown };
    return typeof value?.t === "string" ? (value as PhoneCommand) : null;
  } catch {
    return null;
  }
}

interface Session {
  peer: RTCPeerConnection;
  channel: RTCDataChannel | null;
  video: RTCRtpTransceiver;
  audio: RTCRtpTransceiver;
  name: string;
  viaLink: boolean;
  live: boolean;
  /** False until a phone on a pairing link has made its passkey: no picture, no input. */
  authed: boolean;
  channelOpened: boolean;
  stream: MediaStream | null;
  stopAudio: (() => void) | null;
  /** The new room and secret sent to the phone, kept until it confirms saving them. */
  pending: (PlayCredential & { challenge: string }) | null;
  poll: ReturnType<typeof setInterval> | null;
  nextCaptureAt: number;
  nextVideoLogAt: number;
  lastState: string;
  openedAt: number;
}

export class RemotePlayHost {
  private pairing: RemotePairing | null = null;
  private socket: WebSocket | null = null;
  private relay: HostSnapshot["relay"] = "off";
  private session: Session | null = null;
  /** Counts offers, so one still being set up can tell a newer one has come. */
  private offers = 0;
  /**
   * One capture at a time, across sessions too. Capture finds the game by a
   * title it wears for a moment, and an earlier request finishing puts that
   * title back from under a later one, which leaves nothing to pick: the webview
   * then opens its window picker on the PC.
   */
  private capturing = false;
  private nonce: { value: string; expiresAt: number } | null = null;
  private resume: { token: string; expiresAt: number } | null = null;
  private ownerCheckedAt = 0;
  private autoHideTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly deps: HostDeps;
  private readonly listener: HostListener;
  private readonly onPhoneConnected: HostNotice;

  constructor(deps: HostDeps, listener: HostListener, onPhoneConnected: HostNotice) {
    this.deps = deps;
    this.listener = listener;
    this.onPhoneConnected = onPhoneConnected;
  }

  snapshot(): HostSnapshot {
    const session = this.session;
    return { pairing: this.pairing, relay: this.relay, session: session ? { name: session.name, live: session.live } : null };
  }

  /** Pick up where the last run left off. */
  async start(): Promise<void> {
    const saved = await this.deps.loadPairing().catch(() => null);
    if (saved) {
      try {
        const value: unknown = JSON.parse(saved);
        if (isPairing(value)) this.pairing = value;
      } catch {
        // Unreadable: the toggle just starts off.
      }
    }
    this.emit();
    if (this.pairing?.enabled) await this.goOnline();
  }

  stop(): void {
    this.endSession("the app is closing");
    this.goOffline();
  }

  /** The person at this PC really is its owner. Throws, saying why, if not. */
  async confirmOwner(): Promise<void> {
    if (Date.now() - this.ownerCheckedAt < OWNER_CHECK_LASTS_MS) return;
    await this.deps.verifyOwner();
    this.ownerCheckedAt = Date.now();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) await this.confirmOwner();
    const pairing = this.pairing ?? newPairing(enabled);
    await this.store({ ...pairing, enabled });
    if (enabled) {
      await this.goOnline();
    } else {
      this.resume = null;
      this.endSession("Remote Play was turned off");
      this.goOffline();
    }
  }

  async setAutoHide(autoHide: boolean): Promise<void> {
    if (!autoHide) this.cancelAutoHide();
    if (this.pairing) await this.store({ ...this.pairing, autoHide });
  }

  private cancelAutoHide(): void {
    if (this.autoHideTimer !== null) clearTimeout(this.autoHideTimer);
    this.autoHideTimer = null;
  }

  /** A phone just left: if nobody takes over at the PC, take the game off its screen. */
  private phoneLeft(session: Session): void {
    if (!session.live || this.pairing?.autoHide === false) return;
    this.cancelAutoHide();
    this.autoHideTimer = setTimeout(() => void this.autoHide(), AUTO_HIDE_AFTER_MS);
  }

  private async autoHide(): Promise<void> {
    this.autoHideTimer = null;
    const idle = await this.deps.idleMs().catch(() => 0);
    const native = await this.deps.gameState().catch(() => null);
    // Any input since the phone left means someone's at the PC, and it's theirs now.
    if (this.session || idle < AUTO_HIDE_AFTER_MS - AUTO_HIDE_SLACK_MS || !native?.running || native.minimized) return;
    await this.deps.minimizeGame().catch(() => undefined);
    this.deps.log("hid the game: the phone left and nobody's at the PC");
  }

  /** A fresh link. Any phone paired before is out, on a new room. */
  async newLink(): Promise<void> {
    await this.confirmOwner();
    const enabled = this.pairing?.enabled ?? false;
    this.nonce = null;
    this.resume = null;
    this.endSession("a new link was made");
    this.goOffline();
    await this.store(newPairing(enabled));
    if (enabled) await this.goOnline();
  }

  endSession(reason = ENDED_ON_THIS_PC): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    // Coming back after a dropped network shouldn't ask again; being ended here should.
    if (this.resume) this.resume = reason === ENDED_ON_THIS_PC ? null : { ...this.resume, expiresAt: Date.now() + RESUME_LIFETIME_MS };
    this.deps.log(`session over after ${Math.round((Date.now() - session.openedAt) / 1000)} s: ${reason}`);
    if (session.poll !== null) clearInterval(session.poll);
    session.stopAudio?.();
    session.stream?.getTracks().forEach((track) => track.stop());
    session.peer.close();
    void this.deps.releaseInput().catch(() => undefined);
    void this.deps.keepAwake(this.pairing?.enabled ?? false, false).catch(() => undefined);
    this.emit();
  }

  private emit(): void {
    this.listener(this.snapshot());
  }

  private async store(pairing: RemotePairing): Promise<void> {
    await this.deps.savePairing(JSON.stringify(pairing));
    this.pairing = pairing;
    this.emit();
  }

  private async goOnline(): Promise<void> {
    if (this.socket || !this.pairing) return;
    void this.deps.keepAwake(true, false).catch(() => undefined);
    this.relay = "connecting";
    this.emit();
    const origin = PLAY_ORIGIN.replace(/^http/, "ws");
    const socket = this.deps.createSocket(`${origin}/ws/${this.pairing.room}?role=host`);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.relay = "online";
      this.deps.log("relay: online");
      this.pingTimer = setInterval(() => socket.send("ping"), PING_MS);
      this.emit();
    };
    socket.onmessage = (event) => void this.onRelayMessage(String(event.data));
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.deps.log(`relay: dropped (${event?.code}), trying again in ${this.reconnectDelay / 1000} s`);
      this.dropSocket();
      this.relay = "connecting";
      this.emit();
      this.reconnectTimer = setTimeout(() => void this.goOnline(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    };
  }

  private dropSocket(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onopen = null;
      socket.close();
    }
  }

  private goOffline(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.dropSocket();
    this.relay = "off";
    void this.deps.keepAwake(false, false).catch(() => undefined);
    this.emit();
  }

  private async onRelayMessage(text: string): Promise<void> {
    if (text === "pong" || parseRelayNotice(text) || !this.pairing) return;
    for (const credential of acceptedCredentials(this.pairing)) {
      const key = await signalKey(credential);
      const message = await unseal(key, "phone", text);
      if (message?.t === "offer") {
        // Stale means a replay or a phone with the wrong clock, not a stranger.
        if (isFreshOffer(message.at)) await (credential.viaLink ? this.openSession(message, true, key) : this.admit(message, key));
        else this.deps.log("ignored an old offer: a replay, or a phone with the wrong clock");
        return;
      }
    }
    // Wrong secret: an old link, or a phone that was forgotten. Tell it plainly.
    this.deps.log("refused a message sealed with the wrong secret");
    this.socket?.send(JSON.stringify({ relay: "denied" }));
  }

  /**
   * A paired phone gets no answer, and so no address and no connection, until
   * its passkey has signed for this very offer.
   */
  private async admit(offer: Extract<SignalMessage, { t: "offer" }>, key: CryptoKey): Promise<void> {
    const { proof, resume } = offer;
    if (resume && this.resume?.token === resume && Date.now() < this.resume.expiresAt) {
      this.resume = null;
      await this.openSession(offer, false, key);
      return;
    }
    const nonce = this.nonce;
    const passkey = this.pairing?.devicePasskey;
    if (proof && nonce && passkey && Date.now() < nonce.expiresAt) {
      this.nonce = null;
      if (await verifyProof(proof, passkey, nonce.value, offer.sdp)) {
        await this.openSession(offer, false, key);
        return;
      }
      this.deps.log("refused a passkey that didn't check out");
    }
    this.nonce = { value: createSecret(), expiresAt: Date.now() + NONCE_LIFETIME_MS };
    this.socket?.send(await seal(key, "host", { t: "challenge", nonce: this.nonce.value }));
  }

  private async openSession(offer: Extract<SignalMessage, { t: "offer" }>, viaLink: boolean, key: CryptoKey): Promise<void> {
    const { sdp, name, note, at } = offer;
    const turn = (this.offers += 1);
    const openedAt = Date.now();
    this.cancelAutoHide();
    this.endSession("the phone connected again");
    this.deps.log(`offer from ${name.slice(0, 40)}${viaLink ? " with the pairing link" : ""}: routes ${routeKinds(sdp)}${typeof note === "string" ? `; ${note.slice(0, MAX_REPORT_LENGTH)}` : ""}`);
    const iceServers = await this.deps.loadIceServers().catch(() => STUN);
    if (turn !== this.offers) return;
    const peer = this.deps.createPeer({ iceServers, bundlePolicy: "max-bundle" });
    try {
      await peer.setRemoteDescription({ type: "offer", sdp: tuneOffer(sdp) });
    } catch (error) {
      this.deps.log(`couldn't use the offer: ${String(error)}`);
      peer.close();
      return;
    }
    if (turn !== this.offers) {
      peer.close();
      return;
    }
    const transceivers = peer.getTransceivers();
    const video = transceivers.find((t) => t.receiver.track.kind === "video");
    const audio = transceivers.find((t) => t.receiver.track.kind === "audio");
    if (!video || !audio) {
      peer.close();
      return;
    }
    video.direction = "sendonly";
    audio.direction = "sendonly";

    const session: Session = {
      peer,
      channel: null,
      video,
      audio,
      name: name.slice(0, 40),
      viaLink,
      live: false,
      authed: !viaLink,
      channelOpened: false,
      stream: null,
      stopAudio: null,
      pending: null,
      poll: null,
      nextCaptureAt: 0,
      nextVideoLogAt: 0,
      lastState: "",
      openedAt,
    };
    this.session = session;
    this.emit();

    peer.ondatachannel = ({ channel }) => {
      session.channel = channel;
      channel.onopen = () => void this.onChannelOpen(session);
      channel.onmessage = (event) => void this.onCommand(session, String(event.data));
      channel.onclose = () => {
        if (this.session !== session) return;
        this.endSession("the connection closed");
        this.phoneLeft(session);
      };
      if (channel.readyState === "open") void this.onChannelOpen(session);
    };
    peer.oniceconnectionstatechange = () => {
      if (this.session === session) this.deps.log(`path: ${peer.iceConnectionState} after ${Date.now() - openedAt} ms`);
    };
    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if (this.session === session && (state === "failed" || state === "closed")) {
        this.endSession(`the connection ${state}`);
        this.phoneLeft(session);
      }
    };

    try {
      await peer.setLocalDescription(await peer.createAnswer());
      await iceGathered(peer);
    } catch (error) {
      this.deps.log(`couldn't answer: ${String(error)}`);
      if (this.session === session) this.endSession("couldn't answer");
      return;
    }
    if (this.session !== session) return;
    const answer = peer.localDescription?.sdp ?? "";
    const relayServer = iceServers.some(({ urls }) => [urls].flat().some((url) => url.startsWith("turn")));
    this.deps.log(`answered after ${Date.now() - openedAt} ms: routes ${routeKinds(answer)}, relay server ${relayServer ? "available" : "not set up"}`);
    this.socket?.send(await seal(key, "host", { t: "answer", sdp: answer, to: at }));
  }

  private async onChannelOpen(session: Session): Promise<void> {
    if (session.channelOpened || this.session !== session) return;
    session.channelOpened = true;
    this.deps.log(`connected after ${Date.now() - session.openedAt} ms`);
    void this.logPath(session);
    if (session.authed) await this.goLive(session);
    else this.beginPairing(session);
  }

  /** Only now does the phone get the game. */
  private async goLive(session: Session): Promise<void> {
    session.live = true;
    this.emit();
    this.onPhoneConnected(session.name);
    void this.deps.keepAwake(true, true).catch(() => undefined);
    this.resume = { token: createSecret(), expiresAt: Number.POSITIVE_INFINITY };
    this.sendEvent(session, { t: "resume", token: this.resume.token });
    await this.deps.focusGame().catch(() => undefined);
    if (this.session !== session) return;
    session.poll = setInterval(() => void this.refreshGame(session), STATE_POLL_MS);
    await this.refreshGame(session);
  }

  /** Which way the connection actually went. */
  private async logPath(session: Session): Promise<void> {
    const stats = await session.peer.getStats().catch(() => null);
    stats?.forEach((report) => {
      if (report.type !== "candidate-pair" || !report.nominated || report.state !== "succeeded") return;
      const rtt = report.currentRoundTripTime === undefined ? "" : `, ${Math.round(report.currentRoundTripTime * 1000)} ms`;
      this.deps.log(`path: ${stats.get(report.localCandidateId)?.candidateType} to ${stats.get(report.remoteCandidateId)?.candidateType}${rtt}`);
    });
  }

  /** What's really going out, so "no picture" can be told from "no connection". */
  private async logVideo(session: Session): Promise<void> {
    const stats = await session.peer.getStats().catch(() => null);
    stats?.forEach((report) => {
      if (report.type !== "outbound-rtp" || report.kind !== "video") return;
      const size = `${report.frameWidth}x${report.frameHeight}`;
      this.deps.log(`video: ${report.framesSent} frames sent, ${size}, ${report.encoderImplementation}, held back by ${report.qualityLimitationReason}, ${Math.round(report.bytesSent / 1_000_000)} MB`);
    });
  }

  /** Swap the one-time link for a room, a secret and a passkey only this phone holds. */
  private beginPairing(session: Session): void {
    session.pending = { room: createRoom(), secret: createSecret(), challenge: createSecret() };
    this.sendEvent(session, { t: "pair", ...session.pending });
  }

  private async finishPairing(session: Session, registration: PasskeyRegistration): Promise<void> {
    const pending = session.pending;
    if (!pending || !this.pairing) return;
    const passkey = await verifyRegistration(registration, pending.challenge);
    if (this.session !== session) return;
    if (!passkey) {
      this.deps.log("refused a passkey that didn't check out while pairing");
      this.endSession("pairing failed");
      return;
    }
    session.pending = null;
    await this.store({
      ...this.pairing,
      room: pending.room,
      linkSecret: null,
      linkExpiresAt: null,
      deviceSecret: pending.secret,
      deviceName: session.name,
      devicePasskey: passkey,
    });
    // Whoever has the old link now reaches an empty room. This session is
    // direct, so leaving the relay doesn't touch it.
    this.dropSocket();
    await this.goOnline();
    if (this.session !== session) return;
    session.authed = true;
    await this.goLive(session);
  }

  private sendEvent(session: Session, event: HostEvent): void {
    if (session.channel?.readyState === "open") session.channel.send(JSON.stringify(event));
  }

  private async refreshGame(session: Session): Promise<void> {
    if (this.session !== session) return;
    const native = await this.deps.gameState().catch(() => null);
    if (!native || this.session !== session) return;
    // A key or button held down mustn't carry over into whatever is in front now.
    if (!native.front) void this.deps.releaseInput().catch(() => undefined);

    const track = session.stream?.getVideoTracks()[0];
    if (track?.readyState === "ended") {
      this.deps.log("capture: the picture stopped");
      this.dropCapture(session);
    }
    this.sendState(session, native);
    if (native.running && native.responding && !native.minimized && !session.stream && !native.locked) {
      await this.startCapture(session);
      if (this.session !== session) return;
      this.sendState(session, native);
    }
    if (session.stream && Date.now() >= session.nextVideoLogAt) {
      session.nextVideoLogAt = Date.now() + VIDEO_LOG_EVERY_MS;
      void this.logVideo(session);
    }
  }

  private sendState(session: Session, native: NativeGameState): void {
    const state: PlayState = {
      game: gamePhase(native),
      video: session.stream !== null,
      locked: native.locked,
      canLaunch: native.canLaunch,
    };
    const summary = JSON.stringify(state);
    if (summary !== session.lastState) {
      session.lastState = summary;
      this.sendEvent(session, { t: "state", ...state });
    }
  }

  private dropCapture(session: Session): void {
    session.stream?.getTracks().forEach((track) => track.stop());
    session.stream = null;
    session.stopAudio?.();
    session.stopAudio = null;
    void session.video.sender.replaceTrack(null);
    void session.audio.sender.replaceTrack(null);
  }

  private async startCapture(session: Session): Promise<void> {
    if (this.capturing || Date.now() < session.nextCaptureAt) return;
    this.capturing = true;
    const started = Date.now();
    try {
      const stream = await this.deps.captureGame();
      this.deps.log(`capture: got the game after ${Date.now() - started} ms`);
      if (this.session !== session) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      session.stream = stream;
      session.nextVideoLogAt = Date.now() + FIRST_VIDEO_LOG_MS;
      const [track] = stream.getVideoTracks();
      track.contentHint = "motion";
      await session.video.sender.replaceTrack(track);
      const parameters = session.video.sender.getParameters();
      for (const encoding of parameters.encodings ?? []) {
        encoding.maxBitrate = MAX_VIDEO_BITRATE;
        encoding.maxFramerate = MAX_FRAME_RATE;
      }
      await session.video.sender.setParameters(parameters).catch(() => undefined);
      if (this.session !== session) return;
      const stopAudio = await this.deps.startAudio(session.audio.sender).catch((error: unknown) => {
        this.deps.log(`sound: couldn't start: ${String(error)}`);
        return null;
      });
      // Sound runs until told to stop, and nothing tells a session that's over.
      if (this.session === session) session.stopAudio = stopAudio;
      else stopAudio?.();
    } catch (error) {
      this.deps.log(`capture: failed: ${String(error)}`);
      session.nextCaptureAt = Date.now() + CAPTURE_RETRY_MS;
    } finally {
      this.capturing = false;
    }
  }

  private async onCommand(session: Session, text: string): Promise<void> {
    if (this.session !== session) return;
    const command = parseCommand(text);
    if (!command) return;
    if (!session.authed) {
      // A phone mid-pairing can do exactly one thing: finish pairing.
      if (command.t === "paired") await this.finishPairing(session, command.passkey);
    } else if (command.t === "focus") {
      await this.deps.focusGame().catch(() => undefined);
      await this.refreshGame(session);
    } else if (command.t === "minimize") {
      await this.deps.minimizeGame().catch(() => undefined);
      await this.refreshGame(session);
    } else if (command.t === "launch") {
      await this.deps.launchGame().catch(() => undefined);
    } else if (command.t === "report") {
      if (typeof command.text === "string") this.deps.log(`phone: ${command.text.slice(0, MAX_REPORT_LENGTH)}`);
    } else if (REMOTE_PLAY_INPUTS.includes(command.t)) {
      // Refused while the game isn't in front; the next state update says why.
      await this.deps.input(command).catch(() => undefined);
    }
  }
}

// ── The real dependencies ────────────────────────────────────────────────────

/** Chromium's audio-track writer; not in TypeScript's DOM types yet. */
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: "audio" });
  readonly writable: WritableStream<AudioData>;
}

/** The game window only, picked out and checked by its handle. */
async function captureGame(): Promise<MediaStream> {
  const handle = await invoke<string>("remote_play_capture_begin");
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the capture didn't start")), CAPTURE_TIMEOUT_MS);
    });
    const request = navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: MAX_FRAME_RATE }, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
    });
    const stream = await Promise.race([request, timeout])
      .catch((error: unknown) => {
        // If it starts after all, it mustn't run on with nobody holding it.
        void request.then((late) => late.getTracks().forEach((track) => track.stop()), () => undefined);
        throw error;
      })
      .finally(() => clearTimeout(timer));
    if (stream.getVideoTracks()[0]?.label !== `window:${handle}:0`) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("captured the wrong window");
    }
    return stream;
  } finally {
    await invoke("remote_play_capture_end");
  }
}

/** Only the game's own sound: Windows taps that one process, not the whole PC. */
async function startAudio(sender: RTCRtpSender): Promise<() => void> {
  const generator = new MediaStreamTrackGenerator({ kind: "audio" });
  const writer = generator.writable.getWriter();
  const channel = new Channel<ArrayBuffer>();
  let timestamp = 0;
  channel.onmessage = (buffer) => {
    const samples = new Float32Array(buffer);
    const numberOfFrames = samples.length / AUDIO_CHANNELS;
    const data = new AudioData({
      format: "f32",
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: AUDIO_CHANNELS,
      numberOfFrames,
      timestamp,
      data: samples,
    });
    timestamp += (numberOfFrames / AUDIO_SAMPLE_RATE) * 1_000_000;
    void writer.write(data).catch(() => data.close());
  };
  await invoke("remote_play_audio_start", { onAudio: channel });
  await sender.replaceTrack(generator);
  return () => {
    void invoke("remote_play_audio_stop");
    void writer.close().catch(() => undefined);
  };
}

async function loadIceServers(): Promise<RTCIceServer[]> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ICE_CONFIG_WAIT_MS);
  try {
    const response = await fetch(`${PLAY_ORIGIN}/ice`, { cache: "no-store", signal: stop.signal });
    const body = (await response.json()) as { iceServers?: RTCIceServer[] };
    return Array.isArray(body.iceServers) ? body.iceServers : STUN;
  } finally {
    clearTimeout(timer);
  }
}

export const realHostDeps: HostDeps = {
  loadPairing: () => invoke<string | null>("remote_play_load_pairing"),
  savePairing: (pairing) => invoke("remote_play_save_pairing", { pairing }),
  gameState: () => invoke<NativeGameState>("remote_play_game_state"),
  focusGame: () => invoke("remote_play_focus_game"),
  minimizeGame: () => invoke("remote_play_minimize_game"),
  idleMs: () => invoke<number>("remote_play_idle_ms"),
  launchGame: () => invoke("remote_play_launch_game"),
  input: (input) => invoke("remote_play_input", { input }),
  releaseInput: () => invoke("remote_play_release"),
  verifyOwner: () => invoke("remote_play_verify_owner"),
  keepAwake: (system, display) => invoke("remote_play_keep_awake", { system, display }),
  captureGame,
  startAudio,
  loadIceServers,
  createSocket: (url) => new WebSocket(url),
  createPeer: (config) => new RTCPeerConnection(config),
  log: (line) => {
    invoke("remote_play_log", { line: `${new Date().toLocaleString("sv")}  ${line}` }).catch(() => undefined);
  },
};
