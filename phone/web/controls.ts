// remote-play/web/controls.ts
//
// Touch to 3DXChat. The game is played with the mouse, so a finger does what
// the mouse does there:
//
//   tap             left click: walk to that spot, press a button, pick a pose
//   drag            hold the right button and move: turn the camera
//   hold, then drag hold the left button: move sliders and windows
//   pinch           mouse wheel: zoom the camera
//
// With the magnifier on, a drag pans the picture instead of turning the camera.

import type { PlayInput } from "../../shared/remotePlay";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const TAP_SLOP_PX = 10;
export const HOLD_MS = 450;
/** Mouse counts per screen pixel of a camera drag. */
export const LOOK_GAIN = 3;
/** Pinch travel for one wheel notch. */
export const PINCH_STEP_PX = 28;

/** Where the picture sits inside its element (object-fit: contain leaves bars). */
export function pictureRect(element: Rect, videoWidth: number, videoHeight: number): Rect {
  if (videoWidth <= 0 || videoHeight <= 0) return element;
  const scale = Math.min(element.width / videoWidth, element.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    left: element.left + (element.width - width) / 2,
    top: element.top + (element.height - height) / 2,
    width,
    height,
  };
}

/** A screen position as 0..1 across the picture; null when it's in the bars. */
export function toGamePoint(clientX: number, clientY: number, picture: Rect): Point | null {
  if (picture.width <= 0 || picture.height <= 0) return null;
  const x = (clientX - picture.left) / picture.width;
  const y = (clientY - picture.top) / picture.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

interface Touch {
  x: number;
  y: number;
}

type Mode =
  | { kind: "idle" }
  | { kind: "pending"; id: number; startX: number; startY: number }
  | { kind: "look"; id: number; lastX: number; lastY: number }
  | { kind: "pan"; id: number; lastX: number; lastY: number }
  | { kind: "drag"; id: number }
  | { kind: "pinch"; distance: number };

export interface GestureTarget {
  input(event: PlayInput): void;
  /** The game position under a finger, if it's over the picture. */
  locate(x: number, y: number): Point | null;
  /** Pan a magnified picture; false when the magnifier is off. */
  pan(dx: number, dy: number): boolean;
}

export class Gestures {
  private mode: Mode = { kind: "idle" };
  private readonly touches = new Map<number, Touch>();
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly target: GestureTarget;

  constructor(target: GestureTarget) {
    this.target = target;
  }

  down(id: number, x: number, y: number): void {
    this.touches.set(id, { x, y });
    if (this.touches.size === 2) {
      this.endMode();
      this.mode = { kind: "pinch", distance: this.spread() };
      // The wheel goes to whatever is under the pointer, so put it on the game.
      const [a, b] = [...this.touches.values()];
      const centre = this.target.locate((a.x + b.x) / 2, (a.y + b.y) / 2);
      if (centre) this.target.input({ t: "point", ...centre });
      return;
    }
    if (this.touches.size > 2 || this.mode.kind !== "idle") return;
    this.mode = { kind: "pending", id, startX: x, startY: y };
    this.holdTimer = setTimeout(() => this.beginDrag(), HOLD_MS);
  }

  move(id: number, x: number, y: number): void {
    const touch = this.touches.get(id);
    if (!touch) return;
    touch.x = x;
    touch.y = y;
    const mode = this.mode;

    if (mode.kind === "pending" && mode.id === id) {
      if (Math.hypot(x - mode.startX, y - mode.startY) >= TAP_SLOP_PX) this.beginMoving(mode, x, y);
    } else if (mode.kind === "look" && mode.id === id) {
      this.target.input({ t: "look", dx: Math.round((x - mode.lastX) * LOOK_GAIN), dy: Math.round((y - mode.lastY) * LOOK_GAIN) });
      mode.lastX = x;
      mode.lastY = y;
    } else if (mode.kind === "pan" && mode.id === id) {
      this.target.pan(x - mode.lastX, y - mode.lastY);
      mode.lastX = x;
      mode.lastY = y;
    } else if (mode.kind === "drag" && mode.id === id) {
      const point = this.target.locate(x, y);
      if (point) this.target.input({ t: "point", ...point });
    } else if (mode.kind === "pinch") {
      const distance = this.spread();
      const notches = Math.trunc((distance - mode.distance) / PINCH_STEP_PX);
      if (notches !== 0) {
        this.target.input({ t: "wheel", ticks: notches });
        mode.distance += notches * PINCH_STEP_PX;
      }
    }
  }

  up(id: number): void {
    this.touches.delete(id);
    const mode = this.mode;
    if (mode.kind === "pending" && mode.id === id) {
      const point = this.target.locate(mode.startX, mode.startY);
      if (point) this.target.input({ t: "tap", ...point });
      this.endMode();
    } else if ((mode.kind === "pinch" && this.touches.size < 2) || ("id" in mode && mode.id === id)) {
      this.endMode();
    }
  }

  /** Let go of everything, e.g. when the connection drops. */
  cancel(): void {
    this.touches.clear();
    this.endMode();
  }

  private beginMoving(mode: { id: number; startX: number; startY: number }, x: number, y: number): void {
    this.clearHold();
    const { id, startX, startY } = mode;
    if (this.target.pan(0, 0)) {
      this.mode = { kind: "pan", id, lastX: startX, lastY: startY };
    } else {
      const point = this.target.locate(startX, startY);
      if (point) this.target.input({ t: "point", ...point });
      this.target.input({ t: "button", button: "right", down: true });
      this.mode = { kind: "look", id, lastX: startX, lastY: startY };
    }
    this.move(id, x, y);
  }

  private beginDrag(): void {
    this.holdTimer = null;
    const mode = this.mode;
    if (mode.kind !== "pending") return;
    const point = this.target.locate(mode.startX, mode.startY);
    if (!point) {
      this.mode = { kind: "idle" };
      return;
    }
    this.target.input({ t: "point", ...point });
    this.target.input({ t: "button", button: "left", down: true });
    this.mode = { kind: "drag", id: mode.id };
  }

  /** Finish whatever is under way, releasing its button. */
  private endMode(): void {
    this.clearHold();
    if (this.mode.kind === "look") this.target.input({ t: "button", button: "right", down: false });
    if (this.mode.kind === "drag") this.target.input({ t: "button", button: "left", down: false });
    this.mode = { kind: "idle" };
  }

  private clearHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private spread(): number {
    const [a, b] = [...this.touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}
