// phone/web/passkeys.ts
//
// The phone's side of shared/passkey.ts: asks the phone to make or use the
// passkey. The name it's saved under says nothing about who this is.

import { PLAY_HOST, proofChallenge, registerChallenge, type PasskeyProof, type PasskeyRegistration } from "../../shared/passkey";
import { fromBase64Url, toBase64Url } from "../../shared/remotePlay";

const PASSKEY_NAME = "3DX Remote Play";
const USER_ID_BYTES = 16;
const ES256 = -7;
const CEREMONY_WAIT_MS = 60_000;

const encoded = (buffer: ArrayBuffer): string => toBase64Url(new Uint8Array(buffer));

export async function canUsePasskeys(): Promise<boolean> {
  try {
    return (await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()) === true;
  } catch {
    return false;
  }
}

export async function makePasskey(nonce: string): Promise<PasskeyRegistration> {
  const made = (await navigator.credentials.create({
    publicKey: {
      rp: { id: PLAY_HOST, name: PASSKEY_NAME },
      user: { id: crypto.getRandomValues(new Uint8Array(USER_ID_BYTES)), name: PASSKEY_NAME, displayName: PASSKEY_NAME },
      challenge: await registerChallenge(nonce),
      pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: CEREMONY_WAIT_MS,
    },
  })) as PublicKeyCredential | null;
  const response = made?.response as AuthenticatorAttestationResponse | undefined;
  const publicKey = response?.getPublicKey?.();
  if (!made || !response || !publicKey) throw new Error("the passkey didn't come back");
  return {
    credentialId: encoded(made.rawId),
    publicKey: encoded(publicKey),
    authenticatorData: encoded(response.getAuthenticatorData()),
    clientDataJSON: encoded(response.clientDataJSON),
  };
}

export async function provePasskey(credentialId: string, nonce: string, sdp: string): Promise<PasskeyProof> {
  const used = (await navigator.credentials.get({
    publicKey: {
      rpId: PLAY_HOST,
      challenge: await proofChallenge(nonce, sdp),
      allowCredentials: [{ type: "public-key", id: fromBase64Url(credentialId) }],
      userVerification: "required",
      timeout: CEREMONY_WAIT_MS,
    },
  })) as PublicKeyCredential | null;
  const response = used?.response as AuthenticatorAssertionResponse | undefined;
  if (!used || !response) throw new Error("the passkey didn't answer");
  return {
    credentialId: encoded(used.rawId),
    authenticatorData: encoded(response.authenticatorData),
    clientDataJSON: encoded(response.clientDataJSON),
    signature: encoded(response.signature),
  };
}
