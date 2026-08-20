// @vitest-environment jsdom
import type { Check, DiagnosticsSnapshot } from "@shared/diagnostics-schema";
import { emptyDiagnostics } from "@shared/diagnostics-schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HealthPanel } from "../web/src/components/HealthPanel";
import { api } from "../web/src/lib/api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function check(over: Partial<Check> = {}): Check {
  return {
    id: "jq-present", key: "jq-present", title: "jq is not on PATH",
    state: "problem", severity: "fatal", detail: "Install it with your package manager.",
    doc: { anchor: "quick-start", title: "Quick start" },
    scope: { kind: "global" }, class: "cheap",
    checkedAt: 1_000, startupOkLine: false, haltsStartup: false,
    ...over,
  };
}
const snap = (over: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot => ({ ...emptyDiagnostics(), ...over });
const answered = (checks: Check[]): DiagnosticsSnapshot => snap({ checks, answered: ["cheap"] });
const panel = (s: DiagnosticsSnapshot, streamDown = false): JSX.Element => (
  <HealthPanel snapshot={s} streamDown={streamDown} labelFor={(id) => id}
    onClose={vi.fn()} onSnapshot={vi.fn()} />
);

describe("HealthPanel rows", () => {
  // The remote jq row ships detail:"" — a detail-only row would render nothing at all.
  it("leads with the title, so a row with an empty detail still says something", () => {
    render(panel(answered([check({ detail: "" })])));
    expect(screen.getByText("jq is not on PATH")).toBeTruthy();
  });

  it("adds the detail as a second line when there is one", () => {
    render(panel(answered([check()])));
    expect(screen.getByText("Install it with your package manager.")).toBeTruthy();
  });

  it("links to the README section only when the check names one", () => {
    render(panel(answered([check()])));
    const link = screen.getByRole("link", { name: "Quick start" });
    expect(link.getAttribute("href")).toBe("https://github.com/neptunix/corral/blob/main/README.md#quick-start");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("renders no link for a check with no doc — which is every synthetic row", () => {
    render(panel(snap(), true));
    expect(screen.getByText("corral is not answering")).toBeTruthy();
    expect(screen.queryByRole("link")).toBe(null);
  });

  it("folds passing rows behind a keyboard-reachable disclosure", () => {
    render(panel(answered([check({ key: "a", state: "ok", title: "node meets the floor" })])));
    const fold = screen.getByRole("button", { name: /corral/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.getAttribute("aria-controls")).toBe("fold-global");
    expect(screen.queryByText("node meets the floor")).toBe(null);
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("node meets the floor")).toBeTruthy();
  });

  it("omits a fold half whose count is zero, so a green tick never covers a pending row", () => {
    render(panel(answered([check({ key: "p", state: "pending", severity: "fatal" })])));
    const fold = screen.getByRole("button", { name: /corral/ });
    expect(fold.textContent).toContain("1 pending");
    expect(fold.textContent).not.toContain("OK");
  });

  it("renders no fold at all for a group that is nothing but problems", () => {
    render(panel(answered([check()])));
    expect(screen.queryByRole("button", { name: /corral:/ })).toBe(null);
  });
});

describe("HealthPanel — Fix issues", () => {
  it("renders no button when the caller has nothing fixable (no board, or nothing outstanding)", () => {
    render(panel(answered([check()])));
    expect(screen.queryByRole("button", { name: "Fix issues" })).toBe(null);
  });

  it("renders the button and fires the caller's handler on click, with Recheck alongside it", () => {
    const onFixIssues = vi.fn();
    render(<HealthPanel snapshot={answered([check()])} streamDown={false} labelFor={(id) => id}
      onClose={vi.fn()} onSnapshot={vi.fn()} onFixIssues={onFixIssues} />);
    fireEvent.click(screen.getByRole("button", { name: "Fix issues" }));
    expect(onFixIssues).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Recheck" })).toBeTruthy();
  });
});

describe("HealthPanel header", () => {
  // "Checking…" asserts activity that is not happening; the empty state names an action instead.
  it("names an action instead of only describing a wait when nothing has answered", () => {
    render(panel(snap()));
    expect(screen.getByText(/Waiting for the first sweep/)).toBeTruthy();
    expect(screen.queryByText(/Checking/)).toBe(null);
  });

  it("stays green over pending rows but says how many are outstanding", () => {
    render(panel(answered([check({ key: "p", state: "pending", severity: "fatal" })])));
    expect(screen.getByText(/OK · 1 pending/)).toBeTruthy();
  });

  it("shows a slow sweep as work rather than a dead button", async () => {
    vi.spyOn(api.diagnostics, "refresh")
      .mockReturnValue(new Promise<DiagnosticsSnapshot>(() => { /* never settles */ }));
    render(panel(answered([check()])));
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => { expect(screen.getByRole("button", { name: "Rechecking…" })).toBeTruthy(); });
    expect(screen.getByRole("button", { name: "Rechecking…" }).hasAttribute("disabled")).toBe(true);
  });

  // "HTTP 503" and "Failed to fetch" say nothing about what happened or what to do.
  it("translates a 503 instead of passing the raw error through", async () => {
    vi.spyOn(api.diagnostics, "refresh").mockRejectedValue(new Error("HTTP 503"));
    render(panel(answered([check()])));
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => { expect(screen.getByText(/diagnostics aren't enabled on this server/)).toBeTruthy(); });
    expect(screen.getByRole("button", { name: "Recheck" }).hasAttribute("disabled")).toBe(false);
  });

  it("tells the operator to wait for a reconnect when the server is gone", async () => {
    vi.spyOn(api.diagnostics, "refresh").mockRejectedValue(new Error("Failed to fetch"));
    render(panel(answered([check()]), true));
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => { expect(screen.getByText(/corral isn't answering/)).toBeTruthy(); });
  });

  it("hands a successful recheck upward, so one slot feeds both the digit and the rows", async () => {
    const fresh = answered([check({ checkedAt: 9_999 })]);
    vi.spyOn(api.diagnostics, "refresh").mockResolvedValue(fresh);
    const onSnapshot = vi.fn();
    render(<HealthPanel snapshot={answered([check()])} streamDown={false} labelFor={(id) => id}
      onClose={vi.fn()} onSnapshot={onSnapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => { expect(onSnapshot).toHaveBeenCalledWith(fresh); });
  });

  it("keeps the update plate inert until stage 3 fills it", () => {
    render(panel(answered([check()])));
    expect(screen.queryByText(/Update available/)).toBe(null);
  });

  it("shows the plate as a link when the update check supplies a release url", () => {
    const url = "https://github.com/neptunix/corral/releases/tag/v0.7.0";
    render(panel(snap({ checks: [check()], answered: ["cheap"],
      self: { version: "0.6.8", latest: "0.7.0", releaseUrl: url } })));
    expect(screen.getByRole("link", { name: /0\.7\.0/ }).getAttribute("href")).toBe(url);
  });

  it("suppresses the whole plate when latest is not a plain version — it is the anchor's own text", () => {
    render(panel(snap({ checks: [check()], answered: ["cheap"],
      self: { version: "0.6.8", latest: "999.0.0 — install from evil.example",
        releaseUrl: "https://github.com/neptunix/corral/releases/tag/v1" } })));
    expect(screen.queryByText(/Update available/)).toBe(null);
    expect(screen.queryByText(/evil\.example/)).toBe(null);
  });

  // Defense in depth: the producer already refuses anything else, but the REST seed this can render
  // from is never Zod-parsed, and this origin reaches session spawn and terminal attach.
  it("renders plain text, never an anchor, for a url that is not an https github.com link", () => {
    for (const releaseUrl of ["javascript:alert(1)", "https://evil.example/r", "http://github.com/o/r"]) {
      const { unmount } = render(panel(snap({ checks: [check()], answered: ["cheap"],
        self: { version: "0.6.8", latest: "0.7.0", releaseUrl } })));
      expect(screen.getByText(/0\.7\.0/)).toBeTruthy();
      expect(screen.queryByRole("link", { name: /0\.7\.0/ })).toBe(null);
      unmount();
    }
  });

  // releaseUrl is nullable independently of latest — never render an anchor with a null href.
  it("shows the plate as plain text when there is a version but no url", () => {
    render(panel(snap({ checks: [check()], answered: ["cheap"],
      self: { version: "0.6.8", latest: "0.7.0", releaseUrl: null } })));
    expect(screen.getByText(/0\.7\.0/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /0\.7\.0/ })).toBe(null);
  });
});
