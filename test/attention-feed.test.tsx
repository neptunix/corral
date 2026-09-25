// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AttentionFeed } from "../web/src/components/AttentionFeed";
import type { BoardAttentionEntry } from "../web/src/lib/attention";

afterEach(cleanup);

// `captured` is a non-nullable boolean on the wire (shared/schema.ts:134). Annotating the fixture is
// what makes that a compile error here rather than a surprise at runtime.
const entry: BoardAttentionEntry = {
  key: "e1:p1",
  record: { state: "blocked", since: Date.now(), lastLines: "waiting", captured: false, sessionName: "worker" },
  taskTitle: "Ship the rail",
};
const finishedEntry: BoardAttentionEntry = {
  key: "e1:p2",
  record: { state: "finished", since: Date.now(), lastLines: "", captured: false, sessionName: "worker" },
  taskTitle: "Ship the rail",
};

describe("AttentionFeed", () => {
  it("renders the entries it is handed rather than computing its own", () => {
    render(<AttentionFeed entries={[entry]} envs={{}} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Ship the rail")).toBeTruthy();
  });

  it("says so plainly when the board is quiet", () => {
    render(<AttentionFeed entries={[]} envs={{}} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Nothing needs you on this board.")).toBeTruthy();
  });

  it("shows a red blocked badge in the header", () => {
    render(<AttentionFeed entries={[entry]} envs={{}} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTitle("1 blocked")).toBeTruthy();
  });

  it("shows a green finished badge, not a red one, for a finished-only entry", () => {
    const { container } = render(<AttentionFeed entries={[finishedEntry]} envs={{}} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("✓1")).toBeTruthy();
    expect(container.querySelector(".bg-destructive")).toBeNull();
  });

  it("shows the muted 0 pill with no entries", () => {
    render(<AttentionFeed entries={[]} envs={{}} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("0").className).toContain("bg-muted");
  });

  it("hands the close decision upward — the rail owns which panel is open", () => {
    const onClose = vi.fn();
    render(<AttentionFeed entries={[]} envs={{}} onOpen={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByTitle("Collapse"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
