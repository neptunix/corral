import { z } from "zod";

export type ProbeAnswer =
  | { readonly kind: "content"; readonly bytes: Buffer; readonly executable: boolean }
  | { readonly kind: "absent" }
  | { readonly kind: "not-regular" }
  | { readonly kind: "too-large"; readonly executable: boolean }
  | { readonly kind: "unreadable"; readonly executable: boolean }
  | { readonly kind: "dir"; readonly exists: boolean }
  | { readonly kind: "exec"; readonly executable: boolean }
  | { readonly kind: "value"; readonly text: string }
  | { readonly kind: "error" };

export interface ParseResult {
  readonly answers: ReadonlyMap<string, ProbeAnswer>;
  readonly missing: ReadonlySet<string>;
}

const KEY_RE = /^[a-z0-9_]+$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** The complete marker vocabulary — the Zod boundary for everything that is not base64 payload. */
const MarkerSchema = z.enum([
  "!absent", "!not-regular", "!too-large:x", "!too-large:f",
  "!unreadable:x", "!unreadable:f",
  "!dir", "!no-dir", "!exec", "!not-exec", "!error",
]);

const MARKER_ANSWERS: Readonly<Record<z.infer<typeof MarkerSchema>, ProbeAnswer>> = {
  "!absent": { kind: "absent" },
  "!not-regular": { kind: "not-regular" },
  "!too-large:x": { kind: "too-large", executable: true },
  "!too-large:f": { kind: "too-large", executable: false },
  "!unreadable:x": { kind: "unreadable", executable: true },
  "!unreadable:f": { kind: "unreadable", executable: false },
  "!dir": { kind: "dir", exists: true },
  "!no-dir": { kind: "dir", exists: false },
  "!exec": { kind: "exec", executable: true },
  "!not-exec": { kind: "exec", executable: false },
  "!error": { kind: "error" },
};

function decodeB64(payload: string): Buffer | null {
  if (!B64_RE.test(payload)) return null;
  const buf = Buffer.from(payload, "base64");
  // Round-trip check: Buffer.from(_, "base64") silently tolerates junk; re-encoding catches it.
  return buf.toString("base64").replace(/=+$/, "") === payload.replace(/=+$/, "") ? buf : null;
}

function parseValue(value: string): ProbeAnswer | null {
  const marker = MarkerSchema.safeParse(value);
  if (marker.success) return MARKER_ANSWERS[marker.data];
  const tag = value.slice(0, 2);
  const payload = value.slice(2);
  if (tag !== "x:" && tag !== "f:" && tag !== "v:") return null;
  const bytes = decodeB64(payload);
  if (bytes === null) return null;
  if (tag === "v:") return { kind: "value", text: bytes.toString("utf8").trim() };
  return { kind: "content", bytes, executable: tag === "x:" };
}

/**
 * Shape-based: a line that is not `KEY<TAB>VALUE` with an expected key is discarded — SSH noise,
 * banners and garbage all fall out here, with no dependence on SSH_NOISE's four prefixes. When the
 * total cap truncated the stream the last line is dropped BEFORE parsing (a half-written base64
 * value must never be decoded — same rule as session-registry's registry read).
 */
export function parseWire(
  raw: string, expectedKeys: ReadonlySet<string>, totalCapBytes: number,
): ParseResult {
  const truncated = Buffer.byteLength(raw, "utf8") > totalCapBytes;
  const clean = truncated ? Buffer.from(raw, "utf8").subarray(0, totalCapBytes).toString("utf8") : raw;
  const lines = clean.split("\n");
  if (truncated) lines.pop();
  const answers = new Map<string, ProbeAnswer>();
  for (const line of lines) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const key = line.slice(0, tab);
    if (!KEY_RE.test(key) || !expectedKeys.has(key) || answers.has(key)) continue;
    const answer = parseValue(line.slice(tab + 1));
    if (answer !== null) answers.set(key, answer);
  }
  const missing = new Set([...expectedKeys].filter((k) => !answers.has(k)));
  return { answers, missing };
}
