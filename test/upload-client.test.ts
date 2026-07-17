import { afterEach, describe, expect, it, vi } from "vitest";

import { isFileDrag, uploadFile } from "../web/src/lib/upload.ts";

describe("isFileDrag", () => {
  it("is true only when a file drag is in progress", () => {
    expect(isFileDrag(["Files"])).toBe(true);
    expect(isFileDrag(["text/plain"])).toBe(false);
    expect(isFileDrag([])).toBe(false);
  });
});

describe("uploadFile", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("posts multipart and returns the validated path", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ path: "/tmp/x/f.png" }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const p = await uploadFile("e-local", new File([new Uint8Array([1])], "f.png"));
    expect(p).toBe("/tmp/x/f.png");
    expect(fetchMock).toHaveBeenCalledWith("/api/envs/e-local/uploads", expect.objectContaining({ method: "POST" }));
  });

  it("throws the server error message on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: { message: "file exceeds the 25 MB limit" } }), { status: 413 }))));
    await expect(uploadFile("e-local", new File([new Uint8Array([1])], "f.png"))).rejects.toThrow("25 MB");
  });
});
