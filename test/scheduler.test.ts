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
});
