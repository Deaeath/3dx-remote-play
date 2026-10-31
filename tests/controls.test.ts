import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayInput } from "../shared/remotePlay";
import {
  Gestures,
  HOLD_MS,
  LOOK_GAIN,
  PINCH_STEP_PX,
  TAP_SLOP_PX,
  pictureRect,
  toGamePoint,
} from "../phone/web/controls";

function setup({ magnified = false, inside = true } = {}) {
  const inputs: PlayInput[] = [];
  const pans: [number, number][] = [];
  const gestures = new Gestures({
    input: (event) => inputs.push(event),
    locate: (x, y) => (inside ? { x: x / 1000, y: y / 500 } : null),
    pan: (dx, dy) => {
      if (magnified) pans.push([dx, dy]);
      return magnified;
    },
  });
  return { gestures, inputs, pans };
}

describe("where a finger lands on the game", () => {
  it("finds the picture between the bars on a wide phone", () => {
    expect(pictureRect({ left: 0, top: 0, width: 2000, height: 900 }, 1600, 900)).toEqual({ left: 200, top: 0, width: 1600, height: 900 });
  });

  it("finds the picture between the bars on a tall screen", () => {
    expect(pictureRect({ left: 0, top: 0, width: 800, height: 900 }, 1600, 900)).toEqual({ left: 0, top: 225, width: 800, height: 450 });
  });

  it("uses the whole element before the first frame", () => {
    const element = { left: 0, top: 0, width: 800, height: 400 };
    expect(pictureRect(element, 0, 0)).toEqual(element);
  });

  it("maps corners and centre", () => {
    const picture = { left: 200, top: 0, width: 1600, height: 900 };
    expect(toGamePoint(200, 0, picture)).toEqual({ x: 0, y: 0 });
    expect(toGamePoint(1800, 900, picture)).toEqual({ x: 1, y: 1 });
    expect(toGamePoint(1000, 450, picture)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("ignores the bars beside the picture", () => {
    const picture = { left: 200, top: 0, width: 1600, height: 900 };
    expect(toGamePoint(100, 450, picture)).toBeNull();
    expect(toGamePoint(1900, 450, picture)).toBeNull();
  });
});

describe("touch gestures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns a tap into a click where the finger landed", () => {
    const { gestures, inputs } = setup();
    gestures.down(1, 500, 250);
    gestures.up(1);
    expect(inputs).toEqual([{ t: "tap", x: 0.5, y: 0.5 }]);
  });

  it("forgives a little finger wobble in a tap", () => {
    const { gestures, inputs } = setup();
    gestures.down(1, 500, 250);
    gestures.move(1, 500 + TAP_SLOP_PX - 2, 250);
    gestures.up(1);
    expect(inputs).toEqual([{ t: "tap", x: 0.5, y: 0.5 }]);
  });

  it("does nothing for a tap in the bars", () => {
    const { gestures, inputs } = setup({ inside: false });
    gestures.down(1, 10, 10);
    gestures.up(1);
    expect(inputs).toEqual([]);
  });

  it("turns the camera with a drag, holding the right button only while it lasts", () => {
    const { gestures, inputs } = setup();
    gestures.down(1, 500, 250);
    gestures.move(1, 520, 250);
    gestures.move(1, 530, 240);
    gestures.up(1);
    expect(inputs).toEqual([
      { t: "point", x: 0.5, y: 0.5 },
      { t: "button", button: "right", down: true },
      { t: "look", dx: 20 * LOOK_GAIN, dy: 0 },
      { t: "look", dx: 10 * LOOK_GAIN, dy: -10 * LOOK_GAIN },
      { t: "button", button: "right", down: false },
    ]);
  });

  it("holds the left button after a long press, to drag sliders", () => {
    const { gestures, inputs } = setup();
    gestures.down(1, 100, 100);
    vi.advanceTimersByTime(HOLD_MS);
    gestures.move(1, 200, 100);
    gestures.up(1);
    expect(inputs).toEqual([
      { t: "point", x: 0.1, y: 0.2 },
      { t: "button", button: "left", down: true },
      { t: "point", x: 0.2, y: 0.2 },
      { t: "button", button: "left", down: false },
    ]);
  });

  it("doesn't turn a drag into a long press later", () => {
    const { gestures, inputs } = setup();
    gestures.down(1, 500, 250);
    gestures.move(1, 540, 250);
    vi.advanceTimersByTime(HOLD_MS * 2);
    gestures.up(1);
    expect(inputs.some((event) => event.t === "button" && event.button === "left")).toBe(false);
  });

  it("zooms by pinching over the game, one wheel notch per step", () => {
    const { gestures, inputs } = setup();
    gestures.down(1, 400, 250);
    gestures.down(2, 600, 250);
    gestures.move(2, 600 + PINCH_STEP_PX * 2, 250);
    gestures.move(1, 400 + PINCH_STEP_PX, 250);
    gestures.up(1);
    gestures.up(2);
    expect(inputs).toEqual([{ t: "point", x: 0.5, y: 0.5 }, { t: "wheel", ticks: 2 }, { t: "wheel", ticks: -1 }]);
  });

  it("lets go of the camera when a second finger arrives", () => {
    const { gestures, inputs } = setup();
    gestures.down(1, 500, 250);
    gestures.move(1, 540, 250);
    gestures.down(2, 700, 250);
    expect(inputs.slice(-2)).toEqual([
      { t: "button", button: "right", down: false },
      { t: "point", x: 0.62, y: 0.5 },
    ]);
  });

  it("pans instead of turning the camera under the magnifier", () => {
    const { gestures, inputs, pans } = setup({ magnified: true });
    gestures.down(1, 500, 250);
    gestures.move(1, 540, 260);
    gestures.up(1);
    expect(inputs).toEqual([]);
    expect(pans.at(-1)).toEqual([40, 10]);
  });

  it("still clicks under the magnifier", () => {
    const { gestures, inputs } = setup({ magnified: true });
    gestures.down(1, 500, 250);
    gestures.up(1);
    expect(inputs).toEqual([{ t: "tap", x: 0.5, y: 0.5 }]);
  });

  it("releases whatever is held when the connection drops", () => {
    const { gestures, inputs } = setup();
    gestures.down(1, 500, 250);
    gestures.move(1, 540, 250);
    gestures.cancel();
    expect(inputs.at(-1)).toEqual({ t: "button", button: "right", down: false });
    gestures.move(1, 600, 250);
    gestures.up(1);
    expect(inputs.at(-1)).toEqual({ t: "button", button: "right", down: false });
  });
});
