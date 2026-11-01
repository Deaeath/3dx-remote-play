// phone/web/panels.ts
//
// The two optional panels: a full keyboard and an on-screen controller. Keys
// and buttons stay down for as long as the finger does, like the real thing.

import type { PhoneCommand } from "../../shared/remotePlay";
import type { Controller, PadButton, Side } from "./controller";

interface KeyDef {
  label: string;
  key: string;
  /** How wide, against an ordinary key. */
  width?: number;
}

const plain = (keys: string): KeyDef[] => [...keys].map((key) => ({ label: key, key }));
const fKeys: KeyDef[] = Array.from({ length: 12 }, (_, index) => ({ label: `F${index + 1}`, key: `f${index + 1}` }));

/** The up arrow is missing on purpose: see `keyboard_key` in remote_input.rs. */
const ROWS: KeyDef[][] = [
  [{ label: "Esc", key: "escape" }, ...fKeys, { label: "Del", key: "delete" }],
  [...plain("`1234567890-="), { label: "⌫", key: "backspace", width: 1.6 }],
  [{ label: "Tab", key: "tab", width: 1.4 }, ...plain("qwertyuiop[]\\")],
  [...plain("asdfghjkl;'"), { label: "Enter", key: "enter", width: 2 }],
  [{ label: "Shift", key: "shift", width: 1.8 }, ...plain("zxcvbnm,./"), { label: "←", key: "left" }, { label: "↓", key: "down" }, { label: "→", key: "right" }],
  [
    { label: "Home", key: "home", width: 1.3 },
    { label: "End", key: "end", width: 1.3 },
    { label: "Space", key: "space", width: 6 },
    { label: "PgUp", key: "pageup", width: 1.3 },
    { label: "PgDn", key: "pagedown", width: 1.3 },
  ],
];

const SHIFT = "shift";

/** Follows one finger on an element until it lifts, even off the element. */
function onPress(element: HTMLElement, down: (event: PointerEvent) => void, up: () => void, move?: (event: PointerEvent) => void): void {
  let pressed = false;
  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    element.setPointerCapture?.(event.pointerId);
    pressed = true;
    element.classList.add("pressed");
    down(event);
  });
  if (move) {
    element.addEventListener("pointermove", (event) => {
      if (pressed) move(event);
    });
  }
  const finish = () => {
    if (!pressed) return;
    pressed = false;
    element.classList.remove("pressed");
    up();
  };
  element.addEventListener("pointerup", finish);
  element.addEventListener("pointercancel", finish);
}

/** Builds the keyboard; returns what lets go of every key. */
export function buildKeyboard(root: HTMLElement, input: (command: PhoneCommand) => void): () => void {
  const down = new Set<string>();
  let shifted = false;

  const setKey = (key: string, pressed: boolean) => {
    if (down.has(key) === pressed) return;
    if (pressed) down.add(key);
    else down.delete(key);
    input({ t: "key", key, down: pressed });
  };
  const setShift = (on: boolean) => {
    shifted = on;
    root.classList.toggle("shifted", on);
    setKey(SHIFT, on);
  };

  for (const row of ROWS) {
    const line = document.createElement("div");
    line.className = "key-row";
    for (const { label, key, width } of row) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "key";
      button.textContent = label;
      button.dataset.key = key;
      if (width) button.style.flexGrow = String(width);
      if (key === SHIFT) {
        // A tap holds Shift for the next key, as phone keyboards do.
        onPress(button, () => setShift(!shifted), () => undefined);
      } else {
        onPress(
          button,
          () => setKey(key, true),
          () => {
            setKey(key, false);
            if (shifted) setShift(false);
          },
        );
      }
      line.append(button);
    }
    root.append(line);
  }

  return () => {
    for (const key of [...down]) setKey(key, false);
    shifted = false;
    root.classList.remove("shifted");
  };
}

function buildStick(root: HTMLElement, side: Side, controller: Controller): void {
  const stick = document.createElement("div");
  stick.className = `stick ${side}`;
  stick.setAttribute("aria-label", side === "left" ? "Move the pointer" : "Turn the camera");
  const knob = document.createElement("div");
  knob.className = "knob";
  stick.append(knob);

  const follow = (event: PointerEvent) => {
    const box = stick.getBoundingClientRect();
    const radius = box.width / 2 || 1;
    const x = (event.clientX - (box.left + radius)) / radius;
    const y = (event.clientY - (box.top + radius)) / radius;
    const scale = Math.min(1, 1 / (Math.hypot(x, y) || 1));
    controller.stick(side, x * scale, y * scale);
    knob.style.transform = `translate(${x * scale * radius}px, ${y * scale * radius}px)`;
  };
  onPress(
    stick,
    follow,
    () => {
      controller.stick(side, 0, 0);
      knob.style.transform = "";
    },
    follow,
  );
  root.append(stick);
}

const PAD_BUTTONS: { name: PadButton; label: string; title: string }[] = [
  { name: "a", label: "A", title: "Left click" },
  { name: "b", label: "B", title: "Right click" },
  { name: "x", label: "X", title: "Enter" },
  { name: "y", label: "Y", title: "Next camera" },
  { name: "lb", label: "LB", title: "Zoom out" },
  { name: "rb", label: "RB", title: "Zoom in" },
  { name: "start", label: "☰", title: "Game menu" },
];

export function buildPad(root: HTMLElement, controller: Controller): void {
  buildStick(root, "left", controller);
  buildStick(root, "right", controller);
  for (const { name, label, title } of PAD_BUTTONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pad-button ${name}`;
    button.textContent = label;
    button.setAttribute("aria-label", title);
    onPress(button, () => controller.button(name, true), () => controller.button(name, false));
    root.append(button);
  }
}
