// @vitest-environment jsdom
import type { Check, DiagnosticsSnapshot } from "@shared/diagnostics-schema";
import { emptyDiagnostics } from "@shared/diagnostics-schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SideRail } from "../web/src/components/SideRail";
import { api } from "../web/src/lib/api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function check(over: Partial<Check> = {}): Check {
  return {
    id: "jq-present", key: "jq-present", title: "jq is not on PATH",
    state: "problem", severity: "fatal", detail: "", doc: null,
    scope: { kind: "global" }, class: "cheap",
    checkedAt: 1_000, startupOkLine: false, haltsStartup: false, ...over,
  };
}
const snap = (over: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot => ({ ...emptyDiagnostics(), ...over });

// STAMPS MATTER. pickSnapshot keeps the incumbent on a tie, so a fixture meant to ARRIVE LATER must
// carry a strictly newer checkedAt or the rail never adopts it and the test passes vacuously.
const clean = snap({ checks: [check({ state: "ok", checkedAt: 1_000 })], answered: ["cheap"] });
const broken = snap({ checks: [check({ checkedAt: 2_000 })], answered: ["cheap"] });
const worse = snap({
  checks: [check({ key: "a", checkedAt: 3_000 }), check({ key: "b", checkedAt: 3_000 })],
  answered: ["cheap"],
});

function rail(over: Partial<Parameters<typeof SideRail>[0]> = {}): JSX.Element {
  return <SideRail diagnostics={clean} streamDown={false} attention={{}} boards={[]} envs={{}}
    activeBoardId="b1" showUnassigned={false} onOpen={vi.fn()} onFixIssues={vi.fn()} {...over} />;
}
const bell = (): HTMLElement => screen.getByRole("button", { name: /Sessions needing attention/ });

describe("SideRail", () => {
  it("starts collapsed", () => {
    render(rail());
    expect(screen.queryByText("Health")).toBe(null);
    expect(screen.queryByText("Attention")).toBe(null);
  });

  it("opens itself once when there is a problem to report", () => {
    render(rail({ diagnostics: broken }));
    expect(screen.getByText("Health")).toBeTruthy();
  });

  // Rerenders with a DIFFERENT, NEWER problem set so the effect genuinely re-fires — otherwise the
  // test passes with the latch deleted.
  it("does not re-open after the operator closes it", () => {
    const { rerender } = render(rail({ diagnostics: broken }));
    fireEvent.click(screen.getByTitle("Collapse"));
    expect(screen.queryByText("Health")).toBe(null);
    rerender(rail({ diagnostics: worse }));
    expect(screen.queryByText("Health")).toBe(null);
  });

  it("never replaces a panel the operator opened by hand", () => {
    const { rerender } = render(rail());
    fireEvent.click(bell());
    expect(screen.getByText("Attention")).toBeTruthy();
    rerender(rail({ diagnostics: broken }));
    expect(screen.getByText("Attention")).toBeTruthy();
    expect(screen.queryByText("Health")).toBe(null);
  });

  // Every load starts collapsed, so the first click is often the bell. Spending the latch there would
  // disable the health auto-open for the whole session.
  it("opening the attention feed does not disable the health auto-open", () => {
    const { rerender } = render(rail());
    fireEvent.click(bell());
    fireEvent.click(screen.getByTitle("Collapse"));
    rerender(rail({ diagnostics: broken }));
    expect(screen.getByText("Health")).toBeTruthy();
  });

  it("shows one panel at a time", () => {
    render(rail({ diagnostics: broken }));
    fireEvent.click(bell());
    expect(screen.getByText("Attention")).toBeTruthy();
    expect(screen.queryByText("Health")).toBe(null);
  });

  // aria-expanded is what the edge-bar indicator's CSS keys off, so this pins the state the
  // visual indicator depends on, not just the panel's presence in the DOM.
  it("marks only the open button's icon as expanded", () => {
    render(rail({ diagnostics: broken }));
    expect(screen.getByRole("button", { name: /System health/ }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(bell());
    expect(bell().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /System health/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("hides the bell off a board but keeps health reachable", () => {
    render(rail({ activeBoardId: null }));
    expect(screen.queryByRole("button", { name: /Sessions needing attention/ })).toBe(null);
    expect(screen.getByRole("button", { name: /System health/ })).toBeTruthy();
  });

  it("drops an open attention panel when the operator leaves the board", () => {
    const { rerender } = render(rail());
    fireEvent.click(bell());
    expect(screen.getByText("Attention")).toBeTruthy();
    rerender(rail({ showUnassigned: true }));
    expect(screen.queryByText("Attention")).toBe(null);
    expect(screen.getByRole("button", { name: /System health/ })).toBeTruthy();
  });

  // Regression: the auto-open effect must guard on the visible `shown` state, not the raw internal
  // `open`. A stale open === "attention" left over from a board the operator has since left must not
  // silently suppress the health auto-open for the rest of the session.
  it("still auto-opens health after a stale attention panel is left behind on a board switch", () => {
    const { rerender } = render(rail());
    fireEvent.click(bell());
    expect(screen.getByText("Attention")).toBeTruthy();
    rerender(rail({ showUnassigned: true }));
    expect(screen.queryByText("Attention")).toBe(null);
    rerender(rail({ showUnassigned: true, diagnostics: broken }));
    expect(screen.getByText("Health")).toBeTruthy();
  });

  it("names the count and kind rather than showing a bare digit", () => {
    render(rail({ diagnostics: broken }));
    expect(screen.getByRole("button", { name: "System health: 1 problem" })).toBeTruthy();
  });

  // A null carrier is the board switch: no frame, no seed, no news.
  it("keeps the rows on screen when a board switch empties the stream", () => {
    const { rerender } = render(rail({ diagnostics: broken }));
    rerender(rail({ diagnostics: null }));
    expect(screen.getByRole("button", { name: "System health: 1 problem" })).toBeTruthy();
  });

  // R9's headline invariant: one slot feeds the digit and the rows, so a Recheck moves the badge
  // before any new frame arrives.
  it("moves the badge digit on a successful recheck, with no new frame", async () => {
    vi.spyOn(api.diagnostics, "refresh")
      .mockResolvedValue(snap({ checks: [check({ state: "ok", checkedAt: 9_999 })], answered: ["cheap"] }));
    render(rail({ diagnostics: broken }));
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "System health: OK" })).toBeTruthy();
    });
  });

  it("offers Fix issues once the panel is open, and hands the caller a built preset on click", () => {
    const onFixIssues = vi.fn();
    render(rail({ diagnostics: broken, onFixIssues }));
    fireEvent.click(screen.getByRole("button", { name: "Fix issues" }));
    expect(onFixIssues).toHaveBeenCalledTimes(1);
    const built = onFixIssues.mock.calls[0]?.[0] as { title: string; preset: { text: string } };
    expect(built.title).toBe("Fix 1 corral issue");
    expect(built.preset.text.startsWith("/corral-doctor")).toBe(true);
  });

  it("hides Fix issues with no active board — an ad-hoc task needs one to attach to", () => {
    render(rail({ diagnostics: broken, activeBoardId: null }));
    expect(screen.getByText("Health")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fix issues" })).toBe(null);
  });

  it("hides Fix issues when the only trouble is synthetic — nothing a spawned session could fix", () => {
    render(rail({ diagnostics: clean, streamDown: true }));
    expect(screen.getByText("Health")).toBeTruthy();
    expect(screen.getByText("corral is not answering")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fix issues" })).toBe(null);
  });

  // A live region that enters the DOM with its content is routinely not announced.
  it("keeps an announcement region mounted before there is anything to announce", () => {
    const { container, rerender } = render(rail());
    const region = container.querySelector('[aria-live="polite"]');
    expect(region).toBeTruthy();
    expect(region?.textContent).toBe("");
    rerender(rail({ diagnostics: broken }));
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("System health opened");
  });
});
