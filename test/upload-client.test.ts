import { afterEach, describe, expect, it, vi } from "vitest";

import { isFileDrag, uploadFile } from "../web/src/lib/upload.ts";

describe("isFileDrag", () => {
  it("is true only when a file drag is in progress", () => {
    expect(isFileDrag(["Files"])).toBe(true);
    expect(isFileDrag(["text/plain"])).toBe(false);
    expect(isFileDrag([])).toBe(false);
  });
});

interface FakeXhr {
  status: number;
  response: unknown;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

// Minimal XMLHttpRequest stand-in: `respond` runs when send() is called, like a server answering.
function stubXhr(respond: (xhr: FakeXhr) => void): { opened: string[] } {
  const opened: string[] = [];
  class Fake implements FakeXhr {
    status = 0;
    response: unknown = null;
    responseType = "";
    upload: FakeXhr["upload"] = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    open(method: string, url: string): void { opened.push(`${method} ${url}`); }
    send(): void { respond(this); }
  }
  vi.stubGlobal("XMLHttpRequest", Fake);
  return { opened };
}

describe("uploadFile", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("posts multipart, reports progress and returns the validated path", async () => {
    const { opened } = stubXhr((x) => {
      x.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 });
      x.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 4 });
      x.status = 200; x.response = { path: "/tmp/x/f.png" }; x.onload?.();
    });
    const seen: number[] = [];
    const p = await uploadFile("e-local", new File([new Uint8Array([1])], "f.png"), (f) => seen.push(f));
    expect(p).toBe("/tmp/x/f.png");
    expect(opened).toEqual(["POST /api/envs/e-local/uploads"]);
    expect(seen).toEqual([0.25, 1]);
  });

  it("throws the server error message on failure", async () => {
    stubXhr((x) => { x.status = 413; x.response = { error: { message: "file exceeds the 25 MB limit" } }; x.onload?.(); });
    await expect(uploadFile("e-local", new File([new Uint8Array([1])], "f.png"))).rejects.toThrow("25 MB");
  });

  it("falls back to the HTTP status when an error body is not the expected shape", async () => {
    stubXhr((x) => { x.status = 502; x.response = null; x.onload?.(); });
    await expect(uploadFile("e", new File([new Uint8Array([1])], "f"))).rejects.toThrow("HTTP 502");
  });

  it("ignores progress events that cannot be turned into a fraction", async () => {
    stubXhr((x) => {
      x.upload.onprogress?.({ lengthComputable: false, loaded: 1, total: 0 });
      x.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 0 });
      x.status = 200; x.response = { path: "/p" }; x.onload?.();
    });
    const seen: number[] = [];
    await uploadFile("e", new File([new Uint8Array([1])], "f"), (f) => seen.push(f));
    expect(seen).toEqual([]);
  });

  it("rejects on a network error and on a malformed success body", async () => {
    stubXhr((x) => { x.onerror?.(); });
    await expect(uploadFile("e", new File([new Uint8Array([1])], "f"))).rejects.toThrow("network");
    stubXhr((x) => { x.status = 200; x.response = { nope: 1 }; x.onload?.(); });
    await expect(uploadFile("e", new File([new Uint8Array([1])], "f"))).rejects.toThrow("malformed");
  });
});
