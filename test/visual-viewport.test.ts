import { describe, expect, it, vi } from "vitest";

import {
  observeViewport, overlayStyle, readViewport,
  type VisualViewportLike, type WindowLike,
} from "../web/src/lib/visual-viewport";

const noop = (): void => undefined;

function viewport(over: Partial<VisualViewportLike> = {}): VisualViewportLike {
  return { height: 300, offsetTop: 12, addEventListener: noop, removeEventListener: noop, ...over };
}

const win = (visualViewport: WindowLike["visualViewport"]): WindowLike => ({ visualViewport });

describe("overlayStyle", () => {
  it("pins the overlay to the region the keyboard leaves visible", () => {
    expect(overlayStyle({ height: 420, offsetTop: 0 })).toEqual({ height: "420px", top: "0px" });
  });

  it("follows the viewport when iOS scrolls it to the focused element", () => {
    // Without `top` the overlay would start above the visible area and the cursor line stay hidden.
    expect(overlayStyle({ height: 420, offsetTop: 96 })).toEqual({ height: "420px", top: "96px" });
  });

  it("leaves the stylesheet in charge where the API is absent", () => {
    expect(overlayStyle(null)).toBeUndefined();
  });
});

describe("readViewport", () => {
  it("reads height and offset", () => {
    expect(readViewport(win(viewport()))).toEqual({ height: 300, offsetTop: 12 });
  });

  it("returns null without visualViewport, rather than throwing", () => {
    expect(readViewport(win(undefined))).toBeNull();
    expect(readViewport(win(null))).toBeNull();
  });
});

describe("observeViewport", () => {
  it("listens for resize AND scroll — a keyboard resizes, iOS then scrolls", () => {
    const add = vi.fn<(type: "resize" | "scroll", cb: () => void) => void>();
    const remove = vi.fn<(type: "resize" | "scroll", cb: () => void) => void>();
    const off = observeViewport(win(viewport({ addEventListener: add, removeEventListener: remove })), noop);

    expect(add.mock.calls.map((c) => c[0]).sort()).toEqual(["resize", "scroll"]);
    off();
    expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual(["resize", "scroll"]);
  });

  it("is a safe no-op where the API is absent", () => {
    expect(() => { observeViewport(win(undefined), noop)(); }).not.toThrow();
  });
});
