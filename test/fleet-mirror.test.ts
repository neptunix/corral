import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FLEET_MIRROR_FILENAME, mirrorPath, readMirrorFile } from "../server/fleet-mirror.ts";

const UUID_A = "aaaaaaaa-0000-4000-8000-000000000001";

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(path.join(os.tmpdir(), "fleet-mirror-test-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function validFile(): unknown {
  return {
    version: 1,
    envs: {
      e1: {
        updatedAt: 1700000000, pendingRestore: false,
        sessions: [{ sessionId: UUID_A, name: "my-tab", cwd: "/repo", workspaceLabel: "acme:web" }],
      },
    },
  };
}

describe("readMirrorFile", () => {
  it("returns null when the file does not exist", () => {
    expect(readMirrorFile(mirrorPath(tmpDir))).toBeNull();
  });

  it("parses a valid mirror file", () => {
    const p = mirrorPath(tmpDir);
    writeFileSync(p, JSON.stringify(validFile()));
    expect(readMirrorFile(p)?.envs.e1?.sessions[0]?.sessionId).toBe(UUID_A);
  });

  it("throws, naming the file, on invalid JSON", () => {
    const p = mirrorPath(tmpDir);
    writeFileSync(p, "{nope");
    expect(() => readMirrorFile(p)).toThrow(p);
  });

  it("rejects a record whose sessionId is not a uuid (fail secure — it must never spawn)", () => {
    const p = mirrorPath(tmpDir);
    const bad = validFile();
    (bad as { envs: { e1: { sessions: { sessionId: string }[] } } }).envs.e1.sessions[0]!.sessionId = "abc; rm -rf /";
    writeFileSync(p, JSON.stringify(bad));
    expect(() => readMirrorFile(p)).toThrow(p);
  });

  it("mirrorPath joins dataDir with the fixed filename", () => {
    expect(mirrorPath("/data")).toBe(path.join("/data", FLEET_MIRROR_FILENAME));
  });
});
