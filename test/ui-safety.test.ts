import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

describe("UI safety — recap never reaches dangerouslySetInnerHTML", () => {
  it("App.tsx: no dangerouslySetInnerHTML line contains 'recap'", () => {
    const src = readFileSync(new URL("../web/src/App.tsx", import.meta.url).pathname, "utf8");
    for (const line of src.split("\n")) {
      if (line.includes("dangerouslySetInnerHTML")) {
        expect(line, `found 'recap' on a dangerouslySetInnerHTML line: ${line.trim()}`).not.toContain("recap");
      }
    }
  });

});

describe("UI safety — SessionModal clipboard (SEC-5)", () => {
  const modalSrc = (): string =>
    readFileSync(new URL("../web/src/components/SessionModal.tsx", import.meta.url).pathname, "utf8");

  it("no xterm clipboard addon — OSC 52 must stay inert", () => {
    expect(modalSrc()).not.toMatch(/addon-clipboard|ClipboardAddon/);
  });
  it("no web-links addon — OSC 8 must stay inert", () => {
    expect(modalSrc()).not.toMatch(/addon-web-links|WebLinksAddon/);
  });
  it("output→input write-back paths stay disabled (SEC-5 constructor invariants)", () => {
    expect(modalSrc()).toContain("allowProposedApi: false");
    expect(modalSrc()).toContain("windowOptions: {}");
  });
  it("⌥+drag escape hatch configured for mouse-reporting TUIs", () => {
    expect(modalSrc()).toContain("macOptionClickForcesSelection: true");
  });
  it("copy-on-select guards the empty selection — a clear must not wipe the clipboard", () => {
    expect(modalSrc()).toContain("onSelectionChange");
    expect(modalSrc()).toMatch(/s\.length > 0/);
  });

  // The Remote Control badge is READ-ONLY. RC is turned on at launch and corral never changes it at
  // runtime — no handler, and above all no slash-command automation typed into a pane.
  // Assert the property, never an occurrence count: a count assertion here has failed twice before.
  it("has no way to turn Remote Control on or off — the badge is read-only", () => {
    const src = modalSrc();
    expect(src).not.toMatch(/onEnableRemoteControl|onDisableRemoteControl/);
    expect(src).not.toMatch(/\/remote-control|\/rc\b/);
  });

  // ...and the badge must actually be there, or the test above passes trivially on a file that never
  // rendered it. Matched on the badge's own title string, NOT on `remoteControl === true` — that
  // expression also appears in the close button's className ternary, so a bare toContain for it stays
  // green even when the badge's guard is rewritten.
  it("does render the read-only Remote Control badge", () => {
    expect(modalSrc()).toContain("Remote Control is connected");
  });

  // The tri-state must survive to the render. `null` (no record) and `false` (positively not
  // connected) are different claims, and collapsing them is how the badge starts lying about sessions
  // corral has never read.
  it("does not collapse remoteControl's null into false at the badge", () => {
    expect(modalSrc()).not.toMatch(/remoteControl \?\? false/);
    expect(modalSrc()).toMatch(/\{remoteControl === true && \(/);
  });
});

describe("UI safety — SessionModal auto-close policy", () => {
  it("auto-closes only on code 1000 — failure codes must keep the modal open", () => {
    const src = readFileSync(new URL("../web/src/components/SessionModal.tsx", import.meta.url).pathname, "utf8");
    expect(src).toContain("closeInfo?.code !== 1000");
  });
});

// One function decides the wording of a session's state everywhere, so a card and the Unassigned list
// can never disagree about what the same session is doing. There is no component-render harness here
// (vitest runs `environment: "node"`), so these pin the call sites by source — the same instrument
// the clipboard invariants above use.
describe("UI wiring — every surface renders session state through sessionStateLabel", () => {
  const read = (rel: string): string =>
    readFileSync(new URL(`../web/src/${rel}`, import.meta.url).pathname, "utf8");

  it("TaskCard renders the label, not the raw herdr status", () => {
    const src = read("components/TaskCard.tsx");
    expect(src).toContain("sessionStateLabel(s.live)");
    // The exact span it replaced must be gone. Scoped to that span, not to `s.live?.status` at large:
    // the status dot, the pending checks and a child modal's prop all read it legitimately.
    expect(src).not.toContain('<span className="text-muted-foreground">{s.live?.status ?? "unknown"}</span>');
  });

  it("UnassignedView puts the state in words at the FRONT of the subtitle", () => {
    const src = read("components/UnassignedView.tsx");
    expect(src).toContain("subtitle={`${sessionStateLabel(session)} · ");
  });

  it("SessionModal renders the label too", () => {
    expect(read("components/SessionModal.tsx"))
      .toContain("sessionStateLabel({ status, claudeStatus, waitingFor, registryStatus })");
  });

  it("App passes all five state fields into SessionModal", () => {
    const src = read("App.tsx");
    for (const prop of ["status=", "claudeStatus=", "waitingFor=", "remoteControl=", "registryStatus="]) {
      expect(src, prop).toContain(`${prop}{liveByKey.get(\`\${session.env}:\${session.paneId}\`)?.`);
    }
  });
});
