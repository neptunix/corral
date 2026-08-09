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
    // The WHOLE span, not a bare `sessionStateLabel(s.live)`: that weaker form only pins "the function
    // is called somewhere in this file", so moving the call into a `title=` attribute and rendering
    // `s.live?.status` as the visible text keeps it green. Verified by mutation.
    expect(src).toContain('<span className="text-muted-foreground">{sessionStateLabel(s.live)}</span>');
    // The exact span it replaced must be gone. Scoped to that span, not to `s.live?.status` at large:
    // the status dot, the pending checks and a child modal's prop all read it legitimately.
    expect(src).not.toContain('<span className="text-muted-foreground">{s.live?.status ?? "unknown"}</span>');
  });

  it("UnassignedView puts the state in words at the FRONT of the subtitle", () => {
    const src = read("components/UnassignedView.tsx");
    expect(src).toContain("subtitle={`${sessionStateLabel(session)} · ");
  });

  // The dot and the words beside it must come from ONE decision. Colouring the dot from herdr's
  // agent_status while the label reads Claude's produced a sky-blue "done" dot next to the word "idle".
  // Asserting the whole className expression, not just that sessionStateTone appears in the file: the
  // weaker form stays green if the tone is computed and then dropped on the floor.
  it("colours TaskCard's dot from the tone, not from the raw herdr status", () => {
    const src = read("components/TaskCard.tsx");
    expect(src).toContain('${detached ? "bg-slate-600" : TONE_DOT[sessionStateTone(s.live)]}');
    expect(src).not.toContain("STATUS_DOT[s.live?.status");
  });

  it("colours UnassignedView's dot from the tone, not from the raw herdr status", () => {
    const src = read("components/UnassignedView.tsx");
    expect(src).toContain("className={TONE_COLOR[sessionStateTone(session)]}");
    expect(src).not.toContain("STATUS_COLOR[session.status]");
  });

  // Both palettes must be TOTAL over the tone union, or a tone added later silently renders no colour
  // class at all. `Record<SessionStateTone, string>` is what makes typecheck enforce that.
  it("keys both dot palettes on the tone union so typecheck keeps them total", () => {
    expect(read("components/TaskCard.tsx")).toContain("const TONE_DOT: Record<SessionStateTone, string>");
    expect(read("components/UnassignedView.tsx")).toContain("const TONE_COLOR: Record<SessionStateTone, string>");
  });

  // The assertions above pin the palettes' SHAPE. Nothing pinned a VALUE, so repainting `attention` to
  // `done`'s blue — a session waiting on a human rendered as finished — kept the whole suite green.
  // These pin the two claims that carry meaning: the legacy fallback, and that the states a user must
  // tell apart are actually different colours.
  const PALETTES = [
    ["components/TaskCard.tsx", "TONE_DOT", "bg-slate-500"],
    ["components/UnassignedView.tsx", "TONE_COLOR", "text-slate-400 light:text-slate-500"],
  ] as const;

  const paletteOf = (src: string, name: string): Record<string, string> => {
    const body = src.split(`const ${name}: Record<SessionStateTone, string> = {`)[1]?.split("};")[0] ?? "";
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/(\w+): "([^"]+)"/g)) {
      const [, key, value] = m;
      if (key !== undefined && value !== undefined) out[key] = value;
    }
    // Guard the PARSER, not just its output: a rename that silently yielded {} would make every
    // assertion below vacuous.
    if (Object.keys(out).length === 0) throw new Error(`could not parse ${name}`);
    return out;
  };

  it("keeps `unknown` on the class the herdr-keyed lookup fell back to, so the transients are not repainted", () => {
    for (const [file, name, legacy] of PALETTES) {
      expect(paletteOf(read(file), name).unknown, file).toBe(legacy);
    }
  });

  it("gives `unavailable` a colour distinct from `idle` on both surfaces", () => {
    for (const [file, name] of PALETTES) {
      const p = paletteOf(read(file), name);
      expect(Object.keys(p).sort(), file)
        .toEqual(["attention", "done", "idle", "unavailable", "unknown", "working"]);
      // THE regression this tone exists for: "corral could not read this" must not look like "at rest".
      expect(p.unavailable, file).not.toBe(p.idle);
      expect(p.unavailable, file).not.toBe(p.unknown);
    }
  });

  // A tone rendered in another tone's colour is the original bug wearing a different hat, so pin the
  // colour FAMILY of each semantic tone rather than the exact class (which stays free to be tuned).
  it("renders each semantic tone in its own colour family", () => {
    for (const [file, name] of PALETTES) {
      const p = paletteOf(read(file), name);
      for (const [tone, family] of [["working", "emerald"], ["attention", "red"], ["done", "sky"], ["unavailable", "amber"]] as const) {
        expect(p[tone], `${file} ${tone}`).toContain(family);
      }
    }
  });

  it("SessionModal renders the label too", () => {
    expect(read("components/SessionModal.tsx"))
      .toContain("sessionStateLabel({ status, claudeStatus, waitingFor, registryStatus })");
  });

  // Each prop must be fed the field OF THE SAME NAME. `claudeStatus` and `waitingFor` are both
  // `string | null`, so swapping them typechecks — and the label then renders the reason where the
  // status belongs. Asserting only the prop prefix and `liveByKey.get(…)?.` leaves that swap invisible:
  // verified by mutation, three cross-wirings survived the whole suite.
  const STATE_FIELDS = ["status", "claudeStatus", "waitingFor", "remoteControl", "registryStatus"];

  it("App passes each state field into SessionModal from the field of the same name", () => {
    const src = read("App.tsx");
    for (const f of STATE_FIELDS) {
      expect(src, f).toContain(`${f}={liveByKey.get(\`\${session.env}:\${session.paneId}\`)?.${f} ??`);
    }
  });

  // ...and the map those props read from must not cross-wire them either. Two builders fill it — the
  // unassigned SessionRows and the enriched board links — and both are as swappable as the call site.
  it("builds liveByKey from the matching field on both sources", () => {
    const src = read("App.tsx");
    for (const f of STATE_FIELDS) {
      expect(src, `unassigned ${f}`).toContain(`${f}: s.${f}`);
      expect(src, `link ${f}`).toContain(`${f}: link.live.${f}`);
    }
  });
});
