import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sanitizeUploadName, sweepUploadRoot, writeUploadFile } from "../server/uploads.ts";

describe("sanitizeUploadName", () => {
  it("strips directory components (traversal)", () => {
    expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadName("/abs/foo.png")).toBe("foo.png");
    expect(sanitizeUploadName("a\\b\\c.png")).toBe("c.png");
  });
  it("reduces spaces and hostile chars to underscore, whole-string", () => {
    expect(sanitizeUploadName("my shot.png")).toBe("my_shot.png");
    expect(sanitizeUploadName("name.png")).toBe("na_me.png"); // ESC stripped
    expect(sanitizeUploadName("a b;c$(x).PNG")).toBe("a_b_c__x_.PNG");
  });
  it("preserves the extension", () => {
    expect(sanitizeUploadName("report.final.pdf").endsWith(".pdf")).toBe(true);
  });
  it("rejects degenerate names", () => {
    expect(sanitizeUploadName("")).toBe("file");
    expect(sanitizeUploadName("..")).toBe("file");
    expect(sanitizeUploadName("...")).toBe("file");
  });
});

describe("writeUploadFile / sweepUploadRoot", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "corral-up-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("writes bytes under root and returns the absolute path", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const dest = await writeUploadFile({ root, originalName: "pic.png", bytes });
    expect(dest.startsWith(root + path.sep)).toBe(true);
    expect(path.basename(dest)).toBe("pic.png");
    expect(new Uint8Array(readFileSync(dest))).toEqual(bytes);
  });
  it("isolates each write in its own subdir", async () => {
    const a = await writeUploadFile({ root, originalName: "x.png", bytes: new Uint8Array([1]) });
    const b = await writeUploadFile({ root, originalName: "x.png", bytes: new Uint8Array([2]) });
    expect(path.dirname(a)).not.toBe(path.dirname(b));
  });
  it("sweep removes the whole root, tolerating absence", async () => {
    await writeUploadFile({ root, originalName: "x.png", bytes: new Uint8Array([1]) });
    await sweepUploadRoot(root);
    expect(existsSync(root)).toBe(false);
    await expect(sweepUploadRoot(root)).resolves.toBeUndefined(); // idempotent
  });
});
