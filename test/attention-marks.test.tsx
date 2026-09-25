// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AttentionBadges, FinishedKeysContext, FinishedMark } from "../web/src/components/AttentionMarks";

afterEach(cleanup);

describe("AttentionBadges", () => {
  it("shows red blocked and green finished side by side", () => {
    render(<AttentionBadges counts={{ blocked: 1, finished: 2 }} scope="on this board" />);
    expect(screen.getByTitle("1 blocked on this board").textContent).toBe("1");
    expect(screen.getByTitle("2 finished on this board").textContent).toBe("✓2");
  });
  it("renders nothing at zero", () => {
    const { container } = render(<AttentionBadges counts={{ blocked: 0, finished: 0 }} scope="" />);
    expect(container.textContent).toBe("");
  });
});
describe("FinishedMark", () => {
  it("shows ✓ only for a key in the context set", () => {
    render(<FinishedKeysContext.Provider value={new Set(["e:p1"])}><FinishedMark sessionKey="e:p1" /><FinishedMark sessionKey="e:p2" /></FinishedKeysContext.Provider>);
    expect(screen.getAllByTitle("Finished — not opened yet")).toHaveLength(1);
  });
});
