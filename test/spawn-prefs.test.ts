// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { readSpawnPrefs, rememberSpawnEnv, rememberSpawnModel, rememberSpawnRemoteControl, rememberSpawnTarget } from "../web/src/lib/spawn-prefs";

const KEY = "corral.spawn.prefs";
const EMPTY = { env: null, targetByEnv: {}, model: null, remoteControl: false };

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("spawn prefs — round trip", () => {
  it("remembers env, model, and a target per environment", () => {
    rememberSpawnEnv("local");
    rememberSpawnModel("opus");
    rememberSpawnTarget("local", "w1");
    rememberSpawnTarget("remote", "new:myrepo");

    const prefs = readSpawnPrefs();
    expect(prefs.env).toBe("local");
    expect(prefs.model).toBe("opus");
    // Keyed BY ENV: a workspaceId only means anything inside the env it came from.
    expect(prefs.targetByEnv.local).toBe("w1");
    expect(prefs.targetByEnv.remote).toBe("new:myrepo");
  });

  it("a later write does not drop the other fields", () => {
    rememberSpawnEnv("local");
    rememberSpawnTarget("local", "w1");
    rememberSpawnRemoteControl(true);
    rememberSpawnModel("sonnet");

    const prefs = readSpawnPrefs();
    expect(prefs.env).toBe("local");
    expect(prefs.targetByEnv.local).toBe("w1");
    expect(prefs.remoteControl).toBe(true);
  });

  // Remembering this at all deviates from the original A.1 rule (see spawn-prefs.ts) — so the OFF state
  // has to round-trip as reliably as the on state, or a tick becomes impossible to take back.
  it("remembers Remote Control both on and off", () => {
    rememberSpawnRemoteControl(true);
    expect(readSpawnPrefs().remoteControl).toBe(true);
    rememberSpawnRemoteControl(false);
    expect(readSpawnPrefs().remoteControl).toBe(false);
  });

  it("treats a non-boolean stored Remote Control as off", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ remoteControl: "yes" }));
    expect(readSpawnPrefs().remoteControl).toBe(false);
  });
});

describe("spawn prefs — untrusted storage", () => {
  it("returns empty prefs when nothing is stored", () => {
    expect(readSpawnPrefs()).toEqual(EMPTY);
  });

  it("falls back to empty prefs on unparseable JSON", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(readSpawnPrefs()).toEqual(EMPTY);
  });

  it("falls back to empty prefs when the stored value is not an object", () => {
    window.localStorage.setItem(KEY, '"local"');
    expect(readSpawnPrefs()).toEqual(EMPTY);
  });

  it("drops individual fields of the wrong type instead of throwing", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ env: 42, targetByEnv: { local: 7 }, model: "opus" }));
    const prefs = readSpawnPrefs();
    expect(prefs.env).toBeNull();
    expect(prefs.targetByEnv).toEqual({});
    expect(prefs.model).toBe("opus");
  });

  it("survives a browser that denies storage access", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
    expect(readSpawnPrefs()).toEqual(EMPTY);

    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("QuotaExceeded"); });
    expect(() => { rememberSpawnEnv("local"); }).not.toThrow();
  });
});
