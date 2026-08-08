import { Mutex } from "async-mutex";
import { renameSync, writeFileSync } from "node:fs";

const mutexes = new Map<string, Mutex>();

/** Serialize callbacks by key. Pass the target file path so distinct files don't share a lock. */
export function withMutex<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  let m = mutexes.get(key);
  if (m === undefined) { m = new Mutex(); mutexes.set(key, m); }
  return m.runExclusive(fn);
}

/** Atomic write: temp file + rename. Synchronous by design (§3.2). `mode` lands on the temp file, so
 *  the rename carries it — setting it after the rename would leave a window at the default umask. */
export function writeAtomic(filePath: string, data: string, mode?: number): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, data, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  renameSync(tmp, filePath);
}
