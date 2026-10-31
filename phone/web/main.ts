// remote-play/web/main.ts
//
// The page behind the Remote Play link: connects a phone to its PC and turns
// touch into game input. See REMOTE-PLAY.md for the whole picture.

import {
  MAX_TEXT_LENGTH,
  isCredential,
  parseLinkFragment,
  credentialToUse,
  parseRelayNotice,
  seal,
  signalKey,
  unseal,
  type HostEvent,
  type PhoneCommand,
  type PlayCredential,
  type PlayKey,
  type PlayState,
  type SavedCredential,
} from "../../shared/remotePlay";
import { Gestures, pictureRect, toGamePoint, type Rect } from "./controls";

const STORE_KEY = "3dx-play:v1";
const ICE_WAIT_MS = 2500;
const ANSWER_WAIT_MS = 20_000;
const RETRY_MS = 2000;
const PING_MS = 25_000;
const STATS_MS = 2000;
const MAGNIFIED = 2;
const CHAT_CLOSE_MS = 200;
/** The game's cameras in the order the camera button walks through them. */
const CAMERA_KEYS: PlayKey[] = ["f7", "f5", "f6"];
const STUN = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const picture = element<HTMLVideoElement>("picture");
const surface = element("surface");
const badge = element("badge");
const chatForm = element<HTMLFormElement>("chat");
const chatInput = element<HTMLInputElement>("chat-input");
const zoomButton = element("zoom-button");
const soundButton = element("sound-button");
const panel = element("panel");
const panelTitle = element("panel-title");
const panelText = element("panel-text");
const panelAction = element<HTMLButtonElement>("panel-action");
const panelLink = element("panel-link");

let remoteStream: MediaStream | null = null;
let credential: PlayCredential | null = null;
/** Connecting with a link rather than this phone's own credential. */
let viaLink = false;
let signal: CryptoKey | null = null;
let iceServers: RTCIceServer[] = STUN;
let relay: WebSocket | null = null;
let peer: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let live = false;
let wanted = false;
let failures = 0;
let panelFor: "connection" | "game" | null = null;
let answerTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let wakeLock: { release(): Promise<void> } | null = null;
let cameraIndex = 0;
let magnified = false;
let panX = 0;
let panY = 0;

function storedCredential(): SavedCredential | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    return isCredential(value) ? (value as SavedCredential) : null;
  } catch {
    return null;
  }
}

function deviceName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return "iPhone";
  if (/iPad/.test(agent)) return "iPad";
  if (/Android/.test(agent)) return "Android phone";
  return "Phone";
}

function isInstallableIos(): boolean {
  const iosSafari = /iPhone|iPad/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
  return iosSafari && (navigator as Navigator & { standalone?: boolean }).standalone === false;
}

interface PanelAction {
  label: string;
  run: () => void;
}

function showPanel(owner: "connection" | "game" | null, title: string, text: string, action?: PanelAction, download = false): void {
  panelFor = owner;
  panelTitle.textContent = title;
  panelText.textContent = text;
  panelAction.hidden = !action;
  panelAction.textContent = action?.label ?? "";
  panelAction.onclick = action?.run ?? null;
  panelLink.hidden = !download;
  panel.hidden = false;
}

function hidePanel(): void {
  panelFor = null;
  panel.hidden = true;
}

function setLive(value: boolean): void {
  live = value;
  document.body.classList.toggle("live", value);
  if (!value) {
    gestures.cancel();
    closeChat();
    badge.textContent = "";
  }
}

/** If the phone won't start with sound, start muted: a picture beats silence. */
function playPicture(): void {
  picture.play().catch(() => {
    picture.muted = true;
    soundButton.setAttribute("aria-pressed", "false");
    picture.play().catch(() => undefined);
  });
}

function send(command: PhoneCommand): void {
  if (channel?.readyState === "open") channel.send(JSON.stringify(command));
}

// ── Connecting ───────────────────────────────────────────────────────────────

function relayUrl(room: string): string {
  const origin = location.origin.replace(/^http/, "ws");
  return `${origin}/ws/${room}?role=phone`;
}

async function loadIceServers(): Promise<void> {
  try {
    const response = await fetch("/ice", { cache: "no-store" });
    const body = (await response.json()) as { iceServers?: RTCIceServer[] };
    if (Array.isArray(body.iceServers)) iceServers = body.iceServers;
  } catch {
    iceServers = STUN;
  }
}

function clearAnswerTimer(): void {
  if (answerTimer !== null) clearTimeout(answerTimer);
  answerTimer = null;
}

function closeRelay(): void {
  if (pingTimer !== null) clearInterval(pingTimer);
  pingTimer = null;
  if (relay) {
    relay.onclose = null;
    relay.close();
  }
  relay = null;
}

function closePeer(): void {
  clearAnswerTimer();
  if (statsTimer !== null) clearInterval(statsTimer);
  statsTimer = null;
  if (channel) channel.onclose = null;
  channel?.close();
  channel = null;
  if (peer) {
    peer.onconnectionstatechange = null;
    peer.close();
  }
  peer = null;
  for (const track of remoteStream?.getTracks() ?? []) remoteStream?.removeTrack(track);
}

function disconnect(): void {
  closePeer();
  closeRelay();
  setLive(false);
}

function retrySoon(): void {
  disconnect();
  if (wanted) setTimeout(() => void connect(), RETRY_MS);
}

async function connect(): Promise<void> {
  if (!wanted || !credential || relay) return;
  showPanel("connection", "Connecting", failures > 1 ? "Still trying. A different network, like Wi-Fi, can help." : "Reaching your PC...");
  signal = await signalKey(credential);
  await loadIceServers();
  if (!wanted || relay) return;

  const socket = new WebSocket(relayUrl(credential.room));
  relay = socket;
  socket.onopen = () => {
    pingTimer = setInterval(() => socket.send("ping"), PING_MS);
  };
  socket.onmessage = (event) => void onRelayMessage(String(event.data));
  socket.onclose = () => {
    if (relay === socket) retrySoon();
  };
}

async function onRelayMessage(text: string): Promise<void> {
  if (text === "pong") return;
  const notice = parseRelayNotice(text);
  if (notice?.relay === "denied") {
    // Not proof of anything, as the relay can't vouch for who sent it, so what
    // this phone has saved stays put.
    wanted = false;
    disconnect();
    showPanel(null, "Your PC doesn't know this phone", "Open Remote Play on your PC and make a new link.");
    return;
  }
  if (notice?.relay === "peers") {
    if (notice.host) {
      if (!peer) await startPeer();
    } else if (!live) {
      closePeer();
      const usedLink = viaLink ? " A link that was already used won't connect again." : "";
      showPanel("connection", "Your PC is offline", `Turn on your PC and make sure Remote Play is on. This page connects by itself once it's back.${usedLink}`);
    }
    return;
  }
  if (!signal || !peer) return;
  const message = await unseal(signal, "host", text);
  if (message?.t === "answer") {
    clearAnswerTimer();
    await peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
  }
}

function iceGathered(connection: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (connection.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(resolve, ICE_WAIT_MS);
    connection.addEventListener("icegatheringstatechange", () => {
      if (connection.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function startPeer(): Promise<void> {
  const connection = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
  peer = connection;
  connection.addTransceiver("video", { direction: "recvonly" });
  connection.addTransceiver("audio", { direction: "recvonly" });
  connection.ontrack = ({ receiver, track }) => {
    remoteStream?.addTrack(track);
    // Lowest latency the browser will do; older Safari just ignores this.
    (receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = 0;
    playPicture();
  };
  connection.onconnectionstatechange = () => {
    if (connection !== peer) return;
    if (connection.connectionState === "failed") {
      failures += 1;
      retrySoon();
    }
  };

  const dataChannel = connection.createDataChannel("play");
  channel = dataChannel;
  dataChannel.onopen = onChannelOpen;
  dataChannel.onmessage = (event) => onHostEvent(String(event.data));
  dataChannel.onclose = retrySoon;

  await connection.setLocalDescription(await connection.createOffer());
  await iceGathered(connection);
  if (connection !== peer || !signal || relay?.readyState !== WebSocket.OPEN) return;
  const sdp = connection.localDescription?.sdp ?? "";
  relay.send(await seal(signal, "phone", { t: "offer", sdp, at: Date.now(), name: deviceName() }));
  answerTimer = setTimeout(() => {
    failures += 1;
    retrySoon();
  }, ANSWER_WAIT_MS);
}

function onChannelOpen(): void {
  failures = 0;
  // Only needed again if this connection drops.
  closeRelay();
  setLive(true);
  hidePanel();
  playPicture();
  void keepScreenOn();
  statsTimer = setInterval(() => void updateBadge(), STATS_MS);
}

function onHostEvent(text: string): void {
  let event: HostEvent;
  try {
    event = JSON.parse(text) as HostEvent;
  } catch {
    return;
  }
  if (event.t === "pair") {
    const paired = { room: event.room, secret: event.secret };
    if (!isCredential(paired)) return;
    const saved: SavedCredential = { ...paired, usedLink: credential?.room };
    credential = paired;
    viaLink = false;
    localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    // The link did its job; don't leave it in the address bar or history.
    history.replaceState(null, "", location.pathname);
    send({ t: "paired" });
  } else if (event.t === "state") {
    showGameState(event);
  }
}

function showGameState(state: PlayState): void {
  if (state.locked) {
    showPanel("game", "Your PC is locked", "Windows has to be unlocked at the PC before you can play. Leave it unlocked next time you head out.");
  } else if (state.game === "closed") {
    showPanel(
      "game",
      "3DXChat is closed",
      state.canLaunch ? "Start it on your PC from here." : "Open 3DXChat on your PC once, then it can be started from here.",
      state.canLaunch ? { label: "Open 3DXChat", run: () => send({ t: "launch" }) } : undefined,
    );
  } else if (state.game === "frozen") {
    showPanel("game", "3DXChat isn't responding", "It has frozen on your PC. This page carries on by itself if it comes back.");
  } else if (state.game === "background") {
    showPanel("game", "3DXChat isn't in front", "Something else is on top of the game on your PC.", {
      label: "Bring it to the front",
      run: () => send({ t: "focus" }),
    });
  } else if (!state.video) {
    showPanel("game", "Starting the picture", "Getting 3DXChat ready...");
  } else if (panelFor === "game") {
    hidePanel();
  }
}

async function updateBadge(): Promise<void> {
  if (!peer) return;
  const stats = await peer.getStats();
  const pairs: { currentRoundTripTime?: number; localCandidateId?: string }[] = [];
  stats.forEach((report) => {
    if (report.type === "candidate-pair" && report.nominated && report.state === "succeeded") pairs.push(report);
  });
  const pair = pairs[0];
  if (!pair) return;
  const relayed = stats.get(pair.localCandidateId ?? "")?.candidateType === "relay";
  const ms = pair.currentRoundTripTime === undefined ? "" : `${Math.round(pair.currentRoundTripTime * 1000)} ms`;
  badge.textContent = relayed ? `${ms} relayed` : ms;
}

async function keepScreenOn(): Promise<void> {
  try {
    const lock = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
    wakeLock = (await lock?.request("screen")) ?? null;
  } catch {
    wakeLock = null;
  }
}

// ── Touch ────────────────────────────────────────────────────────────────────

function currentPicture(): Rect {
  const box = picture.getBoundingClientRect();
  return pictureRect(box, picture.videoWidth, picture.videoHeight);
}

function applyMagnifier(): void {
  picture.style.transform = magnified ? `translate(${panX}px, ${panY}px) scale(${MAGNIFIED})` : "";
}

function panPicture(dx: number, dy: number): boolean {
  if (!magnified) return false;
  panX = Math.min(0, Math.max(window.innerWidth * (1 - MAGNIFIED), panX + dx));
  panY = Math.min(0, Math.max(window.innerHeight * (1 - MAGNIFIED), panY + dy));
  applyMagnifier();
  return true;
}

const gestures = new Gestures({
  input: send,
  locate: (x, y) => toGamePoint(x, y, currentPicture()),
  pan: panPicture,
});

surface.addEventListener("pointerdown", (event) => {
  surface.setPointerCapture(event.pointerId);
  gestures.down(event.pointerId, event.clientX, event.clientY);
});
surface.addEventListener("pointermove", (event) => gestures.move(event.pointerId, event.clientX, event.clientY));
surface.addEventListener("pointerup", (event) => gestures.up(event.pointerId));
surface.addEventListener("pointercancel", () => gestures.cancel());

// iOS pinch-zooms the page unless told not to, whatever the viewport says.
for (const type of ["gesturestart", "gesturechange", "dblclick"]) {
  document.addEventListener(type, (event) => event.preventDefault());
}

// ── Buttons ──────────────────────────────────────────────────────────────────

function openChat(): void {
  chatForm.hidden = false;
  document.body.classList.add("chatting");
  // Inside the tap, or iOS won't raise the keyboard.
  chatInput.focus();
}

function closeChat(): void {
  chatForm.hidden = true;
  document.body.classList.remove("chatting");
  chatInput.value = "";
  chatInput.blur();
}

element("chat-button").addEventListener("click", () => (chatForm.hidden ? openChat() : closeChat()));

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim().slice(0, MAX_TEXT_LENGTH);
  if (text) send({ t: "chat", text });
  closeChat();
});

// Dismissing the keyboard closes the bar. The wait lets a tap on Send land first.
chatInput.addEventListener("blur", () => setTimeout(closeChat, CHAT_CLOSE_MS));

element("camera-button").addEventListener("click", () => {
  send({ t: "press", key: CAMERA_KEYS[cameraIndex] });
  cameraIndex = (cameraIndex + 1) % CAMERA_KEYS.length;
});

element("menu-button").addEventListener("click", () => send({ t: "press", key: "escape" }));

zoomButton.addEventListener("click", () => {
  magnified = !magnified;
  panX = magnified ? (window.innerWidth * (1 - MAGNIFIED)) / 2 : 0;
  panY = magnified ? (window.innerHeight * (1 - MAGNIFIED)) / 2 : 0;
  zoomButton.setAttribute("aria-pressed", String(magnified));
  applyMagnifier();
});

soundButton.addEventListener("click", () => {
  picture.muted = !picture.muted;
  soundButton.setAttribute("aria-pressed", String(!picture.muted));
  picture.play().catch(() => undefined);
});

element("end-button").addEventListener("click", () => {
  wanted = false;
  disconnect();
  void wakeLock?.release().catch(() => undefined);
  wakeLock = null;
  showPanel(null, "Session ended", "Your PC stays ready for next time.", { label: "Play again", run: start });
});

// ── Start ────────────────────────────────────────────────────────────────────

/** Runs inside a tap: the only moment phones allow sound and full screen. */
function start(): void {
  if (!credential) return;
  wanted = true;
  remoteStream ??= new MediaStream();
  picture.srcObject = remoteStream;
  picture.muted = false;
  soundButton.setAttribute("aria-pressed", "true");
  playPicture();
  void document.documentElement.requestFullscreen?.({ navigationUI: "hide" })
    .then(() => (screen.orientation as ScreenOrientation & { lock?(orientation: string): Promise<void> }).lock?.("landscape"))
    .catch(() => undefined);
  void connect();
}

function boot(): void {
  if (typeof RTCPeerConnection !== "function") {
    showPanel(null, "This browser can't play", "Open this page in Safari or Chrome instead. Apps like Instagram and Discord open links in a browser of their own.");
    return;
  }
  const link = parseLinkFragment(location.hash);
  credential = credentialToUse(link, storedCredential());
  const fromLink = credential === link ? link : null;
  viaLink = fromLink !== null;
  if (!credential) {
    showPanel(null, "3DX Remote Play", "Play 3DXChat on your phone. Install 3DX Remote Play on your PC and scan the code it shows.", undefined, true);
    return;
  }
  const tip = fromLink && isInstallableIos()
    ? "For full screen: tap Share, choose Add to Home Screen, and open 3DX Play from there. Set it up before you start, this link only works once."
    : "Your game, on your PC, wherever you are.";
  showPanel(null, "3DX Remote Play", tip, { label: "Start playing", run: start });
}

// A link opened again, like a home-screen copy of one, must not wait for a reload.
window.addEventListener("hashchange", boot);
window.addEventListener("pagehide", disconnect);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && live) void keepScreenOn();
});

boot();
