// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KeyBar } from "../web/src/components/KeyBar";

// jsdom ships no matchMedia. Stub it per test so both pointer kinds are reachable.
function stubPointer(coarse: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: coarse && query.includes("coarse"),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // The bar persists whether it is collapsed, so a test that collapses it decides how the next one
  // starts unless the store is cleared. Guarded because Node 26's own experimental global
  // localStorage shadows jsdom's, leaving window.localStorage undefined there.
  try { window.localStorage.clear(); } catch { /* no storage in this environment */ }
});

function renderBar(opts: { coarse: boolean; ctrlArmed?: boolean }) {
  stubPointer(opts.coarse);
  const onKey = vi.fn();
  const onCtrlArmedChange = vi.fn();
  const refocus = vi.fn();
  const onPaste = vi.fn();
  render(
    <KeyBar
      onKey={onKey}
      applicationCursorKeys={() => false}
      onCtrlArmedChange={onCtrlArmedChange}
      ctrlArmed={opts.ctrlArmed ?? false}
      refocus={refocus}
      onPaste={onPaste}
    />,
  );
  return { onKey, onCtrlArmedChange, refocus, onPaste };
}

describe("KeyBar", () => {
  it("stays out of the way on a device that has real keys", () => {
    renderBar({ coarse: false });
    expect(screen.queryByLabelText("Up arrow")).toBeNull();
  });

  it("offers exactly the keys a soft keyboard lacks", () => {
    renderBar({ coarse: true });
    for (const name of ["Escape", "Tab", "Ctrl", "Paste", "Left arrow", "Down arrow", "Up arrow", "Right arrow"]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
  });

  it("sends the arrow that unblocks a select prompt", () => {
    const { onKey } = renderBar({ coarse: true });
    fireEvent.pointerDown(screen.getByLabelText("Down arrow"));
    expect(onKey).toHaveBeenCalledWith("\x1b[B");
  });

  it("sends Escape and Tab verbatim", () => {
    const { onKey } = renderBar({ coarse: true });
    fireEvent.pointerDown(screen.getByLabelText("Escape"));
    fireEvent.pointerDown(screen.getByLabelText("Tab"));
    expect(onKey).toHaveBeenNthCalledWith(1, "\x1b");
    expect(onKey).toHaveBeenNthCalledWith(2, "\t");
  });

  it("offers paste, which iOS cannot raise over the terminal itself", () => {
    const { onPaste, onKey } = renderBar({ coarse: true });
    fireEvent.pointerDown(screen.getByLabelText("Paste"));
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onKey).not.toHaveBeenCalled();
  });

  it("arms Ctrl rather than sending anything", () => {
    const { onKey, onCtrlArmedChange } = renderBar({ coarse: true });
    fireEvent.pointerDown(screen.getByLabelText("Ctrl"));
    expect(onCtrlArmedChange).toHaveBeenCalledWith(true);
    expect(onKey).not.toHaveBeenCalled();
  });

  it("applies an armed Ctrl to the next arrow and then releases it", () => {
    const { onKey, onCtrlArmedChange } = renderBar({ coarse: true, ctrlArmed: true });
    fireEvent.pointerDown(screen.getByLabelText("Right arrow"));
    expect(onKey).toHaveBeenCalledWith("\x1b[1;5C");
    expect(onCtrlArmedChange).toHaveBeenCalledWith(false);
  });

  it("disarms Ctrl on a second tap", () => {
    const { onKey, onCtrlArmedChange } = renderBar({ coarse: true, ctrlArmed: true });
    fireEvent.pointerDown(screen.getByLabelText("Ctrl"));
    expect(onCtrlArmedChange).toHaveBeenCalledWith(false);
    expect(onKey).not.toHaveBeenCalled();
  });

  // An app can switch DECCKM on mid-session, so a mode captured once would send the wrong spelling.
  it("reads the cursor-key mode at press time", () => {
    stubPointer(true);
    let applicationMode = false;
    const onKey = vi.fn();
    render(
      <KeyBar
        onKey={onKey}
        applicationCursorKeys={() => applicationMode}
        onCtrlArmedChange={vi.fn()}
        ctrlArmed={false}
        refocus={vi.fn()}
        onPaste={vi.fn()}
      />,
    );
    fireEvent.pointerDown(screen.getByLabelText("Up arrow"));
    applicationMode = true;
    fireEvent.pointerDown(screen.getByLabelText("Up arrow"));
    expect(onKey).toHaveBeenNthCalledWith(1, "\x1b[A");
    expect(onKey).toHaveBeenNthCalledWith(2, "\x1bOA");
  });

  it("shows the armed state, so the modifier is never invisibly stuck", () => {
    renderBar({ coarse: true, ctrlArmed: true });
    expect(screen.getByLabelText("Ctrl").getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps its keys unfocusable, which is what stops iOS closing the keyboard on a tap", () => {
    // A real <button> takes focus off the terminal's textarea; restoring it then reopens the
    // keyboard, and on a key that does not restore it the keyboard just stays shut.
    renderBar({ coarse: true });
    for (const name of ["Up arrow", "Ctrl", "Escape", "Paste"]) {
      const key = screen.getByLabelText(name);
      expect(key.tagName).toBe("SPAN");
      expect(key.hasAttribute("tabindex")).toBe(false);
    }
  });

  it("takes focus back after every press, which is what holds the keyboard open", () => {
    // Fast arrowing down a list otherwise loses focus to a synthesized tap and the keyboard closes.
    const { refocus } = renderBar({ coarse: true });
    fireEvent.pointerDown(screen.getByLabelText("Up arrow"));
    fireEvent.pointerDown(screen.getByLabelText("Up arrow"));
    fireEvent.pointerDown(screen.getByLabelText("Escape"));
    expect(refocus).toHaveBeenCalledTimes(3);
  });

  it("gives the collapsed row's height to the terminal — the reopen button is out of the flow", () => {
    // A button left in the flex column would keep most of the height collapsing was meant to free.
    renderBar({ coarse: true });
    fireEvent.pointerDown(screen.getByLabelText("Hide keys"));
    expect(screen.getByLabelText("Show keys").className).toContain("absolute");
  });

  it("collapses to a single reopen button and comes back", () => {
    renderBar({ coarse: true });
    fireEvent.pointerDown(screen.getByLabelText("Hide keys"));

    expect(screen.queryByLabelText("Up arrow")).toBeNull();
    const reopen = screen.getByLabelText("Show keys");
    expect(reopen.getAttribute("aria-expanded")).toBe("false");

    fireEvent.pointerDown(reopen);
    expect(screen.getByLabelText("Up arrow")).toBeTruthy();
  });
});
