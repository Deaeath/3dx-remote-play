// remote-play/web/main.ts
//
// The page behind the Remote Play link: connects a phone to its PC and turns
// touch into game input. See REMOTE-PLAY.md for the whole picture.

import {
  MAX_TEXT_LENGTH,
  RELAY_REPLACED_CODE,
  isCredential,
  parseLinkFragment,
  credentialToUse,
  parseRelayNotice,
  routeKinds,
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
import type { PasskeyProof } from "../../shared/passkey";
import { Controller } from "./controller";
import { Gestures, pictureRect, toGamePoint, type Rect } from "./controls";
import { buildKeyboard, buildPad } from "./panels";
import { canUsePasskeys, makePasskey, provePasskey } from "./passkeys";

declare const __PAGE_VERSION__: string;

const STORE_KEY = "3dx-play:v1";
const ICE_WAIT_MS = 2500;
const ICE_CONFIG_WAIT_MS = 4000;
const RELAY_WAIT_MS = 15_000;
const ANSWER_WAIT_MS = 20_000;
/** Longer than a slow network needs, shorter than Safari takes to give up by itself. */
const PATH_WAIT_MS = 25_000;
/** Shorter than the PC keeps its nonce, so an Unlock left waiting never fails. */
const UNLOCK_WAIT_MS = 4 * 60_000;
/** One refusal can just mean the PC restarted. Two means it doesn't know this passkey. */
const MAX_PROOF_REJECTIONS = 2;
const RETRY_MS = 2000;
const PING_MS = 25_000;
const STATS_MS = 2000;
const DETAIL_MS = 1000;
const CONTROLLER_TICK_MS = 33;
/** Tell the PC what this phone really sees: soon after starting, then now and then. */
const REPORT_FIRST_TICK = 3;
const REPORT_EVERY_TICKS = 15;
/** What to say once a stage of connecting has failed, by the stage. */
const STUCK = {
  relay: "This phone can't reach the internet right now. Still trying.",
  answer: "Your PC isn't answering. Check that 3DX Remote Play is running on it. Still trying.",
  path: "Your phone and PC can't reach each other right now. Still trying.",
  page: "Something went wrong on this phone. Still trying.",
  unlock: "Still waiting for you to unlock.",
};
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
const panelDetail = element("panel-detail");
element("page-version").textContent = `Version ${__PAGE_VERSION__}`;
const panelAction = element<HTMLButtonElement>("panel-action");
const panelLink = element("panel-link");

let remoteStream: MediaStream | null = null;
let credential: PlayCredential | null = null;
/** Connecting with a link rather than this phone's own credential. */
let viaLink = false;
let passkeyId: string | null = null;
/** Only ever in memory: closing the page means the passkey again. */
let resumeToken: string | null = null;
/** The new room and secret, until this phone's passkey exists. */
let pendingPair: (PlayCredential & { challenge: string }) | null = null;
/** The offer ready to go, and whether a passkey has already signed for it. */
let readySdp = "";
let proofSent = false;
let proofRejections = 0;
let signal: CryptoKey | null = null;
let iceServers: RTCIceServer[] = STUN;
let relay: WebSocket | null = null;
let peer: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let live = false;
let wanted = false;
let failures = 0;
/** Replaces the step's own text once an attempt has failed. */
let stuckHint = "";
/** How the attempt that just failed went; goes with the next offer. */
let lastNote = "";
let attemptStarted = 0;
let step = "";
let phoneRoutes = "";
let pcRoutes = "";
/** The `at` of the offer now waiting for an answer. */
let offerAt = 0;
let panelFor: "connection" | "game" | null = null;
let attemptTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let awaitingPong = false;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let statsTicks = 0;
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

/** How far the current attempt has got. Never an address, so a screenshot of it is safe to share. */
function attemptStatus(): string {
  const parts = [`${Math.round((Date.now() - attemptStarted) / 1000)} s`, step];
  if (peer) parts.push(`path ${peer.iceConnectionState}`);
  if (phoneRoutes) parts.push(`phone ${phoneRoutes}`);
  if (pcRoutes) parts.push(`PC ${pcRoutes}`);
  return parts.join(" \u00b7 ");
}

function showPanel(owner: "connection" | "game" | null, title: string, text: string, action?: PanelAction, download = false): void {
  panelFor = owner;
  panelTitle.textContent = title;
  panelText.textContent = text;
  panelDetail.hidden = owner !== "connection";
  panelDetail.textContent = owner === "connection" ? attemptStatus() : "";
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

function showStep(name: string, text: string): void {
  step = name;
  showPanel("connection", "Connecting", stuckHint || text);
}

function setLive(value: boolean): void {
  live = value;
  document.body.classList.toggle("live", value);
  if (!value) {
    gestures.cancel();
    closeChat();
    openPanel(null);
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
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ICE_CONFIG_WAIT_MS);
  try {
    const response = await fetch("/ice", { cache: "no-store", signal: stop.signal });
    const body = (await response.json()) as { iceServers?: RTCIceServer[] };
    if (Array.isArray(body.iceServers)) iceServers = body.iceServers;
  } catch {
    iceServers = STUN;
  } finally {
    clearTimeout(timer);
  }
}

function clearAttemptTimer(): void {
  if (attemptTimer !== null) clearTimeout(attemptTimer);
  attemptTimer = null;
}

function attemptFailed(stage: keyof typeof STUCK, detail = ""): void {
  stuckHint = STUCK[stage];
  lastNote = `${stage} failed at ${attemptStatus()}${detail && `: ${detail}`}`;
  failures += 1;
  retrySoon();
  // Say so now: the next attempt is a moment away, and could take a while.
  if (wanted) showStep("about to try again", stuckHint);
}

function giveUpAfter(ms: number, stage: keyof typeof STUCK): void {
  clearAttemptTimer();
  attemptTimer = setTimeout(() => attemptFailed(stage), ms);
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
  clearAttemptTimer();
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
  if (wanted) setTimeout(connectNow, RETRY_MS);
}

function connectNow(): void {
  connect().catch((error: unknown) => attemptFailed("page", String(error)));
}

/**
 * Another copy of this page took the room, like a second tab or the Home Screen
 * icon. Coming straight back would throw that one out, and it would do the same
 * in return, and neither would ever get connected.
 */
function replacedElsewhere(): void {
  wanted = false;
  disconnect();
  showPanel(null, "Playing somewhere else", "Another copy of this page took over, like a second tab or the Home Screen icon. Only one can play at a time.", {
    label: "Play here",
    run: start,
  });
}

async function connect(): Promise<void> {
  if (!wanted || !credential || relay) return;
  attemptStarted = Date.now();
  phoneRoutes = "";
  pcRoutes = "";
  showStep("reaching the relay", "Reaching your PC...");
  signal = await signalKey(credential);
  await loadIceServers();
  if (!wanted || relay) return;

  const socket = new WebSocket(relayUrl(credential.room));
  relay = socket;
  socket.onopen = () => {
    awaitingPong = false;
    pingTimer = setInterval(() => {
      // The network can drop a socket without telling either end.
      if (awaitingPong) {
        lastNote = `the relay stopped answering at ${attemptStatus()}`;
        retrySoon();
        return;
      }
      awaitingPong = true;
      socket.send("ping");
    }, PING_MS);
  };
  socket.onmessage = (event) => void onRelayMessage(String(event.data));
  socket.onclose = (event) => {
    if (relay !== socket) return;
    if (event.code === RELAY_REPLACED_CODE) replacedElsewhere();
    else retrySoon();
  };
  giveUpAfter(RELAY_WAIT_MS, "relay");
}

async function onRelayMessage(text: string): Promise<void> {
  if (text === "pong") {
    awaitingPong = false;
    return;
  }
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
      if (!peer) await startPeer().catch((error: unknown) => attemptFailed("page", String(error)));
    } else if (!live) {
      closePeer();
      step = "waiting for the PC";
      const usedLink = viaLink ? " A link that was already used won't connect again." : "";
      showPanel("connection", "Your PC is offline", `Turn on your PC and make sure Remote Play is on. This page connects by itself once it's back.${usedLink}`);
    }
    return;
  }
  const connection = peer;
  if (!signal || !connection) return;
  const message = await unseal(signal, "host", text);
  if (message?.t === "challenge" && connection === peer) {
    await onChallenge(connection, message.nonce);
    return;
  }
  if (message?.t !== "answer" || connection !== peer) return;
  // A slow PC's answer to the last attempt would break this one.
  if (message.to !== undefined && message.to !== offerAt) return;
  pcRoutes = routeKinds(message.sdp);
  showStep("finding a path", "Finding a path to your PC...");
  giveUpAfter(PATH_WAIT_MS, "path");
  await connection.setRemoteDescription({ type: "answer", sdp: message.sdp }).catch((error: unknown) => {
    if (connection === peer) attemptFailed("page", String(error));
  });
}

/** The PC wants the passkey. On most phones that takes a tap, so offer one if asking outright fails. */
async function onChallenge(connection: RTCPeerConnection, nonce: string): Promise<void> {
  resumeToken = null;
  if (proofSent) proofRejections += 1;
  proofSent = false;
  if (proofRejections >= MAX_PROOF_REJECTIONS || !passkeyId) {
    wanted = false;
    disconnect();
    showPanel(null, "Your PC doesn't know this phone", "Open Remote Play on your PC and make a new link.");
    return;
  }
  const unlock = async (): Promise<void> => {
    if (connection !== peer || !passkeyId) return;
    try {
      const proof = await provePasskey(passkeyId, nonce, readySdp);
      proofSent = true;
      await sendOffer(connection, { proof });
    } catch {
      if (connection !== peer) return;
      giveUpAfter(UNLOCK_WAIT_MS, "unlock");
      showPanel("connection", "Unlock to play", "Confirm it's you, and your PC will connect.", { label: "Unlock", run: () => void unlock() });
    }
  };
  await unlock();
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

/** What goes with an offer into the PC's log. */
function offerNote(): string {
  const installed = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const parts = [`page ${__PAGE_VERSION__}`, installed ? "home screen" : "browser"];
  if (iceServers.some(({ urls }) => [urls].flat().some((url) => url.startsWith("turn")))) parts.push("relay available");
  if (failures > 0) parts.push(`${failures} failed before`);
  if (lastNote) parts.push(lastNote);
  lastNote = "";
  return parts.join("; ");
}

async function startPeer(): Promise<void> {
  clearAttemptTimer();
  const connection = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
  peer = connection;
  showStep("preparing", "Reaching your PC...");
  connection.addTransceiver("video", { direction: "recvonly" });
  connection.addTransceiver("audio", { direction: "recvonly" });
  connection.ontrack = ({ receiver, track }) => {
    remoteStream?.addTrack(track);
    // Lowest latency the browser will do; older Safari just ignores this.
    (receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = 0;
    playPicture();
  };
  const onStateChange = () => {
    if (connection !== peer) return;
    if (connection.connectionState === "failed" || connection.iceConnectionState === "failed") attemptFailed("path");
  };
  connection.onconnectionstatechange = onStateChange;
  connection.oniceconnectionstatechange = onStateChange;

  const dataChannel = connection.createDataChannel("play");
  channel = dataChannel;
  dataChannel.onopen = onChannelOpen;
  dataChannel.onmessage = (event) => onHostEvent(String(event.data));
  dataChannel.onclose = () => {
    lastNote = `the connection closed at ${attemptStatus()}`;
    retrySoon();
  };

  await connection.setLocalDescription(await connection.createOffer());
  await iceGathered(connection);
  if (connection !== peer || !signal) return;
  readySdp = connection.localDescription?.sdp ?? "";
  phoneRoutes = routeKinds(readySdp);
  proofSent = false;
  await sendOffer(connection, viaLink ? {} : { resume: resumeToken ?? undefined });
}

async function sendOffer(connection: RTCPeerConnection, extra: { proof?: PasskeyProof; resume?: string }): Promise<void> {
  if (connection !== peer || !signal) return;
  const at = Date.now();
  const sealed = await seal(signal, "phone", { t: "offer", sdp: readySdp, at, name: deviceName(), note: offerNote(), ...extra });
  if (connection !== peer || relay?.readyState !== WebSocket.OPEN) return;
  offerAt = at;
  relay.send(sealed);
  showStep("waiting for the PC's answer", "Asking your PC to connect...");
  giveUpAfter(ANSWER_WAIT_MS, "answer");
}

function onChannelOpen(): void {
  failures = 0;
  proofRejections = 0;
  stuckHint = "";
  clearAttemptTimer();
  // Only needed again if this connection drops.
  closeRelay();
  setLive(true);
  // Until the PC says the picture is on its way, rather than a black screen.
  showPanel("game", "Starting the picture", "Getting 3DXChat ready...");
  playPicture();
  void keepScreenOn();
  statsTicks = 0;
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
    pendingPair = { ...paired, challenge: event.challenge };
    showPanel("connection", "Secure this phone", "Only this phone will be able to connect, and only once it knows it's you.", { label: "Secure with Face ID or passcode", run: () => void securePhone() });
  } else if (event.t === "resume") {
    resumeToken = event.token;
  } else if (event.t === "state") {
    showGameState(event);
  }
}

/** Runs inside a tap, or phones won't make a passkey. */
async function securePhone(): Promise<void> {
  const pair = pendingPair;
  if (!pair) return;
  if (!(await canUsePasskeys())) {
    showPanel("connection", "Set a passcode first", "This phone needs a screen lock to keep your game safe. Set one in its settings, then try again.", { label: "Try again", run: () => void securePhone() });
    return;
  }
  try {
    const passkey = await makePasskey(pair.challenge);
    const saved: SavedCredential = { room: pair.room, secret: pair.secret, usedLink: credential?.room, passkey: passkey.credentialId };
    pendingPair = null;
    credential = { room: pair.room, secret: pair.secret };
    viaLink = false;
    passkeyId = passkey.credentialId;
    localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    // The link did its job; don't leave it in the address bar or history.
    history.replaceState(null, "", location.pathname);
    send({ t: "paired", passkey });
    showPanel("game", "Starting the picture", "Getting 3DXChat ready...");
  } catch {
    showPanel("connection", "Secure this phone", "That didn't go through. Only this phone will be able to connect, and only once it knows it's you.", { label: "Try again", run: () => void securePhone() });
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
  } else if (state.game === "minimized") {
    showPanel("game", "3DXChat is hidden", "It's minimized on your PC, so there's no picture until you bring it back.", {
      label: "Bring it back",
      run: () => send({ t: "focus" }),
    });
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
  const pairs: { currentRoundTripTime?: number; localCandidateId?: string; remoteCandidateId?: string }[] = [];
  let framesDecoded = 0;
  stats.forEach((report) => {
    if (report.type === "candidate-pair" && report.nominated && report.state === "succeeded") pairs.push(report);
    if (report.type === "inbound-rtp" && report.kind === "video") framesDecoded = report.framesDecoded ?? 0;
  });
  const pair = pairs[0];
  const local = stats.get(pair?.localCandidateId ?? "")?.candidateType;
  const remote = stats.get(pair?.remoteCandidateId ?? "")?.candidateType;
  const ms = pair?.currentRoundTripTime === undefined ? "" : `${Math.round(pair.currentRoundTripTime * 1000)} ms`;
  const seen = picture.videoWidth > 0;
  badge.textContent = [ms, local === "relay" ? "relayed" : "", seen ? "" : "no picture yet"].filter(Boolean).join(" ");

  statsTicks += 1;
  if (statsTicks === REPORT_FIRST_TICK || statsTicks % REPORT_EVERY_TICKS === 0) {
    const sound = picture.muted ? "muted" : "sound on";
    const state = picture.paused ? "paused" : "playing";
    send({ t: "report", text: `picture ${picture.videoWidth}x${picture.videoHeight}, ${framesDecoded} frames shown, ${state}, ${sound}, path ${local} to ${remote}, ${ms}` });
  }
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

function nextCamera(): void {
  send({ t: "press", key: CAMERA_KEYS[cameraIndex] });
  cameraIndex = (cameraIndex + 1) % CAMERA_KEYS.length;
}

element("camera-button").addEventListener("click", nextCamera);
element("hide-button").addEventListener("click", () => send({ t: "minimize" }));

const keyboardPanel = element("keyboard");
const padPanel = element("pad");
const keyboardButton = element("keyboard-button");
const padButton = element("pad-button");
const controller = new Controller({ input: send, nextCamera });
const releaseKeys = buildKeyboard(keyboardPanel, send);
buildPad(padPanel, controller);
let controllerTimer: ReturnType<typeof setInterval> | null = null;

/** The stick and paired-controller loop: starts when first needed, then just idles. */
function runController(): void {
  if (controllerTimer !== null) return;
  let last = performance.now();
  controllerTimer = setInterval(() => {
    const now = performance.now();
    if (live) {
      const pad = navigator.getGamepads?.().find(Boolean);
      if (pad) controller.pad({ axes: pad.axes, pressed: pad.buttons.map((button) => button.pressed) });
      controller.tick((now - last) / 1000);
    }
    last = now;
  }, CONTROLLER_TICK_MS);
}

function openPanel(which: HTMLElement | null): void {
  keyboardPanel.hidden = which !== keyboardPanel;
  padPanel.hidden = which !== padPanel;
  keyboardButton.setAttribute("aria-pressed", String(which === keyboardPanel));
  padButton.setAttribute("aria-pressed", String(which === padPanel));
  if (which !== keyboardPanel) releaseKeys();
  if (which !== padPanel) controller.release();
  else runController();
}

keyboardButton.addEventListener("click", () => openPanel(keyboardPanel.hidden ? keyboardPanel : null));
padButton.addEventListener("click", () => openPanel(padPanel.hidden ? padPanel : null));
window.addEventListener("gamepadconnected", runController);

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
  resumeToken = null;
  showPanel(null, "Session ended", "Your PC stays ready for next time.", { label: "Play again", run: start });
});

// ── Start ────────────────────────────────────────────────────────────────────

/** Runs inside a tap: the only moment phones allow sound and full screen. */
function start(): void {
  if (!credential) return;
  wanted = true;
  failures = 0;
  proofRejections = 0;
  stuckHint = "";
  remoteStream ??= new MediaStream();
  picture.srcObject = remoteStream;
  picture.muted = false;
  soundButton.setAttribute("aria-pressed", "true");
  playPicture();
  void document.documentElement.requestFullscreen?.({ navigationUI: "hide" })
    .then(() => (screen.orientation as ScreenOrientation & { lock?(orientation: string): Promise<void> }).lock?.("landscape"))
    .catch(() => undefined);
  connectNow();
}

/**
 * iOS freezes a page it sends to the background, and can bring it back with its
 * connections gone and nobody told, so start again from the top.
 */
function resume(): void {
  if (!wanted) return;
  if (live && peer?.connectionState === "connected") {
    void keepScreenOn();
    playPicture();
    return;
  }
  lastNote = `came back from the background at ${attemptStatus()}`;
  disconnect();
  connectNow();
}

function boot(): void {
  wanted = false;
  disconnect();
  if (typeof RTCPeerConnection !== "function") {
    showPanel(null, "This browser can't play", "Open this page in Safari or Chrome instead. Apps like Instagram and Discord open links in a browser of their own.");
    return;
  }
  const link = parseLinkFragment(location.hash);
  const stored = storedCredential();
  credential = credentialToUse(link, stored);
  const fromLink = credential === link ? link : null;
  viaLink = fromLink !== null;
  passkeyId = viaLink ? null : (stored?.passkey ?? null);
  resumeToken = null;
  if (credential && !viaLink && !passkeyId) {
    credential = null;
    showPanel(null, "Pair this phone again", "Remote Play now locks with Face ID or your passcode. Open Remote Play on your PC and make a new link.");
    return;
  }
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
window.addEventListener("pageshow", (event) => {
  if (event.persisted) resume();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resume();
});
setInterval(() => {
  if (panelFor === "connection") panelDetail.textContent = attemptStatus();
}, DETAIL_MS);

boot();
