import type { SessionRow } from "@shared/schema";
import { describe, expect, it } from "vitest";

import { getEnv } from "../environments.ts";
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
    expect(ran).toEqual(["claude"]);
  });

  it("reads the brief through the pane's shell rather than inlining it", async () => {
    const { ran, stubs } = harness();
    await spawnSession({
      env, taskSlug: "task", cwd: "/repo", repo: "repo", assignedPaneIds: new Set(),
      spawnCommand: "claude", repoPath: "/repo", briefPath: "/data/briefs/abc123.md", ...stubs,
    });
    expect(ran).toEqual(['claude "$(cat /data/briefs/abc123.md)"']);
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
    expect(ran[0]).toBe("claude \"$(cat \"/data/briefs/a;b\\$(c)\\`d\\`e'f.md\")\"");
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
