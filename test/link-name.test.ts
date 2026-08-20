import { describe, expect, it } from "vitest";

import { normalizeLinkName } from "../server/link-name.ts";
import { NAME_MAX } from "../server/spawn.ts";

const graphemes = (s: string): number =>
  [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;

describe("normalizeLinkName", () => {
  it("trims, and a whitespace-only name normalizes to the empty string", () => {
    expect(normalizeLinkName("  fix the auth bug  ")).toBe("fix the auth bug");
    expect(normalizeLinkName("   ")).toBe("");
  });

  it("strips ESC-initiated sequences, not merely the ESC byte", () => {
    // A hand-rolled /[\x00-\x1F]/g eats the ESC and leaves `[31mred` behind; this value is printed
    // raw into the card (web/src/components/TaskCard.tsx) and into MCP output (mcp/digest.ts).
    expect(normalizeLinkName("\u001b[31mred\u001b[0m")).toBe("red");
    expect(normalizeLinkName("a\nb")).toBe("ab");
  });

  it("does not slugify — the card shows what Claude shows", () => {
    expect(normalizeLinkName("Fix the auth bug")).toBe("Fix the auth bug");
  });

  it("caps at NAME_MAX by GRAPHEME, never splitting a surrogate pair", () => {
    expect(normalizeLinkName("a".repeat(NAME_MAX + 20))).toHaveLength(NAME_MAX);
    // An emoji sitting exactly on the boundary: a UTF-16 slice would emit a lone surrogate.
    const out = normalizeLinkName(`${"a".repeat(NAME_MAX - 1)}😀tail`);
    expect(graphemes(out)).toBe(NAME_MAX);
    expect(out.endsWith("😀")).toBe(true);
  });

  it("keeps a ZWJ sequence whole at the boundary — the reason the cap is not by code point", () => {
    // 👨‍👩‍👧 is one grapheme built from five code points. A code-point cap passes every assertion
    // above and still cuts this in half, leaving a bare 👨 on the card.
    const family = "👨‍👩‍👧";
    const out = normalizeLinkName(`${"a".repeat(NAME_MAX - 1)}${family}tail`);
    expect(graphemes(out)).toBe(NAME_MAX);
    expect(out.endsWith(family)).toBe(true);
  });

  it("leaves no trailing space when the cut lands after one", () => {
    const out = normalizeLinkName(`${"a".repeat(NAME_MAX - 1)} bbb`);
    expect(out).toBe(out.trimEnd());
    expect(out).not.toBe("");
  });
});
