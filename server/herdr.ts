import type { PaneRead, SessionRow } from "@shared/schema";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { quote } from "shell-quote";
import { z } from "zod";

import { LIST_TIMEOUT, READ_TIMEOUT } from "../config.ts";
import type { HerdrEnv } from "../environments.ts";
import { parsePane } from "./parser.ts";

export interface ExecSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: { readonly env?: NodeJS.ProcessEnv; readonly timeout: number };
}

// Canonical pane-read signature. Single home for the type so downstream consumers (attention-store,
// api.ts) import it instead of redeclaring it. `readPane` below is assignable to it.
export type ReadFn = (env: HerdrEnv, paneId: string, lines?: number) => Promise<PaneRead>;

export function expandTilde(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function buildExec(env: HerdrEnv, herdrArgs: readonly string[], timeoutMs: number): ExecSpec {
  if (env.kind === "remote") {
    // socket + herdrBin are trusted config; herdrArgs may contain user input → quote ONLY those.
    // The env assignment stays unquoted so the remote shell treats it as an assignment, and ~ is
    // left literal so the REMOTE shell expands it. NOTE: socket/herdrBin must not contain spaces
    // or shell metacharacters — they are interpolated unquoted (safe only as hardcoded constants).
    const remoteCmd = `HERDR_SOCKET_PATH=${env.socket} ${env.herdrBin} ${quote([...herdrArgs])}`;
    return { file: "ssh", args: ["-o", "ConnectTimeout=8", env.sshHost, remoteCmd], options: { timeout: timeoutMs } };
  }
  if (env.socket !== undefined) {
    return {
      file: "herdr",
      args: [...herdrArgs],
      options: { env: { ...process.env, HERDR_SOCKET_PATH: expandTilde(env.socket) }, timeout: timeoutMs },
    };
  }
  return { file: "herdr", args: [...herdrArgs], options: { timeout: timeoutMs } };
}

/**
 * Argv for a PTY-hosted `herdr agent attach` (consumed by the WS attach server, Task 10). Unlike
 * `buildExec` this is NOT one-shot: the remote leg gets `ssh -tt` (a real pty) + keepalives so an
 * orphaned attach is reaped, and there is no `timeout`.
 *
 * CLI syntax (Task 0, empirical on herdr 0.7.1): the attach target is a PLAIN POSITIONAL arg. There
 * is deliberately NO `--` separator — `agent attach -- <paneId>` errors "unknown option" on 0.7.1.
 * Option-injection via a leading-`-` paneId is prevented UPSTREAM by the tightened `PANE_RE` in
 * `validateUpgrade` (the load-bearing SEC-4 control now that `--` is gone), so callers must validate
 * `paneId` before spawning. Input ownership uses herdr's native `--takeover` (full-bidirectional
 * decision): herdr serializes input across clients and releases the grab on client detach — even an
 * abrupt SIGKILL — so the browser never leaves a stuck lock.
 *
 * Remote mirrors `buildExec` exactly: the env assignment + trusted `socket`/`herdrBin` stay OUTSIDE
 * `quote()` so the REMOTE shell expands `~` in the socket; only the user-influenced args are quoted.
 */
export function buildAttachSpec(
  env: HerdrEnv,
  paneId: string,
  takeover = false,
): { file: string; args: string[]; env?: NodeJS.ProcessEnv } {
  const attachArgs = takeover
    ? ["agent", "attach", paneId, "--takeover"]
    : ["agent", "attach", paneId];
  if (env.kind === "remote") {
    const remoteCmd = `HERDR_SOCKET_PATH=${env.socket} ${env.herdrBin} ${quote([...attachArgs])}`;
    return {
      file: "ssh",
      args: [
        "-tt",
        "-o", "ConnectTimeout=8",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=2",
        "-o", "StrictHostKeyChecking=yes",
        env.sshHost, remoteCmd,
      ],
    };
  }
  return env.socket !== undefined
    ? { file: "herdr", args: attachArgs, env: { ...process.env, HERDR_SOCKET_PATH: expandTilde(env.socket) } }
    : { file: "herdr", args: attachArgs };
}

export type ExecFn = (
  file: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

// Callback form, NOT promisify(execFile). With `encoding: "utf8" as const` the execFile string
// overload types the callback's stdout/stderr as `string`. promisify(execFile) resolves its
// overloads through a spread options object unreliably and can surface `string | Buffer`, which
// would break `stdout.replace(...)` at runtime. The callback form is unambiguous. (`as const` is
// allowed by the no-`as` rule — it narrows a literal, not an `as SomeType` assertion.)
export const defaultExec: ExecFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { ...options, encoding: "utf8" as const, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(err.message, { cause: err }));
        else resolve({ stdout, stderr });
      },
    );
  });

const SSH_NOISE = /^(bind|channel_setup|Could not|Warning: remote port).*$/gm;

export async function runHerdr(
  env: HerdrEnv,
  herdrArgs: readonly string[],
  opts: { timeout: number; exec?: ExecFn },
): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  const spec = buildExec(env, herdrArgs, opts.timeout);
  const { stdout } = await exec(spec.file, spec.args, { ...spec.options });
  // Remote stdout may carry SSH chatter; strip only those lines. Do NOT trim — pane read text
  // must keep its line structure (the JSON path tolerates surrounding whitespace).
  return env.kind === "remote" ? stdout.replace(SSH_NOISE, "") : stdout;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const WorkspaceListSchema = z.object({
  result: z.object({ workspaces: z.array(z.object({ workspace_id: z.string(), label: z.string() })).default([]) }).default({ workspaces: [] }),
});
const TabListSchema = z.object({
  result: z.object({ tabs: z.array(z.object({ tab_id: z.string(), label: z.string(), workspace_id: z.string() })).default([]) }).default({ tabs: [] }),
});
const AgentSessionSchema = z.object({
  source: z.string().optional(),
  agent: z.string().optional(),
  kind: z.string().optional(),
  value: z.string().optional(),
}).optional();

const AgentListSchema = z.object({
  result: z.object({
    agents: z.array(z.object({
      // `agent` is absent for non-claude panes (`herdr agent start … -- bash` emits only `name`);
      // a required string here made ONE such pane take the whole env unreachable (found in smoke).
      agent: z.string().default(""), agent_status: z.string(), cwd: z.string(),
      pane_id: z.string(), tab_id: z.string(), workspace_id: z.string(),
      agent_session: AgentSessionSchema,
    })).default([]),
  }).default({ agents: [] }),
});

async function herdrJson(env: HerdrEnv, herdrArgs: readonly string[], exec?: ExecFn): Promise<unknown> {
  // A JSON.parse SyntaxError here (herdr emitted non-JSON / an error blob) propagates up through
  // listSessions to pollEnv's catch, which marks the env unreachable — the intended degraded path.
  const out = await runHerdr(env, herdrArgs, exec === undefined ? { timeout: LIST_TIMEOUT } : { timeout: LIST_TIMEOUT, exec });
  const safe = out.trim();
  const parsed: unknown = JSON.parse(safe === "" ? "{}" : safe);
  return parsed;
}

function parseList<T>(schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } }, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`herdr ${label} list: unexpected shape: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  return result.data;
}

export async function listSessions(env: HerdrEnv, exec?: ExecFn): Promise<SessionRow[]> {
  const [wsRaw, tabRaw, agentRaw] = await Promise.all([
    herdrJson(env, ["workspace", "list"], exec),
    herdrJson(env, ["tab", "list"], exec),
    herdrJson(env, ["agent", "list"], exec),
  ]);
  const ws = parseList(WorkspaceListSchema, wsRaw, "workspace");
  const tabs = parseList(TabListSchema, tabRaw, "tab");
  const agents = parseList(AgentListSchema, agentRaw, "agent");

  const wsLabel = new Map(ws.result.workspaces.map((w) => [w.workspace_id, w.label]));
  const tabLabel = new Map(tabs.result.tabs.map((t) => [t.tab_id, t.label]));

  return agents.result.agents.map((a) => {
    const sv = a.agent_session;
    const sessionId =
      sv?.kind === "id" && sv.value !== undefined && UUID_RE.test(sv.value)
        ? sv.value
        : null;
    return {
      env: env.id,
      paneId: a.pane_id,
      status: a.agent_status,
      agent: a.agent,
      cwd: a.cwd,
      tab: tabLabel.get(a.tab_id) ?? "?",
      workspace: wsLabel.get(a.workspace_id) ?? "?",
      tabId: a.tab_id,
      workspaceId: a.workspace_id,
      sessionId,
      recap: null,
      recapAt: null,
      recapStatus: null,
      statusline: null,
      statuslineStatus: null,
    };
  });
}

export async function closePane(env: HerdrEnv, paneId: string, exec?: ExecFn): Promise<void> {
  await runHerdr(
    env,
    ["pane", "close", paneId],
    exec === undefined ? { timeout: LIST_TIMEOUT } : { timeout: LIST_TIMEOUT, exec },
  );
}

export async function readPane(
  env: HerdrEnv,
  paneId: string,
  lines = 50,
  exec?: ExecFn,
): Promise<PaneRead> {
  // `pane read` returns RAW TEXT, never JSON — do not JSON.parse it.
  const text = await runHerdr(
    env,
    ["pane", "read", paneId, "--source", "recent", "--lines", String(lines)],
    exec === undefined ? { timeout: READ_TIMEOUT } : { timeout: READ_TIMEOUT, exec },
  );
  return { text, ...parsePane(text) };
}

const PaneGetSchema = z.object({
  result: z.object({
    pane: z.object({
      pane_id: z.string(),
      tab_id: z.string(),
      workspace_id: z.string(),
      cwd: z.string(),
    }),
  }),
});

// herdr 0.7.1 nests the created ids under result.tab / result.root_pane / result.workspace; older
// builds returned them flat. Accept BOTH so a herdr version bump doesn't silently break spawn again.
const TabCreateSchema = z.object({
  result: z.object({
    tab: z.object({ tab_id: z.string() }).optional(),
    tab_id: z.string().optional(),
    root_pane: z.object({ pane_id: z.string() }).optional(),
    pane_id: z.string().optional(),
  }),
});

const WorkspaceCreateSchema = z.object({
  result: z.object({
    workspace: z.object({ workspace_id: z.string() }).optional(),
    workspace_id: z.string().optional(),
  }),
});

const PaneListSchema = z.object({
  result: z.object({
    panes: z.array(z.object({ pane_id: z.string(), cwd: z.string() })).default([]),
  }).default({ panes: [] }),
});

export async function paneRun(env: HerdrEnv, paneId: string, text: string, exec?: ExecFn): Promise<void> {
  await runHerdr(env, ["pane", "run", paneId, text],
    exec === undefined ? { timeout: LIST_TIMEOUT } : { timeout: LIST_TIMEOUT, exec });
}

export async function paneGet(
  env: HerdrEnv, paneId: string, exec?: ExecFn,
): Promise<{ paneId: string; tabId: string; workspaceId: string; cwd: string }> {
  const out = await runHerdr(env, ["pane", "get", paneId],
    exec === undefined ? { timeout: LIST_TIMEOUT } : { timeout: LIST_TIMEOUT, exec });
  const parsed = PaneGetSchema.parse(JSON.parse(out.trim()));
  const p = parsed.result.pane;
  return { paneId: p.pane_id, tabId: p.tab_id, workspaceId: p.workspace_id, cwd: p.cwd };
}

export async function tabCreate(
  env: HerdrEnv, workspaceId: string, cwd: string, label: string, exec?: ExecFn,
): Promise<{ tabId: string; paneId: string }> {
  const out = await runHerdr(
    env, ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label],
    exec === undefined ? { timeout: LIST_TIMEOUT } : { timeout: LIST_TIMEOUT, exec },
  );
  const r = TabCreateSchema.parse(JSON.parse(out.trim())).result;
  const tabId = r.tab?.tab_id ?? r.tab_id;
  const paneId = r.root_pane?.pane_id ?? r.pane_id;
  if (tabId === undefined || paneId === undefined) {
    throw new Error(`tab create: missing tab_id/pane_id in response: ${out.slice(0, 200)}`);
  }
  return { tabId, paneId };
}

export async function workspaceCreate(
  env: HerdrEnv, cwd: string, label: string, exec?: ExecFn,
): Promise<string> {
  const out = await runHerdr(
    env, ["workspace", "create", "--cwd", cwd, "--label", label],
    exec === undefined ? { timeout: LIST_TIMEOUT } : { timeout: LIST_TIMEOUT, exec },
  );
  const r = WorkspaceCreateSchema.parse(JSON.parse(out.trim())).result;
  const id = r.workspace?.workspace_id ?? r.workspace_id;
  if (id === undefined) throw new Error(`workspace create: missing workspace_id in response: ${out.slice(0, 200)}`);
  return id;
}

export async function listPanes(
  env: HerdrEnv, workspaceId: string, exec?: ExecFn,
): Promise<{ paneId: string; cwd: string }[]> {
  const raw = await herdrJson(env, ["pane", "list", "--workspace", workspaceId], exec);
  const parsed = PaneListSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.result.panes.map((p) => ({ paneId: p.pane_id, cwd: p.cwd }));
}

export async function tabClose(env: HerdrEnv, tabId: string, exec?: ExecFn): Promise<void> {
  await runHerdr(env, ["tab", "close", tabId],
    exec === undefined ? { timeout: LIST_TIMEOUT } : { timeout: LIST_TIMEOUT, exec });
}

export async function workspaceClose(env: HerdrEnv, workspaceId: string, exec?: ExecFn): Promise<void> {
  await runHerdr(env, ["workspace", "close", workspaceId],
    exec === undefined ? { timeout: LIST_TIMEOUT } : { timeout: LIST_TIMEOUT, exec });
}

export async function listWorkspaces(
  env: HerdrEnv, exec?: ExecFn,
): Promise<{ workspace_id: string; label: string }[]> {
  const raw = await herdrJson(env, ["workspace", "list"], exec);
  const parsed = WorkspaceListSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.result.workspaces;
}

export async function listTabs(
  env: HerdrEnv, exec?: ExecFn,
): Promise<{ tab_id: string; label: string; workspace_id: string }[]> {
  const raw = await herdrJson(env, ["tab", "list"], exec);
  const parsed = TabListSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.result.tabs;
}
