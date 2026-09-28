import { describe, it, expect } from "vitest";

import { makeGuarded } from "../server/scheduler.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("makeGuarded", () => {
  it("skips a new run while the previous is pending", async () => {
    let calls = 0;
    const d = deferred();
    const run = makeGuarded(async () => { calls++; await d.promise; });

    void run();
    await Promise.resolve();
    void run();
    expect(calls).toBe(1);

    d.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await run();
    expect(calls).toBe(2);
  });

  it("a call that lands mid-run settles only once the running task has finished", async () => {
    const d = deferred();
    let finished = false;
    const run = makeGuarded(async () => { await d.promise; finished = true; });

    void run();
    let joinedSettled = false;
    const joined = run().then(() => { joinedSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(joinedSettled).toBe(false);

    d.resolve();
    await joined;
    expect(finished).toBe(true);
  });

  it("a mid-run caller does not see a failure that belongs to the running task", async () => {
    const d = deferred();
    const run = makeGuarded(async () => { await d.promise; throw new Error("tick failed"); });

    const first = run();
    const joined = run();
    d.resolve();
    await expect(first).rejects.toThrow("tick failed");
    await expect(joined).resolves.toBeUndefined();
  });
});
