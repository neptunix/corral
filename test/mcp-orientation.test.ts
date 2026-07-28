import { describe, expect, it } from "vitest";

import { ORIENTATION } from "../mcp/orientation.ts";

// This string is sent as the MCP `instructions` field, which lands in the context of every session
// running inside corral, for the whole life of that session. So it is held to two standards the rest
// of the codebase is not: it must stay SHORT, and it must carry exactly the things a per-tool
// description cannot (the shared vocabulary, and the orderings that span several tools).
describe("ORIENTATION (MCP instructions)", () => {
  it("stays compact enough to sit in every session's context", () => {
    // Not a style preference: this text is unconditional context cost for every corral session.
    // If it grows past a screenful, the content belongs in the skill instead.
    expect(ORIENTATION.split("\n").length).toBeLessThanOrEqual(30);
    expect(ORIENTATION.length).toBeLessThan(2000);
  });

  it("defines the vocabulary the tool descriptions use but never explain", () => {
    for (const term of ["ENVIRONMENT", "PANE", "TAB", "CARD", "LINK"]) {
      expect(ORIENTATION).toContain(term);
    }
  });

  it("states the tab convention and that addressing is still by pane", () => {
    // Two claims, both load-bearing and both easy to get subtly wrong. The CONVENTION is one tab per
    // session (panes split a tab's screen, so corral opens a tab rather than splitting), but a tab
    // CAN hold several panes — so the addressable unit is the pane. Stating only the convention would
    // make `env:paneId` look interchangeable with a tab id; stating only the mechanism would invite
    // splitting panes.
    expect(ORIENTATION).toMatch(/one tab, one pane, one session/);
    expect(ORIENTATION).toMatch(/Addressing is\s+still by pane/);
  });

  it("names corral_whoami as the first call", () => {
    expect(ORIENTATION).toMatch(/corral_whoami FIRST/);
  });

  it("gives the handoff order, which is the ordering that loses work when wrong", () => {
    const update = ORIENTATION.indexOf("corral_task_update");
    const spawn = ORIENTATION.indexOf("corral_spawn");
    const close = ORIENTATION.indexOf("corral_session_close");
    expect(update).toBeGreaterThan(-1);
    expect(update).toBeLessThan(spawn);
    expect(spawn).toBeLessThan(close);
  });

  it("marks tool output as untrusted", () => {
    expect(ORIENTATION.toLowerCase()).toContain("untrusted");
  });

  it("tells the session to install the skill, and where from", () => {
    expect(ORIENTATION).toContain("skills/corral/");
    expect(ORIENTATION).toMatch(/INSTALL THE CORRAL SKILL/);
  });

  it("requires operator intent before a spawn or a close", () => {
    expect(ORIENTATION).toMatch(/Never spawn or close without the operator/);
  });
});
