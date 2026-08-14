import { execFile } from "node:child_process";

export interface RunLocalToolOptions {
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export type RunTool = typeof runLocalTool;

/**
 * Run a named local tool with an optional extra environment variable and timeout.
 * Returns trimmed stdout on success, or null on any error (non-zero exit, binary not found, timeout).
 * Never throws.
 *
 * @param bin The binary name (no shell expansion)
 * @param args Command-line arguments (not interpreted by a shell)
 * @param opts Optional: extraEnv to merge with process.env, timeoutMs (default 5000)
 * @returns Trimmed stdout on success, null on any error
 */
export async function runLocalTool(
  bin: string,
  args: readonly string[],
  opts?: RunLocalToolOptions,
): Promise<string | null> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const env = opts?.extraEnv ? { ...process.env, ...opts.extraEnv } : process.env;

  return new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      { timeout: timeoutMs, env, encoding: "utf8" as const, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}
