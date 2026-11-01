// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  setEnabled: [] as boolean[],
  newLinks: 0,
  listener: null as null | ((snapshot: unknown) => void),
}));

vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: vi.fn(async () => undefined),
  disable: vi.fn(async () => undefined),
  isEnabled: vi.fn(async () => false),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
}));

// The real window script, with a host that records what it's asked to do.
vi.mock("../src/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/host")>();
  class FakeHost {
    constructor(_deps: unknown, onSnapshot: (snapshot: unknown) => void) {
      state.listener = onSnapshot;
    }
    async start() {}
    async setEnabled(enabled: boolean) {
      state.setEnabled.push(enabled);
      state.listener?.({ pairing: actual.newPairing(enabled), relay: enabled ? "online" : "off", session: null });
    }
    async newLink() {
      state.newLinks += 1;
    }
    async confirmOwner() {}
    endSession() {}
  }
  return { ...actual, RemotePlayHost: FakeHost };
});

const body = /<body>([\s\S]*)<\/body>/.exec(readFileSync("index.html", "utf8"))?.[1] ?? "";

describe("the app window", () => {
  it("turns Remote Play on and off with the switch", async () => {
    document.body.innerHTML = body;
    await import("../src/main");
    const toggle = document.getElementById("enabled") as HTMLInputElement;
    const pair = document.getElementById("pair") as HTMLElement;
    expect(toggle.checked).toBe(false);
    expect(pair.hidden).toBe(true);

    toggle.click();
    await vi.waitFor(() => expect(state.setEnabled).toEqual([true]));
    await vi.waitFor(() => expect(toggle.checked).toBe(true));
    expect(pair.hidden).toBe(false);
    expect((document.getElementById("status") as HTMLElement).textContent).toBe("Ready");

    toggle.click();
    await vi.waitFor(() => expect(state.setEnabled).toEqual([true, false]));
    await vi.waitFor(() => expect(toggle.checked).toBe(false));
    expect(pair.hidden).toBe(true);
  });

  it("shows the pairing code and makes a new link only after a second tap on Forget", async () => {
    document.body.innerHTML = body;
    vi.resetModules();
    await import("../src/main");
    const toggle = document.getElementById("enabled") as HTMLInputElement;
    toggle.click();
    await vi.waitFor(() => expect((document.getElementById("pair") as HTMLElement).hidden).toBe(false));
    // Buttons stay disabled while the host saves.
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));

    (document.getElementById("show-code") as HTMLButtonElement).click();
    await vi.waitFor(() => expect((document.getElementById("qr") as HTMLElement).querySelector("svg")).not.toBeNull());

    state.listener?.({
      pairing: { enabled: true, room: "r", linkSecret: null, linkExpiresAt: null, deviceSecret: "s", devicePasskey: { credentialId: "c", publicKey: "p" }, deviceName: "iPhone" },
      relay: "online",
      session: null,
    });
    const forget = document.getElementById("forget") as HTMLButtonElement;
    forget.click();
    expect(state.newLinks).toBe(0);
    forget.click();
    await vi.waitFor(() => expect(state.newLinks).toBe(1));
  });
});
