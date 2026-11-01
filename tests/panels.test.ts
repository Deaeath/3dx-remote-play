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

  describe("its size", () => {
    const picker = () => root.querySelector("select")!;
    const choose = (size: string) => {
      picker().value = size;
      picker().dispatchEvent(new Event("change"));
    };

    beforeEach(() => {
      localStorage.clear();
      root = document.createElement("section");
      release = buildKeyboard(root, (command) => sent.push(command));
    });

    it("starts at medium, with small and large on offer", () => {
      expect(root.dataset.size).toBe("medium");
      expect([...picker().options].map((option) => option.value)).toEqual(["small", "medium", "large"]);
    });

    it("changes when picked, and presses nothing in the game", () => {
      choose("large");
      expect(root.dataset.size).toBe("large");
      expect(sent).toEqual([]);
    });

    it("is remembered next time", () => {
      choose("small");
      const next = document.createElement("section");
      buildKeyboard(next, () => undefined);
      expect(next.dataset.size).toBe("small");
    });

    it("ignores a stored size that doesn't exist", () => {
      localStorage.setItem("3dx-play:keyboard-size", "giant");
      const next = document.createElement("section");
      buildKeyboard(next, () => undefined);
      expect(next.dataset.size).toBe("medium");
    });
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
