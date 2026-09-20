import { z } from "zod";

import { PANE_RE } from "../ws-attach-guard.ts";

/**
 * The one line a remote shim writes before it starts piping MCP traffic. It carries the caller's
 * coordinates WITHIN its environment, and nothing else — the environment itself is asserted by which
 * listener the connection arrived on and is never in this payload (ADR 0009).
 *
 * `HERDR_SOCKET_PATH` is deliberately NOT a field. On every other path it is a gate that narrows
 * which environment a caller may be in; here that question is already settled by the transport, so
 * the value could only be inert — and carrying an inert, caller-chosen string on the one path built
 * not to trust caller-chosen strings is an invitation to someone later wiring it back into a
 * decision.
 *
 * `cwd` stays, and is a tie-breaker only: a stale snapshot can briefly hold both a dead row and its
 * replacement for one pane id, and cwd is what separates them.
 */
export const PreambleSchema = z.object({
  v: z.literal(1),
  paneId: z.string().regex(PANE_RE, "malformed paneId"),
  cwd: z.string(),
}).strict();

export type Preamble = z.infer<typeof PreambleSchema>;

/** The largest preamble line accepted before the connection is dropped, so a peer that never sends a
 *  newline cannot make corral buffer without bound. Generous next to a real one (~60 bytes). */
export const PREAMBLE_MAX_BYTES = 4096;

export type PreambleParse =
  | { readonly ok: true; readonly preamble: Preamble }
  | { readonly ok: false; readonly reason: string };

/** Parse one preamble line. Never throws: a malformed line is a peer error, not a server fault. */
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
