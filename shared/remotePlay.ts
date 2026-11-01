// shared/remotePlay.ts
//
// The Remote Play wire format, used by the PC app and the phone page.
//
// A small relay introduces the two sides and then gets out of the way: video,
// sound and input go directly between them over WebRTC. Everything the relay
// carries is sealed here with AES-GCM under a key derived from a secret that
// reaches the phone in the link's #fragment, which browsers never send to any
// server. So the relay can't read or forge a message, and the PC only ever
// answers someone who holds the secret. See REMOTE-PLAY.md.

/** The public home of the phone page and the relay. */
export const PLAY_ORIGIN = "https://3dx-play.pages.dev";

export type PlayRole = "host" | "phone";

export interface PlayCredential {
  room: string;
  secret: string;
}

/** One chat message; the game's own box is shorter than this. */
export const MAX_TEXT_LENGTH = 240;

/** An offer older than this is a replay, not a phone trying to connect. */
const OFFER_MAX_AGE_MS = 2 * 60_000;

const ROOM_BYTES = 16;
const SECRET_BYTES = 32;
const ROOM_PATTERN = /^[0-9a-f]{32}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNAL_INFO = "3dx-play/signal/v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  return fromBase64(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function createRoom(): string {
  return Array.from(randomBytes(ROOM_BYTES), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createSecret(): string {
  return toBase64Url(randomBytes(SECRET_BYTES));
}

export function isCredential(value: unknown): value is PlayCredential {
  if (typeof value !== "object" || value === null) return false;
  const { room, secret } = value as Partial<PlayCredential>;
  return typeof room === "string" && typeof secret === "string" && ROOM_PATTERN.test(room) && SECRET_PATTERN.test(secret);
}

export function linkFor({ room, secret }: PlayCredential, origin = PLAY_ORIGIN): string {
  return `${origin}/#${room}.${secret}`;
}

/** The credential in a link's fragment (with or without the #); null if none. */
export function parseLinkFragment(fragment: string): PlayCredential | null {
  const [room, secret, extra] = fragment.replace(/^#/, "").split(".");
  const credential = { room, secret };
  return extra === undefined && isCredential(credential) ? credential : null;
}

/** What a phone keeps after pairing: its own room and secret, and which link it paired with. */
export type SavedCredential = PlayCredential & { usedLink?: string };

/**
 * What a phone connects with. A Home Screen copy of the page always opens at
 * the link it was saved from, long after that link was used up, so a used
 * link gives way to the phone's own credential. A new link always wins.
 */
export function credentialToUse(link: PlayCredential | null, saved: SavedCredential | null): PlayCredential | null {
  if (link && link.room !== saved?.usedLink) return link;
  return saved;
}

export async function signalKey({ room, secret }: PlayCredential): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", fromBase64Url(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: hexBytes(room), info: encoder.encode(SIGNAL_INFO) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** What the two sides exchange through the relay. */
export type SignalMessage =
  // `note`: how this phone's last attempt went, for the PC's log.
  | { t: "offer"; sdp: string; at: number; name: string; note?: string }
  // `to`: the `at` of the offer this answers, so a late answer can't land on a newer attempt.
  | { t: "answer"; sdp: string; to?: number };

/** The sender is bound in, so a message can't be bounced back at its author. */
function additionalData(from: PlayRole): Uint8Array<ArrayBuffer> {
  return encoder.encode(`3dx-play/${from}`);
}

export async function seal(key: CryptoKey, from: PlayRole, message: SignalMessage): Promise<string> {
  const iv = randomBytes(12);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(from) },
    key,
    encoder.encode(JSON.stringify(message)),
  );
  return JSON.stringify({ iv: toBase64(iv), ct: toBase64(new Uint8Array(sealed)) });
}

function isSignalMessage(value: unknown): value is SignalMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<Record<"t" | "sdp" | "at" | "name", unknown>>;
  if (typeof message.sdp !== "string") return false;
  if (message.t === "answer") return true;
  return message.t === "offer" && typeof message.at === "number" && typeof message.name === "string";
}

/** The message, or null if it isn't one this key and sender produced. */
export async function unseal(key: CryptoKey, from: PlayRole, text: string): Promise<SignalMessage | null> {
  try {
    const { iv, ct } = JSON.parse(text) as { iv: string; ct: string };
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv), additionalData: additionalData(from) },
      key,
      fromBase64(ct),
    );
    const message: unknown = JSON.parse(decoder.decode(plain));
    return isSignalMessage(message) ? message : null;
  } catch {
    return null;
  }
}

export function isFreshOffer(at: number, now = Date.now()): boolean {
  return Math.abs(now - at) <= OFFER_MAX_AGE_MS;
}

/**
 * The kinds of route an SDP offers, without one address, so it's safe to show
 * and to log: "mdns" a local address behind a made-up name, "host" a local
 * address, "srflx" a public one, "relay" a TURN server.
 */
export function routeKinds(sdp: string): string {
  const kinds = new Set<string>();
  for (const [, address, kind] of sdp.matchAll(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\w+)/gm)) {
    kinds.add(kind === "host" && address.endsWith(".local") ? "mdns" : kind);
  }
  return kinds.size > 0 ? [...kinds].sort().join(", ") : "none";
}

/** Keys the phone may press. Mirrors `virtual_key` in src-tauri/src/remote_play.rs, which has the last word. */
export type PlayKey = "escape" | "f5" | "f6" | "f7";

export type PlayButton = "left" | "right";

/** Game input. x and y are 0..1 across the game's picture. */
export type PlayInput =
  | { t: "tap"; x: number; y: number }
  | { t: "point"; x: number; y: number }
  | { t: "button"; button: PlayButton; down: boolean }
  | { t: "look"; dx: number; dy: number }
  | { t: "wheel"; ticks: number }
  | { t: "press"; key: PlayKey }
  // Held like a real key. `keyboard_key` in src-tauri/src/remote_input.rs says which exist.
  | { t: "key"; key: string; down: boolean }
  | { t: "chat"; text: string };

/** Phone → PC over the data channel. */
export type PhoneCommand = PlayInput | { t: "focus" } | { t: "launch" } | { t: "paired" } | { t: "report"; text: string };

/** "frozen": running, but not answering Windows (hung). */
export type GamePhase = "closed" | "frozen" | "background" | "front";

export interface PlayState {
  game: GamePhase;
  /** The picture is on its way. */
  video: boolean;
  /** Windows is locked: nothing can be seen or pressed until it's unlocked at the PC. */
  locked: boolean;
  /** The PC knows where 3DXChat is, so "Open 3DXChat" can work. */
  canLaunch: boolean;
}

/** PC → phone over the data channel. */
export type HostEvent = ({ t: "state" } & PlayState) | ({ t: "pair" } & PlayCredential);

export const REMOTE_PLAY_INPUTS: readonly string[] = ["tap", "point", "button", "look", "wheel", "press", "key", "chat"];

/** How the relay closes a socket when another one takes its place in the room. */
export const RELAY_REPLACED_CODE = 4000;

/** The relay's own frames; everything else it carries is sealed. */
export type RelayNotice = { relay: "peers"; host: boolean; phone: boolean } | { relay: "denied" };

export function parseRelayNotice(text: string): RelayNotice | null {
  try {
    const value = JSON.parse(text) as { relay?: unknown; host?: unknown; phone?: unknown };
    if (value.relay === "denied") return { relay: "denied" };
    if (value.relay === "peers") return { relay: "peers", host: value.host === true, phone: value.phone === true };
  } catch {
    // Not JSON: not one of ours.
  }
  return null;
}
