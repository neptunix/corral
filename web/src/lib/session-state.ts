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

// Keyed by tone, NOT by herdr's agent_status — the dot and the label must come from one decision.
// `unknown` keeps the class the herdr-keyed lookup fell back to, so the closing/resuming transients are
// not repainted; the values are pinned in test/ui-safety.test.ts. It lives beside the tone rather than
// in one component because more than one surface paints these dots, and two palettes would drift.
export const TONE_DOT: Record<SessionStateTone, string> = {
  working: "bg-emerald-400 light:bg-emerald-600",
  attention: "bg-red-400 light:bg-red-600",
  idle: "bg-slate-500",
  done: "bg-sky-400 light:bg-sky-600",
  unavailable: "bg-amber-400 light:bg-amber-600",
  unknown: "bg-slate-500",
};

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

/**
 * Text colours for the same tones — a SIBLING of TONE_DOT, which paints backgrounds. Every surface
 * that puts a tone into TEXT rather than a dot reads this one map: the Unassigned list's bullet and
 * the column marker's number. It lives here for the same reason TONE_DOT does — a second copy in a
 * component is how the two drifted apart before.
 */
export const TONE_TEXT: Record<SessionStateTone, string> = {
  working: "text-emerald-400 light:text-emerald-600",
  attention: "text-red-400 light:text-red-600",
  idle: "text-slate-500",
  done: "text-sky-400 light:text-sky-600",
  unavailable: "text-amber-400 light:text-amber-600",
  unknown: "text-slate-400 light:text-slate-500",
};

// Severity, NOT the union's declaration order — a surface that summarises several sessions in one
// mark has to pick which of them it speaks for. `unavailable` outranks `working` deliberately: it
// means corral could not read that session, and ranking it under a calm tone hides it behind one,
// which is the failure this tone was introduced to prevent.
const TONE_SEVERITY: Record<SessionStateTone, number> = {
  attention: 5, unavailable: 4, working: 3, done: 2, idle: 1, unknown: 0,
};

/**
 * The tone that speaks for a GROUP of sessions — the most urgent one present. An empty group has
 * nothing to speak for and gets the tone that claims nothing.
 */
export function worstTone(tones: readonly SessionStateTone[]): SessionStateTone {
  let worst: SessionStateTone = "unknown";
  for (const t of tones) if (TONE_SEVERITY[t] > TONE_SEVERITY[worst]) worst = t;
  return worst;
}

/** Structural, like SessionStateFields — a card's session link, seen only through the field below. */
interface MaybeLiveLink {
  readonly live: { readonly detached: boolean } | null;
}

/**
 * Is this link a session that is actually RUNNING? A detached link points at a session that has
 * ended: the card still renders it, and it is still resumable, but nothing is behind it.
 *
 * ONE predicate decides this everywhere (the card's primary session, the closed-column confirmation,
 * the column marker), because the three surfaces disagreeing about which sessions are alive is a bug
 * with no symptom until someone acts on the wrong one. The `closing` synthetic already sets
 * `detached`, so this rule does move.
 */
export function isLiveLink<T extends MaybeLiveLink>(s: T): s is T & { live: NonNullable<T["live"]> } {
  return s.live !== null && !s.live.detached;
}

/**
 * Which SESSION a link points at. A spawn/attach race can persist two links resolving to one live
 * session, so every surface that counts or lists links collapses them on this key first — and they
 * must all collapse the same way, or the card shows one session while the column marker above it
 * says two, with a collapsed column offering nothing to reconcile that against.
 *
 * `sessionId` is part of the key, not the whole of it: after a herdr restart two links can share a
 * paneId (one live at the reused pane, one detached still aimed at it) and only their sessionIds
 * differ.
 */
export function sessionLinkKey(s: { readonly env: string; readonly paneId: string; readonly sessionId: string | null }): string {
  return `${s.env}:${s.paneId}:${s.sessionId ?? ""}`;
}
