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
 * The colour of the dot that sits beside the label. Deliberately a SMALL semantic set rather than one
 * token per status: two vocabularies feed the label (Claude's and herdr's) and they overlap only on
 * `idle`, so a per-status palette would have to name the same colour twice under different keys.
 */
export type SessionStateTone = "working" | "attention" | "idle" | "done" | "unknown";

/**
 * herdr's `agent_status` vocabulary. Everything outside it lands on `unknown`, which is what the
 * optimistic "closing…"/"resuming…" synthetics and a detached row's "unknown" want anyway — and both
 * call sites map `unknown` to the exact fallback class they already used, so those look unchanged.
 */
function herdrTone(status: string): SessionStateTone {
  if (status === "working") return "working";
  if (status === "blocked") return "attention";
  if (status === "done") return "done";
  if (status === "idle") return "idle";
  return "unknown";
}

/**
 * The dot's tone, from the SAME fields and in the SAME branch order as sessionStateLabel.
 *
 * A SIBLING of the label, never a lookup on the string it returns: the label is display text
 * ("waiting · input needed" is not a key). And it must not be derived from herdr's `status` on its own
 * — that is precisely how the dot came to contradict the words next to it, colouring a row `done` in
 * herdr's vocabulary while the label read `idle` in Claude's.
 */
export function sessionStateTone(s: SessionStateFields | null): SessionStateTone {
  if (s === null) return "unknown";
  if (s.registryStatus === null) return herdrTone(s.status);
  if (s.registryStatus === "no-config-dirs") return herdrTone(s.status);
  // "starting" — the pane is up and Claude has not registered yet. That is activity, not rest.
  if (s.registryStatus === "no-session-ref") return "working";
  // "state unavailable" — corral cannot say what this session is doing, so the dot must not claim to.
  if (s.registryStatus !== "ok") return "unknown";
  if (s.claudeStatus === null) return herdrTone(s.status);
  if (s.claudeStatus === "busy") return "working";
  // `waiting` is the one Claude state that needs a human, so it takes the same red as herdr's
  // `blocked` and as the attention feed's `text-destructive`.
  if (s.claudeStatus === "waiting") return "attention";
  if (s.claudeStatus === "idle" || s.claudeStatus === "shell") return "idle";
  return "unknown";
}
