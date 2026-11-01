// A software passkey for the tests: real keys and real signatures, shaped just
// as a phone would shape them, so only the phone's own hardware is pretend.

import { PLAY_HOST, proofChallenge, registerChallenge, type PasskeyProof, type PasskeyRegistration } from "../shared/passkey";
import { PLAY_ORIGIN, toBase64Url } from "../shared/remotePlay";

const encoder = new TextEncoder();
const USER_PRESENT_AND_VERIFIED = 0x05;
const CREDENTIAL_ID = "ZmFrZS1wYXNza2V5";

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export async function authenticatorData(flags = USER_PRESENT_AND_VERIFIED, site = PLAY_HOST): Promise<Uint8Array<ArrayBuffer>> {
  const data = new Uint8Array(37);
  data.set(await sha256(encoder.encode(site)));
  data[32] = flags;
  return data;
}

export function clientData(type: string, challenge: Uint8Array, origin = PLAY_ORIGIN): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify({ type, challenge: toBase64Url(challenge), origin, crossOrigin: false }));
}

/** WebCrypto signs raw; passkeys sign in DER. */
function toDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const part = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = [...bytes.subarray(start)];
    return (trimmed[0] & 0x80) !== 0 ? [0, ...trimmed] : trimmed;
  };
  const first = part(raw.subarray(0, 32));
  const second = part(raw.subarray(32));
  return new Uint8Array([0x30, first.length + second.length + 4, 0x02, first.length, ...first, 0x02, second.length, ...second]);
}

export interface FakePasskey {
  register(nonce: string): Promise<PasskeyRegistration>;
  prove(nonce: string, sdp: string, overrides?: { flags?: number; site?: string; origin?: string; type?: string }): Promise<PasskeyProof>;
}

export async function makeFakePasskey(): Promise<FakePasskey> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)));
  return {
    async register(nonce) {
      return {
        credentialId: CREDENTIAL_ID,
        publicKey,
        authenticatorData: toBase64Url(await authenticatorData()),
        clientDataJSON: toBase64Url(clientData("webauthn.create", await registerChallenge(nonce))),
      };
    },
    async prove(nonce, sdp, overrides = {}) {
      const data = await authenticatorData(overrides.flags, overrides.site);
      const client = clientData(overrides.type ?? "webauthn.get", await proofChallenge(nonce, sdp), overrides.origin);
      const clientHash = await sha256(client);
      const signed = new Uint8Array(data.length + clientHash.length);
      signed.set(data);
      signed.set(clientHash, data.length);
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, signed));
      return {
        credentialId: CREDENTIAL_ID,
        authenticatorData: toBase64Url(data),
        clientDataJSON: toBase64Url(client),
        signature: toBase64Url(toDer(raw)),
      };
    },
  };
}
