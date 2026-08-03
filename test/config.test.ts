import { describe, it, expect, afterEach } from "vitest";

import {
  ATTENTION_MIN_WORK_MS, BOARD_DATA_DIR, BRIEF_ROOT, CHEAP_INTERVAL_MS, CORRAL_HOME, intFromEnv,
  LIST_TIMEOUT, RECAP_ENABLED, RECAP_INTERVAL_MS, RECAP_TAIL_BYTES,
  RECAP_READ_TIMEOUT_MS, RECAP_CONTENT_MAX,
  TAB_RENAME_ENABLED, ZOMBIE_REAP_GRACE_MS,
} from "../config.ts";
import { resolveReapGrace } from "../server/preflight.ts";

describe("intFromEnv", () => {
  const KEY = "CORRAL_TEST_INT_ENV"; // static property below → avoids no-dynamic-delete
  afterEach(() => { delete process.env.CORRAL_TEST_INT_ENV; });

  it("returns the fallback when the var is unset", () => {
    expect(intFromEnv(KEY, 42)).toBe(42);
  });
  it("parses a valid integer", () => {
    process.env.CORRAL_TEST_INT_ENV = "123";
    expect(intFromEnv(KEY, 42)).toBe(123);
  });
  it("rejects empty/whitespace input (the Number('')===0 footgun) → fallback", () => {
    process.env.CORRAL_TEST_INT_ENV = "";
    expect(intFromEnv(KEY, 8787, { min: 1 })).toBe(8787);
    process.env.CORRAL_TEST_INT_ENV = "   ";
    expect(intFromEnv(KEY, 8787, { min: 1 })).toBe(8787);
  });
  it("rejects non-integer input → fallback", () => {
    process.env.CORRAL_TEST_INT_ENV = "abc";
    expect(intFromEnv(KEY, 42)).toBe(42);
    process.env.CORRAL_TEST_INT_ENV = "1.5";
    expect(intFromEnv(KEY, 42)).toBe(42);
  });
  it("rejects a value below min → fallback", () => {
    process.env.CORRAL_TEST_INT_ENV = "0";
    expect(intFromEnv(KEY, 8787, { min: 1 })).toBe(8787);
  });
  it("accepts a negative integer when no min is set", () => {
    process.env.CORRAL_TEST_INT_ENV = "-5";
    expect(intFromEnv(KEY, 42)).toBe(-5);
  });
});

describe("RECAP config defaults", () => {
  it("RECAP_ENABLED defaults to true", () => { expect(RECAP_ENABLED).toBe(true); });
  it("RECAP_INTERVAL_MS defaults to 60000", () => { expect(RECAP_INTERVAL_MS).toBe(60000); });
  it("RECAP_TAIL_BYTES defaults to 262144", () => { expect(RECAP_TAIL_BYTES).toBe(262144); });
  it("RECAP_READ_TIMEOUT_MS defaults to 8000", () => { expect(RECAP_READ_TIMEOUT_MS).toBe(8000); });
  it("RECAP_CONTENT_MAX defaults to 4096", () => { expect(RECAP_CONTENT_MAX).toBe(4096); });
});

describe("poll + attention config defaults", () => {
  it("CHEAP_INTERVAL_MS defaults to 30000 (durable, not instant)", () => { expect(CHEAP_INTERVAL_MS).toBe(30000); });
  it("ATTENTION_MIN_WORK_MS defaults to 600000 (10 min)", () => { expect(ATTENTION_MIN_WORK_MS).toBe(600000); });
});

describe("TAB_RENAME_ENABLED", () => {
  it("defaults to true when the env var is unset", () => {
    // The test runner does not set TAB_RENAME_ENABLED, so the imported default must be true.
    expect(TAB_RENAME_ENABLED).toBe(true);
  });
});

describe("BRIEF_ROOT", () => {
  // Regression guard: BRIEF_ROOT used to live under CORRAL_HOME, which BOARD_DATA_DIR defaults to and
  // which server/git.ts `git add -A`s on an interval — a spawn brief written there gets permanently
  // committed to the board-data repo's history. It MUST live outside both, like UPLOAD_ROOT.
  it("does not live inside CORRAL_HOME", () => {
    expect(BRIEF_ROOT.startsWith(CORRAL_HOME)).toBe(false);
  });
  it("does not live inside BOARD_DATA_DIR (what server/git.ts actually commits)", () => {
    expect(BRIEF_ROOT.startsWith(BOARD_DATA_DIR)).toBe(false);
  });
});

describe("shipped reaper defaults", () => {
  it("clear their own floor, so a default install never needs the startup clamp", () => {
    // Guards the pair, not the literals: lowering the grace default OR raising the poll interval
    // default re-opens the race this floor exists to close, and would otherwise only show up as a
    // console line at boot.
    expect(resolveReapGrace(ZOMBIE_REAP_GRACE_MS, CHEAP_INTERVAL_MS, LIST_TIMEOUT))
      .toEqual({ ms: ZOMBIE_REAP_GRACE_MS, message: null });
  });
});
