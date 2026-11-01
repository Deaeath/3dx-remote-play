import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneCommand } from "../shared/remotePlay";
import { Controller } from "../phone/web/controller";

describe("the controller", () => {
  let sent: PhoneCommand[];
  let nextCamera: ReturnType<typeof vi.fn>;
  let controller: Controller;
  const centre: PhoneCommand = { t: "point", x: 0.5, y: 0.5 };

  beforeEach(() => {
    sent = [];
    nextCamera = vi.fn();
    controller = new Controller({ input: (command) => sent.push(command), nextCamera });
  });

  it("puts the pointer on the game once, the first time it's used", () => {
    controller.button("a", true);
    controller.button("a", false);
    controller.button("a", true);
    expect(sent.filter((command) => command.t === "point")).toEqual([centre]);
  });

  it("holds the mouse buttons for as long as A and B", () => {
    controller.button("a", true);
    controller.button("a", false);
    controller.button("b", true);
    controller.button("b", false);
    expect(sent.slice(1)).toEqual([
      { t: "button", button: "left", down: true },
      { t: "button", button: "left", down: false },
      { t: "button", button: "right", down: true },
      { t: "button", button: "right", down: false },
    ]);
  });

  it("maps X, Y, the bumpers and Start", () => {
    for (const name of ["x", "y", "lb", "rb", "start"] as const) {
      controller.button(name, true);
      controller.button(name, false);
    }
    expect(sent.slice(1)).toEqual([
      { t: "key", key: "enter", down: true },
      { t: "key", key: "enter", down: false },
      { t: "wheel", ticks: -1 },
      { t: "wheel", ticks: 1 },
      { t: "press", key: "escape" },
    ]);
    expect(nextCamera).toHaveBeenCalledOnce();
  });

  it("moves the pointer with the left stick, with no button", () => {
    controller.stick("left", 1, 0);
    controller.tick(0.1);
    expect(sent).toEqual([centre, { t: "look", dx: 110, dy: 0 }]);
  });

  it("ignores a stick resting in its dead zone", () => {
    controller.stick("left", 0.1, -0.1);
    controller.stick("right", -0.1, 0.1);
    controller.tick(1);
    expect(sent).toEqual([]);
  });

  it("holds the right button only while the right stick is tilted", () => {
    controller.stick("right", 0, 1);
    controller.tick(0.1);
    controller.stick("right", 0, 0);
    controller.tick(0.1);
    expect(sent).toEqual([
      centre,
      { t: "button", button: "right", down: true },
      { t: "look", dx: 0, dy: 180 },
      { t: "button", button: "right", down: false },
    ]);
  });

  it("keeps the right button down until both B and the stick let go", () => {
    controller.button("b", true);
    controller.stick("right", 1, 0);
    controller.tick(0.01);
    controller.button("b", false);
    expect(sent.filter((command) => command.t === "button")).toEqual([{ t: "button", button: "right", down: true }]);
    controller.stick("right", 0, 0);
    controller.tick(0.01);
    expect(sent.at(-1)).toEqual({ t: "button", button: "right", down: false });
  });

  it("doesn't lose slow movement to rounding", () => {
    controller.stick("left", 0.3, 0);
    for (let i = 0; i < 100; i += 1) controller.tick(0.033);
    const moved = sent.reduce((total, command) => total + (command.t === "look" ? command.dx : 0), 0);
    expect(moved).toBeGreaterThan(0);
  });

  it("lets go of everything when released", () => {
    controller.button("a", true);
    controller.button("x", true);
    controller.stick("right", 1, 0);
    controller.tick(0.1);
    sent.length = 0;
    controller.release();
    expect(sent).toEqual([
      { t: "button", button: "left", down: false },
      { t: "key", key: "enter", down: false },
      { t: "button", button: "right", down: false },
    ]);
    controller.tick(1);
    expect(sent).toHaveLength(3);
  });

  it("reads a paired controller's standard layout", () => {
    const pressed = Array.from({ length: 16 }, () => false);
    pressed[0] = true;
    controller.pad({ axes: [1, 0, 0, 0], pressed });
    controller.tick(0.1);
    expect(sent).toContainEqual({ t: "button", button: "left", down: true });
    expect(sent).toContainEqual({ t: "look", dx: 110, dy: 0 });
  });

  it("doesn't let a resting paired controller undo the on-screen one", () => {
    const rest = { axes: [0, 0, 0, 0], pressed: Array.from({ length: 16 }, () => false) };
    controller.pad(rest);
    controller.button("a", true);
    controller.stick("left", 1, 0);
    controller.pad(rest);
    controller.tick(0.1);
    expect(sent).not.toContainEqual({ t: "button", button: "left", down: false });
    expect(sent).toContainEqual({ t: "look", dx: 110, dy: 0 });
  });
});
