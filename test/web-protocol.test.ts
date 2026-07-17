import { describe, expect, it } from "vitest";

import { closeMessage, parseKey } from "../web/src/lib/protocol.ts";

// These pin the client half of two server↔web contracts: the WS close codes the
// server mints (server/ws-attach.ts 4000/4001, ws-attach-guard 1013, pty-bridge 1000) and the
// `${env.id}:${paneId}` attention-key format (server/attention-store.ts). If the server changes a
// code or the key shape, update BOTH sides — this file is the tripwire.

describe("closeMessage (WS close-code → operator copy)", () => {
  it("prefers a server-sent reason over the code mapping", () => {
    expect(closeMessage(4000, "custom reason")).toBe("custom reason");
  });
  it("4000 → attach failed (spawn error)", () => {
    expect(closeMessage(4000, "")).toBe("attach failed");
  });
  it("4001 → attach unavailable (pty exited within the probe grace)", () => {
    expect(closeMessage(4001, "")).toBe("attach unavailable");
  });
  it("1013 → attach limit reached (spawn limiter exhausted)", () => {
    expect(closeMessage(1013, "")).toBe("attach limit reached — too many terminals open");
  });
  it("1000 → session ended (normal close)", () => {
    expect(closeMessage(1000, "")).toBe("session ended");
  });
  it("any other code → generic connection closed", () => {
    expect(closeMessage(1006, "")).toBe("connection closed");
  });
});

describe("parseKey (attention `env:paneId` key)", () => {
  it("splits on the FIRST colon only — paneIds may themselves contain colons", () => {
    expect(parseKey("e:w653:p1")).toEqual({ env: "e", paneId: "w653:p1" });
  });
  it("plain env:paneId", () => {
    expect(parseKey("work-local:w1-1")).toEqual({ env: "work-local", paneId: "w1-1" });
  });
  it("no-colon fallback: the whole key is the env, empty paneId", () => {
    expect(parseKey("nocolon")).toEqual({ env: "nocolon", paneId: "" });
  });
});
