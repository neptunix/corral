// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsModal } from "../web/src/components/SettingsModal";
import { readTerminalPrefs, SCROLL_SPEED_DEFAULT } from "../web/src/lib/terminal-prefs";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("settings modal — scroll speed", () => {
  it("opens on the default when nothing is stored", () => {
    render(<SettingsModal onClose={() => undefined} />);
    expect(screen.getByText(`${String(SCROLL_SPEED_DEFAULT)}×`)).toBeTruthy();
  });

  it("persists a move immediately, without a save button", () => {
    render(<SettingsModal onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Scroll speed"), { target: { value: "6" } });

    expect(readTerminalPrefs().scrollSpeed).toBe(6);
    expect(screen.getByText("6×")).toBeTruthy();
  });

  it("reopens on the persisted value", () => {
    render(<SettingsModal onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Scroll speed"), { target: { value: "8" } });
    cleanup();

    render(<SettingsModal onClose={() => undefined} />);
    expect(screen.getByText("8×")).toBeTruthy();
  });

  it("resets to the default", () => {
    render(<SettingsModal onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Scroll speed"), { target: { value: "9" } });
    fireEvent.click(screen.getByText("Reset to default"));

    expect(readTerminalPrefs().scrollSpeed).toBe(SCROLL_SPEED_DEFAULT);
  });

  it("closes on Done and on a click outside the panel", () => {
    const onClose = vi.fn();
    const { container } = render(<SettingsModal onClose={onClose} />);

    fireEvent.click(screen.getByText("Done"));
    expect(onClose).toHaveBeenCalledTimes(1);

    const scrim = container.firstElementChild;
    if (scrim === null) throw new Error("scrim missing");
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
