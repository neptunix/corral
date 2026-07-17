import { describe, expect, it } from "vitest";

import { formatDropInjection, formatPaste } from "../web/src/lib/paste.ts";

describe("formatDropInjection", () => {
  it("terminates every path (incl. the last) with a space inside the bracketed paste", () => {
    const bytes = formatDropInjection(["/a/b.png", "/c/d.pdf"]);
    expect(new TextDecoder().decode(bytes)).toBe("\x1b[200~/a/b.png /c/d.pdf \x1b[201~");
  });
  it("terminates a single path too (so it attaches, not stays raw)", () => {
    expect(new TextDecoder().decode(formatDropInjection(["/a/b.png"]))).toBe("\x1b[200~/a/b.png \x1b[201~");
  });
});

describe("formatPaste", () => {
  const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

  it("wraps even a single line, so the app never treats a paste as typed input", () => {
    expect(decode(formatPaste("hello"))).toBe("\x1b[200~hello\x1b[201~");
  });

  it("sends newlines as \\r (what a terminal delivers), never \\n", () => {
    expect(decode(formatPaste("a\nb\nc"))).toBe("\x1b[200~a\rb\rc\x1b[201~");
  });

  it("collapses CRLF to one \\r (not \\r\\r) and leaves a lone \\r alone", () => {
    expect(decode(formatPaste("a\r\nb"))).toBe("\x1b[200~a\rb\x1b[201~");
    expect(decode(formatPaste("a\rb"))).toBe("\x1b[200~a\rb\x1b[201~");
  });

  it("strips embedded markers so a crafted clipboard cannot close the block early", () => {
    // Without stripping, the ESC[201~ would end the paste and the tail would be typed —
    // its \r arriving as a real Enter, submitting mid-paste. Steerable by the clipboard's author.
    expect(decode(formatPaste("a\x1b[201~\rrm -rf /\r"))).toBe("\x1b[200~a\rrm -rf /\r\x1b[201~");
    // Already-bracketed text must not nest.
    expect(decode(formatPaste("\x1b[200~x\x1b[201~"))).toBe("\x1b[200~x\x1b[201~");
  });

  it("strips to a fixed point — removing one marker can stitch a new one from its neighbours", () => {
    // Removing the END joins "\x1b[20" and "0~" into a START. A single strip pass emits TWO
    // start markers and breaks the one-pair invariant.
    expect(decode(formatPaste("\x1b[20\x1b[201~0~"))).toBe("\x1b[200~\x1b[201~");
  });

  it("strips a crafted stitch-chain in linear time (quadratic stripping would hang here)", () => {
    const k = 100_000;
    const evil = "\x1b[20".repeat(k) + "\x1b[201~" + "0~".repeat(k);
    // Every marker removal stitches the next one, k times over. The whole body cancels out.
    expect(decode(formatPaste(evil))).toBe("\x1b[200~\x1b[201~");
  });
});
