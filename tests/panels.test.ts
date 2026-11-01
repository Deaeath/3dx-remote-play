// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { PhoneCommand } from "../shared/remotePlay";
import { buildKeyboard } from "../phone/web/panels";

describe("the keyboard", () => {
  let sent: PhoneCommand[];
  let root: HTMLElement;
  let release: () => void;

  const key = (name: string) => [...root.querySelectorAll("button")].find((button) => button.dataset.key === name) ?? null;
  const press = (name: string) => key(name)?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  const lift = (name: string) => key(name)?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));

  beforeEach(() => {
    sent = [];
    root = document.createElement("section");
    release = buildKeyboard(root, (command) => sent.push(command));
  });

  it("holds a key for as long as the finger", () => {
    press("q");
    expect(sent).toEqual([{ t: "key", key: "q", down: true }]);
    lift("q");
    expect(sent.at(-1)).toEqual({ t: "key", key: "q", down: false });
  });

  it("lets a tap of Shift cover the next key, then lets go", () => {
    press("shift");
    lift("shift");
    press("a");
    lift("a");
    expect(sent).toEqual([
      { t: "key", key: "shift", down: true },
      { t: "key", key: "a", down: true },
      { t: "key", key: "a", down: false },
      { t: "key", key: "shift", down: false },
    ]);
    expect(root.classList.contains("shifted")).toBe(false);
  });

  it("lets go of what's held when released", () => {
    press("shift");
    press("w");
    sent.length = 0;
    release();
    expect(sent).toEqual([
      { t: "key", key: "shift", down: false },
      { t: "key", key: "w", down: false },
    ]);
  });

  it("offers no key that reaches outside the game", () => {
    for (const name of ["lwin", "rwin", "win", "alt", "menu", "ctrl", "control", "up"]) {
      expect(key(name)).toBeNull();
    }
  });

  it("offers a full set of letters, digits and function keys", () => {
    for (const name of [..."abcdefghijklmnopqrstuvwxyz0123456789", "f1", "f12", "space", "enter", "backspace", "tab"]) {
      expect(key(name), name).not.toBeNull();
    }
  });
});
