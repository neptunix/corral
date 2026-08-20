import type { PaneRead, SessionRow } from "@shared/schema";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { quote } from "shell-quote";
import { z } from "zod";

import { FOCUS_TRANSLATION_ENABLED, LIST_TIMEOUT, READ_TIMEOUT } from "../config.ts";
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

// Exported for server/session-registry.ts's remote read: the ONE definition of "lines the ssh client
// wrote, not the remote command". A second copy would drift the day one of them is extended.
export const SSH_NOISE = /^(bind|channel_setup|Could not|Warning: remote port).*$/gm;

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

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const WorkspaceListSchema = z.object({
  result: z.object({ workspaces: z.array(z.object({ workspace_id: z.string(), label: z.string() })).default([]) }).default({ workspaces: [] }),
});
const TabListSchema = z.object({
  // `focused` marks the ONE tab herdr currently has focused (there is never more than one). Defaulted
  // rather than required: a herdr that omits the field must not make the whole env unreachable — focus
  // translation then simply has nowhere to restore to.
  result: z.object({ tabs: z.array(z.object({ tab_id: z.string(), label: z.string(), workspace_id: z.string(), focused: z.boolean().default(false) })).default([]) }).default({ tabs: [] }),
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
      recapSource: null,
      statusline: null,
      statuslineStatus: null,
      claudeStatus: null,
      waitingFor: null,
      remoteControl: null,
      registryStatus: null,
      // Neither literal has registry access where it is built; rebuild() is the sole writer of real values.
      claudeName: null,
      claudeNameUserSet: null,
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
    // `workspace create` also seeds a root tab + pane; surface them so spawn can reuse that tab
    // instead of leaving it empty and creating a second one.
    root_pane: z.object({ pane_id: z.string().optional(), tab_id: z.string().optional() }).optional(),
  }),
});

const PaneListSchema = z.object({
  result: z.object({
    panes: z.array(z.object({ pane_id: z.string(), cwd: z.string() })).default([]),
  }).default({ panes: [] }),
});

// No `.default()` on `result`/`panes` (unlike the sibling PaneListSchema above): a missing or
// renamed container must fail safeParse and hit the warn branch in listAllPanes below, not
// silently parse as zero panes — that silence is exactly the failure mode the warning exists to
// catch (a shape drift would otherwise disable reaping for the env with no signal). Accepted
// trade-off: a herdr host with genuinely zero panes that omits `panes` also warns once per env;
// harmless — the return value is still `[]` either way, and an empty host has nothing to reap.
const PaneListAllSchema = z.object({
  result: z.object({
    panes: z.array(z.object({
      pane_id: z.string(),
      tab_id: z.string(),
      workspace_id: z.string(),
      agent: z.string().optional(),
      agent_status: z.string().optional(),
      agent_session: AgentSessionSchema,
    })),
  }),
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
  // The focus flag is passed EXPLICITLY, never left to herdr's (undocumented) default. A pane that was
  // never focused sits in Claude's `unknown` focus state, which is NOT `blurred` — and only `blurred`
  // produces an `away_summary`. So a spawn that skips focus makes the session permanently unable to ever
  // write a recap, however long it then runs. Focusing a newly created tab is what any terminal does
  // anyway; the next focus event (another spawn, or opening any session on the board) blurs it.
  const focusFlag = FOCUS_TRANSLATION_ENABLED ? "--focus" : "--no-focus";
  const out = await runHerdr(
    env, ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, focusFlag],
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
): Promise<{ workspaceId: string; rootTabId: string | undefined; rootPaneId: string | undefined }> {
  // Same explicit focus decision as `tabCreate`, and NOT redundant with it: when corral creates the
  // workspace, herdr seeds a root tab and `spawn.ts` renames that tab instead of calling `tabCreate`,
  // so this is the only focus flag those spawns ever see (spawn into a repo with no picked workspace,
  // resume onto a dead workspaceId, and the first restore of each workspace group in fleet-restore).
  const focusFlag = FOCUS_TRANSLATION_ENABLED ? "--focus" : "--no-focus";
  const out = await runHerdr(
    env, ["workspace", "create", "--cwd", cwd, "--label", label, focusFlag],
    exec === undefined ? { timeout: LIST_TIMEOUT } : { timeout: LIST_TIMEOUT, exec },
  );
  const r = WorkspaceCreateSchema.parse(JSON.parse(out.trim())).result;
  const id = r.workspace?.workspace_id ?? r.workspace_id;
  if (id === undefined) throw new Error(`workspace create: missing workspace_id in response: ${out.slice(0, 200)}`);
  return { workspaceId: id, rootTabId: r.root_pane?.tab_id, rootPaneId: r.root_pane?.pane_id };
}

/**
 * A pane's own coordinates and labels, independent of whether an AGENT is registered on it.
 *
 * `listSessions` above is built from `herdr agent list`, so it only ever sees panes herdr has already
 * registered a Claude agent on — on this machine, 11 of 13 panes. A pane created seconds ago is real,
 * occupied, and invisible there, which is exactly the state a just-spawned session asks about when it
 * calls corral_whoami as its first action. This is the identity path's fallback for that window.
 *
 * Returns null when the pane does not exist (or the environment cannot answer) rather than throwing:
 * every caller is already on a miss path and wants to try the next environment, not to fail.
 */
export async function paneIdentity(
  env: HerdrEnv, paneId: string, exec?: ExecFn,
): Promise<{ paneId: string; tabId: string; tabLabel: string; workspaceId: string; workspaceLabel: string; cwd: string } | null> {
  let pane: { paneId: string; tabId: string; workspaceId: string; cwd: string };
  try {
    pane = await paneGet(env, paneId, exec);
  } catch {
    return null;
  }
  // Labels are cosmetic here, so a failure to read them must not sink the resolution that matters.
  // `listSessions` uses the same "?" placeholder for an unknown id.
  const labels = await Promise.all([
    herdrJson(env, ["tab", "list"], exec).then((r) => TabListSchema.safeParse(r)).catch(() => undefined),
    herdrJson(env, ["workspace", "list"], exec).then((r) => WorkspaceListSchema.safeParse(r)).catch(() => undefined),
  ]);
  const [tabs, spaces] = labels;
  const tabLabel = tabs?.success === true
    ? tabs.data.result.tabs.find((t) => t.tab_id === pane.tabId)?.label ?? "?"
    : "?";
  const workspaceLabel = spaces?.success === true
    ? spaces.data.result.workspaces.find((w) => w.workspace_id === pane.workspaceId)?.label ?? "?"
    : "?";
  return { ...pane, tabLabel, workspaceLabel };
}

export async function listPanes(
  env: HerdrEnv, workspaceId: string, exec?: ExecFn,
): Promise<{ paneId: string; cwd: string }[]> {
  const raw = await herdrJson(env, ["pane", "list", "--workspace", workspaceId], exec);
  const parsed = PaneListSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.result.panes.map((p) => ({ paneId: p.pane_id, cwd: p.cwd }));
}

export interface PaneIdentity {
  readonly paneId: string;
  readonly tabId: string;
  readonly workspaceId: string;
  readonly hasAgent: boolean;
}

// One warning per env per process for an unparseable `pane list` — see the safeParse branch below.
const warnedPaneListShape = new Set<string>();

/**
 * Every pane herdr knows about, with its tab/workspace and whether an agent is registered on it.
 * Distinct from `listPanes` above, which is workspace-scoped and carries `cwd` for spawn.
 *
 * `hasAgent` reports whether herdr shows ANY agent signal on the pane: an `agent` string, an
 * `agent_session`, or an `agent_status` other than "unknown". It is NOT authoritative for absence:
 * an agent started as a bare shell (`herdr agent start <name> -- bash`) is reported here exactly like
 * a free pane. Occupancy is decided by the `agent list` index in the poller snapshot, which does list
 * that case; this call supplies pane IDENTITY. An unparseable list yields [], which the reaper reads
 * as "no evidence", so a shape change can only suppress reaping, never widen it.
 */
export async function listAllPanes(env: HerdrEnv, exec?: ExecFn): Promise<PaneIdentity[]> {
  const raw = await herdrJson(env, ["pane", "list"], exec);
  const parsed = PaneListAllSchema.safeParse(raw);
  if (!parsed.success) {
    // Silent before: an env whose `pane list` shape drifts loses reaping forever with no signal.
    // Rate-limited to once per env per process — this can fire every poll tick otherwise.
    if (!warnedPaneListShape.has(env.id)) {
      warnedPaneListShape.add(env.id);
      console.warn(`[herdr] pane list: unexpected shape env=${env.id}: ${JSON.stringify(raw).slice(0, 200)}`);
    }
    return [];
  }
  return parsed.data.result.panes.map((p) => ({
    paneId: p.pane_id,
    tabId: p.tab_id,
    workspaceId: p.workspace_id,
    hasAgent: p.agent !== undefined || p.agent_session !== undefined || (p.agent_status ?? "unknown") !== "unknown",
  }));
}

export async function tabClose(env: HerdrEnv, tabId: string, exec?: ExecFn): Promise<void> {
  await runHerdr(env, ["tab", "close", tabId],
    exec === undefined ? { timeout: LIST_TIMEOUT } : { timeout: LIST_TIMEOUT, exec });
}

/**
 * Focus a herdr tab. This is the ONLY lever corral has over a Claude session's terminal focus state,
 * and it is what revives `away_summary`: herdr delivers real focus-report sequences (CSI I / CSI O) to
 * the pane, so focusing tab X blurs whatever was focused before — measured to work with no herdr client
 * attached at all, because focus is server state. Nothing is written into the pane, so this stays a
 * control command of the same class as `tab rename` / `tab close`.
 *
 * See docs/adr/0005 for the mechanism and its gates.
 */
export async function tabFocus(env: HerdrEnv, tabId: string, exec?: ExecFn): Promise<void> {
  await runHerdr(env, ["tab", "focus", tabId],
    exec === undefined ? { timeout: LIST_TIMEOUT } : { timeout: LIST_TIMEOUT, exec });
}

/** The tab herdr currently has focused, or null when nothing reports focus (nothing to restore to). */
export async function focusedTabId(env: HerdrEnv, exec?: ExecFn): Promise<string | null> {
  const parsed = TabListSchema.safeParse(await herdrJson(env, ["tab", "list"], exec));
  if (!parsed.success) return null;
  return parsed.data.result.tabs.find((t) => t.focused)?.tab_id ?? null;
}

export async function tabRename(env: HerdrEnv, tabId: string, label: string, exec?: ExecFn): Promise<void> {
  await runHerdr(env, ["tab", "rename", tabId, label],
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

/**
 * Same call as `listWorkspaces`, but a listing that does not parse THROWS instead of arriving as an
 * empty array.
 *
 * Repo resolution (server/spawn.ts) reads "no space carries this label" as "create one", so the
 * lenient variant's `[]` on a schema mismatch is indistinguishable from a real empty herdr and lands
 * on a duplicate create — a second workspace for a repository that may already have one. Only that
 * path needs this; every other caller wants the degraded-but-usable listing.
 */
export async function listWorkspacesStrict(
  env: HerdrEnv, exec?: ExecFn,
): Promise<{ workspace_id: string; label: string }[]> {
  const raw = await herdrJson(env, ["workspace", "list"], exec);
  return parseList(WorkspaceListSchema, raw, "workspace").result.workspaces;
}
