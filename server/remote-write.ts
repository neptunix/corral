import { spawn } from "node:child_process";
import { quote } from "shell-quote";

import type { HerdrEnv } from "../environments.ts";
import { SSH_NOISE } from "./herdr.ts";
import { sshFlags } from "./ssh-flags.ts";

type RemoteEnv = Extract<HerdrEnv, { readonly kind: "remote" }>;

// Runs under `sh -c` on the remote so it does not depend on the login shell's syntax, with the file
// name passed as a positional parameter ($1) rather than spliced into the script. mktemp -d makes a
// 0700 directory (and umask 077 the file), so a file dropped into a shared /tmp is readable by the
// remote user only. When `cat` fails the directory is removed again; a client killed by the timeout
// is best-effort only, and whatever it leaves is left to the remote OS's temp cleaning.
const REMOTE_SCRIPT =
  'umask 077; d=$(mktemp -d "${TMPDIR:-/tmp}/corral-upload.XXXXXX") || exit 1; ' +
  'if cat > "$d/$1"; then printf %s "$d/$1"; else rm -rf "$d"; exit 1; fi';

// The whole transfer is bounded, not just the connect: ConnectTimeout does not apply to a client
// attaching to an already-running shared master, so a stalled link would otherwise hang forever.
// The budget grows with the payload so a 25 MB file on a slow link is not cut off at a fixed limit.
const BASE_TIMEOUT_MS = 30_000;
const PER_MB_TIMEOUT_MS = 20_000;
const MAX_CAPTURE_CHARS = 64 * 1024;
const REMOTE_PATH_RE = /^\/.+$/;

export interface RemoteChild {
  readonly stdin: { end(data: Uint8Array): unknown; on(event: "error", cb: () => void): unknown };
  readonly stdout: { on(event: "data", cb: (chunk: Buffer) => void): unknown };
  readonly stderr: { on(event: "data", cb: (chunk: Buffer) => void): unknown };
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: (code: number | null) => void): unknown;
  kill(): unknown;
}
export type SpawnSsh = (file: string, args: readonly string[]) => RemoteChild;

const defaultSpawn: SpawnSsh = (file, args) => spawn(file, [...args], { stdio: ["pipe", "pipe", "pipe"] });

export function remoteWriteTimeoutMs(byteLength: number): number {
  return BASE_TIMEOUT_MS + Math.ceil(byteLength / (1024 * 1024)) * PER_MB_TIMEOUT_MS;
}

/**
 * Write `bytes` to `<remote tmp>/corral-upload.<random>/<name>` on a remote env over the shared ssh
 * connection and return the file's absolute remote path. `name` must already be a single safe
 * basename (sanitizeUploadName). The caller owns lifetime: the private directory is left in the
 * remote's temp dir, which the OS clears; a brief file is removed by the launch command that reads it.
 */
export function writeRemoteFile(
  env: RemoteEnv,
  opts: { readonly name: string; readonly bytes: Uint8Array; readonly timeoutMs?: number; readonly spawnFn?: SpawnSsh },
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? remoteWriteTimeoutMs(opts.bytes.byteLength);
  const remoteCmd = quote(["sh", "-c", REMOTE_SCRIPT, "sh", opts.name]);
  const child = (opts.spawnFn ?? defaultSpawn)("ssh", [...sshFlags(), env.sshHost, remoteCmd]);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`upload to remote timed out after ${String(Math.round(timeoutMs / 1000))}s`));
    }, timeoutMs);
    timer.unref();
    function finish(err: Error | null, value = ""): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err === null) resolve(value); else reject(err);
    }

    child.stdout.on("data", (chunk) => { if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk.toString("utf8"); });
    // EPIPE when ssh exits before reading everything; the exit code below carries the real failure.
    child.stdin.on("error", () => undefined);
    child.on("error", (err) => { finish(new Error(`ssh failed to start: ${err.message}`, { cause: err })); });
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = stderr.replace(SSH_NOISE, "").trim().split("\n").pop() ?? "";
        finish(new Error(`remote write failed (ssh exit ${String(code)})${detail === "" ? "" : `: ${detail}`}`));
        return;
      }
      const out = stdout.replace(SSH_NOISE, "").trim().split("\n").pop() ?? "";
      if (REMOTE_PATH_RE.test(out)) finish(null, out);
      else finish(new Error("remote write returned no usable path"));
    });
    child.stdin.end(opts.bytes);
  });
}
