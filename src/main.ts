// src/main.ts
//
// The app's one window: turn Remote Play on, pair a phone, see who's playing.
// The host keeps running while the window is closed to the tray.

import "./style.css";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { LINK_LIFETIME_MS, RemotePlayHost, pairingLink, realHostDeps, type HostSnapshot } from "./host";
import { renderQr } from "./qr";

const RELAY_LABELS = { off: "Off", connecting: "Connecting", online: "Ready" } as const;
/** "Forget this phone" needs a second tap within this long. */
const FORGET_CONFIRM_MS = 4000;
const COPIED_MS = 1500;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const enabledToggle = element<HTMLInputElement>("enabled");
const statusRow = element("status-row");
const status = element("status");
const sessionBox = element("session");
const sessionName = element("session-name");
const sessionState = element("session-state");
const endButton = element<HTMLButtonElement>("end");
const pairBox = element("pair");
const qr = element("qr");
const showCode = element<HTMLButtonElement>("show-code");
const copyLink = element<HTMLButtonElement>("copy-link");
const hideCode = element<HTMLButtonElement>("hide-code");
const newLink = element<HTMLButtonElement>("new-link");
const pairNote = element("pair-note");
const pairedBox = element("paired");
const phoneName = element("phone-name");
const forgetButton = element<HTMLButtonElement>("forget");
const startupBox = element("startup");
const autostartToggle = element<HTMLInputElement>("autostart");

let snapshot: HostSnapshot = { pairing: null, relay: "off", session: null };
let busy = false;
let codeShown = false;
/** Where the user just put the switch, until the host has caught up. */
let wantedEnabled: boolean | null = null;
let forgetArmed: ReturnType<typeof setTimeout> | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/** Someone at the PC can always see that a phone connected. */
async function notifyConnected(name: string): Promise<void> {
  try {
    const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    if (granted) sendNotification({ title: "3DX Remote Play", body: `Your ${name} connected and is playing.` });
  } catch (error) {
    console.warn("[remote play] couldn't show the notification:", error);
  }
}

const host = new RemotePlayHost(
  realHostDeps,
  (next) => {
    snapshot = next;
    render();
  },
  (name) => void notifyConnected(name),
);

function render(): void {
  const pairing = snapshot.pairing;
  const enabled = pairing?.enabled ?? false;
  const paired = Boolean(pairing?.deviceSecret);
  const link = pairingLink(pairing);
  if (!link) codeShown = false;

  enabledToggle.checked = wantedEnabled ?? enabled;
  enabledToggle.disabled = busy;
  statusRow.hidden = !enabled;
  status.textContent = RELAY_LABELS[snapshot.relay];

  sessionBox.hidden = !(enabled && snapshot.session);
  sessionName.textContent = snapshot.session?.name ?? "";
  sessionState.textContent = snapshot.session?.live ? "Playing" : "Connecting";

  pairedBox.hidden = !(enabled && paired);
  phoneName.textContent = pairing?.deviceName ?? "Phone";
  forgetButton.disabled = busy;

  pairBox.hidden = !(enabled && !paired);
  const showing = Boolean(link && codeShown);
  qr.hidden = !showing;
  if (link && showing) renderQr(qr, link);
  showCode.hidden = !link || showing;
  copyLink.hidden = !showing;
  hideCode.hidden = !showing;
  newLink.hidden = Boolean(link);
  newLink.disabled = busy;
  pairNote.textContent = link
    ? `Whoever opens this first becomes the one phone that can connect, so keep it off stream. It works once, within ${LINK_LIFETIME_MS / 60_000} minutes.`
    : "Pairing links stop working after a while. Make a new one when your phone is in your hand.";

  startupBox.hidden = !enabled;

  // Take the code off screen the moment it stops working.
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = link && pairing?.linkExpiresAt ? setTimeout(render, Math.max(0, pairing.linkExpiresAt - Date.now()) + 50) : null;
}

async function whileBusy(work: () => Promise<void>): Promise<void> {
  busy = true;
  render();
  try {
    await work();
  } catch (error) {
    console.warn("[remote play]", error);
  } finally {
    busy = false;
    render();
  }
}

function disarmForget(): void {
  if (forgetArmed !== null) clearTimeout(forgetArmed);
  forgetArmed = null;
  forgetButton.textContent = "Forget this phone";
}

// Read the switch before anything redraws it: a redraw puts it back to the
// host's state, which is still the old one.
enabledToggle.addEventListener("change", () => {
  const wanted = enabledToggle.checked;
  wantedEnabled = wanted;
  void whileBusy(async () => {
    try {
      await host.setEnabled(wanted);
    } finally {
      wantedEnabled = null;
    }
  });
});
endButton.addEventListener("click", () => host.endSession());
newLink.addEventListener("click", () => void whileBusy(() => host.newLink()));

showCode.addEventListener("click", () => {
  codeShown = true;
  render();
});
hideCode.addEventListener("click", () => {
  codeShown = false;
  render();
});
copyLink.addEventListener("click", () => {
  const link = pairingLink(snapshot.pairing);
  if (!link) return;
  void navigator.clipboard.writeText(link).then(() => {
    copyLink.textContent = "Copied";
    setTimeout(() => {
      copyLink.textContent = "Copy link";
    }, COPIED_MS);
  });
});

forgetButton.addEventListener("click", () => {
  if (forgetArmed === null) {
    forgetButton.textContent = "Tap again to forget";
    forgetArmed = setTimeout(disarmForget, FORGET_CONFIRM_MS);
    return;
  }
  disarmForget();
  // A new room: the forgotten phone has nothing to connect to any more.
  void whileBusy(() => host.newLink());
});

function showAutostart(): void {
  void autostartEnabled()
    .then((on) => {
      autostartToggle.checked = on;
    })
    .catch(() => undefined);
}

autostartToggle.addEventListener("change", () => {
  const change = autostartToggle.checked ? enableAutostart() : disableAutostart();
  void change.catch((error) => console.warn("[remote play] Open with Windows:", error)).finally(showAutostart);
});

showAutostart();
render();
void host.start().catch((error) => console.warn("[remote play] couldn't start:", error));
