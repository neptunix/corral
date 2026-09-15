// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PastePrompt } from "../web/src/components/PastePrompt";

afterEach(cleanup);

function setup() {
  const onText = vi.fn();
  const onCancel = vi.fn();
  render(<PastePrompt onText={onText} onCancel={onCancel} />);
  return { onText, onCancel, field: screen.getByRole("textbox") };
}

describe("PastePrompt", () => {
  it("forwards a paste without a second tap", () => {
    const { onText, field } = setup();
    fireEvent.paste(field, { clipboardData: { getData: () => "hello world" } });
    expect(onText).toHaveBeenCalledWith("hello world");
  });

  it("keeps the text intact — multi-line is the case bracketing exists for", () => {
    const { onText, field } = setup();
    fireEvent.paste(field, { clipboardData: { getData: () => "one\ntwo\nthree" } });
    expect(onText).toHaveBeenCalledWith("one\ntwo\nthree");
  });

  it("offers Send for a browser that fills the field without a usable paste event", () => {
    const { onText, field } = setup();
    fireEvent.change(field, { target: { value: "typed in" } });
    fireEvent.click(screen.getByText("Send"));
    expect(onText).toHaveBeenCalledWith("typed in");
  });

  it("treats an empty clipboard as a cancel rather than sending nothing", () => {
    const { onText, onCancel, field } = setup();
    fireEvent.paste(field, { clipboardData: { getData: () => "" } });
    expect(onText).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("cancels on the button", () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("swallows Escape, so dismissing the prompt does not close the session behind it", () => {
    const { onCancel } = setup();
    const evt = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const stopped = vi.spyOn(evt, "stopPropagation");
    screen.getByRole("textbox").dispatchEvent(evt);
    expect(onCancel).toHaveBeenCalled();
    expect(stopped).toHaveBeenCalled();
  });
});
