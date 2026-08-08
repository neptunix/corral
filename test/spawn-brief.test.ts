import type { SessionRow } from "@shared/schema";
import { describe, expect, it } from "vitest";

import { getEnv } from "../environments.ts";
import { BRIEF_FALLBACK } from "../server/brief.ts";
import { spawnSession } from "../server/spawn.ts";

const env = getEnv("work-local");

function harness() {
  const ran: string[] = [];
  const stubs = {
    listFn: async (): Promise<SessionRow[]> => [],
    paneGetFn: async () => ({ paneId: "p1", tabId: "t1", workspaceId: "ws1", cwd: "/repo" }),
    paneRunFn: async (_e: unknown, _p: string, text: string) => { ran.push(text); },
    workspaceCreateFn: async () => ({ workspaceId: "ws1", rootTabId: "t1", rootPaneId: "p1" }),
    tabCreateFn: async () => ({ tabId: "t1", paneId: "p1" }),
    tabRenameFn: async () => undefined,
    tabCloseFn: async () => undefined,
    workspaceCloseFn: async () => undefined,
    workspaceListFn: async () => [],
    listPanesFn: async () => [],
  };
  return { ran, stubs };
}

describe("spawn with a brief", () => {
  it("launches the bare command when no brief is supplied", async () => {
    const { ran, stubs } = harness();
    await spawnSession({
      env, taskSlug: "task", cwd: "/repo", repo: "repo", assignedPaneIds: new Set(),
      spawnCommand: "claude", repoPath: "/repo", ...stubs,
    });
    expect(ran).toEqual(["claude --name task-a"]);
  });

  it("reads the brief through the pane's shell rather than inlining it", async () => {
    const { ran, stubs } = harness();
    await spawnSession({
      env, taskSlug: "task", cwd: "/repo", repo: "repo", assignedPaneIds: new Set(),
      spawnCommand: "claude", repoPath: "/repo", briefPath: "/data/briefs/abc123.md", ...stubs,
    });
    expect(ran).toEqual([
      `claude --name task-a "$(cat /data/briefs/abc123.md || printf '%s' '${BRIEF_FALLBACK}'; rm -f /data/briefs/abc123.md)"`,
    ]);
  });

  // The regression this pins: deletion must be CAUSED by the read, not scheduled alongside it. The
  // server's unlink timer is only a backstop for a pane that never runs the command; if the brief's
  // only deletion were that timer, a shell still sourcing a heavy rc file could lose the race and
  // `cat` a file that is already gone — which expands to the empty string, so the pane would launch
  // `claude ""` and start with no brief at all while the spawn had already reported success.
  it("deletes the brief in the same substitution that reads it", async () => {
    const { ran, stubs } = harness();
    await spawnSession({
      env, taskSlug: "task", cwd: "/repo", repo: "repo", assignedPaneIds: new Set(),
      spawnCommand: "claude", repoPath: "/repo", briefPath: "/data/briefs/abc123.md", ...stubs,
    });
    const cmd = ran[0] ?? "";
    // Both tokens inside the one substitution, so the rm cannot run before the cat.
    expect(cmd.indexOf("cat ")).toBeLessThan(cmd.indexOf("rm -f "));
    expect(cmd).toContain("; rm -f ");
  });

  // Without the `||` branch, `$(cat <missing>)` expands to the EMPTY STRING — the pane would launch
  // `claude ""` and start with no brief while corral_spawn had already reported success. The whole
  // handoff would be lost with nothing anywhere saying so.
  it("substitutes a self-describing message if the brief cannot be read", async () => {
    const { ran, stubs } = harness();
    await spawnSession({
      env, taskSlug: "task", cwd: "/repo", repo: "repo", assignedPaneIds: new Set(),
      spawnCommand: "claude", repoPath: "/repo", briefPath: "/data/briefs/abc123.md", ...stubs,
    });
    const cmd = ran[0] ?? "";
    expect(cmd).toContain("||");
    expect(cmd).toContain(BRIEF_FALLBACK);
    // The fallback must be reachable only when cat fails, i.e. between the read and the delete.
    expect(cmd.indexOf("||")).toBeGreaterThan(cmd.indexOf("cat "));
    expect(cmd.indexOf("||")).toBeLessThan(cmd.indexOf("rm -f "));
    // Single-quoted, so nothing inside it can be interpreted by the shell.
    expect(cmd).toContain(`printf '%s' '${BRIEF_FALLBACK}'`);
  });

  // The launched command only ever embeds `briefPath` (a short, server-generated file path) — never
  // the brief's own content, which the pane's shell reads at runtime via `$(cat …)`. So this does not
  // exercise a large or multi-line brief; it only proves an ordinary path produces a single-line
  // command, which is what `pane run` (append-Enter) requires.
  it("produces a single-line command for an ordinary brief path", async () => {
    const { ran, stubs } = harness();
    await spawnSession({
      env, taskSlug: "task", cwd: "/repo", repo: "repo", assignedPaneIds: new Set(),
      spawnCommand: "claude", repoPath: "/repo", briefPath: "/data/briefs/abc123.md", ...stubs,
    });
    expect(ran[0]).not.toContain("\n");
  });

  it("shell-quotes a path containing a space", async () => {
    const { ran, stubs } = harness();
    await spawnSession({
      env, taskSlug: "task", cwd: "/repo", repo: "repo", assignedPaneIds: new Set(),
      spawnCommand: "claude", repoPath: "/repo", briefPath: "/data dir/briefs/abc.md", ...stubs,
    });
    expect(ran[0]).toContain("'/data dir/briefs/abc.md'");
    expect(ran[0]).not.toContain("cat /data dir/");
  });

  it("neutralizes shell metacharacters in the brief path (semicolon, $(), backticks, quote)", async () => {
    const { ran, stubs } = harness();
    const hostile = "/data/briefs/a;b$(c)`d`e'f.md";
    await spawnSession({
      env, taskSlug: "task", cwd: "/repo", repo: "repo", assignedPaneIds: new Set(),
      spawnCommand: "claude", repoPath: "/repo", briefPath: hostile, ...stubs,
    });
    // shell-quote wraps the path in double quotes and backslash-escapes `$` and `` ` `` so the
    // command substitution and backticks cannot be interpreted by the shell that runs `cat`.
    const q = "\"/data/briefs/a;b\\$(c)\\`d\\`e'f.md\"";
    expect(ran[0]).toBe(`claude --name task-a "$(cat ${q} || printf '%s' '${BRIEF_FALLBACK}'; rm -f ${q})"`);
    // The hostile substrings must never appear raw/unescaped — that would mean the shell could
    // execute `c` (via `$(c)` or backticks) or terminate the `cat` command early via `;`.
    expect(ran[0]).not.toContain("cat /data/briefs/a;b$(c)");
    expect(ran[0]).not.toContain("a;b$(c)`d`e'f.md\"");
  });

  it("prefers resume over a brief when both are somehow supplied", async () => {
    const { ran, stubs } = harness();
    await spawnSession({
      env, taskSlug: "task", cwd: "/repo", repo: "repo", assignedPaneIds: new Set(),
      spawnCommand: "claude", repoPath: "/repo",
      resumeSessionId: "11111111-2222-3333-4444-555555555555",
      briefPath: "/data/briefs/abc123.md", ...stubs,
      targetWorkspaceId: "ws1",
    });
    expect(ran[0]).toBe("claude --resume 11111111-2222-3333-4444-555555555555");
  });
});
