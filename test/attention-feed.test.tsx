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

describe("AttentionFeed", () => {
  it("renders the entries it is handed rather than computing its own", () => {
    render(<AttentionFeed entries={[entry]} envs={{}} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Ship the rail")).toBeTruthy();
  });

  it("says so plainly when the board is quiet", () => {
    render(<AttentionFeed entries={[]} envs={{}} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Nothing needs you on this board.")).toBeTruthy();
  });

  it("hands the close decision upward — the rail owns which panel is open", () => {
    const onClose = vi.fn();
    render(<AttentionFeed entries={[]} envs={{}} onOpen={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByTitle("Collapse"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
