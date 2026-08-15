// @vitest-environment jsdom
import type { StatuslineData } from "@shared/schema";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionMeta } from "../web/src/components/SessionMeta";

afterEach(cleanup);

// SECONDS, not milliseconds: `isStale` multiplies this by 1000. Passing Date.now() here puts the
// capture tens of thousands of years ahead, so the fresh-metrics path passes without being tested.
const NOW_SEC = 1_776_000_000;

function statusline(over: Partial<StatuslineData> = {}): StatuslineData {
  return {
    v: 1, captured_at: NOW_SEC, session_id: "s1", session_name: null, name_source: null,
    account: { uuid: null, email: null, org: null, tier: null },
    model: "Opus 5", model_id: null,
    ctx: { pct: 18, tokens: 185_000, window: null },
    cost: { usd: 10.25, lines_added: 237, lines_removed: 36 },
    rate: { five_hour: null, seven_day: null },
    effort: null, thinking: null, cc_version: null,
    ...over,
  };
}

describe("SessionMeta", () => {
  it("shows the recap with the tag of the rung that produced it", () => {
    render(<SessionMeta statusline={statusline()} recap="Fixing the focus flag" recapStatus="ok" recapSource="ai-title" />);
    expect(screen.getByText("Fixing the focus flag")).toBeTruthy();
    expect(screen.getByText("topic")).toBeTruthy();
  });

  // The reason is the whole point of carrying the status to the web: a blank line that says nothing
  // is how a dead recap source hid for a month.
  it("states the reason instead of a blank line when there is no recap", () => {
    render(<SessionMeta statusline={statusline()} recap={null} recapStatus="not-found" recapSource={null} />);
    expect(screen.getByText("transcript not found")).toBeTruthy();
  });

  // The cache keeps the last good text and refreshes only the status, so this is the one case where
  // a broken read would otherwise render exactly like a healthy one.
  it("marks a retained recap whose last read failed, and keeps the text", () => {
    render(<SessionMeta statusline={statusline()} recap="Fixing the focus flag" recapStatus="read-error" recapSource="away-summary" />);
    expect(screen.getByText("Fixing the focus flag")).toBeTruthy();
    const badge = screen.getByText("recap ⚠");
    expect(badge.getAttribute("title")).toContain("recap read failed");
  });

  // The warning used to be appended AFTER the text. On a row shared with the metrics a suffix is the
  // first thing truncation eats, so it would disappear exactly when the text is long enough to need
  // it. It belongs on the badge, which sits on the side of the row that never shrinks.
  it("keeps the failed-read marker out of the truncating half of the row", () => {
    const long = "x".repeat(400);
    render(<SessionMeta statusline={statusline()} recap={long} recapStatus="read-error" recapSource="last-prompt" />);
    const badge = screen.getByText("prompt ⚠");
    const text = screen.getByText(long);
    expect(badge.className).toContain("shrink-0");
    expect(text.className).toContain("truncate");
    expect(text.contains(badge)).toBe(false);
  });

  it("renders both halves even with nothing captured yet", () => {
    render(<SessionMeta statusline={null} recap={null} recapStatus={null} recapSource={null} />);
    expect(screen.getByText("metrics not read yet")).toBeTruthy();
    expect(screen.getByText("recap not read yet")).toBeTruthy();
  });

  // Asserted on the ELEMENT, not on a title the badge would not carry in this state either way —
  // the earlier form stayed green with the null guard deleted, which is the defect it claimed to pin.
  it("drops the badge when there is no rung to name and nothing is wrong", () => {
    render(<SessionMeta statusline={statusline()} recap="some text" recapStatus="ok" recapSource={null} />);
    expect(screen.queryByTestId("recap-badge")).toBeNull();
    expect(screen.getByText("some text")).toBeTruthy();
  });

  // MetricChips moved here wholesale in this change and had nothing asserting a character of it:
  // the whole metrics half could render blank without a test going red.
  it("prints the captured metrics as one chip run", () => {
    const { container } = render(<SessionMeta statusline={statusline()} recap={null} recapStatus={null} recapSource={null} />);
    expect(container.textContent).toContain("Opus 5");
    expect(container.textContent).toContain("ctx 18% (185K)");
    expect(container.textContent).toContain("$10.25");
    expect(container.textContent).toContain("+237/\u221236");
  });

  it("omits an uncaptured field rather than printing a dash for it", () => {
    const { container } = render(
      <SessionMeta
        statusline={statusline({ cost: { usd: null, lines_added: null, lines_removed: null } })}
        recap={null} recapStatus={null} recapSource={null}
      />,
    );
    expect(container.textContent).toContain("Opus 5");
    expect(container.textContent).not.toContain("$");
    expect(container.textContent).not.toContain("\u2014");
  });

  it("dims an old capture and leaves a fresh one alone", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW_SEC * 1000);
      const fresh = render(<SessionMeta statusline={statusline()} recap={null} recapStatus={null} recapSource={null} />);
      expect(fresh.container.querySelector(".opacity-50")).toBeNull();
      cleanup();
      vi.setSystemTime((NOW_SEC + 3600) * 1000);
      const old = render(<SessionMeta statusline={statusline()} recap={null} recapStatus={null} recapSource={null} />);
      expect(old.container.querySelector(".opacity-50")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
