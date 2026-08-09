import type { RegistryStatus } from "@shared/schema";

/**
 * The four fields this needs, structurally — so it works on BOTH an enriched card link
 * (`LiveSessionData`) and a raw unassigned row (`SessionRow`), which carry the same field names. A
 * `LiveSessionData`-only signature would have forced an adapter at the Unassigned view.
 */
export interface SessionStateFields {
  readonly status: string;
  readonly claudeStatus: string | null;
  readonly waitingFor: string | null;
  readonly registryStatus: RegistryStatus | null;
}

/**
 * What a session row says. Claude's own state wins over herdr's `agent_status` when corral has it, and
 * a state corral could NOT read is rendered distinctly from an idle one — showing "idle" for a session
 * whose registry is unreadable is the exact failure the registryStatus enum exists to prevent.
 *
 * ONE function decides this wording everywhere (card, Unassigned list, modal), so two surfaces can
 * never disagree about what the same session is doing.
 */
export function sessionStateLabel(s: SessionStateFields | null): string {
  if (s === null) return "unknown";
  // Not consulted at all: the first sweep has not landed for this pane. Herdr's status is the honest
  // answer; "state unavailable" would be a permanent false alarm.
  if (s.registryStatus === null) return s.status;
  // NOT "state unavailable". `no-config-dirs` means corral was never TOLD where to look — it is a
  // configuration statement about the environment, not a failure to read this session, and it is the
  // DEFAULT for every remote environment (`claudeConfigDirs` defaults to `[]`). Left in the degraded
  // branch it would replace the herdr status corral genuinely knows with "state unavailable" on every
  // remote session's row, permanently, on a completely healthy fleet. The configuration gap is
  // reported once per environment in the startup report instead, which is the right surface for a
  // thing the operator fixes in a config file.
  if (s.registryStatus === "no-config-dirs") return s.status;
  if (s.registryStatus === "no-session-ref") return "starting";
  if (s.registryStatus !== "ok") return "state unavailable";
  if (s.claudeStatus === null) return s.status;
  if (s.claudeStatus === "waiting" && s.waitingFor !== null && s.waitingFor !== "") {
    return `waiting · ${s.waitingFor}`;
  }
  return s.claudeStatus;
}

/**
 * The colour of the dot beside the label. `unavailable` is separate from `unknown` because sharing a
 * colour with `idle` is the exact failure registryStatus exists to prevent: "corral could not read
 * this" must not look like "at rest". `unknown` is the quiet default — no claim, no alarm.
 */
export type SessionStateTone =
  | "working" | "attention" | "idle" | "done" | "unavailable" | "unknown";

/** herdr's `agent_status` vocabulary; anything else (the closing/resuming synthetics) is no claim. */
function herdrTone(status: string): SessionStateTone {
  if (status === "working") return "working";
  if (status === "blocked") return "attention";
  if (status === "done") return "done";
  if (status === "idle") return "idle";
  return "unknown";
}

/**
 * The dot's tone — a SIBLING of sessionStateLabel, same fields and same branch order. Never a lookup
 * on the string the label returns ("waiting · input needed" is not a key), and never derived from
 * herdr's `status` alone: that is how the dot came to contradict the words next to it.
 */
export function sessionStateTone(s: SessionStateFields | null): SessionStateTone {
  if (s === null) return "unknown";
  if (s.registryStatus === null) return herdrTone(s.status);
  if (s.registryStatus === "no-config-dirs") return herdrTone(s.status);
  // "starting" claims nothing. sessionId stays null forever for a bare-shell agent and for any pane
  // started outside a herdr context, so an activity colour here would be permanent and wrong.
  if (s.registryStatus === "no-session-ref") return "unknown";
  if (s.registryStatus !== "ok") return "unavailable";
  if (s.claudeStatus === null) return herdrTone(s.status);
  if (s.claudeStatus === "busy") return "working";
  // The one Claude state that needs a human — same red as herdr's `blocked` and the attention feed.
  if (s.claudeStatus === "waiting") return "attention";
  if (s.claudeStatus === "idle" || s.claudeStatus === "shell") return "idle";
  // A status this version of corral does not know. The label prints the word; the dot says corral
  // cannot vouch for it, rather than painting a possibly-active session at rest.
  return "unavailable";
}
