import { z } from "zod";

import { PANE_RE } from "../ws-attach-guard.ts";

// Strict, and carries no socket hint: the environment comes from the listener (ADR 0009).
export const PreambleSchema = z.object({
  v: z.literal(1),
  paneId: z.string().regex(PANE_RE, "malformed paneId"),
  cwd: z.string(),
}).strict();

export type Preamble = z.infer<typeof PreambleSchema>;

// Generous next to a real preamble (~60 bytes); the cap is what stops a peer buffering without bound.
export const PREAMBLE_MAX_BYTES = 4096;

export type PreambleParse =
  | { readonly ok: true; readonly preamble: Preamble }
  | { readonly ok: false; readonly reason: string };

export function parsePreamble(line: string): PreambleParse {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    return { ok: false, reason: `preamble is not JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const parsed = PreambleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `preamble is malformed: ${parsed.error.message}` };
  return { ok: true, preamble: parsed.data };
}
