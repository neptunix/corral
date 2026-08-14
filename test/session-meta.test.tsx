// @vitest-environment jsdom
import type { StatuslineData } from "@shared/schema";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SessionMeta } from "../web/src/components/SessionMeta";

afterEach(cleanup);

function statusline(over: Partial<StatuslineData> = {}): StatuslineData {
  return {
    v: 1, captured_at: Date.now(), session_id: "s1", session_name: null, name_source: null,
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

  it("drops the badge when there is no rung to name and nothing is wrong", () => {
    render(<SessionMeta statusline={statusline()} recap="some text" recapStatus="ok" recapSource={null} />);
    expect(screen.queryByTitle(/Claude's own recap/)).toBeNull();
    expect(screen.getByText("some text")).toBeTruthy();
  });
});
