import { Mutex } from "async-mutex";
import { renameSync, writeFileSync } from "node:fs";

const mutexes = new Map<string, Mutex>();

/** Serialize callbacks by key. Pass the target file path so distinct files don't share a lock. */
export function withMutex<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  let m = mutexes.get(key);
  if (m === undefined) { m = new Mutex(); mutexes.set(key, m); }
  return m.runExclusive(fn);
}

/** Atomic write: temp file + rename. Synchronous by design (§3.2). */
export function writeAtomic(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, filePath);
}
