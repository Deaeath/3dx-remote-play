// phone/web/controller.ts
//
// A controller to 3DXChat, on screen or paired with the phone. The game is
// played with the mouse, so the controller does what the mouse does there:
//
//   left stick      move the pointer
//   right stick     hold the right button and move: turn the camera
//   A / B           left / right mouse button
//   X               Enter
//   Y               next camera
//   LB / RB         mouse wheel: zoom out / in
//   Start           Esc: the game's menu

import type { PhoneCommand } from "../../shared/remotePlay";

export type PadButton = "a" | "b" | "x" | "y" | "lb" | "rb" | "start";
export type Side = "left" | "right";

const DEADZONE = 0.15;
/** Mouse counts a second at full tilt. */
const POINTER_SPEED = 1100;
const CAMERA_SPEED = 1800;
/** The standard layout's button numbers, for a paired controller. */
const STANDARD_BUTTONS: Record<PadButton, number> = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, start: 9 };
const STANDARD_AXES: Record<Side, [number, number]> = { left: [0, 1], right: [2, 3] };

export interface PadState {
  axes: readonly number[];
  pressed: readonly boolean[];
}

export interface ControllerTarget {
  input(command: PhoneCommand): void;
  nextCamera(): void;
}

interface Tilt {
  x: number;
  y: number;
}

/** A stick past its dead zone, gentle near the centre for fine aim. */
function shaped({ x, y }: Tilt): Tilt | null {
  const length = Math.hypot(x, y);
  if (length < DEADZONE) return null;
  const amount = (Math.min(length, 1) - DEADZONE) / (1 - DEADZONE);
  const strength = (amount * amount) / length;
  return { x: x * strength, y: y * strength };
}

export class Controller {
  private readonly sticks: Record<Side, Tilt> = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  private readonly held = new Set<PadButton>();
  /** What's holding the right mouse button: B, the right stick, or both. */
  private readonly rightHolders = new Set<"b" | "stick">();
  private readonly lastPad = new Map<string, number | boolean>();
  private carryX = 0;
  private carryY = 0;
  private centred = false;
  private readonly target: ControllerTarget;

  constructor(target: ControllerTarget) {
    this.target = target;
  }

  stick(side: Side, x: number, y: number): void {
    this.sticks[side] = { x, y };
  }

  button(name: PadButton, down: boolean): void {
    if (this.held.has(name) === down) return;
    if (down) this.held.add(name);
    else this.held.delete(name);
    this.centrePointer();
    const { input } = this.target;
    if (name === "a") input({ t: "button", button: "left", down });
    else if (name === "b") this.holdRight("b", down);
    else if (name === "x") input({ t: "key", key: "enter", down });
    else if (down && name === "y") this.target.nextCamera();
    else if (down && name === "lb") input({ t: "wheel", ticks: -1 });
    else if (down && name === "rb") input({ t: "wheel", ticks: 1 });
    else if (down && name === "start") input({ t: "press", key: "escape" });
  }

  /** A paired controller, read every tick; only what changed counts, so it can't undo the screen's. */
  pad({ axes, pressed }: PadState): void {
    const changed = (key: string, value: number | boolean): boolean => {
      if (this.lastPad.get(key) === value) return false;
      this.lastPad.set(key, value);
      return true;
    };
    for (const side of ["left", "right"] as const) {
      const [xAxis, yAxis] = STANDARD_AXES[side];
      const x = axes[xAxis] ?? 0;
      const y = axes[yAxis] ?? 0;
      const movedX = changed(`${side}x`, x);
      const movedY = changed(`${side}y`, y);
      if (movedX || movedY) this.stick(side, x, y);
    }
    for (const [name, index] of Object.entries(STANDARD_BUTTONS) as [PadButton, number][]) {
      const down = pressed[index] ?? false;
      if (changed(name, down)) this.button(name, down);
    }
  }

  tick(seconds: number): void {
    const pointer = shaped(this.sticks.left);
    const camera = shaped(this.sticks.right);
    if (pointer || camera) this.centrePointer();
    this.holdRight("stick", camera !== null);
    this.carryX += ((pointer?.x ?? 0) * POINTER_SPEED + (camera?.x ?? 0) * CAMERA_SPEED) * seconds;
    this.carryY += ((pointer?.y ?? 0) * POINTER_SPEED + (camera?.y ?? 0) * CAMERA_SPEED) * seconds;
    const dx = Math.trunc(this.carryX);
    const dy = Math.trunc(this.carryY);
    if (dx === 0 && dy === 0) return;
    this.carryX -= dx;
    this.carryY -= dy;
    this.target.input({ t: "look", dx, dy });
  }

  /** Let go of everything, e.g. when the connection drops. */
  release(): void {
    for (const name of [...this.held]) this.button(name, false);
    this.sticks.left = { x: 0, y: 0 };
    this.sticks.right = { x: 0, y: 0 };
    this.holdRight("stick", false);
    this.carryX = 0;
    this.carryY = 0;
    this.centred = false;
  }

  /** The game refuses clicks off its window, so the first use starts on it. */
  private centrePointer(): void {
    if (this.centred) return;
    this.centred = true;
    this.target.input({ t: "point", x: 0.5, y: 0.5 });
  }

  private holdRight(holder: "b" | "stick", down: boolean): void {
    const before = this.rightHolders.size > 0;
    if (down) this.rightHolders.add(holder);
    else this.rightHolders.delete(holder);
    const after = this.rightHolders.size > 0;
    if (before !== after) this.target.input({ t: "button", button: "right", down: after });
  }
}
