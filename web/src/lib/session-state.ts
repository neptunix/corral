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
