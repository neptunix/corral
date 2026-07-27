import { describe, expect, it } from "vitest";

import { CorralError } from "../mcp/client.ts";
import { runTool } from "../mcp/tools/reply.ts";

// The error path is the one route into a tool reply that otherwise bypasses mcp/digest.ts's
// firewall entirely: err.message can be Zod's multi-line pretty-printed validation output, or
// herdr/SSH exec stderr from a spawn/close failure — arbitrary length, arbitrary newlines, and on
// a remote env that is remote output. These tests prove runTool collapses and bounds it the same
// way every other rendered field in this codebase is collapsed and bounded.
describe("runTool error firewall", () => {
  it("pins the literal [unreachable] code-tag prefix for a CorralError", async () => {
    const out = await runTool(async () => { throw new CorralError("unreachable", "corral is not reachable"); });
    expect(out).toMatch(/^corral error \[unreachable\]: /);
  });

  it("pins the literal [unresolved] code-tag prefix for a CorralError", async () => {
    const out = await runTool(async () => { throw new CorralError("unresolved", "no live session at pane w1:p1"); });
    expect(out).toMatch(/^corral error \[unresolved\]: /);
  });

  it("collapses a newline-carrying CorralError message (e.g. Zod's pretty-printed output) onto one line", () => {
    return runTool(async () => {
      throw new CorralError("bad_response", "line one\nline two\r\nline three line four");
    }).then((out) => {
      expect(out.split("\n")).toHaveLength(1);
      expect(out).toContain("line one");
      expect(out).toContain("line four");
    });
  });

  it("truncates a pathologically long CorralError message (e.g. SSH exec stderr)", async () => {
    const out = await runTool(async () => { throw new CorralError("spawn_error", "x".repeat(5000)); });
    expect(out.length).toBeLessThan(400);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("x".repeat(400));
  });

  it("collapses and truncates a generic (non-CorralError) thrown Error the same way", async () => {
    const out = await runTool(async () => { throw new Error("boom\nstack trace line".repeat(50)); });
    expect(out.split("\n")).toHaveLength(1);
    expect(out.length).toBeLessThan(400);
  });

  it("does not touch a normal successful result", async () => {
    expect(await runTool(async () => "ok")).toBe("ok");
  });
});
