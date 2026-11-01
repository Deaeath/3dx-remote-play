import { beforeAll, describe, expect, it } from "vitest";
import { verifyProof, verifyRegistration, type PairedPasskey } from "../shared/passkey";
import { fromBase64Url, toBase64Url } from "../shared/remotePlay";
import { makeFakePasskey, type FakePasskey } from "./fakePasskey";

const NONCE = "one-time-nonce";
const SDP = "the-offer";

describe("the passkey check", () => {
  let phone: FakePasskey;
  let paired: PairedPasskey;

  beforeAll(async () => {
    phone = await makeFakePasskey();
    const stored = await verifyRegistration(await phone.register(NONCE), NONCE);
    if (!stored) throw new Error("registration failed");
    paired = stored;
  });

  it("accepts the phone's own passkey signing this nonce and this offer", async () => {
    expect(await verifyProof(await phone.prove(NONCE, SDP), paired, NONCE, SDP)).toBe(true);
  });

  it("refuses a proof made for another nonce, so an old one can't be replayed", async () => {
    expect(await verifyProof(await phone.prove("old-nonce", SDP), paired, NONCE, SDP)).toBe(false);
  });

  it("refuses a proof moved onto another offer, so it can't let someone else's connection in", async () => {
    expect(await verifyProof(await phone.prove(NONCE, SDP), paired, NONCE, "an-attackers-offer")).toBe(false);
  });

  it("refuses another passkey", async () => {
    const stranger = await makeFakePasskey();
    expect(await verifyProof(await stranger.prove(NONCE, SDP), paired, NONCE, SDP)).toBe(false);
  });

  it("refuses a passkey used without Face ID or a passcode", async () => {
    expect(await verifyProof(await phone.prove(NONCE, SDP, { flags: 0x01 }), paired, NONCE, SDP)).toBe(false);
  });

  it("refuses a passkey used on another website", async () => {
    expect(await verifyProof(await phone.prove(NONCE, SDP, { site: "evil.example" }), paired, NONCE, SDP)).toBe(false);
    expect(await verifyProof(await phone.prove(NONCE, SDP, { origin: "https://evil.example" }), paired, NONCE, SDP)).toBe(false);
  });

  it("refuses the wrong kind of ceremony", async () => {
    expect(await verifyProof(await phone.prove(NONCE, SDP, { type: "webauthn.create" }), paired, NONCE, SDP)).toBe(false);
  });

  it("refuses a tampered signature, and garbage without throwing", async () => {
    const proof = await phone.prove(NONCE, SDP);
    const signature = fromBase64Url(proof.signature);
    signature[signature.length - 1] ^= 0xff;
    expect(await verifyProof({ ...proof, signature: toBase64Url(signature) }, paired, NONCE, SDP)).toBe(false);
    expect(await verifyProof({ ...proof, signature: "@@@" }, paired, NONCE, SDP)).toBe(false);
    expect(await verifyProof({ ...proof, clientDataJSON: "bm90IGpzb24" }, paired, NONCE, SDP)).toBe(false);
  });

  it("refuses a registration for another challenge or with a bad key", async () => {
    expect(await verifyRegistration(await phone.register("other"), NONCE)).toBeNull();
    expect(await verifyRegistration({ ...(await phone.register(NONCE)), publicKey: "bm90IGEga2V5" }, NONCE)).toBeNull();
  });

  it("keeps only the public half", async () => {
    expect(Object.keys(paired).sort()).toEqual(["credentialId", "publicKey"]);
  });
});
