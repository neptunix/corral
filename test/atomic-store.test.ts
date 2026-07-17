import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { withMutex, writeAtomic } from "../server/atomic-store.ts";

describe("atomic-store", () => {
  it("writeAtomic writes via temp+rename", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atom-"));
    const p = path.join(dir, "x.json");
    writeAtomic(p, '{"a":1}');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}');
  });
  it("withMutex serializes same-key callbacks", async () => {
    const order: number[] = [];
    const slow = (n: number) => withMutex("k", async () => { await Promise.resolve(); order.push(n); });
    await Promise.all([slow(1), slow(2), slow(3)]);
    expect(order).toEqual([1, 2, 3]);
  });
});
