// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { attachForcedSelectionGuard } from "../web/src/lib/forced-selection";

let detach: (() => void) | null = null;

afterEach(() => {
  detach?.();
  detach = null;
  document.body.innerHTML = "";
});

function mount(): { screen: HTMLElement; seen: string[] } {
  const container = document.createElement("div");
  const screen = document.createElement("div"); // stands in for .xterm, where xterm's report listeners live
  container.appendChild(screen);
  document.body.appendChild(container);
  const seen: string[] = [];
  screen.addEventListener("mousemove", (e) => { seen.push(`move:${String(e.buttons)}`); });
  screen.addEventListener("wheel", () => { seen.push("wheel"); });
  detach = attachForcedSelectionGuard(container);
  return { screen, seen };
}

function mouse(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
}

describe("forced-selection guard", () => {
  it("drops a buttonless move during an ⌥-drag, keeps moves with the button held", () => {
    const { screen, seen } = mount();
    screen.dispatchEvent(mouse("mousedown", { altKey: true, button: 0, buttons: 1 }));
    screen.dispatchEvent(mouse("mousemove", { buttons: 1 }));
    screen.dispatchEvent(mouse("mousemove", { buttons: 0 }));
    expect(seen).toEqual(["move:1"]);
  });

  it("drops wheel during an ⌥-drag", () => {
    const { screen, seen } = mount();
    screen.dispatchEvent(mouse("mousedown", { altKey: true, button: 0, buttons: 1 }));
    screen.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 10 }));
    expect(seen).toEqual([]);
  });

  it("lets hover reports through again once the button is released", () => {
    const { screen, seen } = mount();
    screen.dispatchEvent(mouse("mousedown", { altKey: true, button: 0, buttons: 1 }));
    screen.dispatchEvent(mouse("mouseup", { altKey: false, button: 0, buttons: 0 }));
    screen.dispatchEvent(mouse("mousemove", { buttons: 0 }));
    screen.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 10 }));
    expect(seen).toEqual(["move:0", "wheel"]);
  });

  it("leaves a plain drag alone — it belongs to the app", () => {
    const { screen, seen } = mount();
    screen.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1 }));
    screen.dispatchEvent(mouse("mousemove", { buttons: 0 }));
    expect(seen).toEqual(["move:0"]);
  });

  it("stops guarding after detach", () => {
    const { screen, seen } = mount();
    screen.dispatchEvent(mouse("mousedown", { altKey: true, button: 0, buttons: 1 }));
    detach?.();
    detach = null;
    screen.dispatchEvent(mouse("mousemove", { buttons: 0 }));
    expect(seen).toEqual(["move:0"]);
  });
});
