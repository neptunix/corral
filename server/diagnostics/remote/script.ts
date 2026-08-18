import { quote } from "shell-quote";

import type { HerdrEnv } from "../../../environments.ts";
import { MAX_READABLE_BYTES } from "../deps.ts";
import type { ManifestEntry, ProbeManifest } from "./manifest.ts";
import { toolCallSignature } from "./recorder.ts";

/** The remote arm of `HerdrEnv` — mirrors `server/whoami.ts`'s `Extract<HerdrEnv, { kind: "local" }>`. */
export type RemoteEnv = Extract<HerdrEnv, { kind: "remote" }>;

export interface RoundSpec {
  readonly file: "ssh";
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly expectedKeys: ReadonlySet<string>;
}

export const ROUND_TIMEOUT_MS = 10_000;

/** Bounds one round's raw stream, well under `defaultExec`'s 10 MiB `maxBuffer` (herdr.ts). */
export const PROBE_TOTAL_CAP_BYTES = 8 * MAX_READABLE_BYTES;

/** No composed round-2 remote command may exceed this many characters — well under ARG_MAX. */
const ROUND2_MAX_CMD_CHARS = 100_000;

// The probe's own flag list — deliberately NOT `buildExec`'s (herdr.ts:33) or session-registry's
// `SSH_FLAGS` (session-registry.ts:15): adding to `buildExec` would change every herdr call, so the
// probe carries its own copy instead.
const SSH_PROBE_FLAGS: readonly string[] = ["-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes"];

/**
 * `ef`/`ed`/`ex` — one shell function per subject kind, defined once and called per subject.
 *
 * `ef`'s `[ -r ]` guard is load-bearing: without it, an existing file the remote user cannot read
 * still passes `[ -f ]`, `wc -c` fails into `s=""`, and `base64` fails into an answered-positive
 * EMPTY content line — a false red. `[ -f ]` is false for a FIFO/device, so those fall through to
 * `[ -e ]` → `!not-regular`, never `cat`-ed. Every branch ends in `printf` (success): per-subject
 * failure is payload, never exit status.
 */
const PREAMBLE = `ef() { k=$1; p=$2
  if [ -f "$p" ]; then
    if [ -r "$p" ]; then
      s=$(wc -c < "$p")
      if [ "$s" -gt ${String(MAX_READABLE_BYTES)} ]; then
        if [ -x "$p" ]; then printf '%s\\t!too-large:x\\n' "$k"; else printf '%s\\t!too-large:f\\n' "$k"; fi
      else
        b=$(base64 < "$p" | tr -d '\\n')
        if [ -x "$p" ]; then printf '%s\\tx:%s\\n' "$k" "$b"; else printf '%s\\tf:%s\\n' "$k" "$b"; fi
      fi
    else
      if [ -x "$p" ]; then printf '%s\\t!unreadable:x\\n' "$k"; else printf '%s\\t!unreadable:f\\n' "$k"; fi
    fi
  elif [ -e "$p" ]; then printf '%s\\t!not-regular\\n' "$k"
  else printf '%s\\t!absent\\n' "$k"; fi; }
ed() { if [ -d "$2" ]; then printf '%s\\t!dir\\n' "$1"; else printf '%s\\t!no-dir\\n' "$1"; fi; }
ex() { if [ -f "$2" ] && [ -x "$2" ]; then printf '%s\\t!exec\\n' "$1"; else printf '%s\\t!not-exec\\n' "$1"; fi; }`;

function fileLine(key: string, p: string): string {
  return `ef '${key}' ${quote([p])}`;
}
function dirLine(key: string, p: string): string {
  return `ed '${key}' ${quote([p])}`;
}
function execLine(key: string, p: string): string {
  return `ex '${key}' ${quote([p])}`;
}

/** `$HOME` — always answered when the round runs at all (unlike `$PATH`, no bash-less escape hatch). */
function homeLine(key: string): string {
  return `printf '%s\\tv:%s\\n' ${key} "$(printf %s "$HOME" | base64 | tr -d '\\n')"`;
}

/**
 * `$PATH`, read via `bash -lc` for real interactive-shell PATH (login rc files, not the SSH
 * subsystem's bare env). A bash-less host lets the substitution fail — no `else` branch, so the
 * key is simply never printed: it goes UNANSWERED, never a false red. This is the ONLY `bash -lc`
 * in the round-F script; it wraps nothing else, and the snippet inside it carries no untrusted token.
 */
function pathLine(key: string): string {
  return `if pe=$(bash -lc 'printf %s "$PATH"' 2>/dev/null); then printf '%s\\tv:%s\\n' ${key} "$(printf %s "$pe" | base64 | tr -d '\\n')"; fi`;
}

function entryLine(e: ManifestEntry): string {
  switch (e.kind) {
    case "value":
      return e.path === "$HOME" ? homeLine(e.key) : pathLine(e.key);
    case "dir":
      return dirLine(e.key, e.path);
    case "exec":
      return execLine(e.key, e.path);
    case "file":
      return fileLine(e.key, e.path);
  }
}

/** `: ` — a no-op builtin appended to every composed script so the round's exit status is always 0
 * regardless of entry order; per-subject failure lives in the wire payload, never in the exit code. */
const TRAILER = ":";

function toSpec(env: RemoteEnv, lines: readonly string[], expectedKeys: ReadonlySet<string>): RoundSpec {
  const script = [PREAMBLE, ...lines, TRAILER].join("\n");
  return { file: "ssh", args: [...SSH_PROBE_FLAGS, env.sshHost, script], timeoutMs: ROUND_TIMEOUT_MS, expectedKeys };
}

/** Round F: filesystem facts. One `ssh` call, one remote-shell parse — walks the manifest exactly. */
export function buildRoundF(env: RemoteEnv, manifest: ProbeManifest): RoundSpec {
  const lines = manifest.entries.map(entryLine);
  const expectedKeys = new Set(manifest.entries.map((e) => e.key));
  return toSpec(env, lines, expectedKeys);
}

export interface ToolRequest {
  readonly key: string;
  readonly signature: string;
}

function toolLine(key: string, cmd: string): string {
  return `if o=$(${cmd} 2>/dev/null); then printf '${key}\\tv:%s\\n' "$(printf %s "$o" | base64 | tr -d '\\n')"; else printf '${key}\\t!error\\n'; fi`;
}

/**
 * Round T: tool version/integration probes. The SCRIPT interpolates the config tokens
 * (`env.herdrBin`/`env.spawnCommand`, unquoted — trusted config), while each `ToolRequest.signature`
 * is built from the producers' LITERAL tokens (`"herdr"`/`"claude"`) via `toolCallSignature` — that
 * split is intentional: it lets the adapter match a probe answer back to the producer call that
 * asked for it, regardless of which binary name the operator configured.
 */
export function buildRoundT(env: RemoteEnv): { readonly spec: RoundSpec; readonly tools: readonly ToolRequest[] } {
  const tools: ToolRequest[] = [];
  const lines: string[] = [];

  lines.push(toolLine("t_0", `HERDR_SOCKET_PATH=${env.socket} ${env.herdrBin} --version`));
  tools.push({ key: "t_0", signature: toolCallSignature("herdr", ["--version"], undefined) });

  lines.push(toolLine("t_1", `${env.spawnCommand} --version`));
  tools.push({ key: "t_1", signature: toolCallSignature("claude", ["--version"], undefined) });

  // Mirrors `integrationChecks` (versions.ts:178-187): one probe per config dir, or a single
  // env-scoped probe (dir undefined, no CLAUDE_CONFIG_DIR prefix) when there are none.
  const dirs: readonly (string | undefined)[] = env.claudeConfigDirs.length === 0 ? [undefined] : env.claudeConfigDirs;
  dirs.forEach((dir, i) => {
    const key = `t_${String(i + 2)}`;
    const prefix = dir === undefined ? "" : `CLAUDE_CONFIG_DIR=${quote([dir])} `;
    lines.push(toolLine(key, `${prefix}HERDR_SOCKET_PATH=${env.socket} ${env.herdrBin} integration status`));
    tools.push({ key, signature: toolCallSignature("herdr", ["integration", "status"], dir) });
  });

  return { spec: toSpec(env, lines, new Set(tools.map((t) => t.key))), tools };
}

export interface Round2Request {
  readonly key: string;
  readonly kind: "file" | "exec";
  readonly path: string;
}

// Control characters (TAB/NEWLINE — the wire delimiters — are inside \x00-\x1f) and shell
// metacharacters. Spaces are deliberately ACCEPTED: `quote()` handles them, and barring spaces
// would permanently degrade `statusline-registered` on macOS (paths under e.g. "Application
// Support" routinely contain one).
// eslint-disable-next-line no-control-regex -- intentional: screening OUT control bytes, not matching text
const ROUND2_CONTROL_RE = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-useless-escape -- `]` and `[` must be escaped inside a character class here for clarity across engines
const ROUND2_META_RE = /[`$\\"';&|<>(){}\[\]*?!#~^]/;

/** Metacharacter/control screen for a round-2 candidate path. Spaces OK; must be absolute. */
export function screenRound2Path(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (ROUND2_CONTROL_RE.test(p)) return false;
  if (ROUND2_META_RE.test(p)) return false;
  return true;
}

function round2Line(req: Round2Request): string {
  const fn = req.kind === "file" ? "ef" : "ex";
  return `${fn} '${req.key}' ${quote([req.path])}`;
}

/**
 * Round 2: conditional follow-up for PATH-derived and settings-referenced dynamic paths. Chunked so
 * no composed remote command exceeds `ROUND2_MAX_CMD_CHARS` — each chunk repeats the preamble and
 * gets its own `RoundSpec`. Requests are appended greedily; a request that would push a non-empty
 * chunk past the bound starts a new one instead.
 */
export function buildRound2(env: RemoteEnv, requests: readonly Round2Request[]): readonly RoundSpec[] {
  const specs: RoundSpec[] = [];
  let lines: string[] = [];
  let keys: string[] = [];

  const flush = (): void => {
    if (lines.length === 0) return;
    specs.push(toSpec(env, lines, new Set(keys)));
    lines = [];
    keys = [];
  };

  for (const req of requests) {
    const line = round2Line(req);
    const candidateLen = [PREAMBLE, ...lines, line, TRAILER].join("\n").length;
    if (lines.length > 0 && candidateLen > ROUND2_MAX_CMD_CHARS) flush();
    lines.push(line);
    keys.push(req.key);
  }
  flush();
  return specs;
}
