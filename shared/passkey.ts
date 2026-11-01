// shared/passkey.ts
//
// Proof that the person connecting is the phone's owner. A passkey made at
// pairing signs for every new connection, with Face ID or the like each time.
// The PC holds only the public half and checks the signature itself, so neither
// the page nor anything on the way can hand out access later. No account is
// involved, and no server ever sees any of this: it travels sealed.

import { PLAY_ORIGIN, fromBase64Url, toBase64Url } from "./remotePlay";

export const PLAY_HOST = new URL(PLAY_ORIGIN).hostname;

const PROOF_INFO = "3dx-play/proof/v1";
const REGISTER_INFO = "3dx-play/register/v1";
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const RP_HASH_LENGTH = 32;
const FLAGS_OFFSET = 32;
const SIGNATURE_PART_LENGTH = 32;

export interface PasskeyProof {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

export interface PasskeyRegistration {
  credentialId: string;
  publicKey: string;
  authenticatorData: string;
  clientDataJSON: string;
}

/** What the PC keeps: only ever the public half. */
export interface PairedPasskey {
  credentialId: string;
  publicKey: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** Tied to the PC's one-time nonce and to this very offer, so a proof can't be replayed or moved to another connection. */
export function proofChallenge(nonce: string, sdp: string): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(encoder.encode(`${PROOF_INFO}\n${nonce}\n${sdp}`));
}

export function registerChallenge(nonce: string): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(encoder.encode(`${REGISTER_INFO}\n${nonce}`));
}

/** What every passkey response has to show: this ceremony, this site, and a real check of the person. */
async function ceremonyChecksOut(clientDataJSON: Uint8Array<ArrayBuffer>, authenticatorData: Uint8Array, type: string, challenge: Uint8Array): Promise<boolean> {
  const client = JSON.parse(decoder.decode(clientDataJSON)) as { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  if (client.type !== type || client.origin !== PLAY_ORIGIN || client.crossOrigin === true) return false;
  if (client.challenge !== toBase64Url(challenge)) return false;
  if (authenticatorData.length <= FLAGS_OFFSET) return false;
  const expectedSite = await sha256(encoder.encode(PLAY_HOST));
  if (expectedSite.some((byte, index) => byte !== authenticatorData[index])) return false;
  const flags = authenticatorData[FLAGS_OFFSET];
  return (flags & FLAG_USER_PRESENT) !== 0 && (flags & FLAG_USER_VERIFIED) !== 0;
}

/** Passkeys sign in DER; WebCrypto wants the two numbers side by side. */
function signatureToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (der[0] !== 0x30 || der[1] !== der.length - 2 || der[2] !== 0x02) return null;
  const firstLength = der[3];
  const secondMarker = 4 + firstLength;
  if (der[secondMarker] !== 0x02) return null;
  const secondLength = der[secondMarker + 1];
  if (secondMarker + 2 + secondLength !== der.length) return null;
  const raw = new Uint8Array(SIGNATURE_PART_LENGTH * 2);
  const place = (part: Uint8Array, end: number): boolean => {
    const trimmed = part.subarray(Math.max(0, part.findIndex((byte) => byte !== 0)));
    if (trimmed.length > SIGNATURE_PART_LENGTH) return false;
    raw.set(trimmed, end - trimmed.length);
    return true;
  };
  const fits = place(der.subarray(4, secondMarker), SIGNATURE_PART_LENGTH) && place(der.subarray(secondMarker + 2), SIGNATURE_PART_LENGTH * 2);
  return fits ? raw : null;
}

export async function verifyProof(proof: PasskeyProof, passkey: PairedPasskey, nonce: string, sdp: string): Promise<boolean> {
  try {
    if (proof.credentialId !== passkey.credentialId) return false;
    const authenticatorData = fromBase64Url(proof.authenticatorData);
    const clientDataJSON = fromBase64Url(proof.clientDataJSON);
    const challenge = await proofChallenge(nonce, sdp);
    if (!(await ceremonyChecksOut(clientDataJSON, authenticatorData, "webauthn.get", challenge))) return false;
    const raw = signatureToRaw(fromBase64Url(proof.signature));
    if (!raw) return false;
    const key = await crypto.subtle.importKey("spki", fromBase64Url(passkey.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const clientHash = await sha256(clientDataJSON);
    const signed = new Uint8Array(authenticatorData.length + clientHash.length);
    signed.set(authenticatorData);
    signed.set(clientHash, authenticatorData.length);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, signed);
  } catch {
    return false;
  }
}

export async function verifyRegistration(registration: PasskeyRegistration, nonce: string): Promise<PairedPasskey | null> {
  try {
    const challenge = await registerChallenge(nonce);
    const fine = await ceremonyChecksOut(fromBase64Url(registration.clientDataJSON), fromBase64Url(registration.authenticatorData), "webauthn.create", challenge);
    if (!fine || !registration.credentialId) return null;
    // Refuses anything that isn't a P-256 key, so it can't fail later instead.
    await crypto.subtle.importKey("spki", fromBase64Url(registration.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return { credentialId: registration.credentialId, publicKey: registration.publicKey };
  } catch {
    return null;
  }
}
